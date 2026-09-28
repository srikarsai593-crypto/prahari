"""Dry-run a change to the station and report what it would move.

Every figure on this console is already a projection — days of cover, a
readiness score, an ETA. What an operator could not do was ask a question
about a station that does not exist yet: *if the ship slips ten days, does
the traverse still go?* The only way to find out was to make the change for
real and undo it afterwards, which puts a fiction into the audit log and
into everyone else's console.

So: the same formulas, run against a modified copy of the station's state,
writing nothing. There is no second model here and no separate set of rules
that could drift from the real ones — `score_feasibility` and
`compute_depletion` are the functions the console uses, handed a snapshot
that has the scenario applied. If a projection disagrees with reality, the
bug is in one place rather than two.

What it deliberately does not do is persist. Not the scenario, not the
result, not an audit entry. A what-if is a question, and a station's record
is for what happened.
"""

from .conditions import get_delta_t


def _factor_for(present: int, nominal: int) -> float:
    """The crew multiplier, matching routes.inventory.station_headcount.

    Floored the same way: an empty station still runs its heating, so the
    burn rate does not fall to zero and report infinite cover.
    """
    return max(0.25, present / max(nominal, 1))


def _depleted(item: dict, days: float, delta_t: float, factor: float) -> dict:
    """Run a stock row forward by `days` and return it as it would then be."""
    from .routes.inventory import compute_depletion

    projected = dict(item)
    if days > 0:
        rate = compute_depletion(projected, delta_t, factor)['depletion_rate']
        projected['quantity'] = max(0.0, float(projected['quantity'] or 0) - rate * days)
    return projected


def _stock_view(item: dict, delta_t: float, factor: float) -> dict:
    from .routes.inventory import compute_depletion

    figures = compute_depletion(item, delta_t, factor)
    return {
        'quantity': round(float(item['quantity'] or 0), 2),
        'days_of_cover': figures['days_of_cover'],
        'depletion_rate': figures['depletion_rate'],
        'stock_state': figures['stock_state'],
    }


async def project(db, station: str, scenario) -> dict:
    """Score the station as it is, and as the scenario would leave it.

    `scenario` carries the deltas; see models.WhatIfScenario for what each
    one means and why it is expressed as a change rather than an absolute.
    """
    from .cascade import MONITORED_STATUSES
    from .models import FeasibilityRequest
    from .routes.expeditions import score_feasibility, station_snapshot
    from .routes.inventory import station_headcount

    # ── The station as it stands ─────────────────────────────────────────
    basis = station_headcount(station, db)
    now_delta_t = get_delta_t(station)
    now_factor = basis['factor']

    rows = [dict(r) for r in db.execute(
        'SELECT * FROM inventory_items WHERE station = ? ORDER BY name', (station,)
    ).fetchall()]

    # ── The station the scenario describes ───────────────────────────────
    after_delta_t = (scenario.delta_t if scenario.delta_t is not None else now_delta_t)
    after_present = max(0, basis['headcount'] + scenario.extra_crew)
    # The nominal comes from the station's own profile, which station_headcount
    # already read — taking it from there rather than a second lookup keeps the
    # projection scaled against exactly what the live figure is scaled against.
    after_factor = _factor_for(after_present, basis['nominal_headcount'])

    inventory = []
    for row in rows:
        before = _stock_view(row, now_delta_t, now_factor)
        projected = _depleted(row, scenario.advance_days, after_delta_t, after_factor)
        after = _stock_view(projected, after_delta_t, after_factor)
        inventory.append({
            'id': row['id'],
            'name': row['name'],
            'unit': row['unit'],
            'before': before,
            'after': after,
            # The figure an operator reads first: how many days this costs.
            'cover_change_days': round(after['days_of_cover'] - before['days_of_cover'], 1),
            'newly_critical': (after['stock_state'] == 'critical'
                               and before['stock_state'] != 'critical'),
        })

    # ── Traverses, scored against both stations ──────────────────────────
    current = station_snapshot(db, station)
    modified = _apply_to_snapshot(current, scenario, station,
                                  after_delta_t, after_factor, rows)

    placeholders = ','.join('?' * len(MONITORED_STATUSES))
    traverses = db.execute(
        f'SELECT * FROM expeditions WHERE station = ? AND status IN ({placeholders})',
        (station, *MONITORED_STATUSES)).fetchall()

    expeditions = []
    for row in traverses:
        request = FeasibilityRequest(
            station=station,
            personnel_required=row['personnel_required'] or 0,
            fuel_required_l=row['fuel_required_l'] or 0,
            expedition_id=row['id'])
        # log=False throughout: a question must not write to the record.
        before = await score_feasibility(request, log=False, snapshot=current)
        after = await score_feasibility(request, log=False, snapshot=modified)
        was_short = {item.label for item in before.items if not item.ok}
        now_short = {item.label for item in after.items if not item.ok}
        expeditions.append({
            'id': row['id'],
            'name': row['name'],
            'status': row['status'],
            'before_readiness': before.readiness_score,
            'after_readiness': after.readiness_score,
            'readiness_change': after.readiness_score - before.readiness_score,
            'newly_short': sorted(now_short - was_short),
            'resolved': sorted(was_short - now_short),
            'blocked': bool(now_short),
        })

    return {
        'station': station,
        'scenario': scenario.model_dump(),
        'assumptions': _assumptions(scenario, basis, after_present, now_delta_t, after_delta_t),
        'inventory': inventory,
        'expeditions': expeditions,
        'summary': {
            'items_newly_critical': sum(1 for i in inventory if i['newly_critical']),
            'traverses_newly_blocked': sum(1 for e in expeditions if e['newly_short']),
            'worst_cover_change_days': min(
                (i['cover_change_days'] for i in inventory), default=0.0),
            # A traverse can lose thirty points to the fuel-reserve check
            # without any line item flipping to "short" — the reserve scales
            # the score rather than failing a row. Summarising only on
            # newly-short would report that scenario as harmless, which is
            # the opposite of what it is.
            'worst_readiness_change': min(
                (e['readiness_change'] for e in expeditions), default=0),
        },
        # Said out loud, every time. A projection that does not announce
        # itself is indistinguishable from a reading.
        'is_projection': True,
        'persisted': False,
    }


def _apply_to_snapshot(current: dict, scenario, station: str,
                       after_delta_t: float, after_factor: float, rows: list[dict]) -> dict:
    """The station snapshot as the scenario would leave it.

    A shallow copy with the affected fields replaced, so every field the
    scenario does not touch is byte-identical to the real one — the two
    scores differ only by what was asked about.
    """
    from .routes.inventory import compute_depletion

    modified = dict(current)
    modified['unassigned_crew'] = max(0, current['unassigned_crew'] + scenario.extra_crew)
    modified['occupied_berths'] = max(0, current['occupied_berths'] + scenario.extra_crew)

    fuel_row = current.get('fuel_row')
    if fuel_row is not None:
        projected_fuel = _depleted(dict(fuel_row), scenario.advance_days,
                                   after_delta_t, after_factor)
        modified['fuel_row'] = projected_fuel
        modified['fuel_burn'] = compute_depletion(projected_fuel, after_delta_t, after_factor)

    # A slipped convoy is still inbound; it just arrives later. The readiness
    # score reads the ETA, so pushing it is the whole of the scenario.
    if scenario.cargo_delay_hours:
        from datetime import timedelta

        from .timeutil import to_utc_iso
        from .routes.shipments import _parse_iso

        pushed = []
        for shipment in current.get('pending_cargo', []):
            entry = dict(shipment)
            eta = _parse_iso(entry.get('eta'))
            if eta is not None:
                entry['eta'] = to_utc_iso(eta + timedelta(hours=scenario.cargo_delay_hours))
            pushed.append(entry)
        modified['pending_cargo'] = pushed
        modified['delayed_cargo'] = [s for s in pushed if s.get('status') == 'delayed']

    return modified


def _assumptions(scenario, basis: dict, after_present: int,
                 now_delta_t: float, after_delta_t: float) -> list[str]:
    """What the projection took as given, in the operator's own terms.

    A number with no statement of what it assumed is a number nobody should
    act on, and this is the half of a what-if that makes it arguable rather
    than oracular.
    """
    notes = []
    if scenario.extra_crew:
        notes.append(f'crew on station {basis["headcount"]} -> {after_present}')
    if scenario.delta_t is not None and scenario.delta_t != now_delta_t:
        notes.append(f'blizzard load dT +{now_delta_t:g}C -> +{scenario.delta_t:g}C')
    if scenario.cargo_delay_hours:
        notes.append(f'every inbound consignment {scenario.cargo_delay_hours:g} h later')
    if scenario.advance_days:
        notes.append(f'{scenario.advance_days:g} day(s) of consumption at the new rate')
    if not notes:
        notes.append('nothing changed — this is the station as it stands')
    notes.append('stock is drawn down at the projected rate; no resupply is assumed '
                 'beyond consignments already inbound')
    return notes
