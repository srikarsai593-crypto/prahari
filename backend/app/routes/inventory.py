from fastapi import APIRouter, HTTPException, Depends
from ..database import get_db
from ..models import StockCommandRequest, InventoryUpdateRequest, Station
from ..events import log_event
from ..llm import parse_stock_command
from ..ws_manager import manager
from ..auth import require_key
from ..conditions import get_delta_t
from ..timeutil import utc_now_iso, to_utc_iso

router = APIRouter(prefix='/inventory', tags=['inventory'])

# Above this, "days of cover" stops being a meaningful number and the UI should
# show it as effectively unlimited rather than a 5-digit figure.
UNBOUNDED_COVER_DAYS = 9999


def compute_depletion(item: dict, delta_t: float) -> dict:
    """depletion_rate = base_burn_rate * (1 + beta * delta_T)
       days_of_cover  = quantity / depletion_rate

    The multiplier is floored at 0.1 so a large negative delta_T cannot flip the
    rate negative and produce a nonsensical negative cover.
    """
    base_burn_rate = item.get('base_burn_rate') or 0
    beta = item.get('beta') or 0.15
    quantity = max(0.0, item.get('quantity') or 0)

    depletion_multiplier = max(0.1, 1 + beta * delta_t)
    depletion_rate = base_burn_rate * depletion_multiplier

    if depletion_rate <= 0:
        days_of_cover = UNBOUNDED_COVER_DAYS
    else:
        days_of_cover = min(UNBOUNDED_COVER_DAYS, quantity / depletion_rate)

    return {
        'base_burn_rate': base_burn_rate,
        'beta': beta,
        'delta_t': delta_t,
        'depletion_rate': round(depletion_rate, 2),
        'days_of_cover': round(days_of_cover, 1),
    }


def _with_depletion(row) -> dict:
    d = dict(row)
    d['updated_at'] = to_utc_iso(d.get('updated_at'))
    # delta_T is a property of the item's own station, not a global.
    d.update(compute_depletion(d, get_delta_t(d['station'])))
    return d


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
    return [_with_depletion(r) for r in db.execute(query, params).fetchall()]


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
    delta = result['quantity']
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
    return _with_depletion(db.execute('SELECT * FROM inventory_items WHERE id = ?',
                                      (item_id,)).fetchone())
