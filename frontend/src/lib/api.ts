import { offlineQueue } from './offlineQueue';
import type {
  Personnel, Incident, Accountability, NearbyAsset, Shipment,
  Expedition, InventoryItem, Geofence, MovementPlan, AppEvent,
  ParsedExpedition, FeasibilityResult, ShipmentStatusTransition,
} from './types';

const BASE = '/api';

const COMMANDER_KEY = process.env.NEXT_PUBLIC_COMMANDER_KEY || 'prahari-demo-2024';

async function request<T = unknown>(url: string, options: RequestInit = {}, description = 'API request'): Promise<T> {
  const method = (options.method || 'GET').toUpperCase();

  if (offlineQueue.isOffline && method !== 'GET') {
    offlineQueue.enqueue(url, options, description);
    return { queued: true, pending: true } as T;
  }

  const response = await fetch(url, options);
  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const message =
      (typeof data === 'object' && data !== null
        ? ((data as Record<string, unknown>)?.detail ?? (data as Record<string, unknown>)?.message)
        : data) || `Request failed with ${response.status}`;
    throw new Error(Array.isArray(message) ? JSON.stringify(message) : String(message));
  }

  return data as T;
}

/** Options for all mutation (non-GET) requests — includes auth key and JSON body. */
const jsonOptions = (method: string, data?: unknown): RequestInit => ({
  method,
  headers: {
    'Content-Type': 'application/json',
    ...(COMMANDER_KEY ? { 'X-Commander-Key': COMMANDER_KEY } : {}),
  },
  body: data === undefined ? undefined : JSON.stringify(data),
});

export const api = {
  // ── Expeditions ─────────────────────────────────────────────────────────────
  listExpeditions: () => request<Expedition[]>(`${BASE}/expeditions`),
  getExpedition: (id: string) => request<Expedition>(`${BASE}/expeditions/${id}`),
  createExpedition: (data: Partial<Expedition>) =>
    request<Expedition>(`${BASE}/expeditions`, jsonOptions('POST', data), 'create expedition'),
  parseNL: (text: string) =>
    request<ParsedExpedition>(`${BASE}/expeditions/parse-nl`, jsonOptions('POST', { text }), 'parse expedition text'),
  checkFeasibility: (data: { station: string; personnel_required: number; fuel_required_l: number }) =>
    request<FeasibilityResult>(`${BASE}/expeditions/feasibility`, jsonOptions('POST', data), 'check expedition feasibility'),

  // ── Shipments ───────────────────────────────────────────────────────────────
  listShipments: (params?: Record<string, string>) => {
    const q = new URLSearchParams(params ?? {}).toString();
    return request<Shipment[]>(`${BASE}/shipments${q ? `?${q}` : ''}`);
  },
  getShipment: (id: string) => request<Shipment>(`${BASE}/shipments/${id}`),
  createShipment: (data: Partial<Shipment>) =>
    request<Shipment>(`${BASE}/shipments`, jsonOptions('POST', data), 'create shipment'),
  scanBarcode: (barcodeId: string) =>
    request<ShipmentStatusTransition>(`${BASE}/shipments/scan-barcode`, jsonOptions('POST', { barcode_id: barcodeId }), 'scan shipment barcode'),
  updateRisk: (id: string, deltaT: number) =>
    request(`${BASE}/shipments/${id}/risk`, jsonOptions('POST', { delta_t: deltaT }), 'update shipment risk'),
  getCurrentDeltaT: () => request(`${BASE}/shipments/delta-t/current`),

  // ── Inventory ────────────────────────────────────────────────────────────────
  listInventory: (params?: Record<string, string>) => {
    const q = new URLSearchParams(params ?? {}).toString();
    return request<InventoryItem[]>(`${BASE}/inventory${q ? `?${q}` : ''}`);
  },
  getExactCount: (station: string, item: string) =>
    request(`${BASE}/inventory/${station}/count?item=${encodeURIComponent(item)}`),
  voiceCommand: (transcript: string) =>
    request(`${BASE}/inventory/voice-command`, jsonOptions('POST', { transcript }), 'process inventory voice command'),
  updateInventory: (id: string, data: Partial<InventoryItem>) =>
    request<InventoryItem>(`${BASE}/inventory/${id}`, jsonOptions('PATCH', data), 'update inventory'),

  // ── Personnel ────────────────────────────────────────────────────────────────
  listPersonnel: () => request<Personnel[]>(`${BASE}/personnel`),
  getPersonnel: (id: string) => request<Personnel>(`${BASE}/personnel/${id}`),
  listMovementPlans: () => request<MovementPlan[]>(`${BASE}/personnel/movement-plans`),
  createMovementPlan: (data: Partial<Omit<MovementPlan, 'planned_route'>> & { planned_route?: any[] }) =>
    request<MovementPlan>(`${BASE}/personnel/movement-plans`, jsonOptions('POST', data), 'create movement plan'),
  simulateMove: (id: string) =>
    request(`${BASE}/personnel/${id}/simulate-move`, jsonOptions('POST'), 'simulate personnel move'),
  resetSimulation: (id: string) =>
    request(`${BASE}/personnel/${id}/reset-simulation`, jsonOptions('POST'), 'reset personnel simulation'),
  triggerSOS: (id: string) =>
    request(`${BASE}/personnel/${id}/sos`, jsonOptions('POST'), 'trigger personnel SOS'),
  checkAccountability: (lat: number, lng: number, radius?: number) =>
    request<Accountability>(`${BASE}/personnel/accountability/check?lat=${lat}&lng=${lng}&radius=${radius ?? 5000}`),
  updatePersonnelStatus: (id: string, status: string) =>
    request<Personnel>(`${BASE}/personnel/${id}/status`, jsonOptions('PATCH', { status }), 'update personnel status'),

  // ── Incidents ────────────────────────────────────────────────────────────────
  listIncidents: () => request<Incident[]>(`${BASE}/incidents`),
  getIncident: (id: string) => request<Incident>(`${BASE}/incidents/${id}`),
  createIncident: (data: Partial<Incident>) =>
    request<Incident & Accountability>(`${BASE}/incidents`, jsonOptions('POST', data), 'create incident'),
  updateIncident: (id: string, data: Partial<Incident>) =>
    request<Incident>(`${BASE}/incidents/${id}`, jsonOptions('PATCH', data), 'update incident'),
  simulatePowerFailure: (station?: string) =>
    request(`${BASE}/incidents/power-failure`, jsonOptions('POST', { station: station ?? 'Maitri' }), 'simulate power failure'),
  searchNearbyAssets: (lat: number, lng: number) =>
    request<NearbyAsset[]>(`${BASE}/incidents/nearby-assets/search?lat=${lat}&lng=${lng}`),
  getAccountability: (id: string) =>
    request<Accountability>(`${BASE}/incidents/${id}/accountability`),

  // ── Geofences ────────────────────────────────────────────────────────────────
  listGeofences: () => request<Geofence[]>(`${BASE}/geofences`),

  // ── Events ───────────────────────────────────────────────────────────────────
  listEvents: (module?: string, limit?: number) => {
    const params = new URLSearchParams();
    if (module) params.set('module', module);
    if (limit) params.set('limit', String(limit));
    const q = params.toString();
    return request<AppEvent[]>(`${BASE}/events${q ? `?${q}` : ''}`);
  },
  createEvent: (data: Partial<AppEvent>) =>
    request<AppEvent>(`${BASE}/events`, jsonOptions('POST', data), 'create event'),
};
