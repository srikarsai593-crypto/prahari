// ─────────────────────────────────────────────────────────────────────────────
// Prahari — Shared TypeScript interfaces matching backend DB column names
// ─────────────────────────────────────────────────────────────────────────────

export interface Personnel {
  id: string;
  name: string;
  role: string | null;
  /** Home station. The backend has carried this since roster queries were
   *  scoped per base; the type simply never caught up. */
  station: string;
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
  telemetry?: Telemetry | null;
}

/** Derived navigation state for someone under active GPS tracking.
 *  Speed comes from the authorised schedule, not from wall-clock time between
 *  console ticks — the tick is a UI cadence, not a rate of travel. */
export interface Telemetry {
  heading_deg: number | null;
  heading_compass: string | null;
  speed_kmh: number | null;
  distance_remaining_km: number;
  eta_minutes: number | null;
  eta_at: string | null;
}

/** Who this browser is, as far as the station is concerned.
 *
 *  The console never holds the commander key - only whether it currently has a
 *  valid session. The key is exchanged once at sign-in for an httpOnly cookie
 *  that page script cannot read. */
export type StationRole = 'commander' | 'observer';

export interface SessionState {
  authenticated: boolean;
  actor: string | null;
  role: StationRole | null;
  via: 'session' | 'api_key' | null;
  /** What this caller may do. Read this rather than inferring it from the
   *  role name — adding a role later must not mean hunting for every place
   *  the browser guessed at permissions. */
  can_write: boolean;
  /** Whether this station hands out read-only sessions without the key. */
  observer_enabled: boolean;
  /** True on a kiosk deployment where reads are served anonymously. */
  public_reads: boolean;
  /** So the sign-in screen can offer the demo key where it is in use. */
  demo_key_enabled: boolean;
  /** The demo key itself, present only when it is the active key - in which
   *  case it is public by definition. Sourced from the station rather than
   *  hardcoded, so no credential-shaped literal ships in the bundle. */
  demo_key: string | null;
  server_time: string;
}

/**
 * Stages of an incident response. See backend/app/incident_lifecycle.py.
 *
 * `open` is the legacy word; the backend normalises it to `declared` and
 * still accepts it as a filter meaning "anything not resolved".
 */
export type IncidentStatus =
  'declared' | 'acknowledged' | 'responding' | 'contained' | 'resolved';

export const INCIDENT_STAGES: IncidentStatus[] =
  ['declared', 'acknowledged', 'responding', 'contained', 'resolved'];

export const STAGE_LABEL: Record<IncidentStatus, string> = {
  declared: 'Declared',
  acknowledged: 'Acknowledged',
  responding: 'Responding',
  contained: 'Contained',
  resolved: 'Resolved',
};

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
  /** Anything that is not resolved. Derived by the backend so no console has
   *  to keep its own copy of which stages are still live. */
  is_active?: boolean;
  stage_description?: string | null;
  /** Stages this incident may legally move to next. */
  next_stages?: IncidentStatus[];
  /** When each stage was entered — the figures a debrief is built on. */
  acknowledged_at?: string | null;
  responding_at?: string | null;
  contained_at?: string | null;
  resolved_at?: string | null;
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

export type AssetStatus = 'available' | 'standby' | 'deployed' | 'unavailable' | string;

export interface NearbyAsset {
  id: string;
  name: string;
  type: string;
  lat: number;
  lng: number;
  station: string;
  status: AssetStatus;
  /** The incident this asset is committed to, if any. */
  assigned_incident_id?: string | null;
  distance_m: number;
  updated_at?: string;
  /** Capability, not just position. */
  fuel_pct?: number | null;
  range_km?: number | null;
  speed_kmh?: number | null;
  seats?: number | null;
  medic_aboard?: number | null;
  /** 0–1. Distance is the largest single factor but no longer the only one. */
  suitability?: number;
  eta_minutes?: number | null;
  out_of_range?: boolean;
  factors?: { proximity: number; fuel: number; reach: number; medic: number };
  /** Why the ranking put it where it did, in words. */
  notes?: string[];
}

/** One step of an incident's Standard Operating Procedure. */
export interface IncidentTask {
  incident_id: string;
  task_key: string;
  label: string;
  position: number;
  done: boolean;
  done_at: string | null;
  done_by: string | null;
}

export interface IncidentSop {
  incident_id: string;
  type?: string;
  tasks: IncidentTask[];
  completed: number;
  total: number;
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
  /** Derived on read: the ETA has passed and nothing has been scanned in. */
  is_overdue?: boolean;
  hours_overdue?: number | null;
  stalled_warning?: string | null;
  /** The band this consignment must be kept in. Null on cargo that has none. */
  temp_min?: number | null;
  temp_max?: number | null;
  cold_chain?: ColdChain;
}

/**
 * Cold-chain state.
 *
 * `monitored: false` is most cargo — a crate of spares has no temperature it
 * must be kept at. `awaiting_reading` and `within` are deliberately distinct:
 * only one of them is reassuring.
 */
export interface ColdChain {
  monitored: boolean;
  state: 'unmonitored' | 'awaiting_reading' | 'within' | 'out_of_band';
  last_temp_c: number | null;
  last_temp_at?: string | null;
  /** 'manual' (someone read a gauge) or 'logger'. Prahari has no sensors. */
  last_temp_source?: 'manual' | 'logger' | null;
  temp_min?: number | null;
  temp_max?: number | null;
  /** Excursions recorded in transit — carried so a recovered crate still
   *  reports that it was out of band. */
  excursion_count: number;
  breach_summary: string | null;
}

export interface TemperatureResult {
  temp_c: number;
  band_state: 'within' | 'above' | 'below' | 'unmonitored';
  deviation_c: number | null;
  rate_c_per_h: number | null;
  breached: boolean;
  drifting: boolean;
  excursion: boolean;
  summary: string;
  excursion_count: number;
  cold_chain: ColdChain;
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
  /** Hours from now until the crate is due; negative backdates it, which is
   *  how an overdue convoy can be exercised without waiting a fortnight. */
  eta_hours?: number;
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
  /** Weather → cargo → expedition: the traverses this blizzard just undermined. */
  degraded_expeditions?: DegradedExpedition[];
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
  /** The score this traverse was approved against. */
  baseline_readiness_score?: number | null;
  /** What the station can support right now. The gap between the two is the
   *  degradation alarm: a stored score is a claim about a moment that passed. */
  live_readiness_score?: number | null;
  readiness_degraded?: boolean;
  readiness_checked_at?: string | null;
  live_feasibility?: FeasibilityLineItem[] | null;
}

/** Which supply-policy band a stock row is judged against. Derived from what
 *  the row actually is, because `category` only ever holds consumable/reusable. */
export type RiskClass = 'medical' | 'fuel' | 'rations' | 'spare_parts' | 'consumable';
export type StockState = 'critical' | 'depleting' | 'nominal';

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
  delta_t?: number;
  /** base_burn_rate scaled by live headcount, for what the crew consumes. */
  effective_base_rate?: number;
  /**
   * What the station actually consumed, derived from the audit log.
   *
   * `null` means nothing has been observed for this row. `rate: null` with a
   * reason means there is history but not enough of it to divide by — the two
   * are different states and the UI must not show either as a zero.
   */
  observed_burn?: {
    rate: number | null;
    movements: number;
    observed_days: number;
    consumed: number;
    reason: string | null;
  } | null;
  /** How the observed rate stands against the configured one. */
  observed_vs_configured?: { ratio: number | null; verdict: string } | null;
  headcount_factor?: number;
  risk_class?: RiskClass;
  /** Days of cover below which this row is critical / merely depleting. */
  critical_days?: number;
  warning_days?: number;
  /** The station's own floor for this row, if one has been set. */
  minimum_threshold?: number | null;
  safety_stock_days?: number | null;
  is_below_minimum?: boolean;
  stock_state?: StockState;
}

/** What a station's consumable burn rates are currently scaled against. */
export interface HeadcountBasis {
  station: string;
  headcount: number;
  nominal_headcount: number;
  factor: number;
}

/** A standing low-stock alert — persists in the audit log until stock recovers. */
export interface StockAlert {
  item_id: string;
  name: string;
  station: string;
  quantity: number;
  unit: string | null;
  days_of_cover: number;
  critical_days: number;
  is_below_minimum: boolean;
  minimum_threshold: number | null;
}

/** The same item across every station Prahari covers. */
export interface CrossStationStock {
  query: string;
  matched: number;
  items: InventoryItem[];
  units: string[];
  best_source: string | null;
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

/** An inbound consignment that would close a shortfall the check found. */
export interface ResupplyRecommendation {
  shipment_id: string;
  barcode_id: string;
  item_name: string;
  quantity: number | null;
  unit: string | null;
  eta: string | null;
  eta_hours: number | null;
  status: string;
  covers_shortfall: boolean;
  recommendation_text: string;
}

export interface FeasibilityLineItem {
  label: string;
  required: number;
  available: number;
  ok: boolean;
  detail?: string;
  resupply?: ResupplyRecommendation | null;
}

export interface FeasibilityResult {
  items: FeasibilityLineItem[];
  readiness_score: number;
  readiness_breakdown: Record<string, number>;
  /** The weights the breakdown was combined with, so the console can show
   *  contributions without keeping a second copy that would drift. */
  readiness_weights?: Record<string, number>;
}

// ── What-if projection ──────────────────────────────────────────────────────

/** A question about a station that does not exist yet. Every field is a
 *  change except delta_t, which is how weather is actually discussed. */
export interface WhatIfScenario {
  extra_crew?: number;
  delta_t?: number | null;
  cargo_delay_hours?: number;
  advance_days?: number;
}

export interface ProjectedStock {
  quantity: number;
  days_of_cover: number;
  depletion_rate: number;
  stock_state: string;
}

export interface WhatIfResult {
  station: string;
  scenario: WhatIfScenario;
  /** What the projection took as given, in the operator's own terms. */
  assumptions: string[];
  inventory: Array<{
    id: string; name: string; unit: string | null;
    before: ProjectedStock; after: ProjectedStock;
    cover_change_days: number; newly_critical: boolean;
  }>;
  expeditions: Array<{
    id: string; name: string; status: string;
    before_readiness: number; after_readiness: number; readiness_change: number;
    newly_short: string[]; resolved: string[]; blocked: boolean;
  }>;
  summary: {
    items_newly_critical: number;
    traverses_newly_blocked: number;
    worst_cover_change_days: number;
    worst_readiness_change: number;
  };
  /** Always true. A projection that does not announce itself is
   *  indistinguishable from a reading. */
  is_projection: boolean;
  persisted: boolean;
}

// ── Stockout risk ───────────────────────────────────────────────────────────

export interface StockoutForecast {
  available: boolean;
  observed_days: number;
  reason: string | null;
  trials?: number;
  horizon_days?: number;
  /** Day by which one trial in ten had run out — the planning figure. */
  p10_days?: number | null;
  p50_days?: number | null;
  survived_horizon_pct?: number;
  mean_daily?: number;
  spread?: { low: number; median: number; high: number };
}

export interface StockoutRisk {
  station: string;
  delta_t: number;
  headcount_factor: number;
  /** Named, because a percentile with no method behind it is over-read. */
  method: string;
  items: Array<{
    id: string; name: string; unit: string | null; quantity: number;
    days_of_cover: number;
    forecast: StockoutForecast;
    probability_lasts_pct?: number;
    until_days?: number;
  }>;
}

// ── Procurement: the leg before the ship ────────────────────────────────────

export type PurchaseOrderStatus = 'ordered' | 'confirmed' | 'shipped' | 'cancelled';

export interface PurchaseOrder {
  id: string;
  reference: string;
  vendor: string;
  item_name: string;
  category: CargoCategory | string;
  quantity: number | null;
  unit: string | null;
  inventory_item_id: string | null;
  destination_station: string;
  status: PurchaseOrderStatus | string;
  ordered_at: string;
  /** What the vendor promised. Null means no date was given. */
  promised_at: string | null;
  /** Set when the order is dispatched and becomes a real consignment. */
  shipment_id: string | null;
  notes: string | null;
  /** Derived on read from the promised date, as a shipment's is from its ETA. */
  is_overdue: boolean;
  days_overdue: number | null;
  slip_warning: string | null;
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

/** A traverse whose readiness has fallen below what it was approved against. */
export interface DegradedExpedition {
  expedition_id: string;
  name: string;
  station: string;
  status: string;
  baseline_readiness: number;
  live_readiness: number;
  degraded: boolean;
  shortfalls: Array<{ label: string; required: number; available: number;
                      detail?: string | null }>;
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

export interface DemoSeasonResult {
  status: string;
  created: { shipments: number; expeditions: number; incidents: number };
  now: StationCounts;
}
