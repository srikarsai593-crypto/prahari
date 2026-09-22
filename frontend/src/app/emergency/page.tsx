'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useWebSocket } from '@/components/WebSocketProvider';
import { useToast } from '@/components/Toast';
import { MapView } from '@/components/MapView';
import { EventTimeline } from '@/components/EventTimeline';
import type { Incident, Accountability, NearbyAsset } from '@/lib/types';

export default function EmergencyPage() {
  const { lastMessage } = useWebSocket();
  const { addToast } = useToast();
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [loading, setLoading] = useState(true);
  const [accountability, setAccountability] = useState<Accountability | null>(null);
  const [nearbyAssets, setNearbyAssets] = useState<NearbyAsset[]>([]);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    type: 'medical',
    severity: 'critical',
    location_lat: -70.767,
    location_lng: 11.731,
    affected_radius_m: 1000,
  });

  const loadNearbyAssets = async (lat: number, lng: number) => {
    try {
      const data = await api.searchNearbyAssets(lat, lng);
      setNearbyAssets(Array.isArray(data) ? data.slice(0, 3) : []);
    } catch (e: any) {
      console.warn('Failed to load nearby assets:', e?.message);
      addToast('⚠️ Could not fetch nearby assets — check backend connection', 'warning');
      setNearbyAssets([]);
    }
  };

  const loadIncidents = async () => {
    setLoading(true);
    try {
      const data = await api.listIncidents();
      const list = Array.isArray(data) ? data : [];
      setIncidents(list);
      if (list.length > 0) {
        const latest = list[0];
        try {
          const acct = await api.getAccountability(latest.id);
          setAccountability(acct);
        } catch { /* accountability may not exist for all incidents */ }
        loadNearbyAssets(latest.location_lat, latest.location_lng);
      }
    } catch (e: any) {
      console.error('Failed to load incidents:', e);
      addToast('Failed to load incidents — is the backend running?', 'alert');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadIncidents(); }, []);

  useEffect(() => {
    if (lastMessage?.type === 'accountability_update') {
      setAccountability(lastMessage.data);
    } else if (lastMessage?.type === 'alert' && lastMessage.data?.type === 'incident') {
      loadIncidents();
    }
  }, [lastMessage]);

  const handleCreate = async () => {
    setCreating(true);
    try {
      const result = await api.createIncident(form as Partial<Incident>);
      addToast('🚨 Emergency declared — accountability check initiated', 'alert');
      // Optimistically update accountability from response without waiting for WS
      if (result?.expected_count !== undefined) {
        setAccountability({
          expected: result.expected_count ?? 0,
          confirmed_safe: result.confirmed_safe_count,
          unaccounted: result.unaccounted_count ?? 0,
        });
      }
      loadIncidents();
      loadNearbyAssets(form.location_lat, form.location_lng);
    } catch (e: any) {
      addToast(e?.message || 'Failed to create incident', 'alert');
    }
    finally { setCreating(false); }
  };


  const handlePowerFailure = async () => {
    try {
      await api.simulatePowerFailure('Maitri');
      addToast('⚡ Power failure simulated at Maitri Station', 'warning');
    } catch (e: any) { addToast(e?.message || 'Failed to simulate', 'alert'); }
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
          <button className="btn-secondary text-xs" onClick={loadIncidents}>↺ Refresh</button>
          <span className="text-xs bg-rose-50 border border-rose-200 text-rose-800 px-3 py-1 rounded-full font-mono font-semibold">EMG-RSP-05</span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6" style={{ minHeight: 'calc(100vh - 200px)' }}>
        {/* Sidebar */}
        <div className="lg:col-span-1 space-y-4 overflow-y-auto" style={{ maxHeight: 'calc(100vh - 200px)' }}>
          {/* Trigger form */}
          <div className="subview-card rounded-2xl p-6">
            <h2 className="text-base font-bold text-rose-700 mb-1 flex items-center gap-2" style={{ fontFamily: 'Outfit, sans-serif' }}>
              🚨 Declare Emergency
            </h2>
            <p className="text-xs text-frost-muted mb-4">Activate protocols across all Antarctic stations.</p>
            <div className="space-y-3">
              <div>
                <label>Incident Category</label>
                <select className="w-full bg-white border border-rose-200 rounded-xl px-3 py-2 text-xs text-arctic-900 focus:outline-none" value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}>
                  <option value="medical">Medical Emergency</option>
                  <option value="fire">Fire</option>
                  <option value="severe_weather">Severe Weather</option>
                  <option value="power_failure">Power Failure</option>
                </select>
              </div>
              <div>
                <label>Severity Level</label>
                <select className="w-full bg-white border border-arctic-200 rounded-xl px-3 py-2 text-xs text-arctic-900 focus:outline-none" value={form.severity} onChange={e => setForm({ ...form, severity: e.target.value })}>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="critical">Critical</option>
                </select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label>Latitude</label>
                  <input type="number" step="0.001" className="w-full bg-white border border-arctic-200 rounded-xl px-3 py-2 text-xs text-arctic-900 focus:outline-none" value={form.location_lat} onChange={e => setForm({ ...form, location_lat: parseFloat(e.target.value) || -70.767 })} />
                </div>
                <div>
                  <label>Longitude</label>
                  <input type="number" step="0.001" className="w-full bg-white border border-arctic-200 rounded-xl px-3 py-2 text-xs text-arctic-900 focus:outline-none" value={form.location_lng} onChange={e => setForm({ ...form, location_lng: parseFloat(e.target.value) || 11.731 })} />
                </div>
              </div>
              <button className="btn-danger w-full text-xs" onClick={handleCreate} disabled={creating}>
                {creating ? 'Declaring...' : '🚨 Declare Emergency'}
              </button>
            </div>
            <div className="mt-4 pt-4 border-t border-arctic-100">
              <button className="w-full bg-amber-50 hover:bg-amber-100 border border-amber-200 text-amber-800 text-xs font-semibold py-2 rounded-xl transition-colors flex items-center justify-center gap-1.5" onClick={handlePowerFailure}>
                ⚡ Simulate Power Failure
              </button>
            </div>
          </div>

          {/* Incidents list */}
          {incidents.length > 0 && (
            <div className="subview-card rounded-2xl p-5">
              <h3 className="text-xs font-bold text-arctic-900 uppercase tracking-wider mb-3" style={{ fontFamily: 'Space Grotesk, sans-serif' }}>
                Active Incidents ({incidents.length})
              </h3>
              <div className="space-y-2">
                {incidents.slice(0, 3).map((inc) => (
                  <div key={inc.id} className="bg-rose-50 p-3 rounded-xl border border-rose-200">
                    <div className="flex justify-between items-start">
                      <span className="font-bold text-rose-800 text-xs capitalize">{inc.type?.replace('_', ' ')}</span>
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${inc.severity === 'critical' ? 'bg-rose-100 border-rose-300 text-rose-800' : 'bg-amber-50 border-amber-200 text-amber-800'}`}>
                        {inc.severity}
                      </span>
                    </div>
                    <p className="text-[10px] text-rose-600 font-mono mt-1">{inc.location_lat?.toFixed(3)}°S, {inc.location_lng?.toFixed(3)}°E</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Nearby Assets */}
          {nearbyAssets.length > 0 && (
            <div className="subview-card rounded-2xl p-5">
              <h3 className="text-xs font-bold text-arctic-900 uppercase tracking-wider mb-3" style={{ fontFamily: 'Space Grotesk, sans-serif' }}>Nearest Assets</h3>
              <div className="space-y-2">
                {nearbyAssets.map((asset, i) => (
                  <div key={i} className="bg-arctic-50 p-3 rounded-xl border border-arctic-200">
                    <div className="font-bold text-arctic-900 text-xs">{asset.name}</div>
                    <div className="text-[10px] text-frost-muted capitalize">{asset.type}</div>
                    <div className="text-[10px] font-mono text-arctic-700 mt-0.5">{asset.distance_m}m away</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Accountability */}
          {accountability && (
            <div className="subview-card rounded-2xl p-5">
              <h3 className="text-xs font-bold text-arctic-900 uppercase tracking-wider mb-3" style={{ fontFamily: 'Space Grotesk, sans-serif' }}>Accountability</h3>
              <div className="space-y-2">
                <div className="flex justify-between items-center bg-arctic-50 p-3 rounded-xl">
                  <span className="text-xs text-frost-muted">Total Expected</span>
                  <span className="font-bold text-arctic-900">{accountability.expected ?? 0}</span>
                </div>
                <div className="flex justify-between items-center bg-emerald-50 border border-emerald-200 p-3 rounded-xl">
                  <span className="text-xs text-emerald-700">Confirmed Safe</span>
                  <span className="font-bold text-emerald-700">{accountability.confirmed_safe ?? 0}</span>
                </div>
                <div className="flex justify-between items-center bg-rose-50 border border-rose-200 p-3 rounded-xl">
                  <span className="text-xs text-rose-700">Unaccounted</span>
                  <span className="font-bold text-rose-700">{accountability.unaccounted ?? 0}</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Map */}
        <div className="lg:col-span-2 subview-card rounded-2xl p-2 overflow-hidden" style={{ minHeight: 480 }}>
          {loading ? (
            <div className="w-full h-full bg-arctic-50 rounded-xl flex items-center justify-center animate-pulse">
              <span className="text-frost-muted text-xs">Loading map data...</span>
            </div>
          ) : (
            <MapView incidents={incidents} />
          )}
        </div>

        {/* Timeline */}
        <div className="lg:col-span-1 overflow-hidden" style={{ maxHeight: 'calc(100vh - 200px)' }}>
          <EventTimeline />
        </div>
      </div>
    </div>
  );
}
