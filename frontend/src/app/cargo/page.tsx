'use client';
import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { Html5Qrcode } from 'html5-qrcode';
import { api } from '@/lib/api';
import { useToast } from '@/components/Toast';

export default function CargoPage() {
  const { addToast } = useToast();
  const [shipments, setShipments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [manualCode, setManualCode] = useState('');
  const [windVal, setWindVal] = useState(28);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);

  const [form, setForm] = useState({
    item_name: '', category: 'fuel', weight_kg: 0,
    destination_station: 'Maitri', priority: 'normal',
  });

  const selectedShipment = shipments.find(s => s.id === selectedId);

  useEffect(() => {
    loadShipments();
    return () => { if (scannerRef.current) scannerRef.current.stop().catch(() => {}); };
  }, []);

  const loadShipments = async () => {
    setLoading(true);
    try {
      const data = await api.listShipments();
      setShipments(Array.isArray(data) ? data : []);
    } catch (e: any) {
      console.error('Failed to load shipments:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async () => {
    if (!form.item_name.trim()) return addToast('Item name is required', 'warning');
    try {
      await api.createShipment(form);
      addToast(`Shipment "${form.item_name}" registered into active manifest`, 'success');
      setForm({ item_name: '', category: 'fuel', weight_kg: 0, destination_station: 'Maitri', priority: 'normal' });
      loadShipments();
    } catch (e: any) { addToast(e?.message || 'Error creating shipment', 'alert'); }
  };

  const processScan = async (code: string) => {
    if (!code.trim()) return;
    try {
      await api.scanBarcode(code.trim());
      addToast('Barcode validated — shipment status updated', 'success');
      loadShipments();
    } catch (e: any) { addToast(e?.message || 'Scan failed', 'alert'); }
  };

  const handleManualScan = async () => {
    if (!manualCode.trim()) return addToast('Enter a barcode ID', 'warning');
    await processScan(manualCode);
    setManualCode('');
  };

  const handleFileScan = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const fileScanner = new Html5Qrcode('qr-file-scanner');
      const result = await fileScanner.scanFile(file, false);
      await processScan(result);
    } catch { addToast('Could not decode QR from image', 'alert'); }
    e.target.value = '';
  };

  const toggleWebcam = async () => {
    if (scanning) {
      if (scannerRef.current) { await scannerRef.current.stop().catch(() => {}); scannerRef.current = null; }
      setScanning(false); return;
    }
    try {
      const scanner = new Html5Qrcode('qr-reader');
      scannerRef.current = scanner;
      await scanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 200, height: 200 } },
        async (decodedText) => {
          await scanner.stop().catch(() => {}); scannerRef.current = null;
          setScanning(false); await processScan(decodedText);
        },
        () => {}
      );
      setScanning(true);
    } catch { addToast('Webcam not available — use manual scan', 'warning'); }
  };

  const handleRiskUpdate = async () => {
    if (!selectedId) return addToast('Select a shipment from the list first', 'warning');
    try {
      const deltaT = Math.round((windVal / 100) * 40);
      await api.updateRisk(selectedId, deltaT);
      addToast(`Applied ${windVal} knot blizzard conditions (ΔT +${deltaT}°C) to cargo routes`, windVal > 65 ? 'alert' : 'warning');
      loadShipments();
    } catch (e: any) { addToast(e?.message || 'Failed to update risk', 'alert'); }
  };

  const getRiskColor = (score: number) =>
    score > 70 ? 'text-rose-600' : score > 40 ? 'text-amber-600' : 'text-emerald-600';
  const getRiskBg = (score: number) =>
    score > 70 ? 'bg-rose-50 border-rose-200 text-rose-700' : score > 40 ? 'bg-amber-50 border-amber-200 text-amber-700' : 'bg-emerald-50 border-emerald-200 text-emerald-700';
  const getStatusStyle = (status: string) =>
    status === 'arrived' || status === 'unloaded'
      ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
      : status === 'in_transit'
      ? 'bg-sky-50 border-sky-200 text-sky-800'
      : 'bg-amber-50 border-amber-200 text-amber-800';

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <Link href="/" className="text-arctic-800 hover:text-arctic-600 flex items-center gap-2 text-xs font-semibold transition-colors bg-white px-3.5 py-1.5 rounded-xl border border-arctic-200 shadow-xs">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M15 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Dashboard
        </Link>
        <span className="text-xs bg-arctic-50 border border-arctic-200 text-arctic-800 px-3 py-1 rounded-full font-mono font-semibold">CGO-LOG-02</span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          {/* Create */}
          <div className="subview-card rounded-2xl p-7">
            <h2 className="text-lg font-bold text-arctic-900 mb-1 flex items-center gap-2" style={{ fontFamily: 'Outfit, sans-serif' }}>
              📦 Create Shipment
            </h2>
            <p className="text-xs text-frost-muted mb-4">Register a new cargo container into the active polar manifest.</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label>Item Name</label>
                <input type="text" className="w-full bg-white border border-arctic-200 rounded-xl px-3 py-2 text-xs text-arctic-900 focus:border-arctic-500 focus:outline-none" value={form.item_name} onChange={e => setForm({...form, item_name: e.target.value})} placeholder="e.g. Diesel Fuel"/>
              </div>
              <div>
                <label>Category</label>
                <select className="w-full bg-white border border-arctic-200 rounded-xl px-3 py-2 text-xs text-arctic-900 focus:border-arctic-500 focus:outline-none" value={form.category} onChange={e => setForm({...form, category: e.target.value})}>
                  <option value="fuel">Fuel</option>
                  <option value="food">Food</option>
                  <option value="equipment">Equipment</option>
                  <option value="medical">Medical</option>
                </select>
              </div>
              <div>
                <label>Weight (kg)</label>
                <input type="number" min="0" className="w-full bg-white border border-arctic-200 rounded-xl px-3 py-2 text-xs text-arctic-900 focus:border-arctic-500 focus:outline-none" value={form.weight_kg || ''} onChange={e => setForm({...form, weight_kg: parseFloat(e.target.value) || 0})} placeholder="500"/>
              </div>
              <div>
                <label>Destination</label>
                <select className="w-full bg-white border border-arctic-200 rounded-xl px-3 py-2 text-xs text-arctic-900 focus:border-arctic-500 focus:outline-none" value={form.destination_station} onChange={e => setForm({...form, destination_station: e.target.value})}>
                  <option>Maitri</option><option>Bharati</option><option>Himadri</option>
                </select>
              </div>
              <div>
                <label>Priority</label>
                <select className="w-full bg-white border border-arctic-200 rounded-xl px-3 py-2 text-xs text-arctic-900 focus:border-arctic-500 focus:outline-none" value={form.priority} onChange={e => setForm({...form, priority: e.target.value})}>
                  <option value="critical">Critical</option>
                  <option value="normal">Normal</option>
                  <option value="low">Low</option>
                </select>
              </div>
            </div>
            <div className="mt-5 flex justify-end">
              <button className="btn-primary text-xs" onClick={handleCreate} disabled={!form.item_name.trim()}>Create Shipment</button>
            </div>
          </div>

          {/* Table */}
          <div className="subview-card rounded-2xl p-7">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-arctic-900" style={{ fontFamily: 'Outfit, sans-serif' }}>Shipment Tracking</h2>
              <button className="btn-secondary text-xs" onClick={loadShipments}>↺ Refresh</button>
            </div>
            {loading ? (
              <div className="space-y-3">
                {[1,2,3].map(i => <div key={i} className="h-10 bg-arctic-50 rounded-xl animate-pulse" />)}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-arctic-100 text-frost-muted uppercase tracking-wider" style={{ fontFamily: 'Space Grotesk, sans-serif' }}>
                      <th className="pb-3 font-semibold">Item</th>
                      <th className="pb-3 font-semibold">Status</th>
                      <th className="pb-3 font-semibold">Risk</th>
                      <th className="pb-3 font-semibold text-right">Dest.</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-arctic-50">
                    {shipments.length === 0 ? (
                      <tr><td colSpan={4} className="py-8 text-center text-frost-muted">No shipments yet. Create one above.</td></tr>
                    ) : shipments.map(s => (
                      <tr
                        key={s.id}
                        onClick={() => setSelectedId(prev => prev === s.id ? null : s.id)}
                        className={`cursor-pointer transition-colors ${selectedId === s.id ? 'bg-arctic-50' : 'hover:bg-arctic-50/50'}`}
                      >
                        <td className="py-3">
                          <div className="font-bold text-arctic-900">{s.item_name}</div>
                          <div className="text-[10px] text-frost-muted font-mono">{s.barcode_id}</div>
                        </td>
                        <td className="py-3">
                          <span className={`px-2.5 py-1 rounded-full border text-[10px] font-semibold font-mono ${getStatusStyle(s.status)}`}>
                            {s.status}
                          </span>
                        </td>
                        <td className="py-3">
                          <span className={`px-2.5 py-1 rounded-full border text-[10px] font-semibold font-mono ${getRiskBg(s.risk_score)}`}>
                            {s.risk_score > 70 ? 'Severe' : s.risk_score > 40 ? 'Elevated' : 'Low'} ({s.risk_score}%)
                          </span>
                        </td>
                        <td className="py-3 text-right text-arctic-600 font-medium">{s.destination_station}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <div className="space-y-6">
          {/* QR */}
          <div className="subview-card rounded-2xl p-7 text-center">
            <h2 className="text-base font-bold text-arctic-900 mb-4" style={{ fontFamily: 'Outfit, sans-serif' }}>QR / Barcode Scan</h2>
            {selectedShipment?.qr_code ? (
              <div className="mb-4">
                <img src={`data:image/png;base64,${selectedShipment.qr_code}`} alt={`QR for ${selectedShipment.barcode_id}`} className="w-44 h-44 mx-auto border border-arctic-200 rounded-xl bg-white p-2 shadow-xs"/>
                <p className="text-[10px] text-frost-muted mt-2 font-mono">{selectedShipment.barcode_id}</p>
              </div>
            ) : (
              <div className="w-44 h-44 mx-auto bg-arctic-50 border-2 border-dashed border-arctic-200 rounded-xl flex flex-col items-center justify-center mb-4 gap-2">
                <svg className="w-8 h-8 text-arctic-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/>
                  <rect x="3" y="13" width="8" height="8" rx="1"/><path d="M13 13h2v2h-2zm4 0h2v2h-2zm0 4h2v2h-2zm-4 4h2v2h-2zm4 0h2v2h-2z"/>
                </svg>
                <span className="text-frost-muted text-[10px]">Select a shipment</span>
              </div>
            )}
            <div id="qr-reader" className={`mx-auto mb-4 overflow-hidden rounded-xl ${scanning ? 'block' : 'hidden'}`} style={{ maxWidth: 280 }} />
            <div id="qr-file-scanner" className="hidden" />
            <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileScan} />
            <div className="space-y-2">
              <button className="btn-secondary w-full text-xs" onClick={() => fileInputRef.current?.click()}>📁 Upload QR Image</button>
              <button className="btn-secondary w-full text-xs" onClick={toggleWebcam}>{scanning ? '⏹ Stop Webcam' : '📷 Scan with Webcam'}</button>
            </div>
            <div className="mt-3 flex gap-2">
              <input type="text" placeholder="Manual barcode ID" value={manualCode} onChange={e => setManualCode(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleManualScan()} className="flex-1 text-xs bg-white border border-arctic-200 rounded-xl px-3 py-2 focus:border-arctic-500 focus:outline-none"/>
              <button className="btn-secondary text-xs whitespace-nowrap" onClick={handleManualScan}>Scan</button>
            </div>
          </div>

          {/* Blizzard sim */}
          <div className="subview-card rounded-2xl p-7">
            <h2 className="text-base font-bold text-arctic-900 mb-1" style={{ fontFamily: 'Outfit, sans-serif' }}>Blizzard Simulator</h2>
            <p className="text-xs text-frost-muted mb-4">Simulate wind conditions affecting cargo routes.</p>
            <label>Wind Speed: <span className="text-arctic-700 font-bold ml-1">{windVal} Knots</span></label>
            <input type="range" min="0" max="100" value={windVal} onChange={e => setWindVal(parseInt(e.target.value))} className="my-3"/>
            <div className={`text-center py-2 px-3 rounded-xl border text-xs font-bold mb-4 ${windVal < 35 ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : windVal < 70 ? 'bg-amber-50 border-amber-200 text-amber-700' : 'bg-rose-50 border-rose-200 text-rose-700'}`}>
              {windVal < 35 ? `LOW RISK — 12% Vulnerability` : windVal < 70 ? `MODERATE RISK — ${Math.round(windVal * 0.7)}% Vulnerability` : `HIGH RISK — ${Math.round(windVal * 0.9)}% Vulnerability`}
            </div>
            <button className="btn-danger w-full text-xs" onClick={handleRiskUpdate}>Apply Weather Impact</button>
            {!selectedId && <p className="text-[10px] text-frost-muted text-center mt-2">Select a shipment above to apply impact</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
