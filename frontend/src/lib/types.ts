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
}

export interface Incident {
  id: string;
  type: 'medical' | 'fire' | 'severe_weather' | 'power_failure' | string;
  location_lat: number;
  location_lng: number;
  affected_radius_m: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: 'open' | 'resolved' | string;
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
  name: string;
  type: string;
  lat: number;
  lng: number;
  distance_m: number;
}

export interface Shipment {
  id: string;
  barcode_id: string;
  expedition_id: string | null;
  item_name: string;
  category: string;
  weight_kg: number;
  priority: 'low' | 'normal' | 'high' | 'critical';
  destination_station: string;
  status: 'dispatched' | 'in_transit' | 'arrived' | 'unloaded' | 'delayed' | string;
  dispatch_date: string | null;
  eta: string | null;
  risk_score: number;
  delay_reason: string | null;
  last_scanned_at: string | null;
  updated_at: string;
}

export interface ShipmentStatusTransition {
  id: string;
  barcode_id: string;
  old_status: Shipment['status'];
  new_status: Shipment['status'];
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
  status: 'draft' | 'active' | 'completed' | 'cancelled' | string;
  readiness_score: number | null;
  readiness_breakdown: string | null;
  feasibility_result: string | null;
  created_at: string;
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
}

export interface AppEvent {
  id: string;
  module: 'expedition' | 'cargo' | 'inventory' | 'personnel' | 'emergency' | string;
  action: string;
  actor: string;
  related_id: string | null;
  metadata: string | null;
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
