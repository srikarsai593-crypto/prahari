from fastapi import APIRouter, HTTPException, Depends
import uuid, io, base64
from datetime import datetime, timedelta
import qrcode
from ..database import get_db
from ..models import (ShipmentCreate, RiskUpdateRequest, StationWeatherRequest,
                      BarcodeScanRequest, Station)
from ..events import log_event
from ..ws_manager import manager
from ..auth import require_key
from ..conditions import set_delta_t, get_delta_t, all_delta_t
from ..timeutil import utc_now, utc_now_iso, to_utc_iso

router = APIRouter(prefix='/shipments', tags=['shipments'])

STATUS_ORDER = ['dispatched', 'in_transit', 'arrived', 'unloaded']
CAPACITY_KG = 10000          # vessel capacity per shipment
TRANSIT_DAYS = 14            # nominal sea leg to station

# Cargo category -> the inventory item it replenishes when unloaded.
# The previous LIKE-match on the raw category string matched the wrong row (or
# none at all) and skipped the restock silently.
CATEGORY_TO_INVENTORY = {
    'fuel': 'Diesel Fuel',
    'food': 'Emergency Rations',
    'medical': 'Medical Supplies',
    'equipment': 'Thermal Blankets',
}


def generate_barcode_id() -> str:
    """Collision-resistant barcode. A COUNT(*)-based scheme raced on concurrent creates."""
    return f'SHP-{utc_now().year}-{uuid.uuid4().hex.upper()[:6]}'


def generate_qr_base64(payload: str) -> str:
    # Level H error correction - ~30% obstruction tolerance (frost/damage resistant).
    qr = qrcode.QRCode(version=1, error_correction=qrcode.constants.ERROR_CORRECT_H,
                       box_size=10, border=4)
    qr.add_data(payload)
    qr.make(fit=True)
    buf = io.BytesIO()
    qr.make_image(fill_color='black', back_color='white').save(buf, format='PNG')
    return base64.b64encode(buf.getvalue()).decode()


def _serialise(row) -> dict:
    d = dict(row)
    for field in ('dispatch_date', 'eta', 'last_scanned_at', 'updated_at'):
        if field in d:
            d[field] = to_utc_iso(d[field])
    return d


@router.get('')
def list_shipments(station: Station = None, status: str = None, priority: str = None):
    """QR images are deliberately NOT inlined here.

    Encoding a PNG per row on every poll made the list O(n) image encodes and
    added ~10 kB per shipment to the payload. Clients fetch the single QR they
    actually display from /shipments/{id}/qr.
    """
    db = get_db()
    query = 'SELECT * FROM shipments WHERE 1=1'
    params = []
    if station:
        query += ' AND destination_station = ?'
        params.append(station)
    if status:
        query += ' AND status = ?'
        params.append(status)
    if priority:
        query += ' AND priority = ?'
        params.append(priority)
    query += ' ORDER BY updated_at DESC'
    return [_serialise(r) for r in db.execute(query, params).fetchall()]


@router.get('/delta-t/current')
def get_current_delta_t(station: Station = None):
    """Current blizzard delta-T, per station, read from the database."""
    if station:
        return {'station': station, 'delta_t': get_delta_t(station)}
    return {'stations': all_delta_t()}


@router.post('/scan-barcode', dependencies=[Depends(require_key)])
async def scan_by_barcode(body: BarcodeScanRequest):
    return await _advance_shipment(barcode_id=body.barcode_id)


@router.get('/{shipment_id}/qr')
def get_shipment_qr(shipment_id: str):
    """The QR image for one shipment, fetched only when it is displayed."""
    db = get_db()
    row = db.execute('SELECT barcode_id FROM shipments WHERE id = ? OR barcode_id = ?',
                     (shipment_id, shipment_id)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail='Shipment not found')
    return {'barcode_id': row['barcode_id'], 'qr_code': generate_qr_base64(row['barcode_id'])}


@router.get('/{shipment_id}')
def get_shipment(shipment_id: str):
    db = get_db()
    row = db.execute('SELECT * FROM shipments WHERE id = ?', (shipment_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail='Shipment not found')
    return _serialise(row)


@router.post('', dependencies=[Depends(require_key)])
async def create_shipment(data: ShipmentCreate):
    """Register a consignment.

    Two things the old version did not do: carry what the crate contains in the
    destination's own units (so unloading can restock exactly), and move stock
    out of an origin station on an inter-station transfer.
    """
    db = get_db()

    # Resolve the stock row this consignment tops up. An explicit id wins; the
    # category map is the fallback for an external resupply with no row picked.
    target_name = None
    if data.inventory_item_id:
        target = db.execute('SELECT * FROM inventory_items WHERE id = ?',
                            (data.inventory_item_id,)).fetchone()
        if not target:
            raise HTTPException(status_code=404,
                                detail=f'Inventory item "{data.inventory_item_id}" not found')
        if target['station'] != data.destination_station:
            raise HTTPException(
                status_code=422,
                detail=f'{target["name"]} belongs to {target["station"]}, but this shipment is '
                       f'routed to {data.destination_station}.')
        target_name = target['name']
    else:
        target_name = CATEGORY_TO_INVENTORY.get(data.category)
        target = db.execute(
            'SELECT * FROM inventory_items WHERE station = ? AND name = ?',
            (data.destination_station, target_name)).fetchone() if target_name else None

    quantity = data.quantity
    unit = data.unit
    if target is not None:
        # Default the payload to the destination row's own unit so the two can
        # never disagree, and fall back to the shipping weight only when the
        # row is genuinely counted in kilograms.
        unit = unit or target['unit']
        if quantity is None and (target['unit'] or '').lower() == 'kg':
            quantity = data.weight_kg

    origin_note = ''
    origin_row = None
    if data.origin_station:
        # An inter-station transfer is a real stock movement: the crate cannot
        # both sit at the origin and be in the hold.
        if quantity is None:
            raise HTTPException(
                status_code=422,
                detail='An inter-station transfer needs a quantity — state how much leaves '
                       f'{data.origin_station}.')
        origin_row = db.execute(
            'SELECT * FROM inventory_items WHERE station = ? AND name = ?',
            (data.origin_station, target_name or data.item_name)).fetchone()
        if not origin_row:
            raise HTTPException(
                status_code=422,
                detail=f'{data.origin_station} holds no "{target_name or data.item_name}" to send.')
        if (origin_row['unit'] or '').lower() != (unit or '').lower():
            raise HTTPException(
                status_code=422,
                detail=f'{data.origin_station} counts {origin_row["name"]} in '
                       f'{origin_row["unit"]}, not {unit} — units must match to transfer.')
        if origin_row['quantity'] < quantity:
            raise HTTPException(
                status_code=409,
                detail=f'{data.origin_station} has only {origin_row["quantity"]} '
                       f'{origin_row["unit"]} of {origin_row["name"]} — cannot send {quantity}.')

    ship_id = 'shp-' + str(uuid.uuid4())[:8]
    barcode_id = generate_barcode_id()
    now = utc_now()
    eta = to_utc_iso(now + timedelta(days=TRANSIT_DAYS))

    capacity_warning = None
    if data.weight_kg > CAPACITY_KG:
        capacity_warning = f'Weight {data.weight_kg}kg exceeds vessel capacity {CAPACITY_KG}kg'

    db.execute(
        'INSERT INTO shipments (id, barcode_id, expedition_id, item_name, category, '
        'weight_kg, quantity, unit, inventory_item_id, priority, origin_station, '
        'destination_station, status, dispatch_date, eta, updated_at) '
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        (ship_id, barcode_id, data.expedition_id, data.item_name, data.category,
         data.weight_kg, quantity, unit,
         data.inventory_item_id or (target['id'] if target is not None else None),
         data.priority, data.origin_station, data.destination_station, 'dispatched',
         utc_now_iso(), eta, utc_now_iso())
    )

    if origin_row is not None:
        new_origin_qty = origin_row['quantity'] - quantity
        db.execute('UPDATE inventory_items SET quantity = ?, updated_at = ? WHERE id = ?',
                   (new_origin_qty, utc_now_iso(), origin_row['id']))
        origin_note = (f' — {quantity} {origin_row["unit"]} drawn from '
                       f'{data.origin_station} stock')
    db.commit()

    route = (f'{data.origin_station} -> {data.destination_station}' if data.origin_station
             else f'external resupply -> {data.destination_station}')
    await log_event('cargo', f'Shipment {barcode_id} created: {data.item_name} '
                    f'({data.category}, {route}){origin_note}',
                    'commander', ship_id, station=data.destination_station)
    if origin_row is not None:
        await log_event('inventory', f'{quantity} {origin_row["unit"]} of {origin_row["name"]} '
                        f'released to shipment {barcode_id} for {data.destination_station}',
                        'cargo_system', origin_row['id'], station=data.origin_station)
        await manager.broadcast({'type': 'inventory_update',
                                 'data': {'item_id': origin_row['id'],
                                          'new_quantity': new_origin_qty}})
    await manager.broadcast({'type': 'shipment_update',
                             'data': {'shipment_id': ship_id, 'status': 'dispatched'}})

    result = {'id': ship_id, 'barcode_id': barcode_id, 'eta': eta, 'status': 'dispatched',
              **data.model_dump(), 'quantity': quantity, 'unit': unit}
    if capacity_warning:
        result['capacity_warning'] = capacity_warning
    if not quantity:
        result['restock_warning'] = (
            f'No stock row at {data.destination_station} matches this consignment — '
            f'unloading it will not top up inventory automatically.')
    return result


async def _advance_shipment(shipment_id: str = None, barcode_id: str = None):
    db = get_db()
    if barcode_id:
        row = db.execute('SELECT * FROM shipments WHERE barcode_id = ?', (barcode_id,)).fetchone()
    else:
        row = db.execute('SELECT * FROM shipments WHERE id = ? OR barcode_id = ?',
                         (shipment_id, shipment_id)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail='Shipment not found')

    shipment = dict(row)
    current_status = shipment['status']
    if current_status == 'delayed':
        current_status = 'in_transit'   # a delayed shipment resumes from in_transit

    if current_status not in STATUS_ORDER:
        await log_event('cargo', f'Anomaly: shipment {shipment["barcode_id"]} scanned with '
                        f'unknown status {current_status}', 'system', shipment['id'],
                        {'anomaly': True}, station=shipment['destination_station'])
        raise HTTPException(status_code=400, detail=f'Unknown status: {current_status}')

    idx = STATUS_ORDER.index(current_status)
    if idx >= len(STATUS_ORDER) - 1:
        await log_event('cargo', f'Anomaly: shipment {shipment["barcode_id"]} already fully '
                        f'processed (status: {current_status})', 'system', shipment['id'],
                        {'anomaly': True}, station=shipment['destination_station'])
        raise HTTPException(status_code=409, detail='Shipment already fully processed')

    new_status = STATUS_ORDER[idx + 1]
    now = utc_now_iso()
    db.execute('UPDATE shipments SET status = ?, last_scanned_at = ?, updated_at = ? WHERE id = ?',
               (new_status, now, now, shipment['id']))
    db.commit()
    await log_event('cargo', f'Shipment {shipment["barcode_id"]} scanned: '
                    f'{current_status} -> {new_status}', 'scanner', shipment['id'],
                    station=shipment['destination_station'])

    # Cross-module: unloading cargo replenishes the stock row it was booked
    # against, in that row's own units. The shipment carries the quantity, so
    # this is an exact top-up rather than a guess from the shipping weight.
    if new_status == 'unloaded':
        inv_row = None
        if shipment.get('inventory_item_id'):
            inv_row = db.execute('SELECT * FROM inventory_items WHERE id = ?',
                                 (shipment['inventory_item_id'],)).fetchone()
        if inv_row is None:
            target = CATEGORY_TO_INVENTORY.get(shipment['category'])
            inv_row = db.execute(
                'SELECT * FROM inventory_items WHERE station = ? AND name = ?',
                (shipment['destination_station'], target)
            ).fetchone() if target else None

        payload = shipment.get('quantity')
        payload_unit = (shipment.get('unit') or '').lower()

        if inv_row is not None and inv_row['station'] != shipment['destination_station']:
            await log_event('cargo', f'Anomaly: shipment {shipment["barcode_id"]} is booked '
                            f'against stock at {inv_row["station"]} but was unloaded at '
                            f'{shipment["destination_station"]} - no restock applied',
                            'system', shipment['id'], {'anomaly': True},
                            station=shipment['destination_station'])
        elif inv_row is None:
            await log_event('cargo', f'Shipment {shipment["barcode_id"]} unloaded but no stock '
                            f'record at {shipment["destination_station"]} matches it - '
                            f'add the quantity manually',
                            'system', shipment['id'], {'anomaly': True},
                            station=shipment['destination_station'])
        elif not payload:
            await log_event('cargo', f'Shipment {shipment["barcode_id"]} unloaded but carries no '
                            f'stated quantity - "{inv_row["name"]}" not topped up automatically',
                            'system', shipment['id'], {'anomaly': True},
                            station=shipment['destination_station'])
        elif payload_unit and payload_unit != (inv_row['unit'] or '').lower():
            await log_event('cargo', f'Anomaly: shipment {shipment["barcode_id"]} declares '
                            f'{payload} {shipment["unit"]} but "{inv_row["name"]}" at '
                            f'{shipment["destination_station"]} is counted in {inv_row["unit"]} - '
                            f'unit mismatch prevented auto-restock; adjust the stock manually',
                            'system', shipment['id'],
                            {'anomaly': True, 'unit_mismatch': True,
                             'shipment_unit': shipment['unit'],
                             'inventory_unit': inv_row['unit'],
                             'inventory_item_id': inv_row['id']},
                            station=shipment['destination_station'])
        else:
            new_qty = inv_row['quantity'] + payload
            db.execute('UPDATE inventory_items SET quantity = ?, updated_at = ? WHERE id = ?',
                       (new_qty, now, inv_row['id']))
            db.commit()
            await log_event('inventory', f'{inv_row["name"]} restocked from unloaded shipment '
                            f'{shipment["barcode_id"]}: {inv_row["quantity"]} -> {new_qty} '
                            f'{inv_row["unit"]} (+{payload})',
                            'cargo_system', inv_row['id'],
                            station=shipment['destination_station'])
            await manager.broadcast({'type': 'inventory_update',
                                     'data': {'item_id': inv_row['id'], 'new_quantity': new_qty}})

    await manager.broadcast({'type': 'shipment_update',
                             'data': {'shipment_id': shipment['id'], 'status': new_status}})
    return {'id': shipment['id'], 'barcode_id': shipment['barcode_id'],
            'old_status': current_status, 'new_status': new_status}


@router.post('/{shipment_id}/scan', dependencies=[Depends(require_key)])
async def scan_shipment(shipment_id: str):
    return await _advance_shipment(shipment_id=shipment_id)


def _score_risk(delta_t: float, priority: str) -> int:
    """Weather dominates, season is a fixed penalty, and critical cargo carries
    extra exposure because a delay costs more."""
    weather_severity_score = (delta_t / 40) * 60
    season_factor = 10
    priority_weight = 15 if priority == 'critical' else 0
    return max(0, min(100, int(weather_severity_score + season_factor + priority_weight)))


async def _apply_station_weather(station: str, delta_t: float) -> dict:
    """Write one station's blizzard load and re-score EVERY consignment bound
    for it.

    Weather is a property of the station, not of one crate. The old flow made
    the operator pick a single shipment, wrote the station ΔT from it and then
    re-scored only that one — so every other consignment to the same base kept
    a risk score from the previous weather, and the list showed two shipments
    on the same route in different risk bands.
    """
    db = get_db()
    applied_delta_t = set_delta_t(station, delta_t)
    now = utc_now_iso()

    rows = db.execute(
        "SELECT * FROM shipments WHERE destination_station = ? "
        "AND status NOT IN ('arrived', 'unloaded')", (station,)
    ).fetchall()

    rescored = []
    for row in rows:
        shipment = dict(row)
        risk_score = _score_risk(applied_delta_t, shipment['priority'])
        new_status = shipment['status']
        delay_reason = shipment['delay_reason']
        eta = shipment['eta']

        if risk_score >= 50 and new_status in ('dispatched', 'in_transit', 'delayed'):
            new_status = 'delayed'
            delay_reason = 'weather'
            # Recompute from the original dispatch date so repeated weather
            # updates do not compound a delay on an already-delayed ETA.
            base = shipment['dispatch_date'] or now
            try:
                base_dt = datetime.fromisoformat(str(base).replace('Z', '+00:00'))
            except ValueError:
                base_dt = utc_now()
            eta = to_utc_iso(base_dt + timedelta(days=TRANSIT_DAYS, hours=risk_score * 0.5))
        elif risk_score < 50 and new_status == 'delayed' and delay_reason == 'weather':
            # The blizzard lifted: a shipment held for weather resumes rather
            # than staying delayed forever because nothing ever cleared it.
            new_status = 'in_transit'
            delay_reason = None
            base = shipment['dispatch_date'] or now
            try:
                base_dt = datetime.fromisoformat(str(base).replace('Z', '+00:00'))
            except ValueError:
                base_dt = utc_now()
            eta = to_utc_iso(base_dt + timedelta(days=TRANSIT_DAYS))

        db.execute('UPDATE shipments SET risk_score = ?, status = ?, delay_reason = ?, eta = ?, '
                   'updated_at = ? WHERE id = ?',
                   (risk_score, new_status, delay_reason, eta, now, shipment['id']))
        rescored.append({'id': shipment['id'], 'barcode_id': shipment['barcode_id'],
                         'risk_score': risk_score, 'status': new_status, 'eta': eta})
    db.commit()

    delayed = sum(1 for r in rescored if r['status'] == 'delayed')
    await log_event('cargo', f'Blizzard load at {station} set to dT {applied_delta_t}C - '
                    f'{len(rescored)} active consignment(s) re-scored, {delayed} delayed',
                    'system', None,
                    {'delta_t': applied_delta_t, 'station': station, 'rescored': rescored},
                    station=station)
    await manager.broadcast({'type': 'blizzard_update',
                             'data': {'station': station, 'delta_t': applied_delta_t,
                                      'rescored': rescored, 'delayed': delayed}})
    return {'station': station, 'delta_t': applied_delta_t, 'rescored': rescored,
            'delayed': delayed, 'affected': len(rescored)}


@router.post('/weather', dependencies=[Depends(require_key)])
async def apply_station_weather(req: StationWeatherRequest):
    """Set a station's blizzard load. Every active consignment to that station
    is re-scored, and Inventory re-runs its depletion curves against the same
    figure. No shipment needs to be selected."""
    return await _apply_station_weather(req.station, req.delta_t)


@router.post('/{shipment_id}/risk', dependencies=[Depends(require_key)])
async def update_risk(shipment_id: str, req: RiskUpdateRequest):
    """Kept for the barcode/API path: applies the weather to the shipment's own
    destination station, which necessarily re-scores this shipment too."""
    db = get_db()
    row = db.execute('SELECT * FROM shipments WHERE id = ?', (shipment_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail='Shipment not found')
    station = row['destination_station']
    result = await _apply_station_weather(station, req.delta_t)

    updated = db.execute('SELECT * FROM shipments WHERE id = ?', (shipment_id,)).fetchone()
    return {'risk_score': updated['risk_score'], 'status': updated['status'],
            'eta': to_utc_iso(updated['eta']), 'delay_reason': updated['delay_reason'],
            'delta_t': result['delta_t'], 'station': station,
            'affected': result['affected'], 'delayed': result['delayed']}
