/**
 * Every message the station fans out on `/ws`, as a discriminated union.
 *
 * `data` used to be `any`, which meant a handler reading `data.personel_id`
 * compiled perfectly and silently never matched — and a field the backend
 * renamed took its consumers with it in silence. Narrowing on `type` now makes
 * the payload's shape known, so a wrong field name is a build failure rather
 * than a module that quietly stops updating.
 *
 * These shapes mirror what `manager.broadcast(...)` is actually called with in
 * the backend. When one changes there, this is the file that has to change
 * with it, and the compiler will point at every place that cared.
 */

import type {
  Accountability, DegradedExpedition, IncidentTask, NearbyAsset, PersonnelInZone, StockAlert,
  Telemetry,
} from './types';

export interface Progress {
  step: number;
  total: number;
  percent: number;
}

/** The alert payload that drives the station-wide critical banner. */
export interface StationAlert {
  type: 'sos' | 'geofence_violation' | 'incident' | 'incident_escalation' | 'power_failure'
    | 'route_deviation' | 'route_pre_flight_warning' | string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  message?: string;
  station?: string | null;
  personnel?: string;
  personnel_id?: string;
  geofence?: string;
  incident_id?: string;
  incident_type?: string;
  zones?: string[];
  lat?: number;
  lng?: number;
}

export type StationBroadcast =
  | { type: 'event'; data: {
      seq: number; id: string; module: string; action: string; actor: string;
      related_id: string | null; metadata: Record<string, unknown> | null;
      station: string | null; created_at: string;
    } }
  | { type: 'alert'; data: StationAlert }
  | { type: 'gps_update'; data: {
      personnel_id: string; name: string; lat: number; lng: number;
      last_update_at: string; alert: StationAlert | null;
      telemetry: Telemetry | null; progress: Progress | null;
    } }
  | { type: 'personnel_update'; data: {
      personnel_id?: string; status?: string; expedition_id?: string;
    } }
  | { type: 'inventory_update'; data: {
      item_id?: string; new_quantity?: number; station?: string;
    } }
  | { type: 'inventory_alert'; data: {
      station: string;
      changes: Array<Pick<StockAlert, 'item_id' | 'name' | 'station' | 'days_of_cover'
        | 'unit' | 'quantity'> & { state: 'raised' | 'cleared' }>;
    } }
  | { type: 'shipment_update'; data: { shipment_id: string; status: string } }
  | { type: 'blizzard_update'; data: {
      station: string; delta_t: number; delayed: number;
      rescored: Array<{ id: string; barcode_id: string; risk_score: number;
                        status: string; eta: string }>;
    } }
  | { type: 'accountability_update'; data: Accountability & {
      incident_id: string; personnel: PersonnelInZone[];
    } }
  | { type: 'incident_update'; data: {
      incident_id: string; status: string; severity?: string;
      affected_radius_m?: number; station?: string | null;
    } }
  | { type: 'incident_sop_update'; data: {
      incident_id: string; tasks: IncidentTask[]; completed: number; total: number;
    } }
  | { type: 'asset_update'; data: Partial<NearbyAsset> & { released_incident_id?: string } }
  | { type: 'expedition_update'; data: {
      expedition_id: string; status: string; station?: string;
    } }
  | { type: 'expedition_readiness'; data: {
      station: string; trigger: string; degraded: DegradedExpedition[];
    } }
  | { type: 'cascade_alert'; data: {
      station: string; delta_t: number; delayed: number;
      degraded: DegradedExpedition[]; summary: string;
    } }
  | { type: 'station_reset'; data: { scope: 'operational' | 'all'; cleared: unknown } };

export type StationMessageType = StationBroadcast['type'];

/** Payload for one message type, so a handler can be written against it. */
export type PayloadOf<T extends StationMessageType> =
  Extract<StationBroadcast, { type: T }>['data'];

const KNOWN_TYPES = new Set<string>([
  'event', 'alert', 'gps_update', 'personnel_update', 'inventory_update', 'inventory_alert',
  'shipment_update', 'blizzard_update', 'accountability_update', 'incident_update',
  'incident_sop_update', 'asset_update', 'expedition_update', 'expedition_readiness',
  'cascade_alert', 'station_reset',
]);

/**
 * True when `message` is one of the broadcasts above.
 *
 * A socket frame is data from the network, so this is a runtime check and not
 * a cast: a backend that is a version ahead can send a type this build has
 * never heard of, and the console should ignore it rather than crash a module.
 */
export function isStationBroadcast(message: unknown): message is StationBroadcast {
  return typeof message === 'object' && message !== null
    && typeof (message as { type?: unknown }).type === 'string'
    && KNOWN_TYPES.has((message as { type: string }).type);
}

/** Narrow a broadcast to one type, for a handler that only cares about one. */
export function isType<T extends StationMessageType>(
  message: StationBroadcast | null, type: T,
): message is Extract<StationBroadcast, { type: T }> {
  return message?.type === type;
}

/** True when the broadcast is any of the given types. */
export function isAnyOf(
  message: StationBroadcast | null, ...types: StationMessageType[]
): boolean {
  return message !== null && (types as string[]).includes(message.type);
}
