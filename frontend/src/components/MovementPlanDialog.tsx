'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { AlertTriangle, CheckCircle2, Route, Undo2, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useToast } from './Toast';
import type { Personnel, Geofence } from '@/lib/types';
import { getStation } from '@/lib/stations';
import { Coordinate } from '@/components/Coordinate';
import { pathLengthKm, restrictedZonesOnPath } from '@/lib/geo';
import type { Waypoint } from './RoutePlannerMap';

/**
 * Authorise a movement plan.
 *
 * Personnel tracking is unusable without this: `simulate-move` needs a plan to
 * walk, and previously the only way to create one was the scripted scenario
 * page, so the module looked functional but moved nobody.
 *
 * The dialog now also lets the operator route *around* what the pre-flight
 * check complains about. Before, the backend would warn that the authorised
 * line crossed the Crevasse Zone and the commander had no way to act on it —
 * a hazard detector with no steering.
 */
interface Props {
  person: Personnel;
  stationId: string;
  onClose: () => void;
  onCreated: () => void;
}

// Leaflet touches `window` at import time, so the editor is browser-only.
const RoutePlannerMap = dynamic(() => import('./RoutePlannerMap'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full bg-arctic-50 rounded-xl flex items-center justify-center
                    text-frost-muted text-xs animate-pulse">
      Loading route planner…
    </div>
  ),
});

/**
 * Straight leg from origin to destination, split into `segments` waypoints.
 *
 * At 8 segments a route densifies to 65 GPS fixes on the backend, which is
 * what turns playback from a 26-second blur into a continuous traverse an
 * operator can actually watch.
 */
function buildRoute(from: Waypoint, to: Waypoint, segments = 8) {
  return Array.from({ length: segments + 1 }, (_, i) => ({
    lat: +(from.lat + ((to.lat - from.lat) * i) / segments).toFixed(6),
    lng: +(from.lng + ((to.lng - from.lng) * i) / segments).toFixed(6),
  }));
}

/** Origin → detours → destination, with each leg subdivided for the simulator. */
function buildRouteVia(from: Waypoint, via: Waypoint[], to: Waypoint) {
  const corners = [from, ...via, to];
  // Fewer subdivisions per leg once there are several legs: the point is a
  // usable fix density overall, not a fix every few metres.
  const perLeg = Math.max(2, Math.round(8 / corners.length) + 1);
  const route: Waypoint[] = [corners[0]];
  for (let i = 0; i < corners.length - 1; i += 1) {
    route.push(...buildRoute(corners[i], corners[i + 1], perLeg).slice(1));
  }
  return route;
}

export function MovementPlanDialog({ person, stationId, onClose, onCreated }: Props) {
  const { addToast } = useToast();
  const station = getStation(stationId);
  const [geofences, setGeofences] = useState<Geofence[]>([]);
  const [destinations, setDestinations] = useState<Geofence[]>([]);
  const [destinationId, setDestinationId] = useState('');
  const [hours, setHours] = useState(6);
  const [submitting, setSubmitting] = useState(false);
  /** Operator-placed detours, in order, between departure and destination. */
  const [waypoints, setWaypoints] = useState<Waypoint[]>([]);

  useEffect(() => {
    api.listGeofences()
      .then((all) => {
        setGeofences(all);
        const usable = all.filter((g) =>
          // A restricted zone is never a valid destination to authorise.
          g.type !== 'restricted'
          // Nor is a camp at another station: the geofence table holds every
          // station's zones, so an unfiltered list let a Bharati operative be
          // authorised to a camp beside Maitri.
          && Math.abs(g.center_lat - station.lat) < 2
          && Math.abs(g.center_lng - station.lng) < 6);
        setDestinations(usable);
        setDestinationId(usable.find((g) => g.type === 'field_camp')?.id ?? usable[0]?.id ?? '');
      })
      .catch(() => addToast('Could not load destinations', 'alert'));
  }, [addToast, station]);

  // Escape closes the dialog — a modal that traps the operator is unusable
  // during an incident.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const destination = useMemo(
    () => destinations.find((d) => d.id === destinationId),
    [destinations, destinationId],
  );

  const origin = useMemo(() => ({
    lat: person.current_lat ?? station.lat,
    lng: person.current_lng ?? station.lng,
  }), [person.current_lat, person.current_lng, station]);

  // Changing destination invalidates detours placed for the previous one.
  useEffect(() => { setWaypoints([]); }, [destinationId]);

  /** The zones near this leg — what the planner draws, hazards included. */
  const relevantGeofences = useMemo(() => {
    if (!destination) return [];
    return geofences.filter((g) =>
      Math.abs(g.center_lat - station.lat) < 2 && Math.abs(g.center_lng - station.lng) < 6);
  }, [geofences, destination, station]);

  const plannedRoute = useMemo(() => {
    if (!destination) return [];
    return buildRouteVia(origin, waypoints,
      { lat: destination.center_lat, lng: destination.center_lng });
  }, [origin, waypoints, destination]);

  /**
   * Live pre-flight verdict, recomputed on every waypoint edit.
   *
   * Deliberately client-side: a round trip per drag would make the editor
   * unusable. The backend still runs the authoritative check on submit, and
   * this one is stricter (segment distance, not sampled points), so a path
   * that reads clear here clears there too.
   */
  const breached = useMemo(
    () => restrictedZonesOnPath(plannedRoute, relevantGeofences),
    [plannedRoute, relevantGeofences]);

  const distanceKm = useMemo(() => pathLengthKm(plannedRoute), [plannedRoute]);

  const addWaypoint = useCallback((wp: Waypoint) => setWaypoints((prev) => [...prev, wp]), []);
  const moveWaypoint = useCallback((index: number, wp: Waypoint) => setWaypoints(
    (prev) => prev.map((existing, i) => (i === index ? wp : existing))), []);
  const removeWaypoint = useCallback((index: number) => setWaypoints(
    (prev) => prev.filter((_, i) => i !== index)), []);

  const submit = async () => {
    if (!destination) return addToast('Choose a destination', 'warning');
    setSubmitting(true);
    try {
      const departure = new Date();
      const arrival = new Date(departure.getTime() + hours * 3600_000);
      const result = await api.createMovementPlan({
        personnel_id: person.id,
        origin_lat: origin.lat,
        origin_lng: origin.lng,
        destination_lat: destination.center_lat,
        destination_lng: destination.center_lng,
        destination_name: destination.name,
        // The operator's own corridor, not a straight line drawn through
        // whatever happens to be in the way.
        planned_route: plannedRoute,
        departure_time: departure.toISOString(),
        expected_arrival: arrival.toISOString(),
      });

      // The backend runs a pre-flight check: say so rather than burying it.
      const warnings = (result as { route_warnings?: string[] })?.route_warnings ?? [];
      if (warnings.length > 0) {
        addToast(`Plan authorised, but the route crosses ${warnings.join(', ')}`, 'warning');
      } else {
        addToast(`${person.name} authorised to ${destination.name}`
          + (waypoints.length ? ` via ${waypoints.length} waypoint(s)` : ''), 'success');
      }
      onCreated();
      onClose();
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Could not create movement plan', 'alert');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[65] bg-arctic-950/30 backdrop-blur-sm flex items-center
                 justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Authorise movement plan for ${person.name}`}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="subview-card p-6 w-full max-w-4xl shadow-raised max-h-[92vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3 mb-4 pb-4
                        border-b border-frost-border">
          <div>
            <span className="overline block">Movement Authorisation · {station.label}</span>
            <h2 className="text-xl font-bold text-arctic-900 mt-1">Authorise Movement</h2>
            <p className="text-13 text-frost-muted mt-0.5">{person.name} · {person.role}</p>
          </div>
          <button type="button" onClick={onClose} data-compact aria-label="Close"
                  className="text-frost-muted hover:text-arctic-900 px-2 py-1 rounded-md
                             hover:bg-frost-subtle transition-colors">
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
          {/* ── Parameters ─────────────────────────────────────────────── */}
          <div className="lg:col-span-2 space-y-4">
            <div>
              <label htmlFor="mp-destination">Destination</label>
              <select id="mp-destination" value={destinationId}
                      onChange={(e) => setDestinationId(e.target.value)}>
                {destinations.length === 0 && (
                  <option value="">No authorised destinations near {station.label}</option>
                )}
                {destinations.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} ({d.type.replace('_', ' ')})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="mp-hours">Expected duration — {hours}h</label>
              <input id="mp-hours" type="range" min={1} max={48} value={hours}
                     onChange={(e) => setHours(parseInt(e.target.value, 10))} />
              <p className="text-2xs text-frost-muted mt-1">
                They are flagged overdue if they have not arrived by then.
              </p>
            </div>

            {/* Authorising a traverse is a precision context: both the
                degrees-minutes reading and the decimal degrees are shown. */}
            <div className="inset-panel p-3 text-xs font-mono text-arctic-800 space-y-2">
              <div className="flex justify-between items-start gap-2">
                <span className="text-frost-muted">Origin</span>
                <Coordinate lat={origin.lat} lng={origin.lng} decimals
                            className="text-right items-end" />
              </div>
              <div className="flex justify-between items-start gap-2">
                <span className="text-frost-muted">Destination</span>
                <Coordinate lat={destination?.center_lat} lng={destination?.center_lng} decimals
                            className="text-right items-end" />
              </div>
              <div className="flex justify-between items-center gap-2 pt-2
                              border-t border-frost-border">
                <span className="text-frost-muted">Route length</span>
                <span className="font-bold text-arctic-900">{distanceKm.toFixed(1)} km</span>
              </div>
            </div>

            {/* ── Live pre-flight verdict ──────────────────────────────── */}
            {breached.length > 0 ? (
              <div className="p-3 rounded-xl border border-rose-200 bg-rose-50/80">
                <p className="flex items-start gap-2 text-13 font-bold text-rose-800">
                  <AlertTriangle size={14} className="shrink-0 mt-0.5" aria-hidden="true" />
                  Route crosses {breached.length} restricted zone
                  {breached.length > 1 ? 's' : ''}
                </p>
                <p className="text-2xs text-rose-700 mt-1">
                  {breached.map((z) => z.name).join(', ')}. Click the map to place a waypoint
                  and steer the corridor around it.
                </p>
              </div>
            ) : (
              <div className="p-3 rounded-xl border border-emerald-200 bg-emerald-50/80">
                <p className="flex items-start gap-2 text-13 font-bold text-emerald-800">
                  <CheckCircle2 size={14} className="shrink-0 mt-0.5" aria-hidden="true" />
                  Safe corridor — 0 restricted hazard zones crossed
                </p>
              </div>
            )}

            <div>
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <span className="overline">
                  Detour waypoints ({waypoints.length})
                </span>
                {waypoints.length > 0 && (
                  <button type="button" data-compact onClick={() => setWaypoints([])}
                          className="text-2xs font-mono tracking-caps uppercase text-arctic-700
                                     hover:underline inline-flex items-center gap-1">
                    <Undo2 size={11} aria-hidden="true" /> Clear
                  </button>
                )}
              </div>
              {waypoints.length === 0 ? (
                <p className="text-2xs text-frost-muted leading-relaxed">
                  Click anywhere on the map to add a detour point. Drag a pin to move it,
                  click a pin to remove it. With none placed, the route is the direct line.
                </p>
              ) : (
                <ul className="space-y-1">
                  {waypoints.map((wp, i) => (
                    <li key={`${wp.lat},${wp.lng},${i}`}
                        className="flex items-center justify-between gap-2 text-2xs font-mono
                                   bg-white border border-frost-border rounded-md px-2 py-1">
                      <span className="text-arctic-900 truncate">
                        {i + 1}. {wp.lat.toFixed(4)}, {wp.lng.toFixed(4)}
                      </span>
                      <button type="button" data-compact aria-label={`Remove waypoint ${i + 1}`}
                              onClick={() => removeWaypoint(i)}
                              className="shrink-0 text-frost-muted hover:text-emergency
                                         p-0.5 rounded transition-colors">
                        <X size={11} aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* ── Planner map ────────────────────────────────────────────── */}
          <div className="lg:col-span-3">
            <div className="flex items-center gap-1.5 mb-2">
              <Route size={13} className="text-arctic-600" aria-hidden="true" />
              <span className="overline">Route Planner</span>
            </div>
            <div className="rounded-xl overflow-hidden border border-frost-border"
                 style={{ height: 380 }}>
              {destination ? (
                <RoutePlannerMap
                  origin={origin}
                  destination={{ lat: destination.center_lat, lng: destination.center_lng }}
                  destinationName={destination.name}
                  waypoints={waypoints}
                  geofences={relevantGeofences}
                  breachedIds={breached.map((z) => z.id)}
                  onAddWaypoint={addWaypoint}
                  onMoveWaypoint={moveWaypoint}
                  onRemoveWaypoint={removeWaypoint}
                />
              ) : (
                <div className="w-full h-full bg-arctic-50 flex items-center justify-center
                                text-frost-muted text-xs">
                  Choose a destination to plan a route.
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-5 pt-4 border-t border-frost-border">
          <button type="button" className="btn-secondary text-13" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary text-13" onClick={submit}
                  disabled={submitting || !destination}>
            {submitting ? 'Authorising…' : 'Authorise Plan'}
          </button>
        </div>
      </div>
    </div>
  );
}
