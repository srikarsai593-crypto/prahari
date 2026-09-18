'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useToast } from '@/components/Toast';

function LoadingCard() {
  return (
    <div className="subview-card rounded-2xl p-7 animate-pulse">
      <div className="h-4 bg-arctic-100 rounded w-1/2 mb-3" />
      <div className="h-3 bg-arctic-50 rounded w-full mb-2" />
      <div className="h-3 bg-arctic-50 rounded w-4/5" />
    </div>
  );
}

export default function ExpeditionPage() {
  const { addToast } = useToast();
  const [nlText, setNlText] = useState('');
  const [parsing, setParsing] = useState(false);
  const [expeditions, setExpeditions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
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
  const [showFeasibility, setShowFeasibility] = useState(false);
  const feasibilityOk = feasibility?.items?.every((item: any) => item.ok) ?? false;

  useEffect(() => { loadExpeditions(); }, []);

  const loadExpeditions = async () => {
    setLoading(true);
    try {
      const data = await api.listExpeditions();
      setExpeditions(Array.isArray(data) ? data : []);
    } catch (e: any) {
      console.error('Failed to load expeditions:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleParse = async () => {
    if (!nlText.trim()) return;
    setParsing(true);
    try {
      const res = await api.parseNL(nlText);
      setForm(prev => ({ ...prev, ...res, raw_request: nlText }));
      addToast('AI parsed waypoints, fuel quotas, and crew specifications', 'success');
    } catch (e: any) {
      addToast(e?.message || 'Failed to parse text', 'alert');
    } finally { setParsing(false); }
  };

  const handleCheck = async () => {
    try {
      const res = await api.checkFeasibility({
        station: form.station,
        personnel_required: form.personnel_required,
        fuel_required_l: form.fuel_required_l,
      });
      setFeasibility(res);
      setShowFeasibility(true);
      addToast('Feasibility projection complete', 'success');
    } catch (e: any) { addToast(e?.message || 'Check failed', 'alert'); }
  };

  const handleSave = async () => {
    if (!form.name.trim()) return addToast('Mission codename is required', 'warning');
    try {
      await api.createExpedition(form);
      addToast(`Expedition ${form.name} dispatched to polar command!`, 'success');
      setForm({ name: '', station: 'Maitri', start_date: '', end_date: '', personnel_required: 0, fuel_required_l: 0, raw_request: '' });
      setFeasibility(null);
      setShowFeasibility(false);
      loadExpeditions();
    } catch (e: any) { addToast(e?.message || 'Failed to save', 'alert'); }
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
        <span className="text-xs bg-arctic-50 border border-arctic-200 text-arctic-800 px-3 py-1 rounded-full font-mono font-semibold">EXP-PLN-01</span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main planner */}
        <div className="subview-card rounded-2xl p-7 lg:col-span-2 space-y-6">
          {/* AI Planner */}
          <div>
            <h2 className="text-lg font-bold text-arctic-900 mb-1 flex items-center gap-2" style={{ fontFamily: 'Outfit, sans-serif' }}>
              <span className="text-arctic-600">⚡</span> AI-Assisted Mission Planner
            </h2>
            <p className="text-xs text-frost-muted mb-3">Input rough mission notes in natural language. PRAHARI edge neural model parses waypoints and constraints.</p>
            <textarea
              className="w-full bg-white border border-arctic-200 rounded-xl p-3.5 text-xs text-arctic-900 focus:border-arctic-500 focus:ring-2 focus:ring-arctic-100 focus:outline-none placeholder-slate-400 font-mono resize-none"
              rows={3}
              placeholder="e.g. Schedule geological survey to Schirmacher Oasis with 4 scientists..."
              value={nlText}
              onChange={e => setNlText(e.target.value)}
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <button className="btn-primary text-xs" onClick={handleParse} disabled={parsing}>
                🧠 {parsing ? 'Parsing...' : 'Parse with Local AI'}
              </button>
              <button className="btn-secondary text-xs" onClick={handleCheck}>
                ❄️ Check Feasibility
              </button>
            </div>
            {showFeasibility && feasibility && (
              <div className={`mt-4 p-4 rounded-xl border text-xs ${feasibilityOk ? 'border-emerald-200 bg-emerald-50/70' : 'border-rose-200 bg-rose-50/70'}`}>
                <div className={`font-bold text-xs mb-1 flex items-center gap-2 ${feasibilityOk ? 'text-emerald-800' : 'text-rose-800'}`}>
                  <span className={`w-2 h-2 rounded-full ${feasibilityOk ? 'bg-emerald-500' : 'bg-rose-500'}`}/>
                  {feasibilityOk ? `✓ Feasibility Approved — ${feasibility.readiness_score ?? 94}% Safe Window` : `✗ Under-Resourced — ${feasibility.readiness_score ?? 0}% Ready`}
                </div>
                {feasibility.items?.map((item: any) => (
                  <div key={item.label} className="flex justify-between mt-1.5">
                    <span className={feasibilityOk ? 'text-emerald-800' : 'text-rose-800'}>{item.label}</span>
                    <span className={`font-mono font-bold ${item.ok ? 'text-emerald-700' : 'text-rose-700'}`}>{item.ok ? '✓ OK' : '✗ Low'}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Form */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-5 border-t border-arctic-100">
            <div>
              <label>Mission Codename</label>
              <input type="text" className="w-full bg-white border border-arctic-200 rounded-xl px-3 py-2 text-xs text-arctic-900 focus:border-arctic-500 focus:outline-none" placeholder="GLACIER-PULSE-IX" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <label>Station</label>
              <select className="w-full bg-white border border-arctic-200 rounded-xl px-3 py-2 text-xs text-arctic-900 focus:border-arctic-500 focus:outline-none" value={form.station} onChange={e => setForm({ ...form, station: e.target.value })}>
                <option>Maitri</option><option>Bharati</option><option>Himadri</option>
              </select>
            </div>
            <div>
              <label>Start Date</label>
              <input type="date" className="w-full bg-white border border-arctic-200 rounded-xl px-3 py-2 text-xs text-arctic-900 focus:border-arctic-500 focus:outline-none" value={form.start_date} onChange={e => setForm({ ...form, start_date: e.target.value })} />
            </div>
            <div>
              <label>End Date</label>
              <input type="date" className="w-full bg-white border border-arctic-200 rounded-xl px-3 py-2 text-xs text-arctic-900 focus:border-arctic-500 focus:outline-none" value={form.end_date} onChange={e => setForm({ ...form, end_date: e.target.value })} />
            </div>
            <div>
              <label>Personnel Count</label>
              <input type="number" className="w-full bg-white border border-arctic-200 rounded-xl px-3 py-2 text-xs text-arctic-900 focus:border-arctic-500 focus:outline-none" placeholder="4" min="0" value={form.personnel_required || ''} onChange={e => setForm({ ...form, personnel_required: parseInt(e.target.value) || 0 })} />
            </div>
            <div>
              <label>Fuel Required (L)</label>
              <input type="number" className="w-full bg-white border border-arctic-200 rounded-xl px-3 py-2 text-xs text-arctic-900 focus:border-arctic-500 focus:outline-none" placeholder="300" min="0" value={form.fuel_required_l || ''} onChange={e => setForm({ ...form, fuel_required_l: parseFloat(e.target.value) || 0 })} />
            </div>
          </div>
          <div className="flex justify-end">
            <button className="btn-primary text-xs tracking-wider uppercase" onClick={handleSave} disabled={!form.name.trim()}>
              Save &amp; Authorize Expedition
            </button>
          </div>
        </div>

        {/* Sidebar */}
        <div className="subview-card rounded-2xl p-7 flex flex-col">
          <h3 className="text-xs font-bold text-arctic-900 uppercase tracking-wider mb-4" style={{ fontFamily: 'Space Grotesk, sans-serif' }}>
            Active Operations
          </h3>
          {loading ? (
            <div className="space-y-3">{[1,2,3].map(i => <LoadingCard key={i} />)}</div>
          ) : (
            <div className="flex-1 space-y-3 text-xs overflow-y-auto">
              {expeditions.length > 0 ? expeditions.map(e => (
                <div key={e.id} className="p-3 bg-arctic-50/60 rounded-xl border border-arctic-200">
                  <div className="flex justify-between font-bold text-arctic-900 mb-1">
                    <span className="truncate mr-2">{e.name}</span>
                    <span className={`shrink-0 ${e.status === 'approved' ? 'text-emerald-600' : e.status === 'draft' ? 'text-arctic-600' : 'text-amber-600'}`}>{e.status}</span>
                  </div>
                  <p className="text-[11px] text-frost-muted">{e.station} · {e.personnel_required} operatives</p>
                </div>
              )) : (
                /* Seeded placeholder data */
                [
                  { name: 'NUNATAK-SCOUT', status: 'En Route', statusColor: 'text-emerald-600', detail: '3 operatives · Ice-shelf sector 4' },
                  { name: 'BOREHOLE-DRILL-4', status: 'Stationary', statusColor: 'text-arctic-600', detail: '6 operatives · Core extraction' },
                  { name: 'MET-STATION-RESUPPLY', status: 'Holding', statusColor: 'text-amber-600', detail: '2 vehicles · Awaiting visibility' },
                ].map(exp => (
                  <div key={exp.name} className="p-3 bg-arctic-50/60 rounded-xl border border-arctic-200">
                    <div className="flex justify-between font-bold text-arctic-900 mb-1">
                      <span className="truncate mr-2">{exp.name}</span>
                      <span className={`shrink-0 ${exp.statusColor}`}>{exp.status}</span>
                    </div>
                    <p className="text-[11px] text-frost-muted">{exp.detail}</p>
                  </div>
                ))
              )}
            </div>
          )}
          <div className="pt-4 border-t border-arctic-100 text-[11px] text-frost-muted mt-4">
            Satellite link synchronized with NavIC / Polar constellation.
          </div>
        </div>
      </div>
    </div>
  );
}
