'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useWebSocket } from '@/components/WebSocketProvider';
import { useToast } from '@/components/Toast';

export default function InventoryPage() {
  const { lastMessage } = useWebSocket();
  const { addToast } = useToast();
  const [inventory, setInventory] = useState<any[]>([]);
  const [filter, setFilter] = useState('All');
  const [loading, setLoading] = useState(true);
  const [transcript, setTranscript] = useState('');
  const [processing, setProcessing] = useState(false);
  const [selectedItem, setSelectedItem] = useState<any | null>(null);
  const [exactCount, setExactCount] = useState<any | null>(null);
  const [loadingExact, setLoadingExact] = useState(false);

  useEffect(() => { loadInventory(); }, [filter]);

  useEffect(() => {
    if (lastMessage && (lastMessage.type === 'inventory_update' || lastMessage.type === 'blizzard_update')) {
      loadInventory();
    }
  }, [lastMessage]);

  const loadInventory = async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = filter !== 'All' ? { station: filter } : {};
      const data = await api.listInventory(params);
      const items = Array.isArray(data) ? data : [];
      setInventory(items);
      if (selectedItem) {
        const updated = items.find((i: any) => i.id === selectedItem.id);
        if (updated) setSelectedItem(updated);
      }
    } catch (e: any) {
      console.error('Failed to load inventory:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleVoice = async () => {
    if (!transcript.trim()) return addToast('Enter a voice command first', 'warning');
    setProcessing(true);
    try {
      const res = await api.voiceCommand(transcript) as { applied: boolean; item_name?: string; new_quantity?: number; error?: string };
      if (res.applied) {
        addToast(`${res.item_name} updated to ${res.new_quantity}`, 'success');
      } else {
        addToast(res.error || 'Command parsed but no matching item found', 'warning');
      }
      setTranscript('');
      loadInventory();
    } catch (e: any) { addToast(e?.message || 'Voice command failed', 'alert'); }
    finally { setProcessing(false); }
  };

  const handleExactCount = async () => {
    setLoadingExact(true);
    try {
      const res = await api.getExactCount('Maitri', 'fuel');
      setExactCount(res);
    } catch (e: any) { addToast(e?.message || 'Exact count query failed', 'alert'); }
    finally { setLoadingExact(false); }
  };

  const getDaysColor = (days: number) =>
    days > 30 ? 'text-emerald-600' : days > 15 ? 'text-amber-600' : 'text-rose-600';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Link href="/" className="text-arctic-800 hover:text-arctic-600 flex items-center gap-2 text-xs font-semibold transition-colors bg-white px-3.5 py-1.5 rounded-xl border border-arctic-200 shadow-xs">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M15 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Dashboard
        </Link>
        <span className="text-xs bg-arctic-50 border border-arctic-200 text-arctic-800 px-3 py-1 rounded-full font-mono font-semibold">INV-MNG-03</span>
      </div>

      {/* Voice Command */}
      <div className="subview-card rounded-2xl p-6">
        <h2 className="text-base font-bold text-arctic-900 mb-1" style={{ fontFamily: 'Outfit, sans-serif' }}>🎙️ Voice Command Input</h2>
        <p className="text-xs text-frost-muted mb-3">Natural language inventory updates. e.g. "Removed 4 thermal blankets from Shed 2"</p>
        <div className="flex gap-3">
          <input
            type="text"
            placeholder='e.g. Removed 4 thermal blankets from Shed 2'
            value={transcript}
            onChange={e => setTranscript(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleVoice()}
            className="flex-1 bg-white border border-arctic-200 rounded-xl px-3 py-2 text-xs text-arctic-900 focus:border-arctic-500 focus:outline-none"
          />
          <button className="btn-primary text-xs whitespace-nowrap" onClick={handleVoice} disabled={processing}>
            {processing ? 'Processing...' : 'Process'}
          </button>
        </div>
      </div>

      {/* Exact Count Banner */}
      <div className="subview-card rounded-2xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h3 className="font-bold text-arctic-900 text-sm" style={{ fontFamily: 'Outfit, sans-serif' }}>Exact Fuel Count — Maitri Station</h3>
          <p className="text-[11px] text-frost-muted mt-0.5">Precise SQL count, bypasses vector/RAG approximation</p>
        </div>
        <div className="flex items-center gap-4">
          {exactCount && (
            <span className="font-mono text-xl text-emerald-700 font-bold bg-emerald-50 border border-emerald-200 px-4 py-1.5 rounded-xl">
              {exactCount.quantity} {exactCount.unit}
            </span>
          )}
          <button className="btn-secondary text-xs" onClick={handleExactCount} disabled={loadingExact}>
            {loadingExact ? 'Querying...' : 'Get Exact Count'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Table */}
        <div className={`subview-card rounded-2xl p-6 ${selectedItem ? 'lg:col-span-2' : 'lg:col-span-3'}`}>
          <div className="flex justify-between items-center mb-5">
            <h2 className="text-base font-bold text-arctic-900" style={{ fontFamily: 'Outfit, sans-serif' }}>Inventory Levels</h2>
            <div className="flex items-center gap-3">
              <div className="flex gap-1 bg-arctic-50 p-1 rounded-xl border border-arctic-200">
                {['All', 'Maitri', 'Bharati'].map(s => (
                  <button
                    key={s}
                    onClick={() => setFilter(s)}
                    className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                      filter === s ? 'bg-white text-arctic-800 shadow-xs border border-arctic-200' : 'text-frost-muted hover:text-arctic-800'
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
              <button className="btn-secondary text-xs" onClick={loadInventory}>↺ Refresh</button>
            </div>
          </div>

          {loading ? (
            <div className="space-y-2">
              {[1,2,3,4,5].map(i => <div key={i} className="h-10 bg-arctic-50 rounded-xl animate-pulse" />)}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-arctic-100 text-frost-muted uppercase tracking-wider" style={{ fontFamily: 'Space Grotesk, sans-serif' }}>
                    <th className="pb-3 font-semibold">Item</th>
                    <th className="pb-3 font-semibold">Category</th>
                    <th className="pb-3 font-semibold">Station</th>
                    <th className="pb-3 font-semibold">Quantity</th>
                    <th className="pb-3 font-semibold">Rate/day</th>
                    <th className="pb-3 font-semibold">Cover</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-arctic-50">
                  {inventory.length === 0 ? (
                    <tr><td colSpan={6} className="py-8 text-center text-frost-muted">No inventory records found.</td></tr>
                  ) : inventory.map(item => (
                    <tr
                      key={item.id}
                      onClick={() => setSelectedItem((prev: any) => prev?.id === item.id ? null : item)}
                      className={`cursor-pointer transition-colors ${selectedItem?.id === item.id ? 'bg-arctic-50' : 'hover:bg-arctic-50/40'}`}
                    >
                      <td className="py-3 font-bold text-arctic-900">{item.name}</td>
                      <td className="py-3">
                        <span className={`px-2.5 py-1 rounded-full border text-[10px] font-semibold ${item.category === 'consumable' ? 'bg-amber-50 border-amber-200 text-amber-700' : 'bg-sky-50 border-sky-200 text-sky-700'}`}>
                          {item.category}
                        </span>
                      </td>
                      <td className="py-3 text-frost-muted">{item.station}</td>
                      <td className="py-3 font-mono text-arctic-800">{item.quantity} {item.unit}</td>
                      <td className="py-3 font-mono text-frost-muted">
                        {typeof item.depletion_rate === 'number' ? `${item.depletion_rate.toFixed(1)}` : '—'}
                      </td>
                      <td className="py-3">
                        {typeof item.days_of_cover === 'number' ? (
                          <span className={`font-bold ${getDaysColor(item.days_of_cover)}`}>
                            {item.days_of_cover.toFixed(1)}d
                          </span>
                        ) : <span className="text-frost-muted">n/a</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Detail panel */}
        {selectedItem && (
          <div className="subview-card rounded-2xl p-6">
            <div className="flex justify-between items-start mb-4">
              <h2 className="text-base font-bold text-arctic-900" style={{ fontFamily: 'Outfit, sans-serif' }}>Item Detail</h2>
              <button className="text-frost-muted hover:text-arctic-800 text-xs font-semibold px-2 py-1 rounded-lg hover:bg-arctic-50 transition-colors" onClick={() => setSelectedItem(null)}>✕ Close</button>
            </div>
            <div className="space-y-4 text-xs">
              <div>
                <span className="text-[10px] text-frost-muted uppercase tracking-wider" style={{ fontFamily: 'Space Grotesk, sans-serif' }}>Name</span>
                <p className="text-xl font-bold text-arctic-900 mt-0.5" style={{ fontFamily: 'Outfit, sans-serif' }}>{selectedItem.name}</p>
              </div>
              {[
                { label: 'Quantity',         val: `${selectedItem.quantity} ${selectedItem.unit}` },
                { label: 'Base Burn Rate',    val: selectedItem.base_burn_rate != null ? `${selectedItem.base_burn_rate} /day` : 'n/a' },
                { label: 'Sensitivity (β)',  val: selectedItem.beta != null ? String(selectedItem.beta) : 'n/a' },
                { label: 'Current ΔT',        val: `${selectedItem.delta_t ?? 0} °C` },
                { label: 'Depletion Rate',   val: typeof selectedItem.depletion_rate === 'number' ? `${selectedItem.depletion_rate.toFixed(2)} /day` : 'n/a' },
              ].map(row => (
                <div key={row.label}>
                  <span className="text-[10px] text-frost-muted uppercase tracking-wider" style={{ fontFamily: 'Space Grotesk, sans-serif' }}>{row.label}</span>
                  <p className="font-mono font-semibold text-arctic-900 mt-0.5">{row.val}</p>
                </div>
              ))}
              <div>
                <span className="text-[10px] text-frost-muted uppercase tracking-wider" style={{ fontFamily: 'Space Grotesk, sans-serif' }}>Days of Cover</span>
                <p className={`font-bold text-2xl mt-0.5 ${getDaysColor(selectedItem.days_of_cover)}`} style={{ fontFamily: 'Outfit, sans-serif' }}>
                  {typeof selectedItem.days_of_cover === 'number' ? `${selectedItem.days_of_cover.toFixed(1)}d` : 'n/a'}
                </p>
              </div>
            </div>
            <div className="mt-5 p-4 bg-arctic-50 rounded-xl border border-arctic-200">
              <p className="text-[10px] text-frost-muted mb-1.5 uppercase tracking-wider" style={{ fontFamily: 'Space Grotesk, sans-serif' }}>Formula</p>
              <code className="text-[11px] text-arctic-800 break-all font-mono leading-relaxed">
                days_of_cover = qty ÷ (base_rate × (1 + β × ΔT))
              </code>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
