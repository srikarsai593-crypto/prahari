'use client';
import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { useToast } from '@/components/Toast';

export default function ExpeditionPage() {
  const { addToast } = useToast();
  const [nlText, setNlText] = useState('');
  const [parsing, setParsing] = useState(false);
  const [expeditions, setExpeditions] = useState<any[]>([]);
  const [form, setForm] = useState({
    name: '',
    station: 'Maitri',
    start_date: '',
    end_date: '',
    personnel_required: 0,
    fuel_required_l: 0,
    raw_request: '',
  });
  const [feasibility, setFeasibility] = useState<any>(null);
  const feasibilityOk = feasibility?.items?.every((item: any) => item.ok) ?? false;

  useEffect(() => {
    loadExpeditions();
  }, []);

  const loadExpeditions = () => api.listExpeditions().then(data => setExpeditions(Array.isArray(data) ? data : []));

  const handleParse = async () => {
    if (!nlText) return;
    setParsing(true);
    try {
      const res = await api.parseNL(nlText);
      setForm(prev => ({ ...prev, ...res, raw_request: nlText }));
      addToast('Parsed natural language successfully', 'success');
    } catch (e) {
      addToast('Failed to parse text', 'alert');
    } finally {
      setParsing(false);
    }
  };

  const handleCheck = async () => {
    try {
      const res = await api.checkFeasibility({
        station: form.station,
        personnel_required: form.personnel_required,
        fuel_required_l: form.fuel_required_l,
      });
      setFeasibility(res);
      addToast('Feasibility check complete', 'info');
    } catch (e) {
      addToast('Check failed', 'alert');
    }
  };

  const handleSave = async () => {
    try {
      await api.createExpedition(form);
      addToast('Expedition saved', 'success');
      setForm({ name: '', station: 'Maitri', start_date: '', end_date: '', personnel_required: 0, fuel_required_l: 0, raw_request: '' });
      setFeasibility(null);
      loadExpeditions();
    } catch (e) {
      addToast('Failed to save', 'alert');
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-2 space-y-6">
        <div className="glass-card p-6">
          <h2 className="text-xl font-bold mb-4 text-white">AI Expedition Planning</h2>
          <div className="flex gap-4 mb-4">
            <textarea
              className="flex-1"
              rows={3}
              placeholder="e.g. Create a 30-day expedition to Maitri with 12 researchers and 2 engineers."
              value={nlText}
              onChange={e => setNlText(e.target.value)}
            />
          </div>
          <button className="btn-primary" onClick={handleParse} disabled={parsing}>
            {parsing ? 'Parsing...' : 'Parse with Local AI'}
          </button>
        </div>

        <div className="glass-card p-6">
          <h2 className="text-xl font-bold mb-4 text-white">Expedition Details</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label>Name</label>
              <input type="text" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <label>Station</label>
              <select value={form.station} onChange={e => setForm({ ...form, station: e.target.value })}>
                <option value="Maitri">Maitri</option>
                <option value="Bharati">Bharati</option>
                <option value="Himadri">Himadri</option>
              </select>
            </div>
            <div>
              <label>Start Date</label>
              <input type="date" value={form.start_date} onChange={e => setForm({ ...form, start_date: e.target.value })} />
            </div>
            <div>
              <label>End Date</label>
              <input type="date" value={form.end_date} onChange={e => setForm({ ...form, end_date: e.target.value })} />
            </div>
            <div>
              <label>Personnel Count</label>
              <input type="number" value={form.personnel_required || 0} onChange={e => setForm({ ...form, personnel_required: parseInt(e.target.value) || 0 })} />
            </div>
            <div>
              <label>Required Fuel (L)</label>
              <input type="number" value={form.fuel_required_l || 0} onChange={e => setForm({ ...form, fuel_required_l: parseFloat(e.target.value) || 0 })} />
            </div>
          </div>
          <div className="mt-6 flex gap-4">
            <button className="btn-secondary" onClick={handleCheck}>Check Feasibility</button>
            <button className="btn-primary" onClick={handleSave} disabled={!form.name || !form.personnel_required || !form.fuel_required_l}>Save Expedition</button>
          </div>
        </div>

        <div className="glass-card p-6">
          <h2 className="text-xl font-bold mb-4 text-white">Recent Expeditions</h2>
          <div className="space-y-2">
            {expeditions.map(e => (
              <div key={e.id} className="p-4 border border-polar-700/30 rounded-lg flex justify-between items-center bg-polar-900/30">
                <div>
                  <div className="font-bold text-white">{e.name}</div>
                  <div className="text-sm text-polar-400">{e.station} | {e.start_date} to {e.end_date}</div>
                </div>
                <div className={`status-badge status-${e.status === 'under_resourced' ? 'danger' : e.status === 'draft' ? 'info' : 'safe'}`}>
                  {e.status}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="space-y-6">
        {feasibility && (
          <div className="glass-card p-6">
            <h2 className="text-xl font-bold mb-4 text-white">Feasibility Report</h2>
            <div className="flex justify-center mb-6">
              <div
                className="w-32 h-32 rounded-full border-8 flex items-center justify-center text-3xl font-bold"
                style={{ borderColor: feasibilityOk ? '#22C55E' : '#EF4444', color: feasibilityOk ? '#22C55E' : '#EF4444' }}
              >
                {feasibility.readiness_score ?? 0}%
              </div>
            </div>
            <div className="space-y-4">
              {feasibility.items?.map((item: any) => (
                <div key={item.label} className="grid grid-cols-[1fr_auto_auto] gap-3 items-center border-b border-polar-800/60 pb-3">
                  <span>{item.label}</span>
                  <span className="font-mono text-polar-300">{item.detail || `${item.available}/${item.required}`}</span>
                  {item.ok ? <span className="text-safe">OK</span> : <span className="text-danger">Low</span>}
                </div>
              ))}
              <div className="pt-2 grid grid-cols-2 gap-2 text-xs">
                {Object.entries(feasibility.readiness_breakdown || {}).map(([key, value]) => (
                  <div key={key} className="bg-polar-900/50 rounded-lg p-2">
                    <div className="uppercase text-polar-500">{key}</div>
                    <div className="font-bold text-polar-100">{String(value)}%</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
