'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { offlineQueue } from '@/lib/offlineQueue';
import { useToast } from '@/components/Toast';
import { EventTimeline } from '@/components/EventTimeline';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const plannedRoute = [
  { lat: -70.767, lng: 11.731 }, { lat: -70.775, lng: 11.75 },
  { lat: -70.783, lng: 11.77  }, { lat: -70.79,  lng: 11.8  },
  { lat: -70.8,   lng: 11.83  }, { lat: -70.81,  lng: 11.86 },
  { lat: -70.84,  lng: 11.93  }, { lat: -70.85,  lng: 11.95 },
];

export default function ScenarioPage() {
  const { addToast } = useToast();
  const [offline, setOffline] = useState(offlineQueue.isOffline);
  const [pendingCount, setPendingCount] = useState(offlineQueue.pendingCount);
  const [activeStep, setActiveStep] = useState(1);
  const [stepStatus, setStepStatus] = useState<Record<number, 'pending' | 'running' | 'done' | 'error'>>({});

  useEffect(() => {
    const unsub = offlineQueue.subscribe(() => {
      setOffline(offlineQueue.isOffline);
      setPendingCount(offlineQueue.pendingCount);
    });
    return unsub;
  }, []);

  const runStep = async (step: number, action: () => Promise<void>) => {
    if (stepStatus[step] === 'running') return;
    setStepStatus(prev => ({ ...prev, [step]: 'running' }));
    try {
      await action();
      setStepStatus(prev => ({ ...prev, [step]: 'done' }));
      setActiveStep(s => Math.max(s, step + 1));
    } catch (e: any) {
      console.error(`Step ${step} failed:`, e);
      setStepStatus(prev => ({ ...prev, [step]: 'error' }));
      addToast(`Step ${step} failed: ${e?.message || 'Unknown error'}`, 'alert');
    }
  };

  const getFirstShipment = async () => {
    const data = await api.listShipments();
    const list = Array.isArray(data) ? data : [];
    if (!list.length) throw new Error('No shipments found. Run Step 3 first.');
    return list[0];
  };

  const getResearchers = async () => {
    const data = await api.listPersonnel();
    const list = Array.isArray(data) ? data : [];
    let researchers = list.filter((p: any) => p.role === 'Researcher' || p.role === 'Scientist').slice(0, 2);
    if (researchers.length < 2) researchers = list.slice(0, 2); // fallback to any
    if (researchers.length < 2) throw new Error('Need at least 2 personnel records in database');
    return researchers;
  };

  const toggleConnectivity = async () => {
    if (offlineQueue.isOffline) {
      offlineQueue.setOffline(false);
      const flushed = await offlineQueue.flush();
      addToast(`Back online — ${flushed} queued change${flushed !== 1 ? 's' : ''} synced`, 'success');
    } else {
      offlineQueue.setOffline(true);
      addToast('System offline — mutating requests will queue locally', 'warning');
    }
  };

  const steps = [
    {
      num: 1,
      title: 'Create Expedition',
      desc: 'Parse a commander request through local AI or fallback rules and persist to database.',
      action: async () => {
        const raw = 'Create a 30-day high-priority expedition to Maitri with 12 researchers and 2 engineers.';
        const parsed = await api.parseNL(raw);
        await api.createExpedition({ ...parsed, raw_request: raw });
        addToast('Expedition created via natural language AI', 'success');
      },
    },
    {
      num: 2,
      title: 'Check Feasibility',
      desc: 'Show the guaranteed seeded fuel shortfall for over-provisioned expeditions.',
      action: async () => {
        const res = await api.checkFeasibility({ station: 'Maitri', personnel_required: 14, fuel_required_l: 8400 });
        const ok = res.items?.every((i: any) => i.ok) ?? false;
        addToast(`Feasibility: ${ok ? 'All resources available' : 'Resource shortfall detected'}`, ok ? 'success' : 'warning');
      },
    },
    {
      num: 3,
      title: 'Dispatch Resupply',
      desc: 'Create critical fuel and medical supply shipments with QR payloads.',
      action: async () => {
        await api.createShipment({ item_name: 'Diesel Fuel', category: 'fuel', weight_kg: 5000, destination_station: 'Maitri', priority: 'critical' });
        await api.createShipment({ item_name: 'Medical Supplies', category: 'medical', weight_kg: 200, destination_station: 'Maitri', priority: 'critical' });
        addToast('Fuel and medical resupply shipments dispatched', 'success');
      },
    },
    {
      num: 4,
      title: 'Scan Shipment',
      desc: 'Advance the latest shipment one status step by scanning its barcode.',
      action: async () => {
        const shipment = await getFirstShipment();
        await api.scanBarcode(shipment.barcode_id);
        addToast('Barcode scanned — shipment tracking updated', 'success');
      },
    },
    {
      num: 5,
      title: 'Simulate Blizzard',
      desc: 'Apply ΔT +30°C and push active shipments into elevated risk status.',
      action: async () => {
        const shipment = await getFirstShipment();
        await api.updateRisk(shipment.id, 30);
        addToast('Blizzard simulated — inventory will recalculate depletion rates', 'warning');
      },
    },
    {
      num: 6,
      title: 'View Inventory Impact',
      desc: 'Fetch live days-of-cover values after the blizzard temperature update.',
      action: async () => {
        const items = await api.listInventory({ station: 'Maitri' });
        const list = Array.isArray(items) ? items : [];
        const fuel = list.find((item: any) => item.category === 'fuel' || item.name?.toLowerCase().includes('fuel'));
        addToast(fuel ? `Fuel cover: ${fuel.days_of_cover?.toFixed(1)} days remaining` : `${list.length} inventory items recalculated`, 'info');
      },
    },
    {
      num: 7,
      title: 'Deploy Personnel',
      desc: 'Deploy two operatives with planned routes from Maitri to Camp Alpha.',
      action: async () => {
        const researchers = await getResearchers();
        for (const person of researchers) {
          await api.createMovementPlan({
            personnel_id: person.id,
            origin_lat: -70.767, origin_lng: 11.731,
            destination_lat: -70.85, destination_lng: 11.95,
            destination_name: 'Camp Alpha',
            planned_route: plannedRoute,
            departure_time: new Date().toISOString(),
            expected_arrival: new Date(Date.now() + 6 * 3600 * 1000).toISOString(),
          });
        }
        addToast(`${researchers.slice(0, 2).map((p: any) => p.name).join(' & ')} deployed to Camp Alpha`, 'success');
      },
    },
    {
      num: 8,
      title: 'GPS & Geofence',
      desc: 'Advance both operatives into the restricted zone to trigger alerts.',
      action: async () => {
        const researchers = await getResearchers();
        for (const person of researchers.slice(0, 2)) {
          await api.resetSimulation(person.id);
          for (let i = 0; i < 8; i++) {
            await api.simulateMove(person.id);
            await delay(400);
          }
        }
        addToast('GPS feeds reached restricted-zone boundary — alerts triggered', 'alert');
      },
    },
    {
      num: 9,
      title: 'Trigger Emergency',
      desc: 'Create a critical incident and populate accountability counts.',
      action: async () => {
        await api.createIncident({ type: 'medical', severity: 'critical', location_lat: -70.85, location_lng: 11.95, affected_radius_m: 5000 });
        addToast('Emergency declared — accountability check started across all stations', 'alert');
      },
    },
    {
      num: 10,
      title: 'Offline Queue Test',
      desc: 'Queue one status update offline, reconnect, and flush it.',
      action: async () => {
        const researchers = await getResearchers();
        if (!researchers.length) throw new Error('No personnel available');
        const person = researchers[0];
        offlineQueue.setOffline(true);
        addToast('System offline — next update will queue', 'warning');
        const nextStatus = person.status === 'at_station' ? 'in_transit' : 'returned';
        await api.updatePersonnelStatus(person.id, nextStatus);
        await delay(800);
        offlineQueue.setOffline(false);
        const flushed = await offlineQueue.flush();
        addToast(`Back online — ${flushed} queued change${flushed !== 1 ? 's' : ''} synced`, 'success');
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
      {/* Header */}
      <div className="flex flex-wrap justify-between items-center mb-6 gap-4">
        <div className="flex items-center gap-4">
          <Link href="/" className="text-arctic-800 hover:text-arctic-600 flex items-center gap-2 text-xs font-semibold transition-colors bg-white px-3.5 py-1.5 rounded-xl border border-arctic-200 shadow-xs">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M15 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Dashboard
          </Link>
          <div>
            <h1 className="text-xl font-bold text-arctic-900" style={{ fontFamily: 'Outfit, sans-serif' }}>Guided Scenario Walkthrough</h1>
            <p className="text-xs text-frost-muted mt-0.5">Run PRAHARI end-to-end for Team 36 OURS — {completedCount}/{steps.length} complete</p>
          </div>
        </div>
        <button
          onClick={toggleConnectivity}
          className={`px-4 py-2 rounded-xl text-xs font-bold border transition-colors ${
            offline ? 'bg-amber-50 text-amber-800 border-amber-200 hover:bg-amber-100' : 'bg-emerald-50 text-emerald-800 border-emerald-200 hover:bg-emerald-100'
          }`}
        >
          {offline ? `⚠️ OFFLINE — ${pendingCount} pending` : '✅ CONNECTED'}
        </button>
      </div>

      {/* Progress bar */}
      <div className="w-full bg-arctic-100 rounded-full h-2 mb-2 border border-arctic-200">
        <div
          className="h-2 rounded-full transition-all duration-700"
          style={{
            width: `${progress}%`,
            background: progress === 100 ? '#22c55e' : 'linear-gradient(to right, #0088CC, #38BDF8)',
          }}
        />
      </div>
      <div className="flex justify-between text-[10px] text-frost-muted mb-6 uppercase tracking-wider" style={{ fontFamily: 'Space Grotesk, sans-serif' }}>
        <span>Progress</span>
        <span className={progress === 100 ? 'text-emerald-600 font-bold' : ''}>{Math.round(progress)}% {progress === 100 ? '— Complete ✓' : ''}</span>
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
                  <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${
                    status === 'done' ? 'bg-emerald-100 text-emerald-700 border border-emerald-300' :
                    status === 'error' ? 'bg-rose-100 text-rose-700 border border-rose-300' :
                    isActive ? 'bg-arctic-100 text-arctic-700 border border-arctic-300' :
                    'bg-arctic-50 text-frost-muted border border-arctic-200'
                  }`}>{step.num}</span>
                  <h3 className="font-bold text-sm text-arctic-900" style={{ fontFamily: 'Outfit, sans-serif' }}>{step.title}</h3>
                </div>
                {status === 'done' && <span className="text-[10px] font-bold text-emerald-600 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full font-mono shrink-0">DONE</span>}
                {status === 'error' && <span className="text-[10px] font-bold text-rose-600 bg-rose-50 border border-rose-200 px-2 py-0.5 rounded-full font-mono shrink-0">ERROR</span>}
                {status === 'running' && <span className="text-[10px] font-bold text-amber-600 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full font-mono shrink-0 animate-pulse">RUNNING</span>}
              </div>
              <p className="text-xs text-frost-muted mb-4 leading-relaxed ml-8">{step.desc}</p>
              <button
                className={`w-full py-2 rounded-xl text-xs font-semibold transition-colors ${getButtonStyle(step.num)}`}
                onClick={() => { if (canRun && status !== 'running') runStep(step.num, step.action); }}
                disabled={!canRun || status === 'running'}
              >
                {status === 'done' ? '↩ Re-run' : status === 'running' ? 'Running...' : status === 'error' ? '↺ Retry' : 'Execute'}
              </button>
            </div>
          );
        })}
      </div>

      {/* Timeline */}
      <div style={{ height: 300 }}>
        <EventTimeline />
      </div>
    </div>
  );
}
