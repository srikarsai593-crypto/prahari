// ─────────────────────────────────────────────────────────────────────────────
// Prahari — Shared TypeScript interfaces matching backend DB column names
// ─────────────────────────────────────────────────────────────────────────────

export interface Personnel {
  id: string;
  name: string;
  role: string | null;
  expedition_id: string | null;
  status: 'at_station' | 'in_transit' | 'field' | 'returned' | 'deviated' | 'sos' | 'off_duty' | string;
  current_lat: number | null;
  current_lng: number | null;
  last_update_at: string | null;
  simulation_step?: number;
  // Tracking computed fields (from list endpoint)
  movement_status?: string;
  overdue?: boolean;
  overdue_reason?: string | null;
  location_update_status?: string;
  location_update_warning?: string | null;
  last_update_age_minutes?: number | null;
  effective_status?: string;
  movement_plan_id?: string;
  destination_name?: string;
  expected_arrival?: string;
  has_movement_plan?: boolean;
  plan_status?: string;
  progress?: { step: number; total: number; percent: number } | null;
}

export type IncidentStatus = 'open' | 'resolved';

export interface Incident {
  id: string;
  type: 'medical' | 'fire' | 'severe_weather' | 'power_failure' | string;
  /** The station whose response radius the incident falls in. */
  station?: string | null;
  location_lat: number;
  location_lng: number;
  affected_radius_m: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: IncidentStatus | string;
  expected_count: number | null;
  confirmed_safe_count: number;
  unaccounted_count: number | null;
  created_at: string;
}

export interface Accountability {
  incident_id?: string;
  expected: number;
  confirmed_safe: number;
  unaccounted: number;
  personnel?: PersonnelInZone[];
}

export interface PersonnelInZone {
  id: string;
  name: string;
  role: string;
  status: string;
  distance_m: number;
}

export interface NearbyAsset {
  id: string;
  name: string;
  type: string;
  lat: number;
  lng: number;
  station: string;
  status: string;
  distance_m: number;
}

export type CargoCategory = 'fuel' | 'food' | 'equipment' | 'medical';
export type Priority = 'low' | 'normal' | 'high' | 'critical';

export interface Shipment {
  id: string;
  barcode_id: string;
  expedition_id: string | null;
  item_name: string;
  category: CargoCategory | string;
  /** Shipping weight — what the vessel carries and what the risk model scores. */
  weight_kg: number;
  /** What the crate contains, in the receiving station's own units. This is
   *  the figure that lands in inventory when the shipment is unloaded. */
  quantity: number | null;
  unit: string | null;
  /** The stock row this consignment tops up, so unloading cannot restock the
   *  wrong item. */
  inventory_item_id: string | null;
  priority: Priority;
  /** null = external resupply vessel. A station id makes it an inter-station
   *  transfer, and the stock leaves that station at dispatch. */
  origin_station: string | null;
  destination_station: string;
  status: 'dispatched' | 'in_transit' | 'arrived' | 'unloaded' | 'delayed' | string;
  dispatch_date: string | null;
  eta: string | null;
  risk_score: number;
  delay_reason: string | null;
  last_scanned_at: string | null;
  updated_at: string;
}

/** What the Cargo form sends. */
export interface ShipmentInput {
  item_name: string;
  category: CargoCategory;
  weight_kg: number;
  quantity?: number;
  unit?: string;
  inventory_item_id?: string;
  priority: Priority;
  origin_station?: string;
  destination_station: string;
  expedition_id?: string;
}

/** One station's blizzard load, and every consignment it re-scored. */
export interface StationWeatherResult {
  station: string;
  delta_t: number;
  affected: number;
  delayed: number;
  rescored: Array<{
    id: string; barcode_id: string; risk_score: number; status: string; eta: string;
  }>;
}

export interface ShipmentStatusTransition {
  id: string;
  barcode_id: string;
  old_status: Shipment['status'];
  new_status: Shipment['status'];
}

export type ExpeditionStatus = 'draft' | 'active' | 'completed' | 'cancelled';

/** A person named on an expedition's roster. */
export interface CrewMember {
  id: string;
  name: string;
  role: string | null;
  status: string;
  station: string;
}

/** What the planner form sends. `readiness_breakdown` goes out as an object and
 *  comes back as a JSON string on the record, so the two are typed separately. */
export interface ExpeditionInput {
  name: string;
  station: string;
  start_date?: string;
  end_date?: string;
  personnel_required: number;
  fuel_required_l: number;
  raw_request?: string;
  readiness_score?: number;
  readiness_breakdown?: Record<string, number>;
  /** Who is going. The expedition cannot be authorised until enough people
   *  are named on it. */
  crew_ids?: string[];
}

export interface Expedition {
  id: string;
  name: string;
  raw_request: string | null;
  station: string;
  start_date: string | null;
  end_date: string | null;
  personnel_required: number;
  fuel_required_l: number;
  status: ExpeditionStatus | string;
  readiness_score: number | null;
  readiness_breakdown: string | null;
  feasibility_result: string | null;
  created_at: string;
  /** The named roster. Assigned crew are committed to this traverse and are
   *  unavailable to any other until it closes. */
  crew?: CrewMember[];
  crew_assigned?: number;
  /** What changed when the status last moved — crew deployed, fuel drawn. */
  notes?: string[];
}

export interface InventoryItem {
  id: string;
  name: string;
  category: string;
  station: string;
  quantity: number;
  unit: string | null;
  base_burn_rate: number | null;
  beta: number;
  days_of_cover: number | null;
  updated_at: string;
  depletion_rate?: number | null;
}

export interface Geofence {
  id: string;
  name: string;
  type: 'station' | 'field_camp' | 'restricted' | string;
  center_lat: number;
  center_lng: number;
  radius_m: number;
}

export interface MovementPlanInput {
  personnel_id: string;
  origin_lat: number;
  origin_lng: number;
  destination_lat: number;
  destination_lng: number;
  destination_name: string;
  planned_route: Array<{ lat: number; lng: number }>;
  departure_time: string;
  expected_arrival: string;
}

export interface MovementPlan {
  id: string;
  personnel_id: string;
  origin_lat: number;
  origin_lng: number;
  destination_lat: number;
  destination_lng: number;
  destination_name: string;
  planned_route: string; // JSON string of [{lat, lng}]
  departure_time: string;
  expected_arrival: string;
  status: 'planned' | 'in_transit' | 'arrived' | 'deviated' | 'completed' | string;
  personnel_name?: string;
  overdue?: boolean;
  movement_status?: string;
}

export interface AppEvent {
  /** Monotonic ordering key. created_at has second resolution, so a single
   *  action produces several rows sharing a timestamp; sort by seq. */
  seq: number;
  id: string;
  module: 'expedition' | 'cargo' | 'inventory' | 'personnel' | 'emergency' | 'system' | string;
  action: string;
  actor: string;
  /** The base this event belongs to. null means station-agnostic (a system or
   *  cross-station entry) and is shown on every console. */
  station: string | null;
  related_id: string | null;
  metadata: string | Record<string, unknown> | null;
  created_at: string;
}

export interface ParsedExpedition extends Omit<Expedition, 'id' | 'status' | 'created_at' | 'readiness_score' | 'readiness_breakdown' | 'feasibility_result'> {
  parse_source: 'gemini' | 'ollama' | 'fallback';
}

export interface FeasibilityLineItem {
  label: string;
  required: number;
  available: number;
  ok: boolean;
  detail?: string;
}

export interface FeasibilityResult {
  items: FeasibilityLineItem[];
  readiness_score: number;
  readiness_breakdown: Record<string, number>;
}

export type ToastType = 'success' | 'warning' | 'alert' | 'info';

/** Deterministic SQL stock count — deliberately not an LLM/RAG answer. */
export interface ExactCount {
  item: string;
  quantity: number;
  unit: string | null;
  matched_rows: number;
  station: string;
  method: 'direct_sql_aggregate';
}

/** Result of a typed stock command — a preview when `dry_run` was set. */
export interface StockCommandResult {
  parsed: {
    action: 'increment' | 'decrement';
    quantity: number;
    item: string;
    location: string;
    parse_source: 'gemini' | 'ollama' | 'fallback';
  };
  applied: boolean;
  /** True when this was a preview: nothing was written. */
  dry_run?: boolean;
  /** The station the command was scoped to. */
  station?: string;
  old_quantity?: number;
  new_quantity?: number;
  item_id?: string;
  item_name?: string;
  unit?: string | null;
  warning?: string;
  error?: string;
  ambiguous_matches?: string[];
}

/** Blizzard delta-T is per station, not a single global value. */
export interface StationConditions {
  stations: Record<string, number>;
}

/** Operational records a station reset would clear. */
export interface StationCounts {
  movement_plans: number;
  incidents: number;
  shipments: number;
  expeditions: number;
  events: number;
  open_incidents: number;
}

export interface StationResetResult {
  status: string;
  scope: 'operational' | 'all';
  cleared: StationCounts;
  now: StationCounts;
}
