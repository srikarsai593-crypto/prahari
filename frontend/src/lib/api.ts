import { offlineQueue } from './offlineQueue';
import type {
  Personnel, Incident, Accountability, NearbyAsset, Shipment, ShipmentInput,
  Expedition, ExpeditionInput, ExpeditionStatus, InventoryItem, Geofence, MovementPlan, AppEvent,
  ParsedExpedition, FeasibilityResult, ShipmentStatusTransition, StationWeatherResult,
  ExactCount, StockCommandResult, StationConditions, MovementPlanInput,
  StationCounts, StationResetResult,
} from './types';

const BASE = '/api';

/**
 * Browser-visible by design: this is a single-operator station console, and the
 * key only gates writes against the station's own LAN backend. A multi-user
 * deployment must replace it with a real session — see README "Security model".
 */
export const COMMANDER_KEY = process.env.NEXT_PUBLIC_COMMANDER_KEY || 'prahari-demo-2024';

/** Header set on every mutation, including replays out of the offline queue. */
export const authHeaders = (): Record<string, string> => ({
  'Content-Type': 'application/json',
  ...(COMMANDER_KEY ? { 'X-Commander-Key': COMMANDER_KEY } : {}),
});

// Replays out of the offline queue must carry the same credentials as a live
// request. The queue never persists headers (they would go stale and would sit
// in localStorage), so it asks for them at flush time.
offlineQueue.setHeaderFactory(authHeaders);

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly url: string) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Marker returned when a mutation was parked in the offline queue. */
export interface QueuedResult { queued: true; pending: true }
export const isQueued = (v: unknown): v is QueuedResult =>
  typeof v === 'object' && v !== null && (v as QueuedResult).queued === true;

function extractMessage(data: unknown, status: number): string {
  if (typeof data === 'string' && data) return data;
  if (typeof data === 'object' && data !== null) {
    const d = data as Record<string, unknown>;
    const detail = d.detail ?? d.message;
    if (typeof detail === 'string') return detail;
    // FastAPI validation errors arrive as [{loc, msg, type}] — render them as
    // something an operator can act on rather than raw JSON.
    if (Array.isArray(detail)) {
      return detail
        .map((e) => {
          const item = e as { loc?: unknown[]; msg?: string };
          const field = Array.isArray(item.loc) ? item.loc.slice(1).join('.') : '';
          return field ? `${field}: ${item.msg}` : item.msg;
        })
        .filter(Boolean)
        .join('; ');
    }
  }
  // Nothing usable came back, so say what it means rather than echoing a code.
  if (status === 404) return 'That record no longer exists — refresh and try again.';
  if (status === 409) return 'That change conflicts with what the station currently holds.';
  if (status >= 500) return 'The station could not complete that. Try again in a moment.';
  return 'That request could not be completed.';
}

async function request<T = unknown>(
  url: string,
  options: RequestInit = {},
  description = 'API request',
): Promise<T> {
  const method = (options.method || 'GET').toUpperCase();

  if (offlineQueue.isOffline && method !== 'GET') {
    offlineQueue.enqueue(url, options, description);
    return { queued: true, pending: true } as T;
  }

  let response: Response;
  try {
    response = await fetch(url, options);
  } catch (cause) {
    // A network failure on a mutation must not be lost: park it so it replays
    // when the link comes back, exactly like an explicit offline mutation.
    if (method !== 'GET') {
      offlineQueue.enqueue(url, options, description);
      return { queued: true, pending: true } as T;
    }
    throw new ApiError(
      `Cannot reach the station right now (${description}). Check the connection indicator.`,
      0, url);
  }

  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }

  if (!response.ok) throw new ApiError(extractMessage(data, response.status), response.status, url);
  return data as T;
}

const jsonOptions = (method: string, data?: unknown): RequestInit => ({
  method,
  headers: authHeaders(),
  body: data === undefined ? undefined : JSON.stringify(data),
});

const qs = (params?: Record<string, string | undefined>) => {
  if (!params) return '';
  const search = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v != null && v !== '') as [string, string][],
  ).toString();
  return search ? `?${search}` : '';
};

export const api = {
  // ── Expeditions ────────────────────────────────────────────────────────────
  /** Filtering belongs on the server: every caller was fetching all three
   *  stations' records and throwing two thirds away. */
  listExpeditions: (params?: { station?: string; status?: string }) =>
    request<Expedition[]>(`${BASE}/expeditions${qs(params)}`),
  createExpedition: (data: ExpeditionInput) =>
    request<Expedition>(`${BASE}/expeditions`, jsonOptions('POST', data), 'create expedition'),
  /** draft → active → completed, or cancelled. Activating re-runs the
   *  feasibility check and is refused if the station is short. */
  updateExpeditionStatus: (id: string, status: ExpeditionStatus) =>
    request<Expedition>(`${BASE}/expeditions/${id}`, jsonOptions('PATCH', { status }),
      'update expedition status'),
  parseNL: (text: string) =>
    request<ParsedExpedition>(`${BASE}/expeditions/parse-nl`, jsonOptions('POST', { text }),
      'parse expedition text'),
  /** `expeditionId` counts the crew already named on that traverse as
   *  available to it, so assigning people does not make it read short-staffed. */
  checkFeasibility: (data: {
    station: string; personnel_required: number; fuel_required_l: number;
    expedition_id?: string;
  }) =>
    request<FeasibilityResult>(`${BASE}/expeditions/feasibility`, jsonOptions('POST', data),
      'check expedition readiness'),
  /** Set the named roster on a traverse that has not departed. */
  setExpeditionCrew: (id: string, crewIds: string[]) =>
    request<Expedition>(`${BASE}/expeditions/${id}/crew`,
      jsonOptions('PATCH', { crew_ids: crewIds }), 'update expedition crew'),

  // ── Shipments ──────────────────────────────────────────────────────────────
  listShipments: (params?: Record<string, string>) =>
    request<Shipment[]>(`${BASE}/shipments${qs(params)}`),
  /** QR images are fetched per shipment, not inlined into every list response. */
  getShipmentQr: (id: string) =>
    request<{ barcode_id: string; qr_code: string }>(`${BASE}/shipments/${id}/qr`),
  createShipment: (data: ShipmentInput) =>
    request<Shipment & { capacity_warning?: string; restock_warning?: string }>(
      `${BASE}/shipments`, jsonOptions('POST', data), 'create shipment'),
  scanBarcode: (barcodeId: string) =>
    request<ShipmentStatusTransition>(`${BASE}/shipments/scan-barcode`,
      jsonOptions('POST', { barcode_id: barcodeId }), 'scan shipment barcode'),
  /**
   * Blizzard load is a property of the STATION, so this re-scores every active
   * consignment bound for it. Scoring one selected shipment left every other
   * crate on the same route carrying risk from the previous weather.
   */
  applyStationWeather: (station: string, deltaT: number) =>
    request<StationWeatherResult>(`${BASE}/shipments/weather`,
      jsonOptions('POST', { station, delta_t: deltaT }), 'apply station weather'),
  getStationConditions: () => request<StationConditions>(`${BASE}/shipments/delta-t/current`),

  // ── Inventory ──────────────────────────────────────────────────────────────
  listInventory: (params?: Record<string, string>) =>
    request<InventoryItem[]>(`${BASE}/inventory${qs(params)}`),
  getExactCount: (station: string, item: string) =>
    request<ExactCount>(`${BASE}/inventory/${station}/count?item=${encodeURIComponent(item)}`),
  /**
   * Typed stock adjustment. `station` is the console's active station and the
   * backend restricts the item match to it — an unscoped command matched the
   * same item name at all three bases and was never applied.
   * `dryRun` returns the parse and the matched row without writing.
   */
  stockCommand: (transcript: string, station: string, dryRun = false) =>
    request<StockCommandResult>(`${BASE}/inventory/command`,
      jsonOptions('POST', { transcript, station, dry_run: dryRun }),
      'process inventory stock command'),
  updateInventory: (id: string, quantity: number, station?: string) =>
    request<InventoryItem>(`${BASE}/inventory/${id}`,
      jsonOptions('PATCH', { quantity, station }), 'update inventory'),

  // ── Personnel ──────────────────────────────────────────────────────────────
  /** `station` narrows the roster to one base — the console's active station. */
  listPersonnel: (station?: string) =>
    request<Personnel[]>(`${BASE}/personnel${qs({ station })}`),
  listMovementPlans: (station?: string) =>
    request<MovementPlan[]>(`${BASE}/personnel/movement-plans${qs({ station })}`),
  createMovementPlan: (data: MovementPlanInput) =>
    request<MovementPlan & { route_warnings: string[] }>(`${BASE}/personnel/movement-plans`,
      jsonOptions('POST', data), 'create movement plan'),
  simulateMove: (id: string) =>
    request<{ status?: string; position?: { lat: number; lng: number };
              alert?: { type: string; message?: string } | null;
              progress?: { step: number; total: number; percent: number } }>(
      `${BASE}/personnel/${id}/simulate-move`, jsonOptions('POST'), 'advance GPS fix'),
  resetSimulation: (id: string) =>
    request(`${BASE}/personnel/${id}/reset-simulation`, jsonOptions('POST'),
      'reset personnel simulation'),
  triggerSOS: (id: string) =>
    request<{ incident_id: string; personnel: string; unaccounted: number }>(
      `${BASE}/personnel/${id}/sos`, jsonOptions('POST'), 'trigger personnel SOS'),
  updatePersonnelStatus: (id: string, status: string) =>
    request<Personnel>(`${BASE}/personnel/${id}/status`, jsonOptions('PATCH', { status }),
      'update personnel status'),

  // ── Incidents ──────────────────────────────────────────────────────────────
  listIncidents: (params?: Record<string, string>) =>
    request<Incident[]>(`${BASE}/incidents${qs(params)}`),
  createIncident: (data: Partial<Incident>) =>
    request<Incident & { expected_count: number; confirmed_safe_count: number;
                         unaccounted_count: number }>(
      `${BASE}/incidents`, jsonOptions('POST', data), 'declare emergency'),
  updateIncident: (id: string, status: 'open' | 'resolved') =>
    request<Incident>(`${BASE}/incidents/${id}`, jsonOptions('PATCH', { status }),
      'update incident'),
  /** Declares a real power-failure incident at the station, with an
   *  accountability count — not just a toast. */
  declarePowerFailure: (station: string) =>
    request<{ incident_id: string; unaccounted_count: number; expected_count: number }>(
      `${BASE}/incidents/power-failure`, jsonOptions('POST', { station }),
      'declare power failure'),
  searchNearbyAssets: (lat: number, lng: number) =>
    request<NearbyAsset[]>(`${BASE}/incidents/nearby-assets/search?lat=${lat}&lng=${lng}`),
  /** Read-only head-count. Does not write or broadcast. */
  readAccountability: (id: string) =>
    request<Accountability>(`${BASE}/incidents/${id}/accountability`),
  /** Recomputes, persists and broadcasts — a deliberate write. */
  refreshAccountability: (id: string) =>
    request<Accountability>(`${BASE}/incidents/${id}/accountability`, jsonOptions('POST'),
      'refresh accountability'),

  // ── Geofences ──────────────────────────────────────────────────────────────
  listGeofences: () => request<Geofence[]>(`${BASE}/geofences`),

  // ── Events ─────────────────────────────────────────────────────────────────
  /**
   * `station` returns that base's events plus the station-agnostic ones.
   * Without it the Maitri timeline reported Bharati's activity as its own.
   * There is deliberately no write: the audit trail is written by the module
   * that owns the action, never by the browser.
   */
  listEvents: (params?: { module?: string; station?: string; limit?: number }) =>
    request<AppEvent[]>(`${BASE}/events${qs({
      module: params?.module,
      station: params?.station,
      limit: params?.limit ? String(params.limit) : undefined,
    })}`),

  // ── Station housekeeping ───────────────────────────────────────────────────
  /** What a reset would clear — shown before the operator confirms. */
  stationCounts: () => request<StationCounts>(`${BASE}/admin/counts`),
  /** Clears operational records and restores the seeded baseline. */
  resetStation: (scope: 'operational' | 'all' = 'operational') =>
    request<StationResetResult>(`${BASE}/admin/reset`,
      jsonOptions('POST', { confirm: 'RESET', scope }), 'reset station'),
};
