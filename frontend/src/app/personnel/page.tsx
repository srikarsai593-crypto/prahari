'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Map, Radio, Square, RotateCw, Plus, Siren, AlertTriangle, UserCheck,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';
import { useStation } from '@/components/StationProvider';
import { useWebSocket } from '@/components/WebSocketProvider';
import { useToast } from '@/components/Toast';
import { MapView } from '@/components/MapView';
import { MovementPlanDialog } from '@/components/MovementPlanDialog';
import { Coordinate } from '@/components/Coordinate';
import type { Personnel, MovementPlan } from '@/lib/types';

const GPS_TICK_MS = 2000;

/**
 * Status moves an operator can make, mirroring VALID_TRANSITIONS in
 * backend/app/routes/personnel.py.
 *
 * Before this the roster was read-only outside the scripted scenario: people
 * arrived in the field and nothing could ever mark them returned or back at
 * base — which also meant an incident could never be resolved, because only
 * `at_station` and `returned` count as verified safe.
 */
const STATUS_ACTIONS: Record<string, Array<{ to: string; label: string }>> = {
  at_station: [],
  in_transit: [
    { to: 'returned', label: 'Mark returned' },
    { to: 'at_station', label: 'Back at base' },
  ],
  field: [{ to: 'returned', label: 'Mark returned' }],
  returned: [{ to: 'at_station', label: 'Back at base' }],
  deviated: [
    { to: 'in_transit', label: 'Back on route' },
    { to: 'returned', label: 'Mark returned' },
  ],
  sos: [
    { to: 'returned', label: 'Recovered — returned' },
    { to: 'in_transit', label: 'Recovered — in transit' },
  ],
};

function parseMovementRoutes(plans: MovementPlan[]) {
  return plans
    .map((plan) => {
      let points: { lat: number; lng: number }[] = [];
      try {
        points = typeof plan.planned_route === 'string'
          ? JSON.parse(plan.planned_route)
          : (plan.planned_route ?? []);
      } catch { points = []; }
      return {
        path: points.map((p) => [p.lat, p.lng] as [number, number]),
        // A deviated plan is drawn in the alert colour, not as a nominal route.
        type: (plan.status === 'deviated' ? 'actual' : 'planned') as 'planned' | 'actual',
      };
    })
    .filter((r) => r.path.length > 1);
}

const getInitials = (name: string) =>
  name.split(' ').map((n) => n[0] || '').join('').slice(0, 2).toUpperCase();

export default function PersonnelPage() {
  const { lastMessage } = useWebSocket();
  const { addToast } = useToast();
  const [personnel, setPersonnel] = useState<Personnel[]>([]);
  const [routes, setRoutes] = useState<ReturnType<typeof parseMovementRoutes>>([]);
  const [loading, setLoading] = useState(true);
  const [simulating, setSimulating] = useState<Record<string, boolean>>({});
  const [planningFor, setPlanningFor] = useState<Personnel | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const { station, stationId, ready } = useStation();

  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  /** Guards against a slow tick overlapping the next one. */
  const inFlight = useRef<Record<string, boolean>>({});

  const stopSim = useCallback((id: string) => {
    if (timers.current[id]) { clearTimeout(timers.current[id]); delete timers.current[id]; }
    delete inFlight.current[id];
    setSimulating((prev) => ({ ...prev, [id]: false }));
  }, []);

  const loadAll = useCallback(async () => {
    const [p, m] = await Promise.allSettled([
      api.listPersonnel(stationId),
      api.listMovementPlans(stationId),
    ]);
    if (p.status === 'fulfilled') setPersonnel(Array.isArray(p.value) ? p.value : []);
    else addToast('Could not reach the station records — check the connection indicator above',
      'alert');
    if (m.status === 'fulfilled') {
      setRoutes(parseMovementRoutes(Array.isArray(m.value) ? m.value : []));
    }
    setLoading(false);
  }, [addToast, stationId]);

  useEffect(() => {
    if (!ready) return;
    setLoading(true);
    void loadAll();
  }, [loadAll, ready]);

  // Every in-flight GPS playback must stop when the page unmounts, or the
  // self-scheduling tick keeps firing against a dead component.
  useEffect(() => {
    const running = timers.current;
    return () => { Object.values(running).forEach(clearTimeout); };
  }, []);

  useEffect(() => {
    if (!lastMessage) return;
    if (lastMessage.type === 'gps_update' && lastMessage.data) {
      const d = lastMessage.data;
      setPersonnel((prev) => prev.map((p) => (p.id === d.personnel_id
        ? { ...p, current_lat: d.lat, current_lng: d.lng, last_update_at: d.last_update_at,
            status: d.alert ? 'deviated' : 'in_transit' }
        : p)));
    } else if (lastMessage.type === 'alert') {
      addToast(lastMessage.data?.message ?? 'Alert received', 'alert');
      void loadAll();
    } else if (lastMessage.type === 'personnel_update'
      || lastMessage.type === 'station_reset') {
      void loadAll();
    }
  }, [lastMessage, addToast, loadAll]);

  /**
   * Record where someone actually is. The endpoint existed and nothing called
   * it, so an operative who walked back into the hut stayed "field" for ever
   * and kept the station's accountability count short.
   */
  const handleStatus = async (person: Personnel, to: string) => {
    setBusyId(person.id);
    try {
      await api.updatePersonnelStatus(person.id, to);
      addToast(`${person.name} → ${to.replace('_', ' ')}`, 'success');
      void loadAll();
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Could not update status', 'alert');
    } finally { setBusyId(null); }
  };

  /**
   * Self-scheduling tick rather than setInterval: a slow or stalled request
   * cannot pile up behind the previous one.
   */
  const startSim = useCallback((id: string) => {
    if (simulating[id]) return;
    setSimulating((prev) => ({ ...prev, [id]: true }));

    const tick = async () => {
      if (inFlight.current[id]) return;
      inFlight.current[id] = true;
      try {
        const res = await api.simulateMove(id);
        if (res?.status === 'arrived') {
          stopSim(id);
          addToast('Arrived at destination', 'success');
          void loadAll();
          return;
        }
        timers.current[id] = setTimeout(tick, GPS_TICK_MS);
      } catch (e) {
        stopSim(id);
        // 409 = no movement plan. Say exactly that instead of failing silently.
        addToast(e instanceof ApiError ? e.message : 'GPS tracking stopped', 'alert');
        void loadAll();
      } finally {
        inFlight.current[id] = false;
      }
    };
    void tick();
  }, [simulating, stopSim, addToast, loadAll]);

  const handleReset = async (id: string) => {
    stopSim(id);
    try {
      await api.resetSimulation(id);
      addToast('Track rewound to plan origin', 'info');
      void loadAll();
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Reset failed', 'alert');
    }
  };

  const handleSOS = async (person: Personnel) => {
    // SOS declares a critical incident for the whole station — confirm it.
    if (!window.confirm(
      `Trigger SOS for ${person.name}?\n\n`
      + 'This declares a critical incident at their last known position and '
      + 'starts an accountability check across the station.')) return;
    try {
      const res = await api.triggerSOS(person.id);
      addToast(`SOS raised for ${person.name} — ${res.unaccounted} unaccounted in zone`, 'alert');
      void loadAll();
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Failed to trigger SOS', 'alert');
    }
  };

  const statusStyle = (status: string) => {
    if (['at_station', 'returned'].includes(status)) return 'bg-emerald-50 border-emerald-200 text-emerald-800';
    if (status === 'field') return 'bg-sky-50 border-sky-200 text-sky-800';
    if (status === 'deviated') return 'bg-rose-50 border-rose-200 text-rose-800';
    if (status === 'in_transit') return 'bg-amber-50 border-amber-200 text-amber-800';
    return 'bg-arctic-50 border-arctic-200 text-arctic-700';
  };

  return (
    <div>
      <PageHeader
        title="Personnel & Safety"
        code="PRS-TRK-04"
        description="Where everyone is, an alert when someone strays off an authorised route,
                     and a head-count of who is back at base."
      >
        <button className="btn-secondary text-13" onClick={() => void loadAll()}>
          <RotateCw size={14} aria-hidden="true" /> Refresh
        </button>
      </PageHeader>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6" style={{ minHeight: 'calc(100vh - 220px)' }}>
        <div className="lg:col-span-1 space-y-4 overflow-y-auto pr-1"
             style={{ maxHeight: 'calc(100vh - 220px)' }}>
          <h2 className="section-heading sticky top-0 bg-ice-surface py-2 z-10">
            {station.label} Roster
            <span className="ml-1 font-normal normal-case tracking-normal text-frost-muted">
              ({loading ? '—' : personnel.length})
            </span>
          </h2>

          {loading ? (
            [1, 2, 3].map((i) => (
              <div key={i} className="subview-card rounded-2xl p-5 animate-pulse">
                <div className="flex gap-3 mb-3">
                  <div className="w-10 h-10 rounded-full bg-arctic-100" />
                  <div className="flex-1">
                    <div className="h-3 bg-arctic-100 rounded w-2/3 mb-2" />
                    <div className="h-2.5 bg-arctic-50 rounded w-1/2" />
                  </div>
                </div>
                <div className="h-12 bg-arctic-50 rounded-xl" />
              </div>
            ))
          ) : personnel.length === 0 ? (
            <div className="subview-card p-6 text-center text-13 text-frost-muted">
              No personnel posted to {station.label}.
            </div>
          ) : personnel.map((p) => {
            const hasPlan = p.has_movement_plan ?? false;
            const status = p.effective_status ?? p.status;
            return (
              <article key={p.id}
                       className={`subview-card rounded-2xl p-5 border-l-4 ${
                         status === 'deviated' || p.overdue ? 'border-l-rose-400' : 'border-l-arctic-400'}`}>
                <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-10 h-10 rounded-full bg-arctic-50 border border-arctic-200
                                    flex items-center justify-center font-bold text-arctic-700
                                    text-sm shrink-0 font-display">
                      {getInitials(p.name)}
                    </div>
                    <div className="min-w-0">
                      <h2 className="font-bold text-arctic-900 text-sm font-display truncate">{p.name}</h2>
                      <p className="text-2xs text-frost-muted truncate">{p.role}</p>
                    </div>
                  </div>
                  <span data-compact
                        className={`px-2.5 py-1 rounded-full border text-xs font-semibold
                                    font-mono shrink-0 ${statusStyle(status)}`}>
                    {status.replace('_', ' ')}
                  </span>
                </div>

                {(p.overdue || p.location_update_warning) && (
                  <p className="text-2xs text-amber-700 bg-amber-50 border border-amber-200
                                rounded-lg px-2.5 py-1.5 mb-3 flex items-center gap-1.5">
                    <AlertTriangle size={12} className="shrink-0" aria-hidden="true" />
                    {p.overdue_reason ?? p.location_update_warning}
                  </p>
                )}

                <div className="text-xs mb-3 bg-arctic-50/60 p-3 rounded-xl
                                border border-arctic-200">
                  <span className="overline block mb-1">Last Known Position</span>
                  <Coordinate lat={p.current_lat} lng={p.current_lng} decimals
                              className="text-arctic-900 font-bold" />
                </div>

                <p className="text-2xs text-frost-muted mb-3">
                  {hasPlan
                    ? `Plan: → ${p.destination_name} (${p.plan_status})`
                    : 'No movement plan authorised'}
                </p>

                <div className="flex flex-wrap gap-2">
                  {!hasPlan ? (
                    <button className="btn-primary text-xs flex-1 min-w-0"
                            onClick={() => setPlanningFor(p)}>
                      <Map size={14} aria-hidden="true" /> Authorise Movement
                    </button>
                  ) : !simulating[p.id] ? (
                    <button className="btn-primary text-xs flex-1 min-w-0"
                            onClick={() => startSim(p.id)}>
                      <Radio size={14} aria-hidden="true" /> Start GPS
                    </button>
                  ) : (
                    <button className="btn-secondary text-xs flex-1 min-w-0"
                            onClick={() => stopSim(p.id)}>
                      <Square size={14} aria-hidden="true" /> Stop GPS
                    </button>
                  )}
                  {hasPlan && (
                    <>
                      <button className="btn-secondary text-xs px-3" title="Rewind to plan origin"
                              aria-label="Rewind to plan origin"
                              onClick={() => void handleReset(p.id)}>
                        <RotateCw size={14} aria-hidden="true" />
                      </button>
                      <button className="btn-secondary text-xs px-3" title="Authorise a new plan"
                              aria-label="Authorise a new plan"
                              onClick={() => setPlanningFor(p)}>
                        <Plus size={14} aria-hidden="true" />
                      </button>
                    </>
                  )}
                  <button
                    className="w-full mt-1 bg-rose-600 hover:bg-rose-700 active:scale-[0.98]
                               text-white text-xs font-bold py-2 rounded-md transition-all
                               flex items-center justify-center gap-1.5"
                    onClick={() => void handleSOS(p)}
                  >
                    <Siren size={14} aria-hidden="true" /> Trigger SOS
                  </button>
                </div>

                {/* Where the person actually is. Only at_station and returned
                    count as verified safe during an incident, so this is what
                    lets an accountability check ever reach zero unaccounted. */}
                {(STATUS_ACTIONS[p.status] ?? []).length > 0 && (
                  <div className="mt-3 pt-3 border-t border-frost-border">
                    <span className="overline block mb-1.5">Record position</span>
                    <div className="flex flex-wrap gap-1.5">
                      {(STATUS_ACTIONS[p.status] ?? []).map((action) => (
                        <button
                          key={action.to}
                          type="button"
                          data-compact
                          disabled={busyId === p.id}
                          onClick={() => void handleStatus(p, action.to)}
                          className="btn-secondary !min-h-0 !px-2.5 !py-1 text-2xs"
                        >
                          <UserCheck size={11} aria-hidden="true" /> {action.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>

        <div className="lg:col-span-2 subview-card rounded-2xl p-2 overflow-hidden"
             style={{ minHeight: 480 }}>
          <MapView personnel={personnel} routes={routes} />
        </div>
      </div>

      {planningFor && (
        <MovementPlanDialog
          person={planningFor}
          stationId={stationId}
          onClose={() => setPlanningFor(null)}
          onCreated={() => void loadAll()}
        />
      )}
    </div>
  );
}
