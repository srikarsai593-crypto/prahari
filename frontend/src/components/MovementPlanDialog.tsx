'use client';

import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { api } from '@/lib/api';
import { useToast } from './Toast';
import type { Personnel, Geofence } from '@/lib/types';
import { getStation } from '@/lib/stations';
import { Coordinate } from '@/components/Coordinate';

/**
 * Authorise a movement plan.
 *
 * Personnel tracking is unusable without this: `simulate-move` needs a plan to
 * walk, and previously the only way to create one was the scripted scenario
 * page, so the module looked functional but moved nobody.
 */
interface Props {
  person: Personnel;
  stationId: string;
  onClose: () => void;
  onCreated: () => void;
}

/** Straight leg from origin to destination, split into `segments` waypoints. */
function buildRoute(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  segments = 4,
) {
  return Array.from({ length: segments + 1 }, (_, i) => ({
    lat: +(from.lat + ((to.lat - from.lat) * i) / segments).toFixed(6),
    lng: +(from.lng + ((to.lng - from.lng) * i) / segments).toFixed(6),
  }));
}

export function MovementPlanDialog({ person, stationId, onClose, onCreated }: Props) {
  const { addToast } = useToast();
  const station = getStation(stationId);
  const [destinations, setDestinations] = useState<Geofence[]>([]);
  const [destinationId, setDestinationId] = useState('');
  const [hours, setHours] = useState(6);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.listGeofences()
      .then((all) => {
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

  const origin = {
    lat: person.current_lat ?? station.lat,
    lng: person.current_lng ?? station.lng,
  };

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
        planned_route: buildRoute(origin,
          { lat: destination.center_lat, lng: destination.center_lng }),
        departure_time: departure.toISOString(),
        expected_arrival: arrival.toISOString(),
      });

      // The backend runs a pre-flight check: say so rather than burying it.
      const warnings = (result as { route_warnings?: string[] })?.route_warnings ?? [];
      if (warnings.length > 0) {
        addToast(`Plan authorised, but the route crosses ${warnings.join(', ')}`, 'warning');
      } else {
        addToast(`${person.name} authorised to ${destination.name}`, 'success');
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
      <div className="subview-card p-6 w-full max-w-md shadow-raised">
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

        <div className="space-y-4">
          <div>
            <label htmlFor="mp-destination">Destination</label>
            <select id="mp-destination" value={destinationId}
                    onChange={(e) => setDestinationId(e.target.value)}
          >
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
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-5">
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
