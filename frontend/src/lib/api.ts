import { offlineQueue } from './offlineQueue';

const BASE = '/api';

async function request<T = any>(url: string, options: RequestInit = {}, description = 'API request'): Promise<T> {
  const method = (options.method || 'GET').toUpperCase();

  if (offlineQueue.isOffline && method !== 'GET') {
    offlineQueue.enqueue(url, options, description);
    return { queued: true, pending: true } as T;
  }

  const response = await fetch(url, options);
  const text = await response.text();
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const message = (typeof data === 'object' ? (data?.detail || data?.message) : data) || `Request failed with ${response.status}`;
    throw new Error(Array.isArray(message) ? JSON.stringify(message) : String(message));
  }

  return data as T;
}

const jsonOptions = (method: string, data?: any): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: data === undefined ? undefined : JSON.stringify(data),
});

export const api = {
  // Expeditions
  listExpeditions: () => request(`${BASE}/expeditions`),
  getExpedition: (id: string) => request(`${BASE}/expeditions/${id}`),
  createExpedition: (data: any) => request(`${BASE}/expeditions`, jsonOptions('POST', data), 'create expedition'),
  parseNL: (text: string) => request(`${BASE}/expeditions/parse-nl`, jsonOptions('POST', { text }), 'parse expedition text'),
  checkFeasibility: (data: any) => request(`${BASE}/expeditions/feasibility`, jsonOptions('POST', data), 'check expedition feasibility'),
  
  // Shipments
  listShipments: (params?: any) => { const q = new URLSearchParams(params || {}).toString(); return request(`${BASE}/shipments${q ? `?${q}` : ''}`); },
  getShipment: (id: string) => request(`${BASE}/shipments/${id}`),
  createShipment: (data: any) => request(`${BASE}/shipments`, jsonOptions('POST', data), 'create shipment'),
  scanBarcode: (barcodeId: string) => request(`${BASE}/shipments/scan-barcode`, jsonOptions('POST', { barcode_id: barcodeId }), 'scan shipment barcode'),
  updateRisk: (id: string, deltaT: number) => request(`${BASE}/shipments/${id}/risk`, jsonOptions('POST', { delta_t: deltaT }), 'update shipment risk'),
  getCurrentDeltaT: () => request(`${BASE}/shipments/delta-t/current`),
  
  // Inventory
  listInventory: (params?: any) => { const q = new URLSearchParams(params || {}).toString(); return request(`${BASE}/inventory${q ? `?${q}` : ''}`); },
  getExactCount: (station: string, item: string) => request(`${BASE}/inventory/${station}/count?item=${encodeURIComponent(item)}`),
  voiceCommand: (transcript: string) => request(`${BASE}/inventory/voice-command`, jsonOptions('POST', { transcript }), 'process inventory voice command'),
  updateInventory: (id: string, data: any) => request(`${BASE}/inventory/${id}`, jsonOptions('PATCH', data), 'update inventory'),
  
  // Personnel
  listPersonnel: () => request(`${BASE}/personnel`),
  getPersonnel: (id: string) => request(`${BASE}/personnel/${id}`),
  listMovementPlans: () => request(`${BASE}/personnel/movement-plans`),
  createMovementPlan: (data: any) => request(`${BASE}/personnel/movement-plans`, jsonOptions('POST', data), 'create movement plan'),
  simulateMove: (id: string) => request(`${BASE}/personnel/${id}/simulate-move`, { method: 'POST' }, 'simulate personnel move'),
  resetSimulation: (id: string) => request(`${BASE}/personnel/${id}/reset-simulation`, { method: 'POST' }, 'reset personnel simulation'),
  triggerSOS: (id: string) => request(`${BASE}/personnel/${id}/sos`, { method: 'POST' }, 'trigger personnel SOS'),
  checkAccountability: (lat: number, lng: number, radius?: number) => request(`${BASE}/personnel/accountability/check?lat=${lat}&lng=${lng}&radius=${radius || 5000}`),
  updatePersonnelStatus: (id: string, status: string) => request(`${BASE}/personnel/${id}/status`, jsonOptions('PATCH', { status }), 'update personnel status'),
  
  // Incidents
  listIncidents: () => request(`${BASE}/incidents`),
  getIncident: (id: string) => request(`${BASE}/incidents/${id}`),
  createIncident: (data: any) => request(`${BASE}/incidents`, jsonOptions('POST', data), 'create incident'),
  updateIncident: (id: string, data: any) => request(`${BASE}/incidents/${id}`, jsonOptions('PATCH', data), 'update incident'),
  simulatePowerFailure: (station?: string) => request(`${BASE}/incidents/power-failure`, jsonOptions('POST', { station: station || 'Maitri' }), 'simulate power failure'),
  searchNearbyAssets: (lat: number, lng: number) => request(`${BASE}/incidents/nearby-assets/search?lat=${lat}&lng=${lng}`),
  getAccountability: (id: string) => request(`${BASE}/incidents/${id}/accountability`),
  
  // Events
  listEvents: (module?: string, limit?: number) => { const params = new URLSearchParams(); if(module) params.set('module', module); if(limit) params.set('limit', String(limit)); const q = params.toString(); return request(`${BASE}/events${q ? `?${q}` : ''}`); },
  createEvent: (data: any) => request(`${BASE}/events`, jsonOptions('POST', data), 'create event'),
};
