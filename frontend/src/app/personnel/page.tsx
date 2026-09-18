'use client';
import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
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
    } catch { routePoints = []; }
    return {
      path: routePoints.map(p => [p.lat, p.lng] as [number, number]),
      type: 'planned',
    };
  }).filter(r => r.path.length > 0);
}

function getInitials(name: string) {
  return name.split(' ').map(n => n[0] || '').join('').slice(0, 2).toUpperCase();
}

export default function PersonnelPage() {
  const { lastMessage } = useWebSocket();
  const { addToast } = useToast();
  const [personnel, setPersonnel] = useState<any[]>([]);
  const [routes, setRoutes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [simulating, setSimulating] = useState<Record<string, boolean>>({});
  const intervalRefs = useRef<Record<string, ReturnType<typeof setInterval>>>({});

  useEffect(() => {
    loadAll();
    return () => { Object.values(intervalRefs.current).forEach(clearInterval); };
  }, []);

  useEffect(() => {
    if (!lastMessage) return;
    if (lastMessage.type === 'gps_update' && lastMessage.data) {
      setPersonnel(prev => prev.map(p =>
        p.id === lastMessage.data.personnel_id
          ? { ...p, current_lat: lastMessage.data.lat, current_lng: lastMessage.data.lng, status: lastMessage.data.alert ? 'deviated' : 'in_transit' }
          : p
      ));
    } else if (lastMessage.type === 'alert') {
      addToast(lastMessage.data?.message || lastMessage.data?.type || 'Alert received', 'alert');
      loadAll();
    }
  }, [lastMessage, addToast]);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [pData, mData] = await Promise.allSettled([
        api.listPersonnel(),
        api.listMovementPlans(),
      ]);
      if (pData.status === 'fulfilled') setPersonnel(Array.isArray(pData.value) ? pData.value : []);
      if (mData.status === 'fulfilled') setRoutes(parseMovementRoutes(Array.isArray(mData.value) ? mData.value : []));
    } catch (e: any) {
      console.error('Failed to load personnel data:', e);
    } finally {
      setLoading(false);
    }
  };

  const getStatusStyle = (status: string) => {
    if (['at_station', 'field', 'returned'].includes(status)) return 'bg-emerald-50 border-emerald-200 text-emerald-800';
    if (status === 'deviated') return 'bg-rose-50 border-rose-200 text-rose-800';
    if (status === 'in_transit') return 'bg-sky-50 border-sky-200 text-sky-800';
    return 'bg-amber-50 border-amber-200 text-amber-800';
  };

  const handleStartSim = (id: string) => {
    if (simulating[id]) return;
    setSimulating(prev => ({ ...prev, [id]: true }));
    intervalRefs.current[id] = setInterval(async () => {
      try { await api.simulateMove(id); }
      catch (e) { clearInterval(intervalRefs.current[id]); delete intervalRefs.current[id]; setSimulating(prev => ({ ...prev, [id]: false })); }
    }, 2000);
  };

  const handleStopSim = (id: string) => {
    if (intervalRefs.current[id]) { clearInterval(intervalRefs.current[id]); delete intervalRefs.current[id]; }
    setSimulating(prev => ({ ...prev, [id]: false }));
  };

  const handleReset = async (id: string) => {
    handleStopSim(id);
    try {
      await api.resetSimulation(id);
      loadAll();
    } catch (e: any) { addToast(e?.message || 'Reset failed', 'alert'); }
  };

  const handleSOS = async (id: string) => {
    try {
      await api.triggerSOS(id);
      addToast('🚨 SOS Triggered — Emergency protocols activated for all stations', 'alert');
    } catch (e: any) { addToast(e?.message || 'Failed to trigger SOS', 'alert'); }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <Link href="/" className="text-arctic-800 hover:text-arctic-600 flex items-center gap-2 text-xs font-semibold transition-colors bg-white px-3.5 py-1.5 rounded-xl border border-arctic-200 shadow-xs">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M15 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Dashboard
        </Link>
        <div className="flex items-center gap-2">
          <button className="btn-secondary text-xs" onClick={loadAll}>↺ Refresh</button>
          <span className="text-xs bg-arctic-50 border border-arctic-200 text-arctic-800 px-3 py-1 rounded-full font-mono font-semibold">PRS-TRK-04</span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6" style={{ minHeight: 'calc(100vh - 200px)' }}>
        {/* Personnel list */}
        <div className="lg:col-span-1 space-y-4 overflow-y-auto" style={{ maxHeight: 'calc(100vh - 200px)' }}>
          <h2 className="text-base font-bold text-arctic-900 sticky top-0 bg-white/80 backdrop-blur-sm py-1 z-10" style={{ fontFamily: 'Outfit, sans-serif' }}>
            Personnel Tracking
            <span className="ml-2 text-xs font-normal text-frost-muted">
              ({loading ? '...' : personnel.length} operatives)
            </span>
          </h2>

          {loading ? (
            [1,2,3].map(i => (
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
            <div className="subview-card rounded-2xl p-6 text-center text-xs text-frost-muted">
              No personnel records found. Check backend connection.
            </div>
          ) : personnel.map(p => (
            <div key={p.id} className="subview-card rounded-2xl p-5 border-l-4 border-l-arctic-400">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-arctic-50 border border-arctic-200 flex items-center justify-center font-bold text-arctic-700 text-sm shrink-0" style={{ fontFamily: 'Outfit, sans-serif' }}>
                    {getInitials(p.name)}
                  </div>
                  <div>
                    <h3 className="font-bold text-arctic-900 text-sm" style={{ fontFamily: 'Outfit, sans-serif' }}>{p.name}</h3>
                    <p className="text-[11px] text-frost-muted">{p.role}</p>
                  </div>
                </div>
                <span className={`px-2.5 py-1 rounded-full border text-[10px] font-semibold font-mono shrink-0 ${getStatusStyle(p.status)}`}>
                  {p.status}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 font-mono text-xs mb-4 bg-arctic-50/60 p-3 rounded-xl border border-arctic-200">
                <div>
                  <span className="text-[9px] text-frost-muted block uppercase tracking-wider">Latitude</span>
                  <span className="text-arctic-900 font-bold">{Number(p.current_lat || -70.767).toFixed(4)}°S</span>
                </div>
                <div>
                  <span className="text-[9px] text-frost-muted block uppercase tracking-wider">Longitude</span>
                  <span className="text-arctic-900 font-bold">{Number(p.current_lng || 11.731).toFixed(4)}°E</span>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                {!simulating[p.id] ? (
                  <button className="btn-primary text-xs flex-1 min-w-0" onClick={() => handleStartSim(p.id)}>
                    📡 Start GPS
                  </button>
                ) : (
                  <button className="btn-secondary text-xs flex-1 min-w-0" onClick={() => handleStopSim(p.id)}>
                    ⏹ Stop GPS
                  </button>
                )}
                <button className="btn-secondary text-xs px-3" onClick={() => handleReset(p.id)} title="Reset to start">↺</button>
                <button
                  className="w-full mt-1 bg-rose-600 hover:bg-rose-700 active:scale-[0.98] text-white text-xs font-bold py-2 rounded-xl transition-all flex items-center justify-center gap-1.5"
                  onClick={() => handleSOS(p.id)}
                >
                  🚨 TRIGGER SOS
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Map */}
        <div className="lg:col-span-2 subview-card rounded-2xl p-2 overflow-hidden" style={{ minHeight: 480 }}>
          <MapView personnel={personnel} routes={routes} />
        </div>
      </div>
    </div>
  );
}
