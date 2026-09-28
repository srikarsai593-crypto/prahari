import { api } from './api';
import { encodeSitrep } from './hfRadio';
import { RULE, heading, masthead, row, stamp } from './textReport';
import { getStation, polarDaylight, seasonalNormal } from './stations';
import type {
  AppEvent, Incident, InventoryItem, Personnel, PurchaseOrder, Shipment, StockAlert,
} from './types';

/**
 * The shift handover brief.
 *
 * A polar station runs continuously and the console does not. When the day
 * commander goes to sleep, everything they know that is not written down
 * goes with them — which consignment is late, who is still out, which stock
 * row they have been watching all week. The relief reads a dashboard showing
 * the *present* and has no way to see what was being tracked.
 *
 * This is the artefact that closes that gap, and it is a different document
 * from the post-incident debrief in `debrief.ts`: that one is retrospective,
 * concerns a single closed incident, and is filed. This one is station-wide,
 * forward-looking, and thrown away at the end of the next watch.
 *
 * ## What it is allowed to contain
 *
 * Only what the station's own records say, read at generation time. The
 * brief carries no judgement of its own — it does not decide that a
 * consignment is "probably fine", or round a head-count. Where a figure is a
 * published climatological normal rather than a measurement, it says so on
 * the line, because a handover is read quickly by someone who has just woken
 * up and that is precisely when an unlabelled number gets taken as a reading.
 *
 * Sections are ordered by what gets somebody killed first: people, then
 * incidents, then conditions, then stores, then cargo, then paperwork.
 */

/** How much of the audit tail to carry. A watch is 8–12 hours; this is
 *  enough to cover one without becoming a log dump nobody reads. */
const ACTIVITY_LINES = 25;

/** Personnel states that mean "not inside the station". */
const AWAY_STATUSES = new Set(['field', 'in_transit', 'deviated', 'sos']);

export interface HandoverSources {
  station: string;
  incidents: Incident[];
  personnel: Personnel[];
  inventory: InventoryItem[];
  alerts: StockAlert[];
  shipments: Shipment[];
  orders: PurchaseOrder[];
  events: AppEvent[];
  /** ΔT per station, as the cargo model uses it. Null when unreadable. */
  deltaT: number | null;
  /** Which sources could not be read, so the document can say so. */
  unavailable: string[];
}

/**
 * Pull everything the brief cites, in one pass.
 *
 * Each source fails on its own. A handover missing its cargo section
 * because that one call timed out is worth incomparably more than no
 * handover, and the document names what it could not read rather than
 * quietly printing a section that looks empty and reassuring.
 */
export async function collectHandover(station: string): Promise<HandoverSources> {
  const unavailable: string[] = [];
  const note = <T>(label: string, fallback: T) => (reason: unknown): T => {
    void reason;
    unavailable.push(label);
    return fallback;
  };

  const [incidents, personnel, inventory, alerts, shipments, orders, events, conditions] =
    await Promise.all([
      api.listIncidents({ station }).catch(note('Incidents', [] as Incident[])),
      api.listPersonnel(station).catch(note('Personnel roster', [] as Personnel[])),
      api.listInventory({ station }).catch(note('Inventory', [] as InventoryItem[])),
      api.listStockAlerts(station).catch(note('Stock alerts', [] as StockAlert[])),
      api.listShipments({ station }).catch(note('Cargo', [] as Shipment[])),
      api.listPurchaseOrders(station).catch(note('Procurement', [] as PurchaseOrder[])),
      api.listEvents({ station, limit: 200 }).catch(note('Audit log', [] as AppEvent[])),
      api.getStationConditions().catch(note('Station conditions', null)),
    ]);

  return {
    station,
    incidents: incidents ?? [],
    personnel: personnel ?? [],
    inventory: inventory ?? [],
    alerts: alerts ?? [],
    shipments: shipments ?? [],
    orders: orders ?? [],
    events: events ?? [],
    deltaT: conditions?.stations?.[station] ?? null,
    unavailable,
  };
}

// ── Derived figures ────────────────────────────────────────────────────────

/** Anything not resolved. `is_active` is derived by the backend; the status
 *  check is the fallback for a row from before that field existed. */
export const activeIncidents = (incidents: Incident[]): Incident[] =>
  incidents.filter((i) => i.is_active ?? !['resolved', 'closed'].includes(String(i.status)));

export const awayFromStation = (personnel: Personnel[]): Personnel[] =>
  personnel.filter((p) => AWAY_STATUSES.has(String(p.effective_status ?? p.status)));

/**
 * People the station should be chasing.
 *
 * Overdue against a movement plan, or reporting an SOS. Deliberately not
 * "everyone outside" — on a working station that is most of the day shift,
 * and a list that always has forty names on it stops being read.
 */
export const outstanding = (personnel: Personnel[]): Personnel[] =>
  personnel.filter((p) => p.overdue === true
    || String(p.effective_status ?? p.status) === 'sos'
    || String(p.effective_status ?? p.status) === 'deviated');

export const overdueCargo = (shipments: Shipment[]): Shipment[] =>
  shipments.filter((s) => s.is_overdue === true || s.status === 'delayed');

/**
 * Cargo that is out of its temperature band, or that was at some point.
 *
 * `excursion_count` is included deliberately: a crate that went out of band
 * in transit and has since come back reads `within` now, and a relief
 * commander still needs to be told, because whether the contents survived is
 * a judgement someone has to make on arrival.
 *
 * `awaiting_reading` is NOT a breach. It means nobody has read the gauge
 * yet, which belongs in the cargo section as an outstanding task, not here
 * as a temperature failure.
 */
export const coldChainBreaches = (shipments: Shipment[]): Shipment[] =>
  shipments.filter((s) => s.cold_chain
    && (s.cold_chain.state === 'out_of_band' || s.cold_chain.excursion_count > 0));

/** Stores at or below the station's critical threshold. */
export const criticalStock = (alerts: StockAlert[]): StockAlert[] =>
  [...alerts].sort((a, b) => a.days_of_cover - b.days_of_cover);

// ── Rendering ──────────────────────────────────────────────────────────────

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function renderHandover(sources: HandoverSources, generatedAt = new Date()): string {
  const station = getStation(sources.station);
  const out: string[] = [];

  const live = activeIncidents(sources.incidents);
  const away = awayFromStation(sources.personnel);
  const chase = outstanding(sources.personnel);
  const alerts = criticalStock(sources.alerts);
  const late = overdueCargo(sources.shipments);
  const breaches = coldChainBreaches(sources.shipments);

  out.push(...masthead('SHIFT HANDOVER BRIEF', `${station.label} — ${station.region}`));
  out.push(row('Generated', stamp(generatedAt.toISOString())));
  out.push(row('Station', station.label));
  out.push(row('Roster on strength', sources.personnel.length));

  if (sources.unavailable.length > 0) {
    out.push('');
    out.push(`  ** INCOMPLETE — could not be read at generation time: `
      + `${sources.unavailable.join(', ')}. Treat each of those sections as `
      + 'unknown, not as empty. **');
  }

  // ── 1. Where the watch stands ────────────────────────────────────────────
  out.push(heading('1. AT A GLANCE'));
  const flags: string[] = [];
  if (chase.length > 0) flags.push(`${plural(chase.length, 'person', 'people')} outstanding`);
  if (live.length > 0) flags.push(`${plural(live.length, 'active incident')}`);
  if (alerts.length > 0) flags.push(`${plural(alerts.length, 'stock row')} at risk`);
  if (late.length > 0) flags.push(`${plural(late.length, 'consignment')} overdue`);
  if (breaches.length > 0) {
    flags.push(`${plural(breaches.length, 'cold-chain excursion')}`);
  }
  out.push(flags.length === 0
    ? '  Nothing outstanding. The station is nominal on every module.'
    : `  Hand over: ${flags.join(', ')}.`);

  // ── 2. People ────────────────────────────────────────────────────────────
  out.push(heading('2. PERSONNEL'));
  out.push(row('On strength', sources.personnel.length));
  out.push(row('Outside the station', away.length));
  out.push(row('Requiring follow-up', chase.length));
  if (chase.length > 0) {
    out.push('');
    out.push('  FOLLOW UP THIS WATCH:');
    for (const p of chase) {
      const state = String(p.effective_status ?? p.status).replace(/_/g, ' ');
      const why = p.overdue_reason ?? (state === 'sos' ? 'SOS RAISED' : state);
      out.push(`    - ${p.name} (${p.role ?? 'role not set'}) — ${state.toUpperCase()}: ${why}`);
      out.push(`        last position report ${stamp(p.last_update_at)}`);
    }
  }
  if (away.length > 0) {
    out.push('');
    out.push('  Outside the station:');
    for (const p of away) {
      const destination = p.destination_name ? ` → ${p.destination_name}` : '';
      out.push(`    - ${p.name}${destination} `
        + `(${String(p.effective_status ?? p.status).replace(/_/g, ' ')})`);
    }
  }

  // ── 3. Incidents ─────────────────────────────────────────────────────────
  out.push(heading('3. ACTIVE INCIDENTS'));
  if (live.length === 0) {
    out.push('  None open.');
  } else {
    for (const incident of live) {
      out.push(`  ${incident.id} — ${incident.type.replace(/_/g, ' ').toUpperCase()}`
        + ` (${incident.severity.toUpperCase()})`);
      out.push(row('    Stage', incident.stage_description
        ?? String(incident.status).toUpperCase()));
      out.push(row('    Declared', stamp(incident.created_at)));
      out.push(row('    Unaccounted',
        incident.unaccounted_count ?? 'not yet counted'));
      if ((incident.unaccounted_count ?? 0) > 0) {
        out.push('    ** HEAD-COUNT IS OPEN ON THIS INCIDENT. **');
      }
      out.push('');
    }
  }

  // ── 4. Conditions ────────────────────────────────────────────────────────
  out.push(heading('4. CONDITIONS'));
  const daylight = polarDaylight(station, generatedAt);
  out.push(row('Daylight regime', daylight === 'midnight_sun' ? 'Midnight sun — 24h daylight'
    : daylight === 'polar_night' ? 'Polar night — 24h darkness'
    : 'Ordinary day/night cycle'));
  out.push(row('Seasonal normal',
    `${seasonalNormal(station, generatedAt)} °C (published normal, NOT a reading)`));
  out.push(row('Blizzard load ΔT', sources.deltaT === null
    ? 'not recorded'
    : `+${sources.deltaT} °C (operator-entered, drives cargo risk)`));
  out.push('');
  out.push('  Prahari has no meteorological feed. The normal above is a published');
  out.push('  climatological figure for the site and the ΔT is what an operator');
  out.push('  entered; neither is a measurement from an instrument.');

  // ── 5. Stores ────────────────────────────────────────────────────────────
  out.push(heading('5. STORES AT RISK'));
  if (alerts.length === 0) {
    out.push('  No row is inside its critical window.');
  } else {
    for (const alert of alerts) {
      out.push(`  ${alert.name} — ${alert.quantity} ${alert.unit ?? ''}`.trimEnd());
      out.push(row('    Days of cover', `${alert.days_of_cover.toFixed(1)} `
        + `(critical below ${alert.critical_days})`));
      if (alert.is_below_minimum) {
        out.push(`    ** BELOW THE STATION MINIMUM OF ${alert.minimum_threshold}. **`);
      }
    }
  }

  // ── 6. Cargo ─────────────────────────────────────────────────────────────
  out.push(heading('6. CARGO'));
  out.push(row('Consignments tracked', sources.shipments.length));
  out.push(row('Overdue or delayed', late.length));
  out.push(row('Cold-chain excursions', breaches.length));
  if (late.length > 0) {
    out.push('');
    out.push('  Overdue:');
    for (const s of late) {
      out.push(`    - ${s.barcode_id} ${s.item_name} (${s.status})`
        + `${s.delay_reason ? ` — ${s.delay_reason}` : ''}`);
      out.push(`        ETA ${stamp(s.eta)}, last scanned ${stamp(s.last_scanned_at)}`);
    }
  }
  if (breaches.length > 0) {
    out.push('');
    out.push('  Cold chain:');
    for (const s of breaches) {
      // "WITHIN" is the literal state but the wrong word to hand someone: a
      // crate that recovered still needs a decision on arrival, so say that
      // rather than making the reader infer it from an excursion count.
      const state = s.cold_chain?.state === 'out_of_band'
        ? 'OUT OF BAND NOW' : 'BACK IN BAND, WAS OUT';
      // The backend's summary already spells out the count, so prefer it and
      // only synthesise a line when there is none.
      const detail = s.cold_chain?.breach_summary
        ?? `${s.cold_chain?.excursion_count ?? 0} excursion(s) recorded in transit`;
      out.push(`    - ${s.barcode_id} ${s.item_name} — ${state}: ${detail}`);
    }
  }

  // ── 7. Procurement ───────────────────────────────────────────────────────
  out.push(heading('7. INBOUND PROCUREMENT'));
  // Mirrors AWAITING_STATUSES in backend/app/routes/procurement.py — an order
  // is open with the vendor until it ships or is cancelled.
  const openOrders = sources.orders.filter(
    (o) => ['ordered', 'confirmed'].includes(String(o.status)));
  const slipping = sources.orders.filter((o) => o.is_overdue);
  out.push(row('Orders open with vendors', openOrders.length));
  out.push(row('Past the promised date', slipping.length));
  for (const order of slipping) {
    out.push(`    - ${order.reference} ${order.item_name} from ${order.vendor}`
      + ` — ${order.days_overdue ?? '?'} day(s) late`);
  }

  // ── 8. Audit tail ────────────────────────────────────────────────────────
  out.push(heading(`8. LAST ${ACTIVITY_LINES} ENTRIES IN THE STATION LOG`));
  const tail = [...sources.events].sort((a, b) => b.seq - a.seq).slice(0, ACTIVITY_LINES);
  if (tail.length === 0) {
    out.push('  No activity recorded.');
  } else {
    for (const event of tail.reverse()) {
      out.push(`  ${stamp(event.created_at)}  ${event.action}  (${event.actor})`);
    }
  }

  // ── 9. Radio fallback ────────────────────────────────────────────────────
  /**
   * The same figures, as an HF message.
   *
   * A handover is the moment someone is about to be the only person awake.
   * If the satellite terminal fails during their watch, the console can no
   * longer generate anything — so the radio version of the station's state
   * is printed here, while it still can.
   */
  out.push(heading('9. HF RADIO SITREP (IF THE SATELLITE LINK IS LOST)'));
  out.push('  Read or key this as-is. It uses only characters a teleprinter can');
  out.push('  carry, and CK is the word count and a check group for the receiving');
  out.push('  operator to verify against.');
  out.push('');
  for (const line of handoverSitrep(sources, generatedAt).split('\n')) {
    out.push(`    ${line}`);
  }

  out.push('');
  out.push(RULE);
  out.push('  Generated by PRAHARI. Every figure above is read from the station\'s');
  out.push('  own records at generation time, except where a line says otherwise.');
  out.push('  Times are UTC. This brief is a snapshot, not a live view.');
  out.push(RULE);
  out.push('');

  return out.join('\n');
}

/** The station's state as an HF SITREP, from the same figures as section 1. */
export function handoverSitrep(sources: HandoverSources, when = new Date()): string {
  const live = activeIncidents(sources.incidents);
  return encodeSitrep({
    station: sources.station,
    personnelTotal: sources.personnel.length,
    personnelOut: awayFromStation(sources.personnel).length,
    unaccounted: live.reduce((total, i) => total + (i.unaccounted_count ?? 0), 0),
    activeIncidents: live.length,
    criticalStockItems: sources.alerts.length,
    when,
  });
}

/** `Prahari-Handover-Maitri-20260928-1432Z.txt` — sorts by station then time. */
export function handoverFilename(station: string, generatedAt = new Date()): string {
  const iso = generatedAt.toISOString();
  const day = iso.slice(0, 10).replace(/-/g, '');
  const time = iso.slice(11, 16).replace(':', '');
  const safe = station.replace(/[^A-Za-z0-9_-]/g, '-');
  return `Prahari-Handover-${safe}-${day}-${time}Z.txt`;
}
