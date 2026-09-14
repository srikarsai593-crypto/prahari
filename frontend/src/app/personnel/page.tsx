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

function formatTimestamp(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString() : 'Not available';
}

export default function PersonnelPage() {
  const { lastMessage } = useWebSocket();
  const { addToast } = useToast();
  const [personnel, setPersonnel] = useState<any[]>([]);
  const [routes, setRoutes] = useState<any[]>([]);
  const [simulating, setSimulating] = useState<Record<string, boolean>>({});
  const intervalRefs = useRef<Record<string, NodeJS.Timeout>>({});
  const trackingAlertsRef = useRef<Record<string, { overdue: boolean; noRecentUpdate: boolean }>>({});
  const hasLoadedPersonnelRef = useRef(false);

  useEffect(() => {
    loadPersonnel();
    loadMovementPlans();
    const refreshTimer = setInterval(() => {
      loadPersonnel(true);
      loadMovementPlans();
    }, 30000);
    return () => {
      Object.values(intervalRefs.current).forEach(clearInterval);
      clearInterval(refreshTimer);
    };
  }, []);

  useEffect(() => {
    if (lastMessage) {
      if (lastMessage.type === 'gps_update' && lastMessage.data) {
        setPersonnel(prev => prev.map(p => p.id === lastMessage.data.personnel_id ? {
          ...p,
          current_lat: lastMessage.data.lat,
          current_lng: lastMessage.data.lng,
          last_update_at: lastMessage.data.last_update_at,
          location_update_status: 'current',
          location_update_warning: null,
          last_update_age_minutes: 0,
          status: lastMessage.data.alert ? 'deviated' : 'in_transit',
          effective_status: p.overdue ? 'overdue' : (lastMessage.data.alert ? 'deviated' : 'in_transit'),
        } : p));
      } else if (lastMessage.type === 'alert') {
        addToast(lastMessage.data?.message || lastMessage.data?.type || 'Alert', 'alert');
        loadPersonnel();
        loadMovementPlans();
      }
    }
  }, [lastMessage, addToast]);

  const loadPersonnel = (notifyOnChange = false) => {
    api.listPersonnel().then(data => {
      const nextPersonnel = Array.isArray(data) ? data : [];

      if (notifyOnChange && hasLoadedPersonnelRef.current) {
        nextPersonnel.forEach(person => {
          const previous = trackingAlertsRef.current[person.id];
          if (person.overdue && !previous?.overdue) {
            addToast(`${person.name} is OVERDUE for arrival`, 'alert');
          }
          if (person.location_update_status === 'no_recent_location_update' && !previous?.noRecentUpdate) {
            addToast(`${person.name}: NO RECENT LOCATION UPDATE`, 'warning');
          }
        });
      }

      trackingAlertsRef.current = Object.fromEntries(nextPersonnel.map(person => [person.id, {
        overdue: Boolean(person.overdue),
        noRecentUpdate: person.location_update_status === 'no_recent_location_update',
      }]));
      hasLoadedPersonnelRef.current = true;
      setPersonnel(nextPersonnel);
    });
  };

  const loadMovementPlans = () => {
    api.listMovementPlans().then(data => {
      const plans = Array.isArray(data) ? data : [];
      setRoutes(parseMovementRoutes(plans));
    });
  };

  const getStatusBadge = (status: string) => {
    if (['at_station', 'field', 'returned'].includes(status)) return 'safe';
    if (status === 'overdue') return 'danger';
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
        {personnel.map(p => {
          const displayStatus = p.effective_status || p.status;
          return (
          <div key={p.id} className="glass-card p-4">
            <div className="flex justify-between items-start mb-3">
              <div>
                <h3 className="font-bold text-white text-lg">{p.name}</h3>
                <p className="text-sm text-polar-400">{p.role}</p>
              </div>
              <div className={`status-badge status-${getStatusBadge(displayStatus)}`}>
                {displayStatus === 'overdue' ? 'OVERDUE' : displayStatus}
              </div>
            </div>
            
            <div className="text-xs font-mono text-polar-300 mb-4 bg-polar-900/50 p-2 rounded">
              Last known location:<br/>
              Lat: {Number(p.current_lat || -70.767).toFixed(4)}<br/>
              Lng: {Number(p.current_lng || 11.731).toFixed(4)}<br/>
              Last update: {formatTimestamp(p.last_update_at)}
            </div>

            {p.overdue && (
              <div className="text-sm text-danger mb-3">
                OVERDUE: expected arrival at {p.destination_name || 'destination'} was {formatTimestamp(p.expected_arrival)}.
              </div>
            )}
            {p.location_update_status === 'no_recent_location_update' && (
              <div className="status-badge status-warning mb-3">
                NO RECENT LOCATION UPDATE
              </div>
            )}

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
          );
        })}
      </div>
      
      <div className="lg:col-span-2 relative glass-card p-2">
        <MapView personnel={personnel} routes={routes} />
      </div>
    </div>
  );
}
