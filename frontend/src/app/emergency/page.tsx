'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Siren, RotateCw, Zap, CheckCircle2, Users } from 'lucide-react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';
import { useStation } from '@/components/StationProvider';
import { Coordinate } from '@/components/Coordinate';
import { useWebSocket } from '@/components/WebSocketProvider';
import { useToast } from '@/components/Toast';
import { MapView } from '@/components/MapView';
import { EventTimeline } from '@/components/EventTimeline';
import type { Incident, Accountability, NearbyAsset } from '@/lib/types';

const INCIDENT_TYPES = [
  ['medical', 'Medical Emergency'],
  ['fire', 'Fire'],
  ['severe_weather', 'Severe Weather'],
  ['power_failure', 'Power Failure'],
] as const;

const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;

/**
 * Coordinates are held as strings while the operator types.
 *
 * `parseFloat(e.target.value) || fallback` turned a half-typed "-" into NaN and
 * snapped the field back to a hard-coded Maitri coordinate — so a negative
 * latitude could not be typed at all, and the fallback was wrong at every other
 * station. The string is parsed once, on submit.
 */
const parseCoord = (raw: string): number | null => {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '-' || trimmed === '.' || trimmed === '-.') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
};

export default function EmergencyPage() {
  const { lastMessage } = useWebSocket();
  const { addToast } = useToast();
  const { station, stationId, ready } = useStation();

  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [showResolved, setShowResolved] = useState(false);
  const [loading, setLoading] = useState(true);
  /** The incident the accountability panel is reporting on. */
  const [focusId, setFocusId] = useState<string | null>(null);
  const [accountability, setAccountability] = useState<Accountability | null>(null);
  const [nearbyAssets, setNearbyAssets] = useState<NearbyAsset[]>([]);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [form, setForm] = useState({ type: 'medical', severity: 'critical' });
  const [lat, setLat] = useState(String(station.lat));
  const [lng, setLng] = useState(String(station.lng));

  // Re-centre the declaration form on the console's active station.
  useEffect(() => {
    if (!ready) return;
    setLat(String(station.lat));
    setLng(String(station.lng));
  }, [station, ready]);

  const openIncidents = useMemo(
    () => incidents.filter((i) => i.status === 'open'), [incidents]);
  const visibleIncidents = showResolved ? incidents : openIncidents;
  const focusIncident = useMemo(
    () => incidents.find((i) => i.id === focusId) ?? null, [incidents, focusId]);

  const loadNearbyAssets = useCallback(async (aLat: number, aLng: number) => {
    try {
      const data = await api.searchNearbyAssets(aLat, aLng);
      setNearbyAssets(Array.isArray(data) ? data.slice(0, 3) : []);
    } catch {
      addToast('Could not fetch nearby assets — check the station link', 'warning');
      setNearbyAssets([]);
    }
  }, [addToast]);

  const loadIncidents = useCallback(async () => {
    setLoading(true);
    try {
      // Scoped to the active station's response radius — an incident at Maitri
      // is not Bharati's to respond to, and plotting both zooms the map out to
      // span two continents.
      const data = await api.listIncidents({ station: stationId });
      const list = Array.isArray(data) ? data : [];
      setIncidents(list);

      // Keep the current focus if it is still open; otherwise fall back to the
      // newest open incident, never to a resolved one.
      const open = list.filter((i) => i.status === 'open');
      setFocusId((prev) => (prev && open.some((i) => i.id === prev) ? prev : open[0]?.id ?? null));
    } catch (e) {
      console.error('Failed to load incidents:', e);
      addToast('Could not reach the station records — check the connection indicator above',
        'alert');
    } finally {
      setLoading(false);
    }
  }, [stationId, addToast]);

  useEffect(() => { if (ready) void loadIncidents(); }, [loadIncidents, ready]);

  // Head-count and assets follow the focused incident rather than "whatever
  // arrived last". Both used to be loaded for the newest incident and then
  // overwritten by any broadcast for any other open one, so the panel could
  // show a different incident's numbers than the one it was sitting next to.
  useEffect(() => {
    if (!focusIncident) { setAccountability(null); setNearbyAssets([]); return; }
    let cancelled = false;
    api.readAccountability(focusIncident.id)
      .then((acct) => { if (!cancelled) setAccountability(acct); })
      .catch(() => { if (!cancelled) setAccountability(null); });
    void loadNearbyAssets(focusIncident.location_lat, focusIncident.location_lng);
    return () => { cancelled = true; };
  }, [focusIncident, loadNearbyAssets]);

  useEffect(() => {
    if (!lastMessage) return;
    if (lastMessage.type === 'accountability_update') {
      // Only adopt a count that belongs to the incident on screen.
      if (focusId && lastMessage.data?.incident_id === focusId) {
        setAccountability(lastMessage.data);
      }
      void loadIncidents();
    } else if (lastMessage.type === 'incident_update'
      || (lastMessage.type === 'alert' && lastMessage.data?.type === 'incident')
      || lastMessage.type === 'station_reset') {
      void loadIncidents();
    }
  }, [lastMessage, focusId, loadIncidents]);

  // ── Declare ────────────────────────────────────────────────────────────────
  const handleCreate = async () => {
    const latValue = parseCoord(lat);
    const lngValue = parseCoord(lng);
    if (latValue === null || lngValue === null) {
      return addToast('Enter a latitude and longitude for the incident', 'warning');
    }
    if (latValue < -90 || latValue > 90 || lngValue < -180 || lngValue > 180) {
      return addToast('Latitude must be −90…90 and longitude −180…180', 'warning');
    }
    setCreating(true);
    try {
      const result = await api.createIncident({
        type: form.type,
        severity: form.severity as Incident['severity'],
        location_lat: latValue,
        location_lng: lngValue,
        affected_radius_m: 1000,
      });
      addToast('Emergency declared — accountability check initiated', 'alert');
      if (result?.id) setFocusId(result.id);
      if (result?.expected_count !== undefined) {
        setAccountability({
          incident_id: result.id,
          expected: result.expected_count ?? 0,
          confirmed_safe: result.confirmed_safe_count,
          unaccounted: result.unaccounted_count ?? 0,
        });
      }
      void loadIncidents();
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Failed to declare incident', 'alert');
    } finally { setCreating(false); }
  };

  /** Recompute the head-count before closing — people move. */
  const handleRefreshCount = async (id: string) => {
    setBusyId(id);
    try {
      const res = await api.refreshAccountability(id);
      setAccountability(res);
      addToast(res.unaccounted > 0
        ? `${res.unaccounted} of ${res.expected} still unaccounted for`
        : `All ${res.expected} in the zone confirmed safe`,
        res.unaccounted > 0 ? 'warning' : 'success');
      void loadIncidents();
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Could not recount', 'alert');
    } finally { setBusyId(null); }
  };

  /**
   * Closing an incident. The backend refuses while anyone in the zone is
   * unaccounted for — that guard existed but nothing in the UI ever called it,
   * so incidents accumulated open forever.
   */
  const handleResolve = async (incident: Incident) => {
    setBusyId(incident.id);
    try {
      await api.updateIncident(incident.id, 'resolved');
      addToast(`${incident.type.replace('_', ' ')} incident resolved`, 'success');
      void loadIncidents();
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Could not resolve incident', 'alert');
    } finally { setBusyId(null); }
  };

  const handlePowerFailure = async () => {
    try {
      const res = await api.declarePowerFailure(stationId);
      addToast(`Power failure declared at ${station.label} — ${res.unaccounted_count} of `
        + `${res.expected_count} in the affected zone unaccounted for`, 'alert');
      setFocusId(res.incident_id);
      void loadIncidents();
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Failed to declare power failure', 'alert');
    }
  };

  const severityChip = (severity: string) =>
    severity === 'critical'
      ? 'bg-rose-100 border-rose-300 text-rose-800'
      : severity === 'high'
        ? 'bg-amber-100 border-amber-300 text-amber-900'
        : 'bg-amber-50 border-amber-200 text-amber-800';

  return (
    <div>
      <PageHeader
        title="Emergency Response"
        code="EMG-RSP-05"
        description="Raise an alarm, count who is inside the affected area, and find the nearest
                     rescue vehicle or medical kit."
      >
        <button className="btn-secondary text-13" onClick={loadIncidents}>
          <RotateCw size={14} aria-hidden="true" /> Refresh
        </button>
      </PageHeader>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6"
           style={{ minHeight: 'calc(100vh - 200px)' }}>
        {/* ── Sidebar ─────────────────────────────────────────────────────── */}
        <div className="lg:col-span-1 space-y-4 overflow-y-auto"
             style={{ maxHeight: 'calc(100vh - 200px)' }}>
          {/* Declare */}
          <div className="subview-card rounded-2xl p-6">
            <h2 className="text-base font-bold text-rose-700 mb-1 flex items-center gap-2">
              <Siren size={16} aria-hidden="true" /> Declare Emergency
            </h2>
            <p className="text-xs text-frost-muted mb-4">
              Declares a critical incident at the given position and starts an accountability
              check across {station.label}.
            </p>
            <div className="space-y-3">
              <div>
                <label htmlFor="em-type">Incident Category</label>
                <select id="em-type" value={form.type}
                        onChange={(e) => setForm({ ...form, type: e.target.value })}>
                  {INCIDENT_TYPES.map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="em-sev">Severity Level</label>
                <select id="em-sev" value={form.severity}
                        onChange={(e) => setForm({ ...form, severity: e.target.value })}>
                  {SEVERITIES.map((sv) => (
                    <option key={sv} value={sv} className="capitalize">{sv}</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label htmlFor="em-lat">Latitude</label>
                  {/* inputMode rather than type=number: the value is held as
                      text so a leading minus sign survives being typed. */}
                  <input id="em-lat" type="text" inputMode="decimal" value={lat}
                         onChange={(e) => setLat(e.target.value)} className="font-mono" />
                </div>
                <div>
                  <label htmlFor="em-lng">Longitude</label>
                  <input id="em-lng" type="text" inputMode="decimal" value={lng}
                         onChange={(e) => setLng(e.target.value)} className="font-mono" />
                </div>
              </div>
              <button type="button"
                      className="text-2xs font-mono tracking-caps uppercase text-arctic-700
                                 hover:underline"
                      onClick={() => { setLat(String(station.lat)); setLng(String(station.lng)); }}>
                Use {station.label} coordinates
              </button>
              <button className="btn-danger w-full text-xs" onClick={handleCreate}
                      disabled={creating}>
                {creating ? 'Declaring…'
                  : <><Siren size={14} aria-hidden="true" /> Declare Emergency</>}
              </button>
            </div>
            <div className="mt-4 pt-4 border-t border-arctic-100">
              <button
                className="w-full bg-amber-50 hover:bg-amber-100 border border-amber-200
                           text-amber-800 text-xs font-semibold py-2 rounded-md
                           transition-colors flex items-center justify-center gap-1.5"
                onClick={handlePowerFailure}
              >
                <Zap size={14} aria-hidden="true" /> Declare Power Failure
              </button>
            </div>
          </div>

          {/* Incident list */}
          <div className="subview-card rounded-2xl p-5">
            <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
              <h3 className="section-heading">
                {showResolved ? 'All' : 'Open'} Incidents ({visibleIncidents.length})
              </h3>
              <button type="button" data-compact
                      onClick={() => setShowResolved((v) => !v)}
                      className="text-2xs font-mono tracking-caps uppercase text-arctic-700
                                 hover:underline shrink-0">
                {showResolved ? 'Open only' : 'Show resolved'}
              </button>
            </div>

            {visibleIncidents.length === 0 ? (
              <p className="text-xs text-frost-muted">
                No {showResolved ? '' : 'open '}incidents at {station.label}.
              </p>
            ) : (
              <div className="space-y-2">
                {visibleIncidents.map((inc) => {
                  const resolved = inc.status === 'resolved';
                  const focused = inc.id === focusId;
                  const blocked = (inc.unaccounted_count ?? 0) > 0;
                  return (
                    <div
                      key={inc.id}
                      onClick={() => setFocusId(inc.id)}
                      className={`p-3 rounded-xl border cursor-pointer transition-colors ${
                        resolved
                          ? 'bg-frost-subtle border-frost-border'
                          : focused
                            ? 'bg-rose-50 border-rose-300 ring-1 ring-rose-200'
                            : 'bg-rose-50/60 border-rose-200 hover:border-rose-300'}`}
                    >
                      <div className="flex justify-between items-start gap-2">
                        <span className={`font-bold text-xs capitalize ${
                          resolved ? 'text-frost-muted' : 'text-rose-800'}`}>
                          {inc.type?.replace('_', ' ')}
                        </span>
                        <span data-compact
                              className={`text-2xs font-semibold px-2 py-0.5 rounded-full border
                                          shrink-0 ${resolved
                                            ? 'bg-frost-subtle border-frost-border text-frost-muted'
                                            : severityChip(inc.severity)}`}>
                          {resolved ? 'resolved' : inc.severity}
                        </span>
                      </div>
                      <p className={`text-xs mt-1 ${resolved ? 'text-frost-muted' : 'text-emergency'}`}>
                        <Coordinate lat={inc.location_lat} lng={inc.location_lng} />
                      </p>
                      <p className="text-2xs text-frost-muted mt-1">
                        {inc.unaccounted_count ?? 0} unaccounted ·{' '}
                        {inc.confirmed_safe_count ?? 0} safe of {inc.expected_count ?? 0}
                      </p>

                      {!resolved && (
                        <div className="flex gap-1.5 mt-2.5">
                          <button
                            type="button"
                            data-compact
                            disabled={busyId === inc.id}
                            onClick={(e) => { e.stopPropagation(); void handleRefreshCount(inc.id); }}
                            className="btn-secondary !min-h-0 !px-2 !py-1 text-2xs flex-1"
                          >
                            <Users size={11} aria-hidden="true" /> Recount
                          </button>
                          <button
                            type="button"
                            data-compact
                            disabled={busyId === inc.id || blocked}
                            title={blocked
                              ? `${inc.unaccounted_count} still unaccounted for — recount once `
                                + 'everyone is confirmed safe'
                              : 'Close this incident'}
                            onClick={(e) => { e.stopPropagation(); void handleResolve(inc); }}
                            className="btn-primary !min-h-0 !px-2 !py-1 text-2xs flex-1"
                          >
                            <CheckCircle2 size={11} aria-hidden="true" /> Resolve
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Nearby assets */}
          {nearbyAssets.length > 0 && (
            <div className="subview-card rounded-2xl p-5">
              <h3 className="section-heading mb-3">Nearest Assets</h3>
              <div className="space-y-2">
                {nearbyAssets.map((asset) => (
                  <div key={asset.id} className="bg-arctic-50 p-3 rounded-xl border
                                                 border-arctic-200">
                    <div className="font-bold text-arctic-900 text-xs">{asset.name}</div>
                    <div className="text-2xs text-frost-muted capitalize">{asset.type}</div>
                    <div className="text-xs metric text-arctic-700 mt-0.5">
                      {asset.distance_m}m away
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Accountability — always says which incident it is counting. */}
          {accountability && focusIncident && (
            <div className="subview-card rounded-2xl p-5">
              <h3 className="section-heading mb-1">Accountability</h3>
              <p className="text-2xs text-frost-muted mb-3">
                <span className="capitalize">{focusIncident.type.replace('_', ' ')}</span> ·{' '}
                <span className="font-mono">{focusIncident.id}</span> ·{' '}
                {Math.round(focusIncident.affected_radius_m)} m radius
              </p>
              <div className="space-y-2">
                <div className="flex justify-between items-center bg-arctic-50 p-3 rounded-xl">
                  <span className="text-xs text-frost-muted">Total Expected</span>
                  <span className="metric text-arctic-900">{accountability.expected ?? 0}</span>
                </div>
                <div className="flex justify-between items-center bg-emerald-50 border
                                border-emerald-200 p-3 rounded-xl">
                  <span className="text-xs text-emerald-700">Confirmed Safe</span>
                  <span className="metric text-emerald-700">
                    {accountability.confirmed_safe ?? 0}
                  </span>
                </div>
                <div className="flex justify-between items-center bg-rose-50 border
                                border-rose-200 p-3 rounded-xl">
                  <span className="text-xs text-rose-700">Unaccounted</span>
                  <span className="metric text-rose-700">{accountability.unaccounted ?? 0}</span>
                </div>
              </div>
              {(accountability.unaccounted ?? 0) > 0 && (
                <p className="text-2xs text-frost-muted mt-3 leading-relaxed">
                  Someone only counts as safe once an operator has confirmed they are back at
                  base. Mark them returned on the Personnel page, then recount.
                </p>
              )}
            </div>
          )}
        </div>

        {/* ── Map — open incidents only ───────────────────────────────────── */}
        <div className="lg:col-span-2 subview-card rounded-2xl p-2 overflow-hidden"
             style={{ minHeight: 480 }}>
          {loading ? (
            <div className="w-full h-full bg-arctic-50 rounded-xl flex items-center
                            justify-center animate-pulse">
              <span className="text-frost-muted text-xs">Loading map data…</span>
            </div>
          ) : (
            <MapView incidents={openIncidents} />
          )}
        </div>

        {/* ── Timeline ────────────────────────────────────────────────────── */}
        <div className="lg:col-span-1 overflow-hidden" style={{ maxHeight: 'calc(100vh - 200px)' }}>
          <EventTimeline />
        </div>
      </div>
    </div>
  );
}
