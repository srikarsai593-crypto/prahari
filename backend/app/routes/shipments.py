from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import Response
import uuid, json, io, base64
from datetime import datetime, timedelta, timezone
import qrcode
from ..database import get_db
from ..models import ShipmentCreate, RiskUpdateRequest
from ..events import log_event
from ..ws_manager import manager

router = APIRouter(prefix='/shipments', tags=['shipments'])

# Global blizzard delta_t shared with inventory module
current_delta_t = 0.0

STATUS_ORDER = ['dispatched', 'in_transit', 'arrived', 'unloaded']
CAPACITY_KG = 10000  # Hard-coded vessel capacity

def generate_barcode_id(db):
    year = datetime.now(timezone.utc).year
    count = db.execute('SELECT COUNT(*) FROM shipments').fetchone()[0]
    return f'SHP-{year}-{count + 1:04d}'

def generate_qr_base64(payload: str) -> str:
    # Level H error correction — ~30% obstruction tolerance (frost/damage resistant)
    qr = qrcode.QRCode(
        version=1,
        error_correction=qrcode.constants.ERROR_CORRECT_H,  # Deliberately Level H for frost resistance
        box_size=10,
        border=4
    )
    qr.add_data(payload)
    qr.make(fit=True)
    img = qr.make_image(fill_color='black', back_color='white')
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    return base64.b64encode(buf.getvalue()).decode()

@router.get('')
def list_shipments(station: str = None, status: str = None, priority: str = None):
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
    rows = db.execute(query, params).fetchall()
    result = []
    for r in rows:
        d = dict(r)
        d['qr_code'] = generate_qr_base64(d['barcode_id'])
        result.append(d)
    return result

@router.get('/{shipment_id}')
def get_shipment(shipment_id: str):
    db = get_db()
    row = db.execute('SELECT * FROM shipments WHERE id = ?', (shipment_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail='Shipment not found')
    d = dict(row)
    d['qr_code'] = generate_qr_base64(d['barcode_id'])
    return d

@router.post('')
async def create_shipment(data: ShipmentCreate):
    db = get_db()
    ship_id = 'shp-' + str(uuid.uuid4())[:8]
    barcode_id = generate_barcode_id(db)
    eta = (datetime.now(timezone.utc) + timedelta(days=14)).isoformat()
    
    # Capacity check
    capacity_warning = None
    if data.weight_kg and data.weight_kg > CAPACITY_KG:
        capacity_warning = f'Weight {data.weight_kg}kg exceeds vessel capacity {CAPACITY_KG}kg'
    
    db.execute(
        'INSERT INTO shipments (id, barcode_id, expedition_id, item_name, category, weight_kg, priority, destination_station, status, dispatch_date, eta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        (ship_id, barcode_id, data.expedition_id, data.item_name, data.category, data.weight_kg, data.priority, data.destination_station, 'dispatched', datetime.now(timezone.utc).isoformat(), eta)
    )
    db.commit()
    await log_event('cargo', f'Shipment {barcode_id} created: {data.item_name} ({data.category})', 'commander', ship_id)
    
    result = {'id': ship_id, 'barcode_id': barcode_id, 'qr_code': generate_qr_base64(barcode_id), 'eta': eta, **data.model_dump()}
    if capacity_warning:
        result['capacity_warning'] = capacity_warning
    return result

@router.post('/{shipment_id}/scan')
async def scan_shipment(shipment_id: str = None, barcode_id: str = None):
    db = get_db()
    if barcode_id:
        row = db.execute('SELECT * FROM shipments WHERE barcode_id = ?', (barcode_id,)).fetchone()
    else:
        row = db.execute('SELECT * FROM shipments WHERE id = ?', (shipment_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail='Shipment not found')
    
    shipment = dict(row)
    current_status = shipment['status']
    
    if current_status == 'delayed':
        current_status = 'in_transit'  # Allow delayed to advance to in_transit behavior
    
    if current_status not in STATUS_ORDER:
        await log_event('cargo', f'Anomaly: shipment {shipment["barcode_id"]} scan with unknown status {current_status}', 'system', shipment['id'], {'anomaly': True})
        raise HTTPException(status_code=400, detail=f'Unknown status: {current_status}')
    
    current_idx = STATUS_ORDER.index(current_status)
    if current_idx >= len(STATUS_ORDER) - 1:
        await log_event('cargo', f'Anomaly: shipment {shipment["barcode_id"]} already fully processed (status: {current_status})', 'system', shipment['id'], {'anomaly': True})
        raise HTTPException(status_code=400, detail='Shipment already fully processed')
    
    new_status = STATUS_ORDER[current_idx + 1]
    now = datetime.now(timezone.utc).isoformat()
    db.execute('UPDATE shipments SET status = ?, last_scanned_at = ?, updated_at = ? WHERE id = ?',
        (new_status, now, now, shipment['id']))
    db.commit()
    
    await log_event('cargo', f'Shipment {shipment["barcode_id"]} scanned: {current_status} → {new_status}', 'scanner', shipment['id'])
    
    # Cross-module trigger: if unloaded, update inventory
    if new_status == 'unloaded':
        inv_row = db.execute('SELECT * FROM inventory_items WHERE station = ? AND (LOWER(name) LIKE ? OR LOWER(category) LIKE ?)',
            (shipment['destination_station'], f'%{shipment["category"]}%', f'%{shipment["category"]}%')).fetchone()
        if inv_row:
            new_qty = inv_row['quantity'] + (shipment['weight_kg'] or 0)
            db.execute('UPDATE inventory_items SET quantity = ?, updated_at = ? WHERE id = ?',
                (new_qty, now, inv_row['id']))
            db.commit()
            await log_event('inventory', f'Stock increased via unloaded shipment {shipment["barcode_id"]} (+{shipment["weight_kg"]} {inv_row["unit"]})', 'system', inv_row['id'])
            await manager.broadcast({'type': 'inventory_update', 'data': {'item_id': inv_row['id'], 'new_quantity': new_qty}})
    
    return {'id': shipment['id'], 'barcode_id': shipment['barcode_id'], 'old_status': current_status, 'new_status': new_status}

@router.post('/scan-barcode')
async def scan_by_barcode(body: dict):
    barcode = body.get('barcode_id', '')
    if not barcode:
        raise HTTPException(status_code=400, detail='No barcode_id provided')
    return await scan_shipment(barcode_id=barcode)

@router.post('/{shipment_id}/risk')
async def update_risk(shipment_id: str, req: RiskUpdateRequest):
    global current_delta_t
    db = get_db()
    row = db.execute('SELECT * FROM shipments WHERE id = ?', (shipment_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail='Shipment not found')
    shipment = dict(row)
    
    # Risk calculation
    weather_severity_score = (req.delta_t / 40) * 60
    season_factor = 10
    priority_weight = 15 if shipment['priority'] == 'critical' else 0
    risk_score = min(100, int(weather_severity_score + season_factor + priority_weight))
    
    # Update shipment
    new_status = shipment['status']
    delay_reason = shipment.get('delay_reason')
    eta = shipment['eta']
    
    if risk_score >= 50:
        new_status = 'delayed'
        delay_reason = 'weather'
        if eta:
            try:
                eta_dt = datetime.fromisoformat(eta)
            except:
                eta_dt = datetime.now(timezone.utc) + timedelta(days=14)
            eta_dt += timedelta(hours=risk_score * 0.5)
            eta = eta_dt.isoformat()
    
    now = datetime.now(timezone.utc).isoformat()
    db.execute('UPDATE shipments SET risk_score = ?, status = ?, delay_reason = ?, eta = ?, updated_at = ? WHERE id = ?',
        (risk_score, new_status, delay_reason, eta, now, shipment_id))
    db.commit()
    
    # Update global delta_t for inventory module
    current_delta_t = req.delta_t
    
    await log_event('cargo', f'Risk score updated for {shipment["barcode_id"]}: {risk_score}/100 (ΔT={req.delta_t}°C)', 'system', shipment_id, {'risk_score': risk_score, 'delta_t': req.delta_t, 'status': new_status})
    
    # Broadcast blizzard update for inventory cross-module recalculation
    await manager.broadcast({'type': 'blizzard_update', 'data': {'delta_t': req.delta_t, 'risk_score': risk_score, 'shipment_id': shipment_id, 'new_status': new_status, 'eta': eta}})
    
    return {'risk_score': risk_score, 'status': new_status, 'eta': eta, 'delay_reason': delay_reason, 'delta_t': req.delta_t}

@router.get('/delta-t/current')
def get_current_delta_t():
    return {'delta_t': current_delta_t}
