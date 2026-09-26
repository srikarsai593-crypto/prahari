'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, RotateCcw } from 'lucide-react';
import { api, isQueued } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';
import { offlineQueue } from '@/lib/offlineQueue';
import { useToast } from '@/components/Toast';
import { useStation } from '@/components/StationProvider';
import { EventTimeline } from '@/components/EventTimeline';
import { getStation } from '@/lib/stations';
import type { Geofence, StationCounts } from '@/lib/types';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fraction of the way from the station toward the destination. */
function interpolate(
  from: { lat: number; lng: number }, to: { lat: number; lng: number }, segments = 5,
) {
  return Array.from({ length: segments + 1 }, (_, i) => ({
    lat: +(from.lat + ((to.lat - from.lat) * i) / segments).toFixed(6),
    lng: +(from.lng + ((to.lng - from.lng) * i) / segments).toFixed(6),
  }));
}

export default function ScenarioPage() {
  const { addToast } = useToast();
  // The walkthrough runs against the console's active station. It used to be
  // hard-wired to Maitri while the page header badge showed whatever station
  // was selected, so every step reported on a base the operator was not
  // looking at.
  const { station, stationId, ready } = useStation();
  const [offline, setOffline] = useState(offlineQueue.isOffline);
  const [pendingCount, setPendingCount] = useState(offlineQueue.pendingCount);
  const [activeStep, setActiveStep] = useState(1);
  const [stepStatus, setStepStatus] =
    useState<Record<number, 'pending' | 'running' | 'done' | 'error'>>({});
  const [counts, setCounts] = useState<StationCounts | null>(null);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    const unsub = offlineQueue.subscribe(() => {
      setOffline(offlineQueue.isOffline);
      setPendingCount(offlineQueue.pendingCount);
    });
    return unsub;
  }, []);

  // Switching station invalidates the run: the steps now target somewhere else.
  useEffect(() => { setStepStatus({}); setActiveStep(1); }, [stationId]);

  const loadCounts = useCallback(() => {
    api.stationCounts().then(setCounts).catch(() => setCounts(null));
  }, []);
  useEffect(() => { if (ready) loadCounts(); }, [loadCounts, ready]);

  /**
   * Reruns of this walkthrough used to pile up expeditions, consignments and
   * open incidents with no way to clear them — after a few passes the dashboard
   * reported records nobody had created that session. This puts the station
   * back to its seeded baseline.
   */
  const handleReset = async (scope: 'operational' | 'all') => {
    if (!window.confirm(
      'Reset the station to its seeded baseline?\n\n'
      + 'This permanently deletes every expedition, consignment, incident and movement plan '
      + 'across all three stations, and restores seeded crew positions and stock levels'
      + (scope === 'all' ? ', including the whole event log' : '')
      + '. It cannot be undone.')) return;
    setResetting(true);
    try {
      const res = await api.resetStation(scope);
      addToast(`Station reset — cleared ${res.cleared.expeditions} expedition(s), `
        + `${res.cleared.shipments} consignment(s) and ${res.cleared.incidents} incident(s)`,
        'success');
      setStepStatus({});
      setActiveStep(1);
      loadCounts();
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Reset failed', 'alert');
    } finally { setResetting(false); }
  };

  const runStep = async (step: number, action: () => Promise<void>) => {
    if (stepStatus[step] === 'running') return;
    setStepStatus(prev => ({ ...prev, [step]: 'running' }));
    try {
      await action();
      setStepStatus((prev) => ({ ...prev, [step]: 'done' }));
      setActiveStep((s) => Math.max(s, step + 1));
      // Each step writes records, so the "what a reset would clear" line has
      // to follow along rather than showing the count from page load.
      loadCounts();
    } catch (e) {
      console.error(`Step ${step} failed:`, e);
      setStepStatus((prev) => ({ ...prev, [step]: 'error' }));
      addToast(`Step ${step} failed: ${e instanceof Error ? e.message : 'Unknown error'}`,
        'alert');
    }
  };

  const getFirstShipment = async () => {
    const data = await api.listShipments({ station: stationId });
    const list = Array.isArray(data) ? data : [];
    if (!list.length) {
      throw new Error(`No consignments routed to ${stationId}. Run Step 3 first.`);
    }
    return list[0];
  };

  const getResearchers = async () => {
    const data = await api.listPersonnel(stationId);
    const list = Array.isArray(data) ? data : [];
    let researchers = list.filter((p) => p.role === 'Researcher' || p.role === 'Scientist')
      .slice(0, 2);
    if (researchers.length < 2) researchers = list.slice(0, 2);  // fall back to anyone on station
    if (researchers.length < 2) {
      throw new Error(`Need at least 2 people on the ${stationId} roster`);
    }
    return researchers;
  };

  /**
   * The destination and the route are derived from the active station's own
   * geofences, so the traverse is real wherever the walkthrough is run.
   *
   * At Maitri this resolves to Camp Alpha and the leg clips the seeded Crevasse
   * Zone — that is the point of the demo: the commander authorises a route
   * across a known crevasse field, Prahari flags it *before* departure, and
   * raises a live alert again on entry. The alert comes from the geofence
   * engine walking the route, not from a script.
   */
  const getDestination = async () => {
    const all = await api.listGeofences();
    const local = (Array.isArray(all) ? all : []).filter((g: Geofence) =>
      Math.abs(g.center_lat - station.lat) < 2 && Math.abs(g.center_lng - station.lng) < 6);
    const camp = local.find((g) => g.type === 'field_camp')
      ?? local.find((g) => g.type !== 'restricted' && g.type !== 'station');
    if (!camp) throw new Error(`No field camp registered near ${station.label} to traverse to.`);
    return camp;
  };

  const toggleConnectivity = async () => {
    if (offlineQueue.isOffline) {
      // setOffline(false) drains the queue and resolves with what it replayed.
      const { flushed, dropped } = await offlineQueue.setOffline(false);
      addToast(`Back online — ${flushed} queued change${flushed !== 1 ? 's' : ''} synced`
        + (dropped ? `, ${dropped} rejected` : ''), dropped ? 'warning' : 'success');
    } else {
      void offlineQueue.setOffline(true);
      addToast('Link down — changes will be saved here and sent when it returns', 'warning');
    }
  };

  const steps = [
    {
      num: 1,
      title: 'Create Expedition',
      desc: 'Write the request in plain words and let Prahari fill in the traverse.',
      action: async () => {
        const raw = `Create a 30-day high-priority expedition to ${stationId} with `
          + '12 researchers and 2 engineers.';
        const parsed = await api.parseNL(raw);
        await api.createExpedition({
          name: parsed.name,
          station: stationId,
          start_date: parsed.start_date ?? undefined,
          end_date: parsed.end_date ?? undefined,
          personnel_required: parsed.personnel_required,
          fuel_required_l: parsed.fuel_required_l,
          raw_request: raw,
        });
        addToast(`Expedition drafted at ${station.label} from plain language`, 'success');
      },
    },
    {
      num: 2,
      title: 'Check Feasibility',
      desc: 'Check whether the station could support a 14-person traverse right now.',
      action: async () => {
        const res = await api.checkFeasibility({
          station: stationId, personnel_required: 14, fuel_required_l: 8400,
        });
        const short = res.items.filter((i) => !i.ok).map((i) => i.label);
        addToast(short.length === 0
          ? `${station.label} can resource this — readiness ${res.readiness_score}%`
          : `${short.join(', ')} short at ${station.label} — readiness ${res.readiness_score}%`,
          short.length === 0 ? 'success' : 'warning');
      },
    },
    {
      num: 3,
      title: 'Dispatch Resupply',
      desc: 'Send in fuel and medical supplies, each labelled with a scannable code.',
      action: async () => {
        // Booked against this station's own stock rows so the final scan
        // actually tops inventory up, in each row's own units.
        const stock = await api.listInventory({ station: stationId });
        const fuelRow = stock.find((i) => i.name.toLowerCase().includes('fuel'));
        const medRow = stock.find((i) => i.name.toLowerCase().includes('medical'));
        await api.createShipment({
          item_name: fuelRow?.name ?? 'Diesel Fuel', category: 'fuel', weight_kg: 5000,
          quantity: 4000, unit: fuelRow?.unit ?? undefined,
          inventory_item_id: fuelRow?.id, destination_station: stationId, priority: 'critical',
        });
        await api.createShipment({
          item_name: medRow?.name ?? 'Medical Supplies', category: 'medical', weight_kg: 200,
          quantity: 60, unit: medRow?.unit ?? undefined,
          inventory_item_id: medRow?.id, destination_station: stationId, priority: 'critical',
        });
        addToast(`Fuel and medical resupply dispatched to ${station.label}`, 'success');
      },
    },
    {
      num: 4,
      title: 'Scan Shipment',
      desc: 'Scan the newest crate to move it one step closer to the store.',
      action: async () => {
        const shipment = await getFirstShipment();
        await api.scanBarcode(shipment.barcode_id);
        addToast('Barcode scanned — shipment tracking updated', 'success');
      },
    },
    {
      num: 5,
      title: 'Simulate Blizzard',
      desc: 'Record a severe cold snap. Everything still on its way here is re-assessed, '
        + 'not just one crate.',
      action: async () => {
        const res = await api.applyStationWeather(stationId, 30);
        addToast(`ΔT +${res.delta_t}°C at ${station.label} — ${res.affected} consignment(s) `
          + `re-scored, ${res.delayed} delayed. Inventory depletion re-runs against the same `
          + 'figure.', 'warning');
      },
    },
    {
      num: 6,
      title: 'View Inventory Impact',
      desc: 'See how many days of supplies are left once the cold is taken into account.',
      action: async () => {
        const items = await api.listInventory({ station: stationId });
        const list = Array.isArray(items) ? items : [];
        const fuel = list.find((item) => item.name?.toLowerCase().includes('fuel'));
        addToast(fuel ? `Fuel cover: ${fuel.days_of_cover?.toFixed(1)} days remaining` : `${list.length} inventory items recalculated`, 'info');
      },
    },
    {
      num: 7,
      title: 'Deploy Personnel',
      desc: 'Send two people out to the nearest field camp. At Maitri the route crosses a '
        + 'known crevasse field, so the check before departure should object.',
      action: async () => {
        const researchers = await getResearchers();
        const camp = await getDestination();
        const origin = { lat: station.lat, lng: station.lng };
        const destination = { lat: camp.center_lat, lng: camp.center_lng };
        const results = [];
        for (const person of researchers) {
          results.push(await api.createMovementPlan({
            personnel_id: person.id,
            origin_lat: origin.lat, origin_lng: origin.lng,
            destination_lat: destination.lat, destination_lng: destination.lng,
            destination_name: camp.name,
            planned_route: interpolate(origin, destination),
            departure_time: new Date().toISOString(),
            expected_arrival: new Date(Date.now() + 6 * 3600 * 1000).toISOString(),
          }));
        }
        const warned = results.flatMap((r) => r?.route_warnings ?? []);
        const names = researchers.slice(0, 2).map((p) => p.name).join(' & ');
        addToast(warned.length
          ? `${names} authorised — pre-flight flagged ${[...new Set(warned)].join(', ')}`
          : `${names} deployed to ${camp.name}`, warned.length ? 'warning' : 'success');
      },
    },
    {
      num: 8,
      title: 'GPS & Geofence',
      desc: 'Follow both of them along the route until they enter the restricted area and '
        + 'the alarm goes off.',
      action: async () => {
        const researchers = await getResearchers();
        let violations = 0;
        for (const person of researchers.slice(0, 2)) {
          await api.resetSimulation(person.id);
          // Walk the whole track; stop early once the person has arrived.
          for (let i = 0; i < 12; i++) {
            const res = await api.simulateMove(person.id);
            if (res?.alert?.type === 'geofence_violation') violations++;
            if (res?.status === 'arrived') break;
            await delay(350);
          }
        }
        addToast(violations > 0
          ? `${violations} geofence violation${violations !== 1 ? 's' : ''} detected — both `
            + 'operatives are now flagged deviated on the roster'
          : 'Both operatives reached the camp without entering a restricted zone',
          violations > 0 ? 'alert' : 'success');
      },
    },
    {
      num: 9,
      title: 'Trigger Emergency',
      desc: 'Declare an emergency and count who is inside the affected area.',
      action: async () => {
        const camp = await getDestination();
        const res = await api.createIncident({
          type: 'medical', severity: 'critical',
          location_lat: camp.center_lat, location_lng: camp.center_lng,
          affected_radius_m: 5000,
        });
        addToast(`Emergency declared at ${camp.name} — ${res.unaccounted_count ?? 0} of `
          + `${res.expected_count ?? 0} in the zone unaccounted for. Resolve it on the `
          + 'Emergency page once everyone is confirmed safe.', 'alert');
      },
    },
    {
      num: 10,
      title: 'Offline Queue Test',
      desc: 'Make a change with the link down, then watch it send itself when it returns.',
      action: async () => {
        const researchers = await getResearchers();
        if (!researchers.length) throw new Error('No personnel available');
        const person = researchers[0];
        void offlineQueue.setOffline(true);
        addToast('Link down — the next change will wait here', 'warning');
        const nextStatus = person.status === 'at_station' ? 'in_transit' : 'returned';
        const queued = await api.updatePersonnelStatus(person.id, nextStatus);
        if (!isQueued(queued)) throw new Error('The change went straight through instead of waiting');
        addToast(`Held here: ${person.name} → ${nextStatus.replace('_', ' ')}`, 'info');
        await delay(800);
        const { flushed, dropped } = await offlineQueue.setOffline(false);
        addToast(`Back online — ${flushed} queued change${flushed !== 1 ? 's' : ''} synced`
          + (dropped ? `, ${dropped} rejected` : ''), dropped ? 'warning' : 'success');
      },
    },
  ];

  const completedCount = Object.values(stepStatus).filter(s => s === 'done').length;
  const progress = (completedCount / steps.length) * 100;

  const getStepStyle = (stepNum: number) => {
    const status = stepStatus[stepNum] || 'pending';
    const isActive = activeStep === stepNum;
    if (status === 'done') return 'border-emerald-200 bg-emerald-50/30';
    if (status === 'error') return 'border-rose-200 bg-rose-50/30';
    if (status === 'running') return 'border-amber-300 bg-amber-50/30';
    if (isActive) return 'border-arctic-300 ring-2 ring-arctic-200 ring-offset-1';
    return 'border-arctic-100 opacity-60';
  };

  const getButtonStyle = (stepNum: number) => {
    const status = stepStatus[stepNum] || 'pending';
    const isActive = activeStep === stepNum;
    if (status === 'done') return 'bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100';
    if (status === 'error') return 'bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100';
    if (status === 'running') return 'bg-amber-50 text-amber-700 border border-amber-200 cursor-not-allowed';
    if (isActive) return 'bg-arctic-600 text-white hover:bg-arctic-700';
    return 'bg-arctic-50 text-frost-muted border border-arctic-200 cursor-not-allowed';
  };

  return (
    <div className="max-w-5xl mx-auto pb-10">
      <PageHeader
        title="Live Scenario"
        code="SIM-WLK-06"
        description={`A guided ten-step run through everything the station does, carried out `
          + `for real at ${station.label} — every step changes the actual records.`}
      >
        <button
          onClick={() => void handleReset('operational')}
          disabled={resetting}
          title="Delete every expedition, consignment, incident and movement plan, and restore
                 seeded crew and stock"
          className="btn-secondary text-13"
        >
          <RotateCcw size={14} aria-hidden="true" />
          {resetting ? 'Resetting…' : 'Reset station data'}
        </button>
        <button
          onClick={toggleConnectivity}
          className={`px-4 py-2 rounded-md text-13 font-bold border transition-colors
                      flex items-center gap-1.5 font-mono tracking-caps ${
            offline
              ? 'bg-alert-tint text-alert border-alert-edge'
              : 'bg-nominal-tint text-nominal border-nominal-edge'}`}
        >
          {offline
            ? <><AlertTriangle size={14} aria-hidden="true" /> OFFLINE — {pendingCount} PENDING</>
            : <><CheckCircle2 size={14} aria-hidden="true" /> CONNECTED</>}
        </button>
      </PageHeader>

      {counts && (
        <p className="text-xs text-frost-muted mb-3">
          On record across all stations: {counts.expeditions} expedition(s),{' '}
          {counts.shipments} consignment(s), {counts.incidents} incident(s)
          {counts.open_incidents > 0 && (
            <span className="text-emergency font-semibold">
              {' '}({counts.open_incidents} still open)
            </span>
          )}. Reruns accumulate — reset above to return to the seeded baseline.
        </p>
      )}

      {/* Progress bar */}
      <div className="w-full bg-frost-subtle rounded-full h-2 mb-2 border border-frost-border
                      overflow-hidden">
        <div
          className="h-full transition-all duration-700"
          style={{
            width: `${progress}%`,
            background: progress === 100 ? '#10b981' : '#0284c7',
          }}
        />
      </div>
      <div className="flex justify-between font-mono text-xs text-frost-muted mb-6
                      uppercase tracking-caps font-bold">
        <span>Walkthrough Progress · {completedCount}/{steps.length} steps</span>
        <span className={progress === 100 ? 'text-nominal' : 'text-arctic-700'}>
          {Math.round(progress)}%{progress === 100 ? ' — Complete' : ''}
        </span>
      </div>

      {/* Steps grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
        {steps.map((step) => {
          const status = stepStatus[step.num] || 'pending';
          const isActive = activeStep === step.num;
          const canRun = isActive || status === 'done' || status === 'error';

          return (
            <div key={step.num} className={`subview-card rounded-2xl p-5 transition-all duration-300 ${getStepStyle(step.num)}`}>
              <div className="flex justify-between items-start mb-2">
                <div className="flex items-center gap-2">
                  <span className={`w-6 h-6 rounded-full flex items-center justify-center text-2xs font-bold shrink-0 ${
                    status === 'done' ? 'bg-emerald-100 text-emerald-700 border border-emerald-300' :
                    status === 'error' ? 'bg-rose-100 text-rose-700 border border-rose-300' :
                    isActive ? 'bg-arctic-100 text-arctic-700 border border-arctic-300' :
                    'bg-arctic-50 text-frost-muted border border-arctic-200'
                  }`}>{step.num}</span>
                  <h3 className="font-bold text-sm text-arctic-900">{step.title}</h3>
                </div>
                {status === 'done' && <span className="text-xs font-bold text-emerald-600 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full font-mono shrink-0">DONE</span>}
                {status === 'error' && <span className="text-xs font-bold text-rose-600 bg-rose-50 border border-rose-200 px-2 py-0.5 rounded-full font-mono shrink-0">ERROR</span>}
                {status === 'running' && <span className="text-xs font-bold text-amber-600 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full font-mono shrink-0 animate-pulse">RUNNING</span>}
              </div>
              <p className="text-xs text-frost-muted mb-4 leading-relaxed ml-8">{step.desc}</p>
              <button
                className={`w-full py-2 rounded-xl text-xs font-semibold transition-colors ${getButtonStyle(step.num)}`}
                onClick={() => { if (canRun && status !== 'running') runStep(step.num, step.action); }}
                disabled={!canRun || status === 'running'}
              >
                {status === 'done' ? 'Re-run' : status === 'running' ? 'Running...' : status === 'error' ? 'Retry' : 'Execute'}
              </button>
            </div>
          );
        })}
      </div>

      {/* Timeline */}
      <div className="h-[340px]">
        <EventTimeline />
      </div>
    </div>
  );
}
