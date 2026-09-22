from fastapi import APIRouter, HTTPException
import uuid
from datetime import datetime
from ..database import get_db
from ..models import IncidentCreate
from ..events import log_event
from ..ws_manager import manager
from ..geo import haversine_distance

router = APIRouter(prefix='/incidents', tags=['incidents'])

def get_nearby_assets(db, lat: float, lng: float, limit: int = 10) -> list:
    """Read assets from DB and compute Haversine distances. No hardcoded coordinates."""
    rows = db.execute('SELECT * FROM emergency_assets').fetchall()
    results = []
    for r in rows:
        dist = haversine_distance(lat, lng, r['lat'], r['lng'])
        results.append({**dict(r), 'distance_m': round(dist)})
    results.sort(key=lambda x: x['distance_m'])
    return results[:limit]

def compute_accountability(db, lat, lng, radius):
    personnel = db.execute('SELECT * FROM personnel').fetchall()
    in_zone = []
    for p in personnel:
        if p['current_lat'] and p['current_lng']:
            dist = haversine_distance(lat, lng, p['current_lat'], p['current_lng'])
            if dist <= radius:
                in_zone.append({'id': p['id'], 'name': p['name'], 'role': p['role'], 'status': p['status'], 'distance_m': round(dist)})
    expected = len(in_zone)
    # Only 'at_station' and 'returned' are verifiably safe in an emergency.
    # 'field', 'in_transit', and 'deviated' personnel are UNACCOUNTED until confirmed.
    confirmed_safe = sum(1 for p in in_zone if p['status'] in ('at_station', 'returned'))
    return expected, confirmed_safe, expected - confirmed_safe, in_zone

@router.get('')
def list_incidents():
    db = get_db()
    rows = db.execute('SELECT * FROM incidents ORDER BY created_at DESC').fetchall()
    return [dict(r) for r in rows]

# NOTE: Static sub-routes MUST be declared before /{incident_id} to avoid
# FastAPI treating the static path segment as a path parameter (404 bug fix).
@router.post('/power-failure')
async def simulate_power_failure(body: dict = None):
    station = (body or {}).get('station', 'Maitri')
    await log_event('emergency', f'Power failure simulated at {station}', 'system', metadata={'type': 'power_failure', 'station': station})
    await manager.broadcast({'type': 'alert', 'data': {'type': 'power_failure', 'station': station, 'message': f'ALERT: Power failure at {station}'}})
    return {'status': 'simulated', 'station': station}

@router.get('/nearby-assets/search')
def search_nearby_assets(lat: float, lng: float):
    db = get_db()
    return get_nearby_assets(db, lat, lng)

@router.get('/assets')
def list_assets():
    """List all emergency assets — positions can be updated via PATCH."""
    db = get_db()
    return [dict(r) for r in db.execute('SELECT * FROM emergency_assets ORDER BY name').fetchall()]

@router.patch('/assets/{asset_id}')
async def update_asset(asset_id: str, body: dict):
    """Update an asset's position or status. Called when a snowcat or helicopter relocates."""
    db = get_db()
    row = db.execute('SELECT * FROM emergency_assets WHERE id = ?', (asset_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail='Asset not found')
    lat  = body.get('lat',    row['lat'])
    lng  = body.get('lng',    row['lng'])
    status = body.get('status', row['status'])
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    db.execute('UPDATE emergency_assets SET lat = ?, lng = ?, status = ?, updated_at = ? WHERE id = ?', (lat, lng, status, now, asset_id))
    db.commit()
    await log_event('emergency', f'Asset "{row["name"]}" position/status updated', 'commander', asset_id)
    return {**dict(row), 'lat': lat, 'lng': lng, 'status': status}

@router.get('/{incident_id}')
def get_incident(incident_id: str):
    db = get_db()
    row = db.execute('SELECT * FROM incidents WHERE id = ?', (incident_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail='Incident not found')
    d = dict(row)
    # Recompute live accountability
    expected, safe, unaccounted, personnel = compute_accountability(db, d['location_lat'], d['location_lng'], d['affected_radius_m'])
    d['expected_count'] = expected
    d['confirmed_safe_count'] = safe
    d['unaccounted_count'] = unaccounted
    d['personnel_in_zone'] = personnel
    d['nearby_assets'] = get_nearby_assets(db, d['location_lat'], d['location_lng'])
    return d

@router.post('')
async def create_incident(data: IncidentCreate):
    db = get_db()
    inc_id = 'inc-' + str(uuid.uuid4())[:8]
    radius = data.affected_radius_m or 5000

    # Compute initial accountability
    expected, safe, unaccounted, personnel_list = compute_accountability(db, data.location_lat, data.location_lng, radius)

    db.execute(
        'INSERT INTO incidents (id, type, location_lat, location_lng, affected_radius_m, severity, status, expected_count, confirmed_safe_count, unaccounted_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        (inc_id, data.type, data.location_lat, data.location_lng, radius, data.severity or 'medium', 'open', expected, safe, unaccounted)
    )
    db.commit()
    await log_event('emergency', f'Incident created: {data.type} (severity: {data.severity or "medium"})', 'system', inc_id, {'type': data.type, 'severity': data.severity})
    await manager.broadcast({'type': 'alert', 'data': {'type': 'incident', 'incident_id': inc_id, 'incident_type': data.type, 'severity': data.severity or 'medium', 'lat': data.location_lat, 'lng': data.location_lng}})
    await manager.broadcast({'type': 'accountability_update', 'data': {'incident_id': inc_id, 'expected': expected, 'confirmed_safe': safe, 'unaccounted': unaccounted, 'personnel': personnel_list}})

    return {'id': inc_id, 'expected_count': expected, 'confirmed_safe_count': safe, 'unaccounted_count': unaccounted, 'personnel_in_zone': personnel_list, **data.model_dump()}

@router.patch('/{incident_id}')
async def update_incident(incident_id: str, body: dict):
    db = get_db()
    row = db.execute('SELECT * FROM incidents WHERE id = ?', (incident_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail='Incident not found')
    status = body.get('status', row['status'])
    db.execute('UPDATE incidents SET status = ? WHERE id = ?', (status, incident_id))
    db.commit()
    action = f'Incident {incident_id} resolved' if status == 'resolved' else f'Incident {incident_id} updated: status → {status}'
    await log_event('emergency', action, 'commander', incident_id)
    return {'id': incident_id, 'status': status}

@router.get('/{incident_id}/accountability')
async def get_accountability(incident_id: str):
    db = get_db()
    row = db.execute('SELECT * FROM incidents WHERE id = ?', (incident_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail='Incident not found')
    incident = dict(row)
    expected, safe, unaccounted, personnel = compute_accountability(db, incident['location_lat'], incident['location_lng'], incident['affected_radius_m'])
    db.execute('UPDATE incidents SET expected_count = ?, confirmed_safe_count = ?, unaccounted_count = ? WHERE id = ?',
        (expected, safe, unaccounted, incident_id))
    db.commit()
    await manager.broadcast({'type': 'accountability_update', 'data': {'incident_id': incident_id, 'expected': expected, 'confirmed_safe': safe, 'unaccounted': unaccounted, 'personnel': personnel}})
    return {'expected': expected, 'confirmed_safe': safe, 'unaccounted': unaccounted, 'personnel': personnel}
