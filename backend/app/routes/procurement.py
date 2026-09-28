"""The leg before the ship.

A consignment starts at the dock. A station's exposure starts weeks earlier,
when someone orders the fuel — and those weeks are where a season is won or
lost. The console could see a crate the moment it was on a vessel and was
blind to everything before that, so "the tanker has not been ordered yet"
and "the tanker is three days out" looked identical from the Cargo board:
absent.

This is that leg. Two things make it a supply chain rather than a second
list:

* **Dispatching an order creates the consignment.** It is not a parallel
  table that happens to mention the same cargo — `POST /procurement/{id}/
  dispatch` calls the real shipment-creation path, links the two, and the
  order becomes `shipped`. The stock row the order named is carried through,
  so the eventual restock still lands on the right item.
* **Lateness is derived on read**, from the vendor's promised date, exactly
  as a consignment's is from its ETA. No scheduler, nothing to catch up on
  after an outage, and the answer is never stale.

What this is not: a vendor portal. Vendors do not log in here and nothing is
sent to them. It is the station's own record of what it has on order, which
is the part the station is answerable for.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query

from ..auth import require_key, require_reader
from ..database import get_db
from ..events import log_event
from ..models import (PurchaseOrderCreate, PurchaseOrderDispatch,
                      PurchaseOrderUpdate, Station)
from ..ratelimit import guard_write
from ..timeutil import to_utc_iso, utc_now, utc_now_iso
from ..ws_manager import manager

# Reads are gated at the router, so a route added later inherits the gate
# instead of quietly shipping open.
router = APIRouter(prefix='/procurement', tags=['procurement'],
                   dependencies=[Depends(require_reader)])

# Statuses where the station is still waiting on the vendor, so a passed
# promise date means something is wrong with the order.
AWAITING_STATUSES = ('ordered', 'confirmed')

# Only a confirmed order can be dispatched. An order the vendor has not
# acknowledged is not cargo, and creating a consignment from one would put a
# crate on the board that nobody has agreed to supply.
DISPATCHABLE_STATUSES = ('confirmed',)


def _reference() -> str:
    return f'PO-{utc_now().year}-{uuid.uuid4().hex.upper()[:6]}'


def _overdue_fields(order: dict, now=None) -> dict:
    """Has the vendor missed the date they promised?

    Derived on read rather than written by a job, for the same reason a
    consignment's lateness is: a station that is offline for days has no
    backlog to work through, and the answer is current whenever it is asked.
    """
    from .shipments import _parse_iso

    now = now or utc_now()
    promised = _parse_iso(order.get('promised_at'))
    if promised is None or order.get('status') not in AWAITING_STATUSES or now <= promised:
        return {'is_overdue': False, 'days_overdue': None, 'slip_warning': None}

    days = round((now - promised).total_seconds() / 86400, 1)
    return {
        'is_overdue': True,
        'days_overdue': days,
        'slip_warning': (f'{order["vendor"]} promised this {days:g} day(s) ago and it has '
                         f'not shipped. Chase it, or plan without it.'),
    }


def _serialise(row, now=None) -> dict:
    d = dict(row)
    for field in ('ordered_at', 'promised_at'):
        if field in d:
            d[field] = to_utc_iso(d[field])
    d.update(_overdue_fields(d, now))
    return d


@router.get('')
def list_orders(station: Station = None, status: str = None):
    """What the station has on order. Slipped orders first — an order the
    vendor has missed is the most urgent row here, and it should not wait
    its turn behind whatever was raised most recently."""
    db = get_db()
    query = 'SELECT * FROM purchase_orders WHERE 1=1'
    params: list = []
    if station:
        query += ' AND destination_station = ?'
        params.append(station)
    if status:
        query += ' AND status = ?'
        params.append(status)
    query += ' ORDER BY ordered_at DESC'

    now = utc_now()
    orders = [_serialise(r, now) for r in db.execute(query, params).fetchall()]
    orders.sort(key=lambda o: (not o['is_overdue'], -(o['days_overdue'] or 0)))
    return orders


@router.post('', dependencies=[Depends(require_key), Depends(guard_write)])
async def create_order(data: PurchaseOrderCreate):
    """Record an order placed with a vendor."""
    from datetime import timedelta

    db = get_db()
    if data.inventory_item_id:
        target = db.execute('SELECT station FROM inventory_items WHERE id = ?',
                            (data.inventory_item_id,)).fetchone()
        if target is None:
            raise HTTPException(status_code=404,
                                detail=f'No stock row {data.inventory_item_id} to restock.')
        if target['station'] != data.destination_station:
            raise HTTPException(
                status_code=422,
                detail=f'That stock row belongs to {target["station"]}, but this order is '
                       f'routed to {data.destination_station}.')

    order_id = 'po-' + str(uuid.uuid4())[:8]
    reference = _reference()
    promised = (to_utc_iso(utc_now() + timedelta(days=data.promised_in_days))
                if data.promised_in_days is not None else None)

    db.execute(
        'INSERT INTO purchase_orders (id, reference, vendor, item_name, category, quantity, '
        'unit, inventory_item_id, destination_station, status, ordered_at, promised_at, '
        'notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        (order_id, reference, data.vendor, data.item_name, data.category, data.quantity,
         data.unit, data.inventory_item_id, data.destination_station, 'ordered',
         utc_now_iso(), promised, data.notes))
    db.commit()

    await log_event('procurement',
                    f'Order {reference} raised with {data.vendor}: {data.item_name} '
                    f'for {data.destination_station}',
                    'commander', order_id,
                    {'vendor': data.vendor, 'reference': reference},
                    station=data.destination_station)
    await manager.broadcast({'type': 'procurement_update',
                             'data': {'order_id': order_id, 'status': 'ordered',
                                      'station': data.destination_station}})
    return _serialise(db.execute('SELECT * FROM purchase_orders WHERE id = ?',
                                 (order_id,)).fetchone())


@router.patch('/{order_id}', dependencies=[Depends(require_key), Depends(guard_write)])
async def update_order(order_id: str, body: PurchaseOrderUpdate):
    """Confirm an order, re-date it, or call it off."""
    from datetime import timedelta

    db = get_db()
    row = db.execute('SELECT * FROM purchase_orders WHERE id = ?', (order_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail='Purchase order not found')
    if row['status'] == 'shipped':
        raise HTTPException(
            status_code=409,
            detail=f'{row["reference"]} has already shipped as a consignment. Track it on '
                   f'the cargo board from here.')
    if body.status is None and body.promised_in_days is None and body.notes is None:
        raise HTTPException(status_code=422,
                            detail='Send at least one of status, promised_in_days or notes.')

    status = body.status or row['status']
    promised = (to_utc_iso(utc_now() + timedelta(days=body.promised_in_days))
                if body.promised_in_days is not None else row['promised_at'])
    notes = body.notes if body.notes is not None else row['notes']

    db.execute('UPDATE purchase_orders SET status = ?, promised_at = ?, notes = ? '
               'WHERE id = ?', (status, promised, notes, order_id))
    db.commit()

    changes = []
    if body.status and status != row['status']:
        changes.append(f'{row["status"]} -> {status}')
    if body.promised_in_days is not None:
        changes.append(f'promised {to_utc_iso(promised)}')
    if changes:
        await log_event('procurement',
                        f'Order {row["reference"]} ({row["vendor"]}): {"; ".join(changes)}',
                        'commander', order_id, station=row['destination_station'])
    await manager.broadcast({'type': 'procurement_update',
                             'data': {'order_id': order_id, 'status': status,
                                      'station': row['destination_station']}})
    return _serialise(db.execute('SELECT * FROM purchase_orders WHERE id = ?',
                                 (order_id,)).fetchone())


@router.post('/{order_id}/dispatch', dependencies=[Depends(require_key), Depends(guard_write)])
async def dispatch_order(order_id: str, body: PurchaseOrderDispatch):
    """Turn a confirmed order into a consignment on its way to the station.

    This is what makes procurement the *first leg* rather than a second
    list: it calls the real shipment-creation path, so the crate that
    appears on the cargo board is an ordinary consignment with a barcode, a
    risk score, a cold-chain band where its category has one, and the stock
    row the order named already attached.
    """
    from .shipments import create_shipment
    from ..models import ShipmentCreate

    db = get_db()
    row = db.execute('SELECT * FROM purchase_orders WHERE id = ?', (order_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail='Purchase order not found')
    if row['status'] == 'shipped':
        raise HTTPException(status_code=409,
                            detail=f'{row["reference"]} has already been dispatched.')
    if row['status'] not in DISPATCHABLE_STATUSES:
        raise HTTPException(
            status_code=409,
            detail=f'{row["reference"]} is {row["status"]}. Confirm it with the vendor '
                   f'before putting a crate on the board for it.')

    shipment = await create_shipment(ShipmentCreate(
        item_name=row['item_name'], category=row['category'],
        weight_kg=body.weight_kg, quantity=row['quantity'], unit=row['unit'],
        inventory_item_id=row['inventory_item_id'],
        destination_station=row['destination_station'], eta_hours=body.eta_hours))

    db.execute("UPDATE purchase_orders SET status = 'shipped', shipment_id = ? WHERE id = ?",
               (shipment['id'], order_id))
    db.commit()

    await log_event('procurement',
                    f'Order {row["reference"]} ({row["vendor"]}) dispatched as consignment '
                    f'{shipment["barcode_id"]}',
                    'commander', order_id,
                    {'shipment_id': shipment['id'], 'barcode_id': shipment['barcode_id']},
                    station=row['destination_station'])
    await manager.broadcast({'type': 'procurement_update',
                             'data': {'order_id': order_id, 'status': 'shipped',
                                      'station': row['destination_station']}})

    return {'order': _serialise(db.execute('SELECT * FROM purchase_orders WHERE id = ?',
                                           (order_id,)).fetchone()),
            'shipment': shipment}


@router.get('/{order_id}')
def get_order(order_id: str):
    db = get_db()
    row = db.execute('SELECT * FROM purchase_orders WHERE id = ?', (order_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail='Purchase order not found')
    return _serialise(row)
