from fastapi import APIRouter, HTTPException, Depends, Query
from ..database import get_db
from ..models import (StockCommandRequest, InventoryUpdateRequest,
                      InventoryPolicyRequest, Station)
from ..events import log_event
from ..llm import parse_stock_command
from ..ws_manager import manager
from ..auth import require_key
from ..conditions import get_delta_t
from ..timeutil import utc_now_iso, to_utc_iso
from ..cascade import propagate_station_change

router = APIRouter(prefix='/inventory', tags=['inventory'])

# Above this, "days of cover" stops being a meaningful number and the UI should
# show it as effectively unlimited rather than a 5-digit figure.
UNBOUNDED_COVER_DAYS = 9999

# --- Supply policy ----------------------------------------------------------
# Criticality used to be one flat "< 15 days" applied to every row, which put
# surgical consumables and spare bolts in the same band. Resupply cadence is
# what actually differs: a medical flight cannot land at Maitri mid-winter, so
# 20 days of pharmaceuticals is an emergency, while 20 days of diesel is an
# ordinary interval between tanker runs.
#
# `category` in the schema is only 'consumable' or 'reusable', so the class is
# read off what the row actually is. A station that disagrees overrides the
# figure per item with safety_stock_days / minimum_threshold.
RISK_CLASS_POLICY = {
    'medical':     {'critical_days': 25, 'warning_days': 45},
    'fuel':        {'critical_days': 14, 'warning_days': 30},
    'rations':     {'critical_days': 20, 'warning_days': 35},
    'spare_parts': {'critical_days': 10, 'warning_days': 20},
    'consumable':  {'critical_days': 15, 'warning_days': 30},
}

# Crew each station is provisioned for. Burn rates in the seed are the rate at
# this headcount, so the ratio against the live roster is the scaling factor.
NOMINAL_HEADCOUNT = {'Maitri': 6, 'Bharati': 5, 'Himadri': 3}

# Statuses that mean a person is eating, drinking and being kept warm by THIS
# station's stores. Someone out on a traverse is carrying their own load.
ON_STATION_STATUSES = ('at_station', 'returned')

# Only what the crew consumes scales with headcount. Reusable kit (blankets,
# generator spares) depletes through wear and failure, not occupancy.
HEADCOUNT_SCALED_CLASSES = ('medical', 'rations', 'consumable')


def risk_class(item: dict) -> str:
    """Which supply-policy band a stock row belongs to."""
    name = (item.get('name') or '').lower()
    if 'medic' in name or 'pharma' in name or 'surg' in name:
        return 'medical'
    if 'fuel' in name or 'diesel' in name or 'petrol' in name or 'kerosene' in name:
        return 'fuel'
    if 'ration' in name or 'food' in name or 'water' in name:
        return 'rations'
    if (item.get('category') or '') == 'reusable':
        return 'spare_parts'
    return 'consumable'


def policy_for(item: dict) -> dict:
    """The thresholds this row is judged against - class defaults unless the
    station has set an explicit floor on the row itself."""
    base = RISK_CLASS_POLICY[risk_class(item)]
    critical = item.get('safety_stock_days')
    if critical is None:
        return dict(base)
    # An explicit floor replaces the critical band; the warning band stays
    # proportional to it rather than being inherited from the class, which
    # could otherwise sit BELOW the operator's own critical line.
    return {'critical_days': float(critical),
            'warning_days': max(float(critical) * 2, float(critical) + 5)}


def station_headcount(station: str, db=None) -> dict:
    """Live crew on station, and what that does to consumable burn rates."""
    db = db or get_db()
    placeholders = ','.join('?' * len(ON_STATION_STATUSES))
    present = db.execute(
        f'SELECT COUNT(*) FROM personnel WHERE station = ? '
        f'AND status IN ({placeholders})',
        (station, *ON_STATION_STATUSES)
    ).fetchone()[0]
    nominal = NOMINAL_HEADCOUNT.get(station) or 1
    # Floored: an empty station still runs its heating and its freezers, so the
    # burn rate does not fall to zero and report infinite cover.
    factor = max(0.25, present / nominal)
    return {'station': station, 'headcount': present, 'nominal_headcount': nominal,
            'factor': round(factor, 3)}


def compute_depletion(item: dict, delta_t: float, headcount_factor: float = 1.0) -> dict:
    """effective_base_rate = base_burn_rate * headcount_factor
       depletion_rate      = effective_base_rate * (1 + beta * delta_T)
       days_of_cover       = quantity / depletion_rate

    The weather multiplier is floored at 0.1 so a large negative delta_T cannot
    flip the rate negative and produce a nonsensical negative cover.

    The headcount factor is the second input the formula was missing. A flat
    base_burn_rate meant a traverse party of eight arriving from Bharati
    changed nothing about Maitri's ration runway, which is exactly the figure
    that arrival should have moved. It applies to what people consume, not to
    reusable kit.
    """
    base_burn_rate = item.get('base_burn_rate') or 0
    beta = item.get('beta') or 0.15
    quantity = max(0.0, item.get('quantity') or 0)

    scaled = risk_class(item) in HEADCOUNT_SCALED_CLASSES
    factor = headcount_factor if scaled else 1.0
    effective_base_rate = base_burn_rate * factor

    depletion_multiplier = max(0.1, 1 + beta * delta_t)
    depletion_rate = effective_base_rate * depletion_multiplier

    if depletion_rate <= 0:
        days_of_cover = UNBOUNDED_COVER_DAYS
    else:
        days_of_cover = min(UNBOUNDED_COVER_DAYS, quantity / depletion_rate)

    policy = policy_for(item)
    minimum = item.get('minimum_threshold')
    if days_of_cover < policy['critical_days']:
        stock_state = 'critical'
    elif days_of_cover < policy['warning_days']:
        stock_state = 'depleting'
    else:
        stock_state = 'nominal'

    return {
        'base_burn_rate': base_burn_rate,
        'effective_base_rate': round(effective_base_rate, 3),
        'headcount_factor': round(factor, 3),
        'beta': beta,
        'delta_t': delta_t,
        'depletion_rate': round(depletion_rate, 2),
        'days_of_cover': round(days_of_cover, 1),
        'risk_class': risk_class(item),
        'critical_days': policy['critical_days'],
        'warning_days': policy['warning_days'],
        'minimum_threshold': minimum,
        'is_below_minimum': minimum is not None and quantity < float(minimum),
        'stock_state': stock_state,
    }


def _with_depletion(row, headcount_factor: float = None) -> dict:
    d = dict(row)
    d['updated_at'] = to_utc_iso(d.get('updated_at'))
    if headcount_factor is None:
        headcount_factor = station_headcount(d['station'])['factor']
    # delta_T is a property of the item's own station, not a global.
    d.update(compute_depletion(d, get_delta_t(d['station']), headcount_factor))
    return d


def _factor_cache(db=None):
    """One headcount query per station per request, not one per row."""
    cache: dict[str, float] = {}

    def factor(station: str) -> float:
        if station not in cache:
            cache[station] = station_headcount(station, db)['factor']
        return cache[station]
    return factor


# --- Persistent low-stock alerts --------------------------------------------
# A toast that vanishes in four seconds is not a record. An operator who was on
# a different tab when diesel crossed its floor had no way to learn it had
# happened - unlike an emergency incident, which stays open in the database
# until somebody closes it.
STOCK_ALERT_ACTION_PREFIX = 'CRITICAL STOCK ALERT'
STOCK_ALERT_CLEARED_PREFIX = 'STOCK ALERT CLEARED'


def _latest_alert_state(db, item_id: str) -> str | None:
    """'raised', 'cleared' or None - the last thing said about this row."""
    row = db.execute(
        "SELECT action FROM events WHERE module = 'inventory' AND related_id = ? "
        "AND (action LIKE ? OR action LIKE ?) ORDER BY seq DESC LIMIT 1",
        (item_id, f'{STOCK_ALERT_ACTION_PREFIX}%', f'{STOCK_ALERT_CLEARED_PREFIX}%')
    ).fetchone()
    if not row:
        return None
    return 'raised' if row['action'].startswith(STOCK_ALERT_ACTION_PREFIX) else 'cleared'


async def evaluate_stock_alerts(station: str, db=None) -> list[dict]:
    """Raise or clear the standing low-stock alert for every row at a station.

    Deliberately called from the WRITE paths (a stock command, a manual
    correction, an unload, a weather change) rather than from list_inventory:
    logging an audit row every time a dashboard polls would bury the timeline
    in duplicates of the same fact.
    """
    db = db or get_db()
    delta_t = get_delta_t(station)
    factor = station_headcount(station, db)['factor']
    rows = db.execute('SELECT * FROM inventory_items WHERE station = ?', (station,)).fetchall()

    changed = []
    for row in rows:
        item = dict(row)
        computed = compute_depletion(item, delta_t, factor)
        breached = computed['stock_state'] == 'critical' or computed['is_below_minimum']
        state = _latest_alert_state(db, item['id'])

        if breached and state != 'raised':
            reason = (f'below its {float(item["minimum_threshold"]):g} {item["unit"] or ""} floor'
                      if computed['is_below_minimum']
                      else f'below its {computed["critical_days"]:g}-day buffer')
            action = (f'{STOCK_ALERT_ACTION_PREFIX}: {item["name"]} at {station} is {reason} '
                      f'({computed["days_of_cover"]:g} days of cover, '
                      f'{item["quantity"]:g} {item["unit"] or ""} on hand)')
            await log_event('inventory', action, 'stock_monitor', item['id'],
                            {'severity': 'critical', 'alert': 'low_stock', **computed},
                            station=station)
            changed.append({'item_id': item['id'], 'name': item['name'], 'station': station,
                            'state': 'raised', 'days_of_cover': computed['days_of_cover'],
                            'unit': item['unit'], 'quantity': item['quantity']})
        elif not breached and state == 'raised':
            await log_event('inventory',
                            f'{STOCK_ALERT_CLEARED_PREFIX}: {item["name"]} at {station} is back '
                            f'above its buffer ({computed["days_of_cover"]:g} days of cover)',
                            'stock_monitor', item['id'],
                            {'severity': 'info', 'alert': 'low_stock_cleared', **computed},
                            station=station)
            changed.append({'item_id': item['id'], 'name': item['name'], 'station': station,
                            'state': 'cleared', 'days_of_cover': computed['days_of_cover'],
                            'unit': item['unit'], 'quantity': item['quantity']})

    if changed:
        await manager.broadcast({'type': 'inventory_alert',
                                 'data': {'station': station, 'changes': changed}})
    return changed


def active_stock_alerts(station: str = None, db=None) -> list[dict]:
    """Rows whose standing alert is currently raised, as the banner shows them."""
    db = db or get_db()
    query = 'SELECT * FROM inventory_items'
    params: list = []
    if station:
        query += ' WHERE station = ?'
        params.append(station)
    factor = _factor_cache(db)
    alerts = []
    for row in db.execute(query, params).fetchall():
        item = dict(row)
        if _latest_alert_state(db, item['id']) != 'raised':
            continue
        computed = compute_depletion(item, get_delta_t(item['station']), factor(item['station']))
        alerts.append({'item_id': item['id'], 'name': item['name'], 'station': item['station'],
                       'quantity': item['quantity'], 'unit': item['unit'],
                       'days_of_cover': computed['days_of_cover'],
                       'critical_days': computed['critical_days'],
                       'is_below_minimum': computed['is_below_minimum'],
                       'minimum_threshold': item['minimum_threshold']})
    alerts.sort(key=lambda a: a['days_of_cover'])
    return alerts


@router.get('')
def list_inventory(station: Station = None, category: str = None):
    db = get_db()
    query = 'SELECT * FROM inventory_items WHERE 1=1'
    params = []
    if station:
        query += ' AND station = ?'
        params.append(station)
    if category:
        query += ' AND category = ?'
        params.append(category)
    query += ' ORDER BY name'
    factor = _factor_cache(db)
    return [_with_depletion(r, factor(r['station']))
            for r in db.execute(query, params).fetchall()]


@router.get('/headcount/{station}')
def headcount_basis(station: Station):
    """What the station's consumable burn rates are currently scaled against.

    The Inventory page quotes this beside the table so the days-of-cover figure
    is traceable: a runway that halved because eight people arrived reads very
    differently from one that halved because of a blizzard.
    """
    return station_headcount(station)


@router.get('/alerts')
def list_stock_alerts(station: Station = None):
    """Standing low-stock alerts - the ones the dashboard banner shows."""
    return active_stock_alerts(station)


@router.post('/alerts/evaluate', dependencies=[Depends(require_key)])
async def run_stock_alert_evaluation(station: Station):
    """Re-run the threshold check for one station and return what changed."""
    changes = await evaluate_stock_alerts(station)
    return {'station': station, 'changes': changes, 'active': active_stock_alerts(station)}


@router.get('/cross-station')
def cross_station_availability(item_name: str = Query(min_length=1, max_length=120)):
    """The same item across every station Prahari covers.

    The multi-station claim was only ever true in the pitch: checking whether
    Bharati had a spare water filter meant switching the console's station,
    reading a number off the table, switching again and holding both in your
    head. One query answers it.
    """
    db = get_db()
    rows = db.execute(
        'SELECT * FROM inventory_items WHERE LOWER(name) LIKE ? ORDER BY station, name',
        (f'%{item_name.lower()}%',)
    ).fetchall()
    factor = _factor_cache(db)
    items = [_with_depletion(r, factor(r['station'])) for r in rows]

    # Surplus is only meaningful between rows counted the same way, so the
    # comparison is grouped by unit rather than summing litres onto units.
    by_unit: dict = {}
    for item in items:
        by_unit.setdefault(item['unit'] or 'unitless', []).append(item)

    return {
        'query': item_name,
        'matched': len(items),
        'items': items,
        'units': sorted(by_unit),
        'best_source': max(items, key=lambda i: i['days_of_cover'])['station'] if items else None,
    }


@router.get('/item/{item_id}')
def get_item(item_id: str):
    db = get_db()
    row = db.execute('SELECT * FROM inventory_items WHERE id = ?', (item_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail='Item not found')
    return _with_depletion(row)


@router.get('/{station}/count')
def exact_count(station: Station, item: str = None):
    """Direct deterministic SQL aggregate - no approximation, no RAG, no LLM.

    A vector/RAG approach answers this via semantic similarity and can return a
    close-but-wrong number. For a life-critical stock count that is unacceptable,
    so this path is a plain SUM over matching rows and reports how many rows it
    covered, so the caller can tell an exact hit from a fuzzy multi-row match.
    """
    db = get_db()
    if item:
        rows = db.execute(
            'SELECT quantity, unit, name FROM inventory_items '
            'WHERE station = ? AND LOWER(name) LIKE ? ORDER BY name',
            (station, f'%{item.lower()}%')
        ).fetchall()
        if not rows:
            raise HTTPException(status_code=404,
                                detail=f'No inventory item matching "{item}" at {station}')
        # Summing rows with different units would be meaningless.
        units = {r['unit'] for r in rows}
        if len(units) > 1:
            raise HTTPException(
                status_code=409,
                detail=f'"{item}" matches {len(rows)} items with mixed units {sorted(units)} - '
                       f'refine the query rather than summing incompatible units.'
            )
        return {
            'item': rows[0]['name'] if len(rows) == 1 else f'{item} ({len(rows)} items)',
            'quantity': sum(r['quantity'] for r in rows),
            'unit': rows[0]['unit'],
            'matched_rows': len(rows),
            'station': station,
            'method': 'direct_sql_aggregate',
        }

    rows = db.execute('SELECT COUNT(*) AS n FROM inventory_items WHERE station = ?',
                      (station,)).fetchone()
    return {'item': 'all items', 'quantity': rows['n'], 'unit': 'distinct records',
            'matched_rows': rows['n'], 'station': station, 'method': 'direct_sql_aggregate'}


@router.post('/command', dependencies=[Depends(require_key)])
async def process_stock_command(req: StockCommandRequest):
    """Apply a typed stock adjustment to ONE station's stock.

    The match is scoped to `req.station` — the console's active station. Seed
    data carries Diesel Fuel, Medical Supplies and Emergency Rations at all
    three bases, so an unscoped LIKE matched three rows for every common item
    and the command was never applied. The parsed `location` is advisory only:
    the station the operator is looking at decides what gets written.

    With `dry_run` the parse and the matched row come back untouched, so the UI
    can show what it understood and wait for an explicit Apply.
    """
    result = await parse_stock_command(req.transcript)
    db = get_db()
    item_name = result['item']
    station = req.station

    rows = db.execute(
        'SELECT * FROM inventory_items WHERE station = ? AND LOWER(name) LIKE ? ORDER BY name',
        (station, f'%{item_name.lower()}%')
    ).fetchall()
    if not rows:
        return {'parsed': result, 'applied': False, 'station': station, 'dry_run': req.dry_run,
                'error': f'Item "{item_name}" not found in {station} inventory'}
    if len(rows) > 1:
        # Two genuinely different items at the same station still need the
        # operator to disambiguate — applying to an arbitrary one loses stock.
        return {'parsed': result, 'applied': False, 'station': station, 'dry_run': req.dry_run,
                'ambiguous_matches': [r['name'] for r in rows],
                'error': f'"{item_name}" matched {len(rows)} items at {station} - be more specific'}

    item = dict(rows[0])
    old_qty = item['quantity']
    # The parse layer already bounds this, but the direction of a stock
    # movement must never be able to come from the sign of its magnitude: a
    # decrement of -200 would read as "removed 200" and write +200. Belt and
    # braces, because the thing on the other side of this line is how much
    # diesel a station believes it has.
    delta = abs(float(result['quantity'] or 0))
    if result['action'] == 'decrement':
        new_qty = max(0, old_qty - delta)
        shortfall = delta - (old_qty - new_qty)
    else:
        new_qty = old_qty + delta
        shortfall = 0

    if req.dry_run:
        # Nothing is written: this is the preview the operator confirms.
        preview = {'parsed': result, 'applied': False, 'dry_run': True, 'station': station,
                   'item_id': item['id'], 'item_name': item['name'], 'unit': item['unit'],
                   'old_quantity': old_qty, 'new_quantity': new_qty}
        if shortfall > 0:
            preview['warning'] = (f'Requested {delta} but only {old_qty} {item["unit"]} is in '
                                  f'stock - {shortfall} could not be issued')
        return preview

    now = utc_now_iso()
    db.execute('UPDATE inventory_items SET quantity = ?, updated_at = ? WHERE id = ?',
               (new_qty, now, item['id']))
    db.commit()

    await log_event('inventory', f'Stock command at {station}: {result["action"]} {delta} '
                    f'{item["name"]} (was {old_qty}, now {new_qty})', 'stock_command', item['id'],
                    {'parsed': result, 'station': station}, station=station)
    await manager.broadcast({'type': 'inventory_update',
                             'data': {'item_id': item['id'], 'new_quantity': new_qty}})
    await evaluate_stock_alerts(station, db)
    await propagate_station_change(station, 'stock command', db)

    response = {'parsed': result, 'applied': True, 'dry_run': False, 'station': station,
                'old_quantity': old_qty, 'new_quantity': new_qty,
                'item_id': item['id'], 'item_name': item['name'], 'unit': item['unit']}
    if shortfall > 0:
        # Silently clamping to zero hides that the station was asked for stock
        # it did not have.
        response['warning'] = (f'Requested {delta} but only {old_qty} was in stock - '
                               f'{shortfall} could not be issued')
    return response


@router.patch('/{item_id}', dependencies=[Depends(require_key)])
async def update_item(item_id: str, body: InventoryUpdateRequest, station: Station = None):
    """Manual quantity correction, scoped to the console's active station.

    The station arrives in the body (or as a query parameter) and must match the
    item's own station. Without that check an edit made while looking at Bharati
    could be applied to a Maitri row by id alone.
    """
    db = get_db()
    row = db.execute('SELECT * FROM inventory_items WHERE id = ?', (item_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail='Item not found')

    requested_station = body.station or station
    if requested_station and requested_station != row['station']:
        raise HTTPException(
            status_code=403,
            detail=f'{row["name"]} ({item_id}) belongs to {row["station"]}, not '
                   f'{requested_station} - switch the active station to edit it.')

    now = utc_now_iso()
    db.execute('UPDATE inventory_items SET quantity = ?, updated_at = ? WHERE id = ?',
               (body.quantity, now, item_id))
    db.commit()
    await log_event('inventory',
                    f'Inventory updated at {row["station"]}: {row["name"]} quantity '
                    f'{row["quantity"]} -> {body.quantity}',
                    'commander', item_id, station=row['station'])
    await manager.broadcast({'type': 'inventory_update',
                             'data': {'item_id': item_id, 'new_quantity': body.quantity}})
    await evaluate_stock_alerts(row['station'], db)
    await propagate_station_change(row['station'], 'stock correction', db)
    return _with_depletion(db.execute('SELECT * FROM inventory_items WHERE id = ?',
                                      (item_id,)).fetchone())


@router.patch('/{item_id}/policy', dependencies=[Depends(require_key)])
async def update_item_policy(item_id: str, body: InventoryPolicyRequest):
    """Set this row's own supply floor.

    Criticality used to be inferred entirely from hard-coded day maths in the
    browser, so an emergency battery bank that must never fall below 10 units
    had nowhere to say so. Either field can be cleared by sending null.
    """
    db = get_db()
    row = db.execute('SELECT * FROM inventory_items WHERE id = ?', (item_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail='Item not found')
    if body.station and body.station != row['station']:
        raise HTTPException(
            status_code=403,
            detail=f'{row["name"]} ({item_id}) belongs to {row["station"]}, not {body.station}.')

    minimum = row['minimum_threshold'] if body.minimum_threshold is None \
        and not body.clear_minimum else body.minimum_threshold
    safety = row['safety_stock_days'] if body.safety_stock_days is None \
        and not body.clear_safety_stock_days else body.safety_stock_days

    db.execute('UPDATE inventory_items SET minimum_threshold = ?, safety_stock_days = ?, '
               'updated_at = ? WHERE id = ?', (minimum, safety, utc_now_iso(), item_id))
    db.commit()

    described = []
    if minimum is not None:
        described.append(f'floor {minimum:g} {row["unit"] or ""}'.strip())
    if safety is not None:
        described.append(f'{safety:g}-day buffer')
    await log_event('inventory',
                    f'Supply policy set for {row["name"]} at {row["station"]}: '
                    f'{", ".join(described) if described else "class defaults restored"}',
                    'commander', item_id, station=row['station'])
    await evaluate_stock_alerts(row['station'], db)
    await manager.broadcast({'type': 'inventory_update',
                             'data': {'item_id': item_id, 'station': row['station']}})
    return _with_depletion(db.execute('SELECT * FROM inventory_items WHERE id = ?',
                                      (item_id,)).fetchone())
