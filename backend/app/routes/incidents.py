from fastapi import APIRouter, HTTPException, Depends
import uuid
from datetime import datetime
from ..database import get_db
from ..models import IncidentCreate
from ..events import log_event
from ..ws_manager import manager
from ..geo import haversine_distance
from ..auth import require_key

router = APIRouter(prefix='/incidents', tags=['incidents'])

# Hardcoded nearby assets
NEARBY_ASSETS = [
    {'name': 'Snowcat Alpha', 'type': 'vehicle', 'lat': -70.770, 'lng': 11.740},
    {'name': 'Emergency Sled', 'type': 'equipment', 'lat': -70.780, 'lng': 11.760},
    {'name': 'Medical Kit Station', 'type': 'medical', 'lat': -70.767, 'lng': 11.735},
    {'name': 'Rescue Helicopter (Grounded)', 'type': 'aircraft', 'lat': -70.765, 'lng': 11.725},
]

def compute_accountability(db, lat, lng, radius):
    personnel = db.execute('SELECT * FROM personnel').fetchall()
    in_zone = []
    for p in personnel:
        if p['current_lat'] and p['current_lng']:
            dist = haversine_distance(lat, lng, p['current_lat'], p['current_lng'])
            if dist <= radius:
                in_zone.append({'id': p['id'], 'name': p['name'], 'role': p['role'], 'status': p['status'], 'distance_m': round(dist)})
    expected = len(in_zone)
    confirmed_safe = sum(1 for p in in_zone if p['status'] in ('at_station', 'field', 'returned'))
    return expected, confirmed_safe, expected - confirmed_safe, in_zone

@router.get('')
def list_incidents():
    db = get_db()
    rows = db.execute('SELECT * FROM incidents ORDER BY created_at DESC').fetchall()
    return [dict(r) for r in rows]

@router.post('', dependencies=[Depends(require_key)])
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

# NOTE: Literal sub-paths MUST be declared before parameterised routes (/{incident_id})
# to prevent FastAPI from swallowing them as path-parameter matches.

@router.post('/power-failure', dependencies=[Depends(require_key)])
async def simulate_power_failure(body: dict = None):
    station = (body or {}).get('station', 'Maitri')
    await log_event('emergency', f'Power failure simulated at {station}', 'system', metadata={'type': 'power_failure', 'station': station})
    await manager.broadcast({'type': 'alert', 'data': {'type': 'power_failure', 'station': station, 'message': f'ALERT: Power failure at {station}'}})
    return {'status': 'simulated', 'station': station}

@router.get('/nearby-assets/search')
def search_nearby_assets(lat: float, lng: float):
    results = []
    for asset in NEARBY_ASSETS:
        dist = haversine_distance(lat, lng, asset['lat'], asset['lng'])
        results.append({**asset, 'distance_m': round(dist)})
    results.sort(key=lambda x: x['distance_m'])
    return results

# Parameterised routes below — must come AFTER all literal sub-paths above.

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
    d['nearby_assets'] = NEARBY_ASSETS
    return d

@router.patch('/{incident_id}', dependencies=[Depends(require_key)])
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
