"""Every movement of stock, recorded the same way, so the log is a ledger.

`base_burn_rate` is a configured constant: it is what the station was
provisioned to consume at its nominal headcount, and nothing has ever checked
it against what the station actually consumed. A figure that has never been
compared against reality is a planning assumption, not a measurement, and
`days_of_cover` is built entirely on top of it.

The audit log already carries every stock change. What it did not carry was
the change in a shape anything could read: the quantities were in the prose
("6500 -> 6300"), and each of six call sites wrote its own UPDATE and its own
sentence. This module is the one place that does both, so every movement lands
with a signed delta and a reason, and the log becomes something the burn rate
can be derived from.

What counts as consumption is deliberately narrow — see `CONSUMING_REASONS`.
A stocktake correction is a fix to a measurement, not fuel that was burned,
and a transfer to another station is a relocation. Counting either would make
the observed rate a record of paperwork.
"""

import json
from datetime import timedelta

from .events import log_event
from .timeutil import utc_now_iso
from .ws_manager import manager

# Why a quantity moved. Stored in the event metadata, so the ledger can be
# read back without parsing prose.
REASON_COMMAND = 'command'                 # operator recorded usage in words
REASON_CORRECTION = 'correction'           # a stocktake put the figure right
REASON_UNLOAD = 'unload'                   # a consignment arrived and was unloaded
REASON_TRANSFER_OUT = 'transfer_out'       # drawn down to supply another station
REASON_EXPEDITION_DRAW = 'expedition_draw' # loaded onto a departing traverse
REASON_EXPEDITION_RETURN = 'expedition_return'  # a cancelled traverse gave it back

# Movements that represent the station actually consuming the item. A
# correction is a measurement being fixed; a transfer is stock moving house;
# an unload or a return is stock arriving. None of those are burn.
CONSUMING_REASONS = (REASON_COMMAND, REASON_EXPEDITION_DRAW)


async def record_movement(db, item: dict, new_quantity: float, *, reason: str,
                          actor: str, message: str, related_id: str = None,
                          extra: dict = None, broadcast: bool = True) -> float:
    """Write the new quantity and log the movement with a machine-readable delta.

    Returns the new quantity, so callers can use it in their own response
    without re-reading the row.
    """
    old_quantity = float(item['quantity'] or 0)
    new_quantity = float(new_quantity)
    delta = round(new_quantity - old_quantity, 6)

    db.execute('UPDATE inventory_items SET quantity = ?, updated_at = ? WHERE id = ?',
               (new_quantity, utc_now_iso(), item['id']))
    db.commit()

    await log_event(
        'inventory', message, actor, related_id or item['id'],
        {
            'stock_delta': delta,
            'old_quantity': old_quantity,
            'new_quantity': new_quantity,
            'item_id': item['id'],
            'item_name': item['name'],
            'unit': item['unit'],
            'reason': reason,
            **(extra or {}),
        },
        station=item['station'])

    if broadcast:
        await manager.broadcast({'type': 'inventory_update',
                                 'data': {'item_id': item['id'],
                                          'new_quantity': new_quantity}})
    return new_quantity


# ── Observed burn rate ──────────────────────────────────────────────────────
# How far back to look. Long enough that one quiet week does not dominate,
# short enough that last season's consumption is not presented as this
# season's rate.
OBSERVATION_WINDOW_DAYS = 30
# Below this, the arithmetic is still arithmetic but the answer is noise: one
# 200 L draw an hour ago is not a 4800 L/day habit. Report nothing rather than
# a figure that looks as authoritative as the configured one.
MIN_OBSERVATION_DAYS = 2.0
MIN_MOVEMENTS = 2


def _consumption_movements(db, station: str, *, now=None,
                           window_days: int = OBSERVATION_WINDOW_DAYS):
    """Every draw-down at this station inside the window, newest last.

    The single reader behind both views below. They had identical filters,
    cutoffs and guards, and two copies of "what counts as consumption" is
    two places for it to drift — which is exactly the definition the
    observed rate turns on.

    The window is applied in SQL. Reading every inventory event the station
    has ever logged and discarding the old ones in Python is a full scan
    that grows for the life of the station, on the page an operator
    refreshes most. `created_at` is ISO-8601 with a fixed-width UTC offset,
    so it sorts lexicographically in the same order as chronologically and a
    string comparison is a correct bound.
    """
    from .timeutil import utc_now

    now = now or utc_now()
    cutoff = (now - timedelta(days=window_days)).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'
    rows = db.execute(
        "SELECT metadata, created_at FROM events "
        "WHERE module = 'inventory' AND station = ? AND metadata IS NOT NULL "
        'AND created_at >= ? ORDER BY seq ASC', (station, cutoff)).fetchall()

    for row in rows:
        try:
            meta = json.loads(row['metadata'])
        except (TypeError, ValueError):
            continue
        if not isinstance(meta, dict) or meta.get('reason') not in CONSUMING_REASONS:
            continue
        delta = meta.get('stock_delta')
        item_id = meta.get('item_id')
        # Only draw-downs. An increment recorded by command is a correction
        # in the operator's own words, not negative consumption.
        if item_id is None or not isinstance(delta, (int, float)) or delta >= 0:
            continue
        yield item_id, -float(delta), str(row['created_at'])


def consumption_by_day(db, station: str, *, now=None,
                       window_days: int = OBSERVATION_WINDOW_DAYS) -> dict:
    """Per item, how much was consumed on each observed day of the window.

    The aggregate rate says what the station averages. It cannot say how
    *steady* that average is, and thirty days of cover at a steady rate is a
    different proposition from thirty at a rate that swings by four. The
    daily series is what the stockout forecast resamples.

    Keyed by day rather than by movement: two draws an hour apart are one
    day's consumption, and counting them as two observations would make the
    station look twice as variable as it is.
    """
    per_item: dict[str, dict[str, float]] = {}
    for item_id, amount, created_at in _consumption_movements(
            db, station, now=now, window_days=window_days):
        day = created_at[:10]
        per_item.setdefault(item_id, {})
        per_item[item_id][day] = per_item[item_id].get(day, 0.0) + amount
    return per_item


def observed_burn_rates(db, station: str, *, now=None,
                        window_days: int = OBSERVATION_WINDOW_DAYS) -> dict:
    """Per item, what the station actually consumed per day over the window.

    Derived from the audit log rather than from a counter, because the log
    is the record that already has to be right and a second counter would be
    a second thing to keep in step.

    Returns `{item_id: {...}}`. An item with too little history is present
    with `rate: None` and a reason, not absent: "we have not observed this
    yet" and "this item does not deplete" must not look the same.
    """
    from .timeutil import utc_now

    now = now or utc_now()

    observed: dict[str, dict] = {}
    for item_id, amount, created_at in _consumption_movements(
            db, station, now=now, window_days=window_days):
        stamp = _epoch(created_at)
        if stamp is None:
            continue
        entry = observed.setdefault(item_id, {'consumed': 0.0, 'movements': 0,
                                              'first': stamp, 'last': stamp})
        entry['consumed'] += amount
        entry['movements'] += 1
        entry['first'] = min(entry['first'], stamp)
        entry['last'] = max(entry['last'], stamp)

    result = {}
    for item_id, entry in observed.items():
        # Measured from the first movement to now, not to the last one:
        # a station that consumed nothing for a fortnight has a lower rate,
        # and ending the window at the last draw would hide exactly that.
        elapsed_days = (now.timestamp() - entry['first']) / 86400
        if entry['movements'] < MIN_MOVEMENTS or elapsed_days < MIN_OBSERVATION_DAYS:
            result[item_id] = {
                'rate': None, 'movements': entry['movements'],
                'observed_days': round(elapsed_days, 2), 'consumed': round(entry['consumed'], 2),
                'reason': f'only {entry["movements"]} movement(s) over '
                          f'{elapsed_days:.1f} day(s) — not enough to infer a rate',
            }
            continue
        result[item_id] = {
            'rate': round(entry['consumed'] / elapsed_days, 3),
            'movements': entry['movements'],
            'observed_days': round(elapsed_days, 2),
            'consumed': round(entry['consumed'], 2),
            'reason': None,
        }
    return result


def _epoch(created_at) -> float | None:
    from datetime import datetime, timezone
    if not created_at:
        return None
    try:
        parsed = datetime.fromisoformat(str(created_at).replace('Z', '+00:00'))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def compare_to_configured(configured: float | None, observed: dict | None) -> dict | None:
    """How the measured rate stands against the one the formula is using.

    The point of showing both is the gap. A station burning 40% more diesel
    than its configured rate has a cover figure that is 40% optimistic, and
    nothing else on the page would say so.
    """
    if not observed or observed.get('rate') is None:
        return None
    rate = observed['rate']
    configured = float(configured or 0)
    if configured <= 0:
        return {'ratio': None, 'verdict': 'no configured rate to compare against'}
    ratio = rate / configured
    if ratio >= 1.25:
        verdict = 'burning faster than planned — cover is optimistic'
    elif ratio <= 0.75:
        verdict = 'burning slower than planned — cover is conservative'
    else:
        verdict = 'in line with the planned rate'
    return {'ratio': round(ratio, 2), 'verdict': verdict}
