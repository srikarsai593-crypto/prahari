'use client';
import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { useWebSocket } from '@/components/WebSocketProvider';
import { useToast } from '@/components/Toast';
import { MapView } from '@/components/MapView';
import { EventTimeline } from '@/components/EventTimeline';

export default function EmergencyPage() {
  const { lastMessage } = useWebSocket();
  const { addToast } = useToast();
  const [incidents, setIncidents] = useState<any[]>([]);
  const [accountability, setAccountability] = useState<any>(null);
  const [nearbyAssets, setNearbyAssets] = useState<any[]>([]);
  const [form, setForm] = useState({
    type: 'medical',
    severity: 'critical',
    location_lat: -70.767,
    location_lng: 11.731,
    affected_radius_m: 1000,
  });

  const loadNearbyAssets = (lat: number, lng: number) => {
    api.searchNearbyAssets(lat, lng).then(data => {
      const assets = Array.isArray(data) ? data.slice(0, 3) : [];
      setNearbyAssets(assets);
    }).catch(() => setNearbyAssets([]));
  };

  useEffect(() => {
    loadIncidents();
  }, []);

  useEffect(() => {
    if (lastMessage?.type === 'accountability_update') {
      setAccountability(lastMessage.data);
    } else if (lastMessage?.type === 'alert' && lastMessage.data?.type === 'incident') {
      loadIncidents();
    }
  }, [lastMessage]);

  const loadIncidents = () => {
    api.listIncidents().then(data => {
      const incList = Array.isArray(data) ? data : [];
      setIncidents(incList);
      if (incList.length > 0) {
        const latest = incList[0];
        api.getAccountability(latest.id).then(setAccountability);
        loadNearbyAssets(latest.location_lat, latest.location_lng);
      }
    });
  };

  const handleCreate = async () => {
    try {
      await api.createIncident(form);
      addToast('Emergency incident created', 'alert');
      loadIncidents();
      loadNearbyAssets(form.location_lat, form.location_lng);
    } catch (e) {
      addToast('Failed to create incident', 'alert');
    }
  };

  const handlePowerFailure = async () => {
    try {
      await api.simulatePowerFailure('Maitri');
      addToast('Power failure simulated', 'warning');
    } catch (e) {
      addToast('Failed to simulate', 'alert');
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 h-[calc(100vh-100px)]">
      <div className="lg:col-span-1 space-y-6 overflow-y-auto">
        <div className="glass-card p-6 border-red-500/30">
          <h2 className="text-xl font-bold mb-4 text-red-400">Trigger Incident</h2>
          <div className="space-y-4">
            <div>
              <label className="text-red-300">Type</label>
              <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })} className="border-red-500/30 focus:border-red-400">
                <option value="medical">Medical Emergency</option>
                <option value="fire">Fire</option>
                <option value="severe_weather">Severe Weather</option>
                <option value="power_failure">Power Failure</option>
              </select>
            </div>
            <div>
              <label className="text-red-300">Severity</label>
              <select value={form.severity} onChange={e => setForm({ ...form, severity: e.target.value })} className="border-red-500/30 focus:border-red-400">
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </div>
            <button className="btn-danger w-full" onClick={handleCreate}>Declare Emergency</button>
          </div>
        </div>

        <div className="glass-card p-6">
          <h2 className="text-xl font-bold mb-4 text-white">Quick Actions</h2>
          <button className="btn-secondary w-full text-warning border-warning" onClick={handlePowerFailure}>Simulate Power Failure</button>
        </div>

        {nearbyAssets.length > 0 && (
          <div className="glass-card p-6 border-blue-500/30">
            <h2 className="text-xl font-bold mb-4 text-white">Nearest Assets</h2>
            <div className="space-y-3">
              {nearbyAssets.map((asset, i) => (
                <div key={i} className="bg-polar-900/50 p-3 rounded-lg border border-polar-700/30">
                  <div className="font-bold text-white">{asset.name}</div>
                  <div className="text-sm text-polar-400 capitalize">{asset.type}</div>
                  <div className="text-sm font-mono text-polar-300 mt-1">{asset.distance_m} m away</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {accountability && (
          <div className="glass-card p-6 border-amber-500/30">
            <h2 className="text-xl font-bold mb-4 text-white">Accountability</h2>
            <div className="space-y-4">
              <div className="flex justify-between items-center bg-polar-900 p-3 rounded-lg">
                <span className="text-polar-300">Total Expected</span>
                <span className="font-bold text-xl">{accountability.expected ?? 0}</span>
              </div>
              <div className="flex justify-between items-center bg-safe/20 border border-safe/30 p-3 rounded-lg">
                <span className="text-safe">Confirmed Safe</span>
                <span className="font-bold text-xl text-safe">{accountability.confirmed_safe ?? 0}</span>
              </div>
              <div className="flex justify-between items-center bg-danger/20 border border-danger/30 p-3 rounded-lg">
                <span className="text-danger">Unaccounted</span>
                <span className="font-bold text-xl text-danger">{accountability.unaccounted ?? 0}</span>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="lg:col-span-2 relative glass-card p-2">
        <MapView incidents={incidents} />
      </div>

      <div className="lg:col-span-1">
        <EventTimeline />
      </div>
    </div>
  );
}
