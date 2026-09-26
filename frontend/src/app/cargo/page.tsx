'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Package, RotateCw, Upload, Camera, Square, CloudSnow } from 'lucide-react';
import { Html5Qrcode } from 'html5-qrcode';
import { api } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { PageHeader } from '@/components/PageHeader';
import { useStation } from '@/components/StationProvider';
import { useWebSocket } from '@/components/WebSocketProvider';
import { useStationConditions } from '@/lib/useStationConditions';
import { STATIONS } from '@/lib/stations';
import type { Shipment, InventoryItem, CargoCategory, Priority } from '@/lib/types';

/** Shipping weight cap per vessel — mirrors CAPACITY_KG in the backend. */
const VESSEL_CAPACITY_KG = 10_000;

const CATEGORIES: CargoCategory[] = ['fuel', 'food', 'equipment', 'medical'];
const PRIORITIES: Priority[] = ['critical', 'normal', 'low'];

interface CargoForm {
  item_name: string;
  category: CargoCategory;
  weight_kg: number;
  quantity: number;
  inventory_item_id: string;
  origin_station: string;
  priority: Priority;
}

const emptyForm = (): CargoForm => ({
  item_name: '', category: 'fuel', weight_kg: 0, quantity: 0,
  inventory_item_id: '', origin_station: '', priority: 'normal',
});

export default function CargoPage() {
  const { addToast } = useToast();
  const { station, stationId, ready } = useStation();
  const { lastMessage } = useWebSocket();
  const { deltaT } = useStationConditions(stationId);

  const [shipments, setShipments] = useState<Shipment[]>([]);
  /** Destination stock rows, so a consignment can name what it tops up. */
  const [stock, setStock] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [manualCode, setManualCode] = useState('');
  const [creating, setCreating] = useState(false);
  const [applyingWeather, setApplyingWeather] = useState(false);
  const [form, setForm] = useState<CargoForm>(emptyForm);
  const [qr, setQr] = useState<string | null>(null);

  // The control sets the station's blizzard ΔT directly. It used to be labelled
  // in knots and converted through an invented wind-to-temperature formula,
  // which presented a made-up number as a measurement.
  const [deltaTInput, setDeltaTInput] = useState(12);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);

  const selectedShipment = shipments.find((s) => s.id === selectedId) ?? null;
  const selectedStock = stock.find((i) => i.id === form.inventory_item_id) ?? null;

  const load = useCallback(async () => {
    setLoading(true);
    const [ship, inv] = await Promise.allSettled([
      api.listShipments({ station: stationId }),
      api.listInventory({ station: stationId }),
    ]);
    if (ship.status === 'fulfilled') {
      setShipments(Array.isArray(ship.value) ? ship.value : []);
    } else {
      addToast('Could not reach the station records — check the connection indicator above',
        'alert');
    }
    if (inv.status === 'fulfilled') setStock(Array.isArray(inv.value) ? inv.value : []);
    setLoading(false);
  }, [stationId, addToast]);

  useEffect(() => { if (ready) void load(); }, [load, ready]);

  // Switching station invalidates a form aimed at the previous destination.
  useEffect(() => { setForm(emptyForm()); setSelectedId(null); }, [stationId]);

  useEffect(() => {
    if (!lastMessage) return;
    if (['shipment_update', 'blizzard_update', 'inventory_update', 'station_reset']
      .includes(lastMessage.type)) void load();
  }, [lastMessage, load]);

  // The list no longer inlines a base64 PNG per row (that was an O(n) image
  // encode per poll); fetch the one QR actually on screen.
  useEffect(() => {
    if (!selectedId) { setQr(null); return; }
    let cancelled = false;
    api.getShipmentQr(selectedId)
      .then((r) => { if (!cancelled) setQr(r.qr_code); })
      .catch(() => { if (!cancelled) setQr(null); });
    return () => { cancelled = true; };
  }, [selectedId]);

  useEffect(() => () => {
    if (scannerRef.current) {
      scannerRef.current.stop().catch(() => {}).finally(() => scannerRef.current?.clear());
    }
  }, []);

  // ── Create ─────────────────────────────────────────────────────────────────
  /** Picking the stock row fixes the item name and the units in one move. */
  const pickStock = (id: string) => {
    const item = stock.find((i) => i.id === id);
    setForm((prev) => ({
      ...prev,
      inventory_item_id: id,
      item_name: item?.name ?? prev.item_name,
      category: (item?.category === 'consumable' ? prev.category : prev.category),
    }));
  };

  const handleCreate = async () => {
    if (!form.item_name.trim()) return addToast('Item name is required', 'warning');
    if (form.weight_kg <= 0) return addToast('Enter the shipping weight in kg', 'warning');
    if (form.origin_station && form.quantity <= 0) {
      return addToast(
        `An inter-station transfer needs a quantity — state how much leaves ${form.origin_station}.`,
        'warning');
    }
    setCreating(true);
    try {
      const res = await api.createShipment({
        item_name: form.item_name.trim(),
        category: form.category,
        weight_kg: form.weight_kg,
        quantity: form.quantity > 0 ? form.quantity : undefined,
        unit: selectedStock?.unit ?? undefined,
        inventory_item_id: form.inventory_item_id || undefined,
        priority: form.priority,
        origin_station: form.origin_station || undefined,
        destination_station: stationId,
      });
      const route = form.origin_station
        ? `${form.origin_station} → ${station.label}`
        : `resupply → ${station.label}`;
      addToast(`${form.item_name} registered (${route})`, 'success');
      if (res.capacity_warning) addToast(res.capacity_warning, 'warning');
      if (res.restock_warning) addToast(res.restock_warning, 'warning');
      setForm(emptyForm());
      void load();
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Error creating shipment', 'alert');
    } finally { setCreating(false); }
  };

  // ── Scanning ───────────────────────────────────────────────────────────────
  const processScan = async (code: string) => {
    if (!code.trim()) return;
    try {
      const res = await api.scanBarcode(code.trim());
      addToast(`${res.barcode_id}: ${res.old_status} → ${res.new_status}`,
        res.new_status === 'unloaded' ? 'success' : 'info');
      void load();
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Scan failed', 'alert');
    }
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
      await processScan(await fileScanner.scanFile(file, false));
    } catch { addToast('Could not decode QR from image', 'alert'); }
    e.target.value = '';
  };

  const toggleWebcam = async () => {
    if (scanning) {
      if (scannerRef.current) {
        await scannerRef.current.stop().catch(() => {});
        scannerRef.current = null;
      }
      setScanning(false);
      return;
    }
    try {
      const scanner = new Html5Qrcode('qr-reader');
      scannerRef.current = scanner;
      await scanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 200, height: 200 } },
        async (decodedText) => {
          await scanner.stop().catch(() => {});
          scannerRef.current = null;
          setScanning(false);
          await processScan(decodedText);
        },
        () => {},
      );
      setScanning(true);
    } catch { addToast('Webcam not available — use manual scan', 'warning'); }
  };

  // ── Weather ────────────────────────────────────────────────────────────────
  /**
   * Weather belongs to the station, so this re-scores every active consignment
   * bound for it. The old control required selecting one shipment, wrote the
   * station ΔT from it and re-scored only that one, leaving every other crate
   * on the same route carrying risk from the previous blizzard.
   */
  const applyWeather = async () => {
    setApplyingWeather(true);
    try {
      const res = await api.applyStationWeather(stationId, deltaTInput);
      addToast(
        res.affected === 0
          ? `ΔT +${res.delta_t}°C recorded at ${station.label} — no active consignments to re-score`
          : `ΔT +${res.delta_t}°C applied at ${station.label} — ${res.affected} consignment(s) `
            + `re-scored, ${res.delayed} delayed`,
        res.delayed > 0 ? 'warning' : 'info');
      void load();
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Failed to apply weather', 'alert');
    } finally { setApplyingWeather(false); }
  };

  const activeCount = useMemo(
    () => shipments.filter((s) => !['arrived', 'unloaded'].includes(s.status)).length,
    [shipments]);

  const riskBg = (score: number) =>
    score > 70 ? 'bg-rose-50 border-rose-200 text-rose-700'
      : score > 40 ? 'bg-amber-50 border-amber-200 text-amber-700'
        : 'bg-emerald-50 border-emerald-200 text-emerald-700';
  const statusStyle = (status: string) =>
    status === 'arrived' || status === 'unloaded'
      ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
      : status === 'in_transit'
        ? 'bg-sky-50 border-sky-200 text-sky-800'
        : status === 'delayed'
          ? 'bg-rose-50 border-rose-200 text-rose-800'
          : 'bg-amber-50 border-amber-200 text-amber-800';

  const severity = deltaTInput < 14 ? 'LOW' : deltaTInput < 28 ? 'MODERATE' : 'SEVERE';
  const severityStyle = deltaTInput < 14
    ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
    : deltaTInput < 28
      ? 'bg-amber-50 border-amber-200 text-amber-700'
      : 'bg-rose-50 border-rose-200 text-rose-700';

  return (
    <div>
      <PageHeader
        title="Cargo & Logistics"
        code="CGO-LOG-02"
        description="Every crate coming into the station: what is in it, where it is up to, and
                     how the weather is affecting its arrival."
      >
        <button className="btn-secondary text-13" onClick={load}>
          <RotateCw size={14} aria-hidden="true" /> Refresh
        </button>
      </PageHeader>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          {/* ── Create ───────────────────────────────────────────────────── */}
          <div className="subview-card rounded-2xl p-7">
            <h2 className="text-lg font-bold text-arctic-900 mb-1 flex items-center gap-2">
              <Package size={18} className="text-arctic-600" aria-hidden="true" /> Create Shipment
            </h2>
            <p className="text-xs text-frost-muted mb-4">
              Register a crate coming into <strong>{station.label}</strong>. Say which supply it
              restocks and unloading will add it to the store automatically.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="cg-origin">Origin</label>
                <select id="cg-origin" value={form.origin_station}
                        onChange={(e) => setForm({ ...form, origin_station: e.target.value })}>
                  <option value="">External resupply vessel</option>
                  {STATIONS.filter((s) => s.id !== stationId).map((s) => (
                    <option key={s.id} value={s.id}>{s.label} (transfer)</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="cg-dest">Destination</label>
                {/* Fixed to the console's active station: a page that writes to
                    one base while the header names another is how stock ends up
                    somewhere nobody looks for it. */}
                <input id="cg-dest" type="text" value={station.label} readOnly
                       className="!bg-frost-subtle !text-frost-muted cursor-not-allowed" />
              </div>

              <div>
                <label htmlFor="cg-stock">Restocks</label>
                <select id="cg-stock" value={form.inventory_item_id}
                        onChange={(e) => pickStock(e.target.value)}>
                  <option value="">Nothing in particular</option>
                  {stock.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name} — {i.quantity} {i.unit}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="cg-item">Item Name</label>
                <input id="cg-item" type="text" value={form.item_name} placeholder="e.g. Diesel Fuel"
                       onChange={(e) => setForm({ ...form, item_name: e.target.value })} />
              </div>

              <div>
                <label htmlFor="cg-qty">
                  Contents {selectedStock ? `(${selectedStock.unit})` : '(units)'}
                </label>
                <input id="cg-qty" type="number" min="0" step="any"
                       value={form.quantity || ''} placeholder="900"
                       onChange={(e) => setForm({
                         ...form, quantity: parseFloat(e.target.value) || 0 })} />
                <p className="text-2xs text-frost-muted mt-1">
                  {selectedStock
                    ? `Added to ${selectedStock.name} at ${station.label} when the crate is unloaded.`
                    : 'Choose a supply above to have this added to the store automatically.'}
                </p>
              </div>
              <div>
                <label htmlFor="cg-weight">Shipping Weight (kg)</label>
                <input id="cg-weight" type="number" min="0" step="any"
                       value={form.weight_kg || ''} placeholder="500"
                       onChange={(e) => setForm({
                         ...form, weight_kg: parseFloat(e.target.value) || 0 })} />
                <p className="text-2xs text-frost-muted mt-1">
                  A vessel carries up to {VESSEL_CAPACITY_KG.toLocaleString()} kg.
                </p>
              </div>

              <div>
                <label htmlFor="cg-cat">Category</label>
                <select id="cg-cat" value={form.category}
                        onChange={(e) => setForm({
                          ...form, category: e.target.value as CargoCategory })}>
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c} className="capitalize">{c}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="cg-prio">Priority</label>
                <select id="cg-prio" value={form.priority}
                        onChange={(e) => setForm({
                          ...form, priority: e.target.value as Priority })}>
                  {PRIORITIES.map((pr) => (
                    <option key={pr} value={pr} className="capitalize">{pr}</option>
                  ))}
                </select>
              </div>
            </div>

            {form.origin_station && (
              <p className="mt-4 inset-panel p-3 text-xs text-arctic-800">
                Inter-station transfer: {form.quantity || '—'}{' '}
                {selectedStock?.unit ?? 'units'} of{' '}
                <strong>{form.item_name || 'the item'}</strong> leaves{' '}
                <strong>{form.origin_station}</strong> stock now and lands at{' '}
                <strong>{station.label}</strong> when the crate is unloaded.
              </p>
            )}

            <div className="mt-5 flex justify-end">
              <button className="btn-primary text-xs" onClick={handleCreate}
                      disabled={creating || !form.item_name.trim()}>
                {creating ? 'Registering…' : 'Create Shipment'}
              </button>
            </div>
          </div>

          {/* ── Table ────────────────────────────────────────────────────── */}
          <div className="subview-card rounded-2xl p-7">
            <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
              <h2 className="text-lg font-bold text-arctic-900">
                Shipment Tracking
                <span className="ml-2 text-xs font-normal text-frost-muted">
                  {activeCount} active
                </span>
              </h2>
              <button className="btn-secondary text-xs" onClick={load}>
                <RotateCw size={14} aria-hidden="true" /> Refresh
              </button>
            </div>
            {loading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-10 bg-arctic-50 rounded-xl animate-pulse" />
                ))}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-arctic-100 text-frost-muted uppercase
                                   tracking-wider">
                      <th className="pb-3 font-semibold">Item</th>
                      <th className="pb-3 font-semibold">Route</th>
                      <th className="pb-3 font-semibold">Contents</th>
                      <th className="pb-3 font-semibold">Status</th>
                      <th className="pb-3 font-semibold">Risk</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-arctic-50">
                    {shipments.length === 0 ? (
                      <tr><td colSpan={5} className="py-8 text-center text-frost-muted text-13">
                        No consignments routed to {station.label}. Register one above.
                      </td></tr>
                    ) : shipments.map((s) => (
                      <tr
                        key={s.id}
                        onClick={() => setSelectedId((prev) => (prev === s.id ? null : s.id))}
                        className={`cursor-pointer transition-colors ${
                          selectedId === s.id ? 'bg-arctic-50' : 'hover:bg-arctic-50/50'}`}
                      >
                        <td className="py-3">
                          <div className="font-bold text-arctic-900">{s.item_name}</div>
                          <div className="text-2xs text-frost-muted font-mono">{s.barcode_id}</div>
                        </td>
                        <td className="py-3 text-frost-muted whitespace-nowrap">
                          {s.origin_station ?? 'Resupply'} → {s.destination_station}
                        </td>
                        <td className="py-3 metric text-arctic-800 whitespace-nowrap">
                          {s.quantity != null ? `${s.quantity} ${s.unit ?? ''}` : '—'}
                        </td>
                        <td className="py-3">
                          <span className={`px-2.5 py-1 rounded-full border text-xs font-semibold
                                            font-mono whitespace-nowrap ${statusStyle(s.status)}`}>
                            {s.status.replace('_', ' ')}
                          </span>
                        </td>
                        <td className="py-3">
                          <span className={`px-2.5 py-1 rounded-full border text-xs font-semibold
                                            font-mono whitespace-nowrap ${riskBg(s.risk_score)}`}>
                            {s.risk_score > 70 ? 'Severe' : s.risk_score > 40 ? 'Elevated' : 'Low'}
                            {' '}({s.risk_score}%)
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <div className="space-y-6">
          {/* ── QR ───────────────────────────────────────────────────────── */}
          <div className="subview-card rounded-2xl p-7 text-center">
            <h2 className="text-base font-bold text-arctic-900 mb-4">QR / Barcode Scan</h2>
            {selectedShipment && qr ? (
              <div className="mb-4">
                <img src={`data:image/png;base64,${qr}`}
                     alt={`QR for ${selectedShipment.barcode_id}`}
                     className="w-44 h-44 mx-auto border border-arctic-200 rounded-xl bg-white
                                p-2 shadow-xs" />
                <p className="text-xs text-frost-muted mt-2 font-mono">
                  {selectedShipment.barcode_id}
                </p>
              </div>
            ) : (
              <div className="w-44 h-44 mx-auto bg-arctic-50 border-2 border-dashed
                              border-arctic-200 rounded-xl flex flex-col items-center
                              justify-center mb-4 gap-2">
                <svg className="w-8 h-8 text-arctic-300" fill="none" stroke="currentColor"
                     viewBox="0 0 24 24" aria-hidden="true">
                  <rect x="3" y="3" width="8" height="8" rx="1" />
                  <rect x="13" y="3" width="8" height="8" rx="1" />
                  <rect x="3" y="13" width="8" height="8" rx="1" />
                  <path d="M13 13h2v2h-2zm4 0h2v2h-2zm0 4h2v2h-2zm-4 4h2v2h-2zm4 0h2v2h-2z" />
                </svg>
                <span className="text-frost-muted text-2xs">Select a shipment</span>
              </div>
            )}
            <div id="qr-reader"
                 className={`mx-auto mb-4 overflow-hidden rounded-xl ${scanning ? 'block' : 'hidden'}`}
                 style={{ maxWidth: 280 }} />
            <div id="qr-file-scanner" className="hidden" />
            <input ref={fileInputRef} type="file" accept="image/*" className="hidden"
                   onChange={handleFileScan} />
            <div className="space-y-2">
              <button className="btn-secondary w-full text-xs"
                      onClick={() => fileInputRef.current?.click()}>
                <Upload size={14} aria-hidden="true" /> Upload QR Image
              </button>
              <button className="btn-secondary w-full text-xs" onClick={toggleWebcam}>
                {scanning
                  ? <><Square size={14} aria-hidden="true" /> Stop Webcam</>
                  : <><Camera size={14} aria-hidden="true" /> Scan with Webcam</>}
              </button>
            </div>
            <div className="mt-3 flex gap-2">
              <input type="text" placeholder="Manual barcode ID" value={manualCode}
                     onChange={(e) => setManualCode(e.target.value)}
                     onKeyDown={(e) => { if (e.key === 'Enter') void handleManualScan(); }}
                     className="flex-1" />
              <button className="btn-secondary text-xs whitespace-nowrap"
                      onClick={handleManualScan}>Scan</button>
            </div>
            <p className="text-2xs text-frost-muted mt-3 leading-relaxed">
              Each scan moves the crate one step along: dispatched, in transit, arrived, then
              unloaded. Unloading adds its contents to {station.label} stock.
            </p>
          </div>

          {/* ── Station weather ──────────────────────────────────────────── */}
          <div className="subview-card rounded-2xl p-7">
            <h2 className="text-base font-bold text-arctic-900 mb-1 flex items-center gap-2">
              <CloudSnow size={16} className="text-arctic-600" aria-hidden="true" />
              Blizzard Load — {station.label}
            </h2>
            <p className="text-xs text-frost-muted mb-4">
              Record how cold it is getting. Everything still on its way here is re-assessed for
              delay, and stock is expected to go faster in the same conditions.
            </p>

            <label htmlFor="cg-dt">
              Thermal delta — <span className="text-arctic-700 font-bold">ΔT +{deltaTInput}°C</span>
            </label>
            <input id="cg-dt" type="range" min="0" max="60" value={deltaTInput}
                   onChange={(e) => setDeltaTInput(parseInt(e.target.value, 10))}
                   className="my-3" />
            <div className={`text-center py-2 px-3 rounded-xl border text-xs font-bold mb-3
                             ${severityStyle}`}>
              {severity} — ΔT +{deltaTInput}°C
            </div>

            <dl className="inset-panel p-3 mb-4 flex items-center justify-between gap-2 text-xs">
              <dt className="text-frost-muted">Currently recorded</dt>
              <dd className="metric text-arctic-900">
                {deltaT === null ? 'No reading' : `ΔT +${deltaT.toFixed(1)}°C`}
              </dd>
            </dl>

            <button className="btn-danger w-full text-xs" onClick={applyWeather}
                    disabled={applyingWeather}>
              {applyingWeather ? 'Applying…' : `Apply to all ${station.label} cargo`}
            </button>
            <p className="text-2xs text-frost-muted text-center mt-2">
              {activeCount} active consignment{activeCount === 1 ? '' : 's'} will be re-scored.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
