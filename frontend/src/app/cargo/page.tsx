'use client';
import { useState, useEffect, useRef } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import { api } from '@/lib/api';
import { useToast } from '@/components/Toast';

export default function CargoPage() {
  const { addToast } = useToast();
  const [shipments, setShipments] = useState<any[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deltaT, setDeltaT] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [manualCode, setManualCode] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);

  const [form, setForm] = useState({
    item_name: '', category: 'fuel', weight_kg: 0, destination_station: 'Maitri', priority: 'normal'
  });

  const selectedShipment = shipments.find(s => s.id === selectedId);

  useEffect(() => {
    loadShipments();
    api.getCurrentDeltaT().then(res => setDeltaT(res.delta_t || 0));
    return () => {
      if (scannerRef.current) {
        scannerRef.current.stop().catch(() => {});
      }
    };
  }, []);

  const loadShipments = () => api.listShipments().then(data => setShipments(Array.isArray(data) ? data : []));

  const handleCreate = async () => {
    try {
      await api.createShipment(form);
      addToast('Shipment created', 'success');
      setForm({ item_name: '', category: 'fuel', weight_kg: 0, destination_station: 'Maitri', priority: 'normal' });
      loadShipments();
    } catch (e) {
      addToast('Error creating shipment', 'alert');
    }
  };

  const processScan = async (code: string) => {
    if (!code) return;
    try {
      await api.scanBarcode(code.trim());
      addToast('Scan successful, status updated', 'success');
      loadShipments();
    } catch (e) {
      addToast('Scan failed', 'alert');
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
      const result = await fileScanner.scanFile(file, false);
      await processScan(result);
    } catch (err) {
      addToast('Could not decode QR from image', 'alert');
    }
    e.target.value = '';
  };

  const toggleWebcam = async () => {
    if (scanning) {
      if (scannerRef.current) {
        await scannerRef.current.stop();
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
          await scanner.stop();
          scannerRef.current = null;
          setScanning(false);
          await processScan(decodedText);
        },
        () => {}
      );
      setScanning(true);
    } catch (err) {
      addToast('Webcam not available', 'warning');
    }
  };

  const handleRiskUpdate = async () => {
    try {
      if (!selectedId) return addToast('Select a shipment first', 'warning');
      await api.updateRisk(selectedId, deltaT);
      addToast('Risk updated based on Delta T', 'info');
      loadShipments();
    } catch (e) {
      addToast('Failed to update risk', 'alert');
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-2 space-y-6">
        <div className="glass-card p-6">
          <h2 className="text-xl font-bold mb-4 text-white">Create Shipment</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label>Item Name</label>
              <input type="text" value={form.item_name} onChange={e => setForm({...form, item_name: e.target.value})} />
            </div>
            <div>
              <label>Category</label>
              <select value={form.category} onChange={e => setForm({...form, category: e.target.value})}>
                <option value="fuel">Fuel</option>
                <option value="food">Food</option>
                <option value="equipment">Equipment</option>
                <option value="medical">Medical</option>
              </select>
            </div>
            <div>
              <label>Weight (kg)</label>
              <input type="number" value={form.weight_kg} onChange={e => setForm({...form, weight_kg: parseFloat(e.target.value)})} />
            </div>
            <div>
              <label>Destination</label>
              <select value={form.destination_station} onChange={e => setForm({...form, destination_station: e.target.value})}>
                <option value="Maitri">Maitri</option>
                <option value="Bharati">Bharati</option>
                <option value="Himadri">Himadri</option>
              </select>
            </div>
            <div>
              <label>Priority</label>
              <select value={form.priority} onChange={e => setForm({...form, priority: e.target.value})}>
                <option value="critical">Critical</option>
                <option value="normal">Normal</option>
                <option value="low">Low</option>
              </select>
            </div>
          </div>
          <button className="btn-primary mt-6" onClick={handleCreate}>Create Shipment</button>
        </div>

        <div className="glass-card p-6">
          <h2 className="text-xl font-bold mb-4 text-white">Tracking & Inventory</h2>
          <div className="space-y-4">
            {shipments.map(s => (
              <div key={s.id} onClick={() => setSelectedId(s.id)} className={`p-4 border rounded-lg cursor-pointer transition-colors ${selectedId === s.id ? 'border-polar-500 bg-polar-800/50' : 'border-polar-700/30 bg-polar-900/30 hover:border-polar-500/50'}`}>
                <div className="flex justify-between mb-2">
                  <div className="font-bold text-white">{s.item_name} <span className="text-xs font-normal text-polar-400">({s.barcode_id})</span></div>
                  <div className={`status-badge status-${s.status === 'arrived' || s.status === 'unloaded' ? 'safe' : s.status === 'in_transit' ? 'info' : 'warning'}`}>{s.status}</div>
                </div>
                <div className="flex justify-between text-sm text-polar-300">
                  <span>{s.category.toUpperCase()} | {s.weight_kg} kg</span>
                  <span>To: {s.destination_station}</span>
                </div>
                <div className="mt-2 h-2 bg-polar-950 rounded-full overflow-hidden">
                  <div className={`h-full ${s.risk_score > 70 ? 'bg-danger' : s.risk_score > 40 ? 'bg-warning' : 'bg-safe'}`} style={{width: `${s.risk_score}%`}}></div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="space-y-6">
        <div className="glass-card p-6 text-center">
          <h2 className="text-xl font-bold mb-4 text-white">QR Scanning</h2>
          {selectedShipment?.qr_code ? (
            <div className="mb-4">
              <img
                src={`data:image/png;base64,${selectedShipment.qr_code}`}
                alt={`QR for ${selectedShipment.barcode_id}`}
                className="w-48 h-48 mx-auto border border-polar-600 rounded-xl bg-white p-2"
              />
              <p className="text-xs text-polar-400 mt-2">{selectedShipment.barcode_id}</p>
            </div>
          ) : (
            <div className="w-48 h-48 mx-auto bg-polar-950 border-2 border-dashed border-polar-600 rounded-xl flex items-center justify-center mb-4">
              <span className="text-polar-400 text-sm px-4">Select a shipment to view QR</span>
            </div>
          )}

          <div id="qr-reader" className={`mx-auto mb-4 overflow-hidden rounded-xl ${scanning ? 'block' : 'hidden'}`} style={{ maxWidth: 300 }} />
          <div id="qr-file-scanner" className="hidden" />

          <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileScan} />
          <div className="space-y-2">
            <button className="btn-secondary w-full" onClick={() => fileInputRef.current?.click()}>
              Upload QR Image
            </button>
            <button className="btn-secondary w-full" onClick={toggleWebcam}>
              {scanning ? 'Stop Webcam' : 'Scan with Webcam'}
            </button>
          </div>

          <div className="mt-4 flex gap-2">
            <input
              type="text"
              placeholder="Manual barcode ID"
              value={manualCode}
              onChange={e => setManualCode(e.target.value)}
              className="flex-1 text-sm"
            />
            <button className="btn-secondary whitespace-nowrap" onClick={handleManualScan}>Scan</button>
          </div>
          <p className="text-xs text-polar-400 mt-4">Level H Error Correction supported</p>
        </div>

        <div className="glass-card p-6">
          <h2 className="text-xl font-bold mb-4 text-white">Blizzard Simulator</h2>
          <label>Temperature Drop (ΔT: {deltaT}°C)</label>
          <input type="range" min="0" max="40" value={deltaT} onChange={e => setDeltaT(parseInt(e.target.value))} className="my-4" />
          <button className="btn-danger w-full" onClick={handleRiskUpdate}>Apply Weather Impact</button>
        </div>
      </div>
    </div>
  );
}
