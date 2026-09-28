import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activeIncidents, awayFromStation, coldChainBreaches, collectHandover, handoverFilename,
  handoverSitrep, outstanding, overdueCargo, renderHandover, type HandoverSources,
} from './handover';
import { api } from './api';
import type { Incident, Personnel, PurchaseOrder, Shipment, StockAlert } from './types';

/**
 * A handover is read by someone who has just woken up and is about to be the
 * only person awake. The failure that matters is not an ugly document — it
 * is a section that is empty because a call failed, read as "nothing to
 * worry about".
 */

const AT = new Date('2026-09-28T14:32:00Z');

const person = (over: Partial<Personnel> = {}): Personnel => ({
  id: 'p1', name: 'Dr Priya Sharma', role: 'Glaciologist', station: 'Maitri',
  expedition_id: null, status: 'at_station', current_lat: null, current_lng: null,
  last_update_at: '2026-09-28T13:00:00Z', ...over,
});

const incident = (over: Partial<Incident> = {}): Incident => ({
  id: 'INC-01', type: 'medical', station: 'Maitri', location_lat: -70.7, location_lng: 11.7,
  affected_radius_m: 500, severity: 'high', status: 'declared', expected_count: 4,
  confirmed_safe_count: 3, unaccounted_count: 1, created_at: '2026-09-28T12:00:00Z',
  is_active: true, ...over,
});

const shipment = (over: Partial<Shipment> = {}): Shipment => ({
  id: 's1', barcode_id: 'SHP-01', expedition_id: null, item_name: 'Vaccines',
  category: 'medical', weight_kg: 20, quantity: 100, unit: 'vial',
  inventory_item_id: null, priority: 'high', origin_station: null,
  destination_station: 'Maitri', status: 'in_transit', dispatch_date: null,
  eta: '2026-09-27T00:00:00Z', risk_score: 40, delay_reason: null,
  last_scanned_at: null, updated_at: '2026-09-28T00:00:00Z', ...over,
});

const alert = (over: Partial<StockAlert> = {}): StockAlert => ({
  item_id: 'inv-1', name: 'Diesel', station: 'Maitri', quantity: 400, unit: 'L',
  days_of_cover: 3.2, critical_days: 7, is_below_minimum: false,
  minimum_threshold: null, ...over,
});

const order = (over: Partial<PurchaseOrder> = {}): PurchaseOrder => ({
  id: 'po1', reference: 'PO-2026-0001', vendor: 'Polar Supplies', item_name: 'Diesel',
  category: 'fuel', quantity: 4000, unit: 'L', inventory_item_id: null,
  destination_station: 'Maitri', status: 'ordered', ordered_at: '2026-09-01T00:00:00Z',
  promised_at: '2026-09-20T00:00:00Z', shipment_id: null, notes: null,
  is_overdue: false, days_overdue: null, slip_warning: null, ...over,
});

const sources = (over: Partial<HandoverSources> = {}): HandoverSources => ({
  station: 'Maitri', incidents: [], personnel: [], inventory: [], alerts: [],
  shipments: [], orders: [], events: [], deltaT: null, unavailable: [], ...over,
});

describe('picking out what matters', () => {
  it('counts anything not resolved as active', () => {
    expect(activeIncidents([
      incident({ id: 'a', is_active: true }),
      incident({ id: 'b', is_active: false }),
    ]).map((i) => i.id)).toEqual(['a']);
  });

  it('falls back to the status for a row predating is_active', () => {
    /** Legacy rows carry `open` and no derived flag; dropping them would
     *  hide a live incident from the brief. */
    expect(activeIncidents([
      incident({ id: 'legacy', is_active: undefined, status: 'open' }),
      incident({ id: 'done', is_active: undefined, status: 'resolved' }),
    ]).map((i) => i.id)).toEqual(['legacy']);
  });

  it('treats anyone not inside the station as away', () => {
    expect(awayFromStation([
      person({ id: 'a', status: 'field' }),
      person({ id: 'b', status: 'at_station' }),
      person({ id: 'c', status: 'in_transit' }),
      person({ id: 'd', status: 'off_duty' }),
    ]).map((p) => p.id)).toEqual(['a', 'c']);
  });

  it('prefers the effective status the backend derived', () => {
    expect(awayFromStation([
      person({ status: 'at_station', effective_status: 'deviated' }),
    ])).toHaveLength(1);
  });

  it('flags for follow-up only those who need chasing', () => {
    /** Everyone outside is most of the day shift. A list of forty names is
     *  a list nobody reads. */
    const chase = outstanding([
      person({ id: 'ok', status: 'field' }),
      person({ id: 'late', status: 'field', overdue: true }),
      person({ id: 'sos', status: 'sos' }),
      person({ id: 'off-route', status: 'deviated' }),
    ]);
    expect(chase.map((p) => p.id)).toEqual(['late', 'sos', 'off-route']);
  });

  it('counts overdue and delayed cargo', () => {
    expect(overdueCargo([
      shipment({ id: 'a', is_overdue: true }),
      shipment({ id: 'b', status: 'delayed' }),
      shipment({ id: 'c', status: 'in_transit' }),
    ]).map((s) => s.id)).toEqual(['a', 'b']);
  });
});

describe('cold chain', () => {
  const chain = (over: Partial<NonNullable<Shipment['cold_chain']>>) => ({
    monitored: true, state: 'within' as const, last_temp_c: 4, excursion_count: 0,
    breach_summary: null, ...over,
  });

  it('reports cargo currently out of band', () => {
    expect(coldChainBreaches([
      shipment({ cold_chain: chain({ state: 'out_of_band' }) }),
    ])).toHaveLength(1);
  });

  it('still reports a crate that recovered after an excursion', () => {
    /**
     * It reads `within` now. Whether the contents survived is a judgement
     * someone has to make on arrival, so it cannot drop off the handover.
     */
    expect(coldChainBreaches([
      shipment({ cold_chain: chain({ state: 'within', excursion_count: 2 }) }),
    ])).toHaveLength(1);
  });

  it('says a recovered crate was out of band, not that it is within', () => {
    /** "WITHIN" is the literal state and the wrong word to hand someone who
     *  still has to decide whether the contents survived. */
    const text = renderHandover(sources({
      shipments: [shipment({ cold_chain: chain({ state: 'within', excursion_count: 2 }) })],
    }), AT);
    expect(text).toContain('BACK IN BAND, WAS OUT');
    expect(text).not.toContain('— WITHIN');
  });

  it('does not repeat the count the backend already spelled out', () => {
    const text = renderHandover(sources({
      shipments: [shipment({ cold_chain: chain({
        state: 'out_of_band', excursion_count: 1,
        breach_summary: '1 excursion recorded in transit' }) })],
    }), AT);
    expect(text).toContain('OUT OF BAND NOW: 1 excursion recorded in transit');
    expect(text).not.toMatch(/excursion\(s\)/);
  });

  it('synthesises a count when the backend gave no summary', () => {
    const text = renderHandover(sources({
      shipments: [shipment({ cold_chain: chain({ state: 'within', excursion_count: 3,
                                                 breach_summary: null }) })],
    }), AT);
    expect(text).toContain('3 excursion(s) recorded in transit');
  });

  it('does not call an unread gauge a temperature failure', () => {
    expect(coldChainBreaches([
      shipment({ cold_chain: chain({ state: 'awaiting_reading' }) }),
      shipment({ cold_chain: chain({ state: 'unmonitored', monitored: false }) }),
      shipment({ cold_chain: undefined }),
    ])).toHaveLength(0);
  });
});

describe('the brief', () => {
  it('says plainly when there is nothing to hand over', () => {
    expect(renderHandover(sources(), AT)).toContain('Nothing outstanding');
  });

  it('leads with a summary of what the relief inherits', () => {
    const text = renderHandover(sources({
      personnel: [person({ overdue: true })],
      incidents: [incident()],
      alerts: [alert()],
      shipments: [shipment({ is_overdue: true })],
    }), AT);
    expect(text).toContain('1 person outstanding');
    expect(text).toContain('1 active incident');
    expect(text).toContain('1 stock row at risk');
    expect(text).toContain('1 consignment overdue');
  });

  it('pluralises the summary', () => {
    const text = renderHandover(sources({
      personnel: [person({ id: 'a', overdue: true }), person({ id: 'b', overdue: true })],
    }), AT);
    expect(text).toContain('2 people outstanding');
  });

  it('names the sources it could not read instead of showing them empty', () => {
    /**
     * The failure this whole document has to avoid: a section that is blank
     * because a call timed out, read at 3am as "nothing to worry about".
     */
    const text = renderHandover(sources({ unavailable: ['Personnel roster', 'Cargo'] }), AT);
    expect(text).toContain('INCOMPLETE');
    expect(text).toContain('Personnel roster, Cargo');
    expect(text).toMatch(/unknown, not as empty/);
  });

  it('shouts about an open head-count', () => {
    const text = renderHandover(sources({
      incidents: [incident({ unaccounted_count: 2 })],
    }), AT);
    expect(text).toContain('HEAD-COUNT IS OPEN');
  });

  it('distinguishes "not yet counted" from "nobody missing"', () => {
    const text = renderHandover(sources({
      incidents: [incident({ unaccounted_count: null })],
    }), AT);
    expect(text).toContain('not yet counted');
    expect(text).not.toContain('HEAD-COUNT IS OPEN');
  });

  it('labels the temperature figures as not being measurements', () => {
    /** Prahari has no met feed. An unlabelled number on a 3am handover gets
     *  taken as a reading. */
    const text = renderHandover(sources({ deltaT: 12 }), AT);
    expect(text).toContain('published normal, NOT a reading');
    expect(text).toContain('operator-entered');
    expect(text).toContain('no meteorological feed');
  });

  it('reports the reason someone is overdue, not just that they are', () => {
    const text = renderHandover(sources({
      personnel: [person({ overdue: true, overdue_reason: 'no position report for 4h' })],
    }), AT);
    expect(text).toContain('no position report for 4h');
  });

  it('counts only orders still open with the vendor', () => {
    const text = renderHandover(sources({
      orders: [order({ status: 'ordered' }), order({ id: 'b', status: 'confirmed' }),
               order({ id: 'c', status: 'shipped' }),
               order({ id: 'd', status: 'cancelled' })],
    }), AT);
    expect(text).toMatch(/Orders open with vendors\W+2/);
  });

  it('puts the station log in the order it happened', () => {
    const text = renderHandover(sources({
      events: [
        { seq: 2, action: 'second thing', actor: 'commander', module: 'system',
          created_at: '2026-09-28T13:00:00Z', related_id: null, metadata: null },
        { seq: 1, action: 'first thing', actor: 'commander', module: 'system',
          created_at: '2026-09-28T12:00:00Z', related_id: null, metadata: null },
      ] as never,
    }), AT);
    expect(text.indexOf('first thing')).toBeLessThan(text.indexOf('second thing'));
  });

  it('carries the radio fallback, because the link may not last the watch', () => {
    const text = renderHandover(sources(), AT);
    expect(text).toContain('HF RADIO SITREP');
    expect(text).toContain('ZCZC PRAHARI SITREP');
    expect(text).toContain('NNNN');
  });
});

describe('the radio SITREP built from the brief', () => {
  it('totals the unaccounted across every active incident', () => {
    const text = handoverSitrep(sources({
      incidents: [incident({ id: 'a', unaccounted_count: 2 }),
                  incident({ id: 'b', unaccounted_count: 1 })],
      personnel: [person()],
    }), AT);
    expect(text).toContain('UNACCOUNTED 3');
  });

  it('ignores the head-count of a resolved incident', () => {
    const text = handoverSitrep(sources({
      incidents: [incident({ is_active: false, unaccounted_count: 5 })],
    }), AT);
    expect(text).toContain('UNACCOUNTED 0');
  });
});

describe('collecting the sources', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('records the name of a source that failed rather than throwing', async () => {
    vi.spyOn(api, 'listIncidents').mockResolvedValue([]);
    vi.spyOn(api, 'listPersonnel').mockRejectedValue(new Error('unreachable'));
    vi.spyOn(api, 'listInventory').mockResolvedValue([]);
    vi.spyOn(api, 'listStockAlerts').mockResolvedValue([]);
    vi.spyOn(api, 'listShipments').mockResolvedValue([]);
    vi.spyOn(api, 'listPurchaseOrders').mockResolvedValue([]);
    vi.spyOn(api, 'listEvents').mockResolvedValue([]);
    vi.spyOn(api, 'getStationConditions').mockResolvedValue({ stations: { Maitri: 8 } });

    const result = await collectHandover('Maitri');
    expect(result.unavailable).toContain('Personnel roster');
    expect(result.personnel).toEqual([]);
    expect(result.deltaT).toBe(8);
  });

  it('reads the ΔT for this station only', async () => {
    for (const name of ['listIncidents', 'listPersonnel', 'listInventory', 'listStockAlerts',
                        'listShipments', 'listPurchaseOrders', 'listEvents'] as const) {
      vi.spyOn(api, name).mockResolvedValue([] as never);
    }
    vi.spyOn(api, 'getStationConditions').mockResolvedValue({
      stations: { Maitri: 8, Bharati: 20 },
    });
    expect((await collectHandover('Bharati')).deltaT).toBe(20);
  });
});

describe('the filename', () => {
  it('sorts by station then time and keeps the Z', () => {
    expect(handoverFilename('Maitri', AT)).toBe('Prahari-Handover-Maitri-20260928-1432Z.txt');
  });
});
