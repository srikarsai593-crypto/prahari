'use client';
import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { offlineQueue } from '@/lib/offlineQueue';
import { useToast } from '@/components/Toast';
import { EventTimeline } from '@/components/EventTimeline';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const plannedRoute = [
  { lat: -70.767, lng: 11.731 },
  { lat: -70.775, lng: 11.75 },
  { lat: -70.783, lng: 11.77 },
  { lat: -70.79, lng: 11.8 },
  { lat: -70.8, lng: 11.83 },
  { lat: -70.81, lng: 11.86 },
  { lat: -70.84, lng: 11.93 },
  { lat: -70.85, lng: 11.95 },
];

const movementPlanPayload = (personnelId: string) => ({
  personnel_id: personnelId,
  origin_lat: -70.767,
  origin_lng: 11.731,
  destination_lat: -70.85,
  destination_lng: 11.95,
  destination_name: 'Camp Alpha',
  planned_route: plannedRoute,
  departure_time: new Date().toISOString(),
  expected_arrival: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
});

export default function ScenarioPage() {
  const { addToast } = useToast();
  const [offline, setOffline] = useState(offlineQueue.isOffline);
  const [pendingCount, setPendingCount] = useState(offlineQueue.pendingCount);
  const [activeStep, setActiveStep] = useState(1);
  const [stepStatus, setStepStatus] = useState<Record<number, 'pending' | 'running' | 'done'>>({});

  useEffect(() => {
    const unsub = offlineQueue.subscribe(() => {
      setOffline(offlineQueue.isOffline);
      setPendingCount(offlineQueue.pendingCount);
    });
    return unsub;
  }, []);

  const runStep = async (step: number, action: () => Promise<void>) => {
    setStepStatus(prev => ({ ...prev, [step]: 'running' }));
    try {
      await action();
      setStepStatus(prev => ({ ...prev, [step]: 'done' }));
      setActiveStep(Math.min(step + 1, steps.length));
    } catch (e) {
      setStepStatus(prev => ({ ...prev, [step]: 'pending' }));
      addToast(`Step ${step} failed`, 'alert');
    }
  };

  const getFirstShipment = async () => {
    const shipments = await api.listShipments();
    return Array.isArray(shipments) ? shipments[0] : null;
  };

  const getResearchers = async () => {
    const personnel = await api.listPersonnel();
    return Array.isArray(personnel)
      ? personnel.filter((p: any) => p.role === 'Researcher').slice(0, 2)
      : [];
  };

  const toggleConnectivity = async () => {
    if (offlineQueue.isOffline) {
      offlineQueue.setOffline(false);
      const flushed = await offlineQueue.flush();
      addToast(`System online; ${flushed} queued change synced`, 'success');
    } else {
      offlineQueue.setOffline(true);
      addToast('System offline; mutating requests will queue', 'warning');
    }
  };

  const steps = [
    {
      title: '1. Create Expedition',
      desc: 'Parse a commander request through local AI or fallback rules.',
      action: async () => {
        const raw = 'Create a 30-day high-priority expedition to Maitri with 12 researchers and 2 engineers.';
        const parsed = await api.parseNL(raw);
        await api.createExpedition({ ...parsed, raw_request: raw });
        addToast('Expedition created via natural language', 'success');
      },
    },
    {
      title: '2. Check Feasibility',
      desc: 'Show the guaranteed seeded fuel shortfall.',
      action: async () => {
        const res = await api.checkFeasibility({ station: 'Maitri', personnel_required: 14, fuel_required_l: 8400 });
        const ok = res.items?.every((item: any) => item.ok);
        addToast(`Feasibility: ${ok ? 'OK' : 'under-resourced'}`, ok ? 'success' : 'warning');
      },
    },
    {
      title: '3. Dispatch Resupply',
      desc: 'Create critical fuel and medical supplies shipments with QR payloads.',
      action: async () => {
        await api.createShipment({ item_name: 'Diesel Fuel', category: 'fuel', weight_kg: 5000, destination_station: 'Maitri', priority: 'critical' });
        await api.createShipment({ item_name: 'Medical Supplies', category: 'medical', weight_kg: 200, destination_station: 'Maitri', priority: 'critical' });
        addToast('Fuel and medical resupply shipments dispatched', 'success');
      },
    },
    {
      title: '4. Scan Shipment',
      desc: 'Advance the latest shipment one status step.',
      action: async () => {
        const shipment = await getFirstShipment();
        if (!shipment) throw new Error('No shipment available');
        await api.scanBarcode(shipment.barcode_id);
        addToast('Barcode scanned, tracking updated', 'success');
      },
    },
    {
      title: '5. Simulate Blizzard',
      desc: 'Apply delta T and push shipment into delayed status.',
      action: async () => {
        const shipment = await getFirstShipment();
        if (!shipment) throw new Error('No shipment available');
        await api.updateRisk(shipment.id, 30);
        addToast('Blizzard simulated; inventory will recalculate', 'warning');
      },
    },
    {
      title: '6. View Inventory Impact',
      desc: 'Fetch live days-of-cover values after the blizzard update.',
      action: async () => {
        const items = await api.listInventory({ station: 'Maitri' });
        const fuel = Array.isArray(items) ? items.find((item: any) => item.name?.toLowerCase().includes('fuel')) : null;
        addToast(fuel ? `Fuel cover now ${fuel.days_of_cover} days` : 'Inventory impact calculated', 'info');
      },
    },
    {
      title: '7. Deploy Personnel',
      desc: 'Deploy two researchers with routes from Maitri to Camp Alpha.',
      action: async () => {
        const researchers = await getResearchers();
        if (researchers.length < 2) throw new Error('Need at least two researchers');
        for (const person of researchers) {
          await api.createMovementPlan(movementPlanPayload(person.id));
        }
        addToast(`${researchers.map((p: any) => p.name).join(' & ')} deployed to Camp Alpha`, 'success');
      },
    },
    {
      title: '8. GPS and Geofence',
      desc: 'Advance both researchers into the restricted zone.',
      action: async () => {
        const researchers = await getResearchers();
        if (researchers.length < 2) throw new Error('Need at least two researchers');
        for (const person of researchers) {
          await api.resetSimulation(person.id);
          for (let i = 0; i < 8; i += 1) {
            await api.simulateMove(person.id);
            await delay(500);
          }
        }
        addToast('Both GPS feeds reached restricted-zone segment', 'alert');
      },
    },
    {
      title: '9. Trigger Emergency',
      desc: 'Create an incident and populate accountability counts.',
      action: async () => {
        await api.createIncident({ type: 'medical', severity: 'critical', location_lat: -70.85, location_lng: 11.95, affected_radius_m: 5000 });
        addToast('Emergency declared; accountability check started', 'alert');
      },
    },
    {
      title: '10. Disconnect Queue',
      desc: 'Queue one status update offline, reconnect, and flush it.',
      action: async () => {
        const researchers = await getResearchers();
        const person = researchers[0];
        if (!person) throw new Error('No personnel available');
        offlineQueue.setOffline(true);
        addToast('System offline; next update will queue', 'warning');
        await api.updatePersonnelStatus(person.id, 'returned');
        await delay(800);
        offlineQueue.setOffline(false);
        const flushed = await offlineQueue.flush();
        addToast(`System online; ${flushed} queued change synced`, 'success');
      },
    },
  ];

  return (
    <div className="max-w-5xl mx-auto pb-10">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-bold text-white mb-2">Guided Scenario Walkthrough</h1>
          <p className="text-polar-300">Run Prahari end to end for Team 36 OURS.</p>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-polar-300">Connectivity:</span>
          <button
            onClick={toggleConnectivity}
            className={`px-4 py-2 rounded-lg font-bold border-2 transition-colors ${offline ? 'bg-danger/20 text-danger border-danger' : 'bg-safe/20 text-safe border-safe'}`}
          >
            {offline ? `OFFLINE - ${pendingCount} pending` : 'ONLINE'}
          </button>
        </div>
      </div>

      <div className="w-full bg-polar-900 rounded-full h-2 mb-8">
        <div className="bg-polar-400 h-2 rounded-full transition-all duration-500" style={{ width: `${((activeStep - 1) / steps.length) * 100}%` }}></div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
        {steps.map((step, i) => {
          const stepNumber = i + 1;
          const status = stepStatus[stepNumber] || 'pending';
          const isActive = activeStep === stepNumber;

          return (
            <div key={step.title} className={`glass-card p-4 transition-all duration-300 ${isActive ? 'ring-2 ring-polar-400 scale-[1.02]' : 'opacity-80'}`}>
              <div className="flex justify-between items-start mb-2">
                <h3 className={`font-bold ${isActive ? 'text-white' : 'text-polar-200'}`}>{step.title}</h3>
                {status === 'done' && <span className="text-safe">Done</span>}
                {status === 'running' && <span className="text-warning animate-pulse">Running</span>}
              </div>
              <p className="text-sm text-polar-400 mb-4 min-h-10">{step.desc}</p>
              <button
                className={`w-full py-2 rounded-lg font-medium transition-colors ${status === 'done' ? 'bg-safe/20 text-safe' : isActive ? 'bg-polar-600 text-white hover:bg-polar-500' : 'bg-polar-800 text-polar-400 cursor-not-allowed'}`}
                onClick={() => { if (isActive || status === 'done') runStep(stepNumber, step.action); }}
                disabled={!isActive && status !== 'done'}
              >
                {status === 'done' ? 'Re-run Step' : status === 'running' ? 'Running...' : 'Execute'}
              </button>
            </div>
          );
        })}
      </div>

      <div className="h-64">
        <EventTimeline />
      </div>
    </div>
  );
}
