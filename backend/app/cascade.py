"""Cross-module propagation: one station event, every module that depends on it.

Prahari's pitch is an *integrated* operational state — a blizzard is not a
cargo fact, it is a station fact that moves fuel burn, shipment ETAs and
whether a traverse can still depart. In the prototype the chain stopped
halfway: weather re-scored consignments, and nothing told the expedition
holding a booking on those consignments that its assumptions had expired.

This module is the missing link. It is deliberately a separate module rather
than a function in one of the routers, because the routers already import one
another (personnel imports incidents, shipments writes inventory) and putting
the fan-out in any one of them closes an import cycle. Everything it needs is
imported lazily inside the functions for the same reason.

The cascade is idempotent and cheap: it recomputes, compares against what was
stored, and only logs or broadcasts when a number actually moved. Calling it
after every write is therefore safe.
"""

import json
import logging

from .database import get_db
from .events import log_event
from .timeutil import utc_now_iso
from .ws_manager import manager

logger = logging.getLogger('prahari.cascade')

# Expedition states whose readiness is still worth monitoring. A completed or
# cancelled traverse cannot degrade — it is already over.
MONITORED_STATUSES = ('draft', 'active')

# How far readiness has to fall below the score the traverse was approved
# against before the commander is told. Small movements are noise: crew step
# out to the workshop, a litre of fuel is drawn.
DEGRADE_TOLERANCE = 10


async def reevaluate_expeditions(station: str, trigger: str, db=None) -> list[dict]:
    """Re-score every open traverse at a station against live conditions.

    A readiness figure stored at planning time is a claim about a moment that
    has passed. If a blizzard has since halved the fuel or a rescue has pulled
    four people off the roster, the card still reading "100% ready" is not
    stale data — it is a commander authorising a departure on assumptions that
    expired hours ago.
    """
    from .models import FeasibilityRequest
    from .routes.expeditions import score_feasibility, station_snapshot

    db = db or get_db()
    placeholders = ','.join('?' * len(MONITORED_STATUSES))
    rows = db.execute(
        f'SELECT * FROM expeditions WHERE station = ? AND status IN ({placeholders})',
        (station, *MONITORED_STATUSES)
    ).fetchall()
    if not rows:
        return []

    # Everything the score depends on that is a property of the *station* -
    # the fuel row, who is at base, what cargo is inbound, how many berths -
    # is identical for every traverse departing from it. Reading it once and
    # passing it in turns an N x 5-query fan-out into 5 queries plus N cheap
    # comparisons, which matters because this runs after every write that
    # moves station conditions.
    snapshot = station_snapshot(db, station)

    degraded = []
    for row in rows:
        expedition = dict(row)
        try:
            result = await score_feasibility(FeasibilityRequest(
                station=station,
                personnel_required=expedition['personnel_required'] or 0,
                fuel_required_l=expedition['fuel_required_l'] or 0,
                start_date=expedition['start_date'], end_date=expedition['end_date'],
                expedition_id=expedition['id'],
            ), log=False, snapshot=snapshot)
        except Exception:  # a scoring failure must not break the write that triggered it
            logger.exception('Readiness re-scoring failed for %s', expedition['id'])
            continue

        live = result.readiness_score
        baseline = expedition['baseline_readiness_score']
        if baseline is None:
            baseline = expedition['readiness_score'] if expedition['readiness_score'] is not None \
                else live
        previous_live = expedition['live_readiness_score']

        db.execute(
            'UPDATE expeditions SET baseline_readiness_score = ?, live_readiness_score = ?, '
            'live_feasibility = ?, readiness_checked_at = ? WHERE id = ?',
            (baseline, live, json.dumps([i.model_dump() for i in result.items]),
             utc_now_iso(), expedition['id'])
        )

        shortfalls = [i for i in result.items if not i.ok]
        is_degraded = live < baseline - DEGRADE_TOLERANCE
        entry = {
            'expedition_id': expedition['id'], 'name': expedition['name'],
            'station': station, 'status': expedition['status'],
            'baseline_readiness': baseline, 'live_readiness': live,
            'degraded': is_degraded,
            'shortfalls': [{'label': i.label, 'required': i.required,
                            'available': i.available, 'detail': i.detail}
                           for i in shortfalls],
        }

        # Only announce a CROSSING, not a state. Re-announcing on every write
        # while the blizzard sits at +25 is how an operator learns to dismiss
        # the banner without reading it.
        crossed = is_degraded and (previous_live is None
                                   or previous_live >= baseline - DEGRADE_TOLERANCE)
        if crossed:
            reason = shortfalls[0].detail if shortfalls else 'station conditions changed'
            await log_event(
                'expedition',
                f'FEASIBILITY DEGRADED: "{expedition["name"]}" fell from {baseline}% to '
                f'{live}% after {trigger} — {reason}',
                'readiness_monitor', expedition['id'],
                {'severity': 'high', 'baseline': baseline, 'live': live, 'trigger': trigger},
                station=station)
        if is_degraded:
            degraded.append(entry)

    db.commit()
    if degraded:
        await manager.broadcast({'type': 'expedition_readiness',
                                 'data': {'station': station, 'trigger': trigger,
                                          'degraded': degraded}})
    return degraded


async def propagate_station_change(station: str, trigger: str, db=None) -> dict:
    """Fan a station-level change out to everything downstream of it.

    Called from the write paths in inventory, shipments, personnel and
    expeditions. Returns what moved so the caller can report it.
    """
    degraded = await reevaluate_expeditions(station, trigger, db)
    return {'station': station, 'trigger': trigger, 'degraded_expeditions': degraded}


async def propagate_weather_change(station: str, delta_t: float, rescored: list,
                                   delayed: int, db=None) -> dict:
    """The full weather -> cargo -> expedition chain, announced as one event.

    Cargo has already been re-scored by the caller; this picks the chain up
    from there, because a delayed consignment is only interesting to the
    module that was counting on it arriving.
    """
    db = db or get_db()
    degraded = await reevaluate_expeditions(station, f'blizzard load dT +{delta_t:g}C', db)

    if delayed or degraded:
        parts = [f'Blizzard dT +{delta_t:g}C at {station}']
        if delayed:
            parts.append(f'{delayed} consignment(s) delayed')
        for entry in degraded:
            parts.append(f'"{entry["name"]}" readiness '
                         f'{entry["baseline_readiness"]}% -> {entry["live_readiness"]}%')
        summary = ' -> '.join(parts)
        await log_event('system', f'SUPPLY CHAIN CASCADE: {summary}', 'cascade_monitor',
                        None, {'severity': 'high', 'station': station, 'delta_t': delta_t,
                               'delayed': delayed, 'degraded': degraded}, station=station)
        await manager.broadcast({'type': 'cascade_alert',
                                 'data': {'station': station, 'delta_t': delta_t,
                                          'delayed': delayed, 'degraded': degraded,
                                          'summary': summary}})
    return {'station': station, 'delta_t': delta_t, 'delayed': delayed,
            'degraded_expeditions': degraded}
