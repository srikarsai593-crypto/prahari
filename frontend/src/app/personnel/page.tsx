'use client';
import { useState, useEffect, useRef } from 'react';
import { api } from '@/lib/api';
import { useWebSocket } from '@/components/WebSocketProvider';
import { useToast } from '@/components/Toast';
import { MapView } from '@/components/MapView';

function parseMovementRoutes(plans: any[]) {
  return plans.map(plan => {
    let routePoints: { lat: number; lng: number }[] = [];
    try {
      routePoints = typeof plan.planned_route === 'string'
        ? JSON.parse(plan.planned_route)
        : plan.planned_route || [];
    } catch {
      routePoints = [];
    }
    return {
      path: routePoints.map(p => [p.lat, p.lng] as [number, number]),
      type: 'planned',
    };
  }).filter(r => r.path.length > 0);
}

export default function PersonnelPage() {
  const { lastMessage } = useWebSocket();
  const { addToast } = useToast();
  const [personnel, setPersonnel] = useState<any[]>([]);
  const [routes, setRoutes] = useState<any[]>([]);
  const [simulating, setSimulating] = useState<Record<string, boolean>>({});
  const intervalRefs = useRef<Record<string, NodeJS.Timeout>>({});

  useEffect(() => {
    loadPersonnel();
    loadMovementPlans();
    return () => {
      Object.values(intervalRefs.current).forEach(clearInterval);
    };
  }, []);

  useEffect(() => {
    if (lastMessage) {
      if (lastMessage.type === 'gps_update' && lastMessage.data) {
        setPersonnel(prev => prev.map(p => p.id === lastMessage.data.personnel_id ? { ...p, current_lat: lastMessage.data.lat, current_lng: lastMessage.data.lng, status: lastMessage.data.alert ? 'deviated' : 'in_transit' } : p));
      } else if (lastMessage.type === 'alert') {
        addToast(lastMessage.data?.message || lastMessage.data?.type || 'Alert', 'alert');
        loadPersonnel();
        loadMovementPlans();
      }
    }
  }, [lastMessage, addToast]);

  const loadPersonnel = () => {
    api.listPersonnel().then(data => setPersonnel(Array.isArray(data) ? data : []));
  };

  const loadMovementPlans = () => {
    api.listMovementPlans().then(data => {
      const plans = Array.isArray(data) ? data : [];
      setRoutes(parseMovementRoutes(plans));
    });
  };

  const getStatusBadge = (status: string) => {
    if (['at_station', 'field', 'returned'].includes(status)) return 'safe';
    if (status === 'deviated') return 'danger';
    if (status === 'in_transit') return 'info';
    return 'warning';
  };

  const handleStartSim = (id: string) => {
    if (simulating[id]) return;
    setSimulating(prev => ({ ...prev, [id]: true }));
    intervalRefs.current[id] = setInterval(async () => {
      try {
        await api.simulateMove(id);
      } catch (e) {
        clearInterval(intervalRefs.current[id]);
        setSimulating(prev => ({ ...prev, [id]: false }));
      }
    }, 2000);
  };

  const handleStopSim = (id: string) => {
    if (intervalRefs.current[id]) {
      clearInterval(intervalRefs.current[id]);
      delete intervalRefs.current[id];
    }
    setSimulating(prev => ({ ...prev, [id]: false }));
  };

  const handleReset = async (id: string) => {
    handleStopSim(id);
    await api.resetSimulation(id);
    loadPersonnel();
    loadMovementPlans();
  };

  const handleSOS = async (id: string) => {
    try {
      await api.triggerSOS(id);
      addToast('SOS Triggered!', 'alert');
    } catch (e) {
      addToast('Failed to trigger SOS', 'alert');
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 h-[calc(100vh-100px)]">
      <div className="lg:col-span-1 space-y-6 overflow-y-auto pr-2">
        <h2 className="text-xl font-bold text-white mb-4">Personnel Tracking</h2>
        {personnel.map(p => (
          <div key={p.id} className="glass-card p-4">
            <div className="flex justify-between items-start mb-3">
              <div>
                <h3 className="font-bold text-white text-lg">{p.name}</h3>
                <p className="text-sm text-polar-400">{p.role}</p>
              </div>
              <div className={`status-badge status-${getStatusBadge(p.status)}`}>
                {p.status}
              </div>
            </div>
            
            <div className="text-xs font-mono text-polar-300 mb-4 bg-polar-900/50 p-2 rounded">
              Lat: {Number(p.current_lat || -70.767).toFixed(4)}<br/>
              Lng: {Number(p.current_lng || 11.731).toFixed(4)}
            </div>

            <div className="grid grid-cols-2 gap-2 mb-2">
              {!simulating[p.id] ? (
                <button className="btn-secondary text-sm min-h-[36px]" onClick={() => handleStartSim(p.id)}>Start GPS</button>
              ) : (
                <button className="btn-secondary text-sm min-h-[36px] bg-polar-800" onClick={() => handleStopSim(p.id)}>Stop GPS</button>
              )}
              <button className="btn-secondary text-sm min-h-[36px]" onClick={() => handleReset(p.id)}>Reset</button>
            </div>
            <button className="btn-danger w-full text-sm min-h-[48px]" onClick={() => handleSOS(p.id)}>TRIGGER SOS</button>
          </div>
        ))}
      </div>
      
      <div className="lg:col-span-2 relative glass-card p-2">
        <MapView personnel={personnel} routes={routes} />
      </div>
    </div>
  );
}
