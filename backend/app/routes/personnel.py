from fastapi import APIRouter, HTTPException, Depends
import uuid, json, os
from datetime import datetime, timezone
from ..database import get_db
from ..models import MovementPlanCreate
from ..events import log_event
from ..ws_manager import manager
from ..geo import haversine_distance, check_geofences, check_route_deviation
from ..simulation import get_next_position, reset_simulation, get_planned_route
from .incidents import compute_accountability
from ..auth import require_key

router = APIRouter(prefix='/personnel', tags=['personnel'])

DEFAULT_LOCATION_UPDATE_TIMEOUT_MINUTES = 10
DESTINATION_REACHED_RADIUS_M = 250


def _location_update_timeout_minutes() -> float:
    """Read the small, deployment-configurable location update timeout."""
    try:
        timeout = float(os.getenv('PERSONNEL_LOCATION_UPDATE_TIMEOUT_MINUTES', DEFAULT_LOCATION_UPDATE_TIMEOUT_MINUTES))
        return timeout if timeout > 0 else DEFAULT_LOCATION_UPDATE_TIMEOUT_MINUTES
    except (TypeError, ValueError):
        return DEFAULT_LOCATION_UPDATE_TIMEOUT_MINUTES


def _parse_timestamp(value):
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)
    except (TypeError, ValueError):
        return None


def _has_reached_destination(personnel, movement_plan) -> bool:
    if not movement_plan or movement_plan['status'] in ('arrived', 'completed'):
        return bool(movement_plan and movement_plan['status'] in ('arrived', 'completed'))

    current_lat = personnel['current_lat']
    current_lng = personnel['current_lng']
    destination_lat = movement_plan['destination_lat']
    destination_lng = movement_plan['destination_lng']
    if (
        current_lat is None
        or current_lng is None
        or destination_lat is None
        or destination_lng is None
    ):
        return False

    distance = haversine_distance(
        destination_lat,
        destination_lng,
        current_lat,
        current_lng,
    )
    return distance <= DESTINATION_REACHED_RADIUS_M


def _tracking_status(personnel, movement_plan, now=None):
    now = now or datetime.now(timezone.utc)
    timeout_minutes = _location_update_timeout_minutes()
    last_update = _parse_timestamp(personnel['last_update_at'])
    expected_arrival = _parse_timestamp(movement_plan['expected_arrival']) if movement_plan else None
    overdue = bool(
        movement_plan
        and expected_arrival
        and now > expected_arrival
        and not _has_reached_destination(personnel, movement_plan)
    )
    no_recent_update = last_update is None or (now - last_update).total_seconds() > timeout_minutes * 60

    return {
        'movement_status': 'overdue' if overdue else (movement_plan['status'] if movement_plan else personnel['status']),
        'overdue': overdue,
        'overdue_reason': (
            f'Expected arrival at {movement_plan["destination_name"]} has passed'
            if overdue else None
        ),
        'location_update_status': 'no_recent_location_update' if no_recent_update else 'current',
        'location_update_warning': (
            'No recent location update' if no_recent_update else None
        ),
        'location_update_timeout_minutes': timeout_minutes,
        'last_update_age_minutes': (
            round(max(0, (now - last_update).total_seconds()) / 60, 1)
            if last_update else None
        ),
    }


def _personnel_with_tracking_status(personnel, movement_plan, now=None):
    result = dict(personnel)
    result.update(_tracking_status(personnel, movement_plan, now))
    result['effective_status'] = 'overdue' if result['overdue'] else personnel['status']
    if movement_plan:
        result['movement_plan_id'] = movement_plan['id']
        result['destination_name'] = movement_plan['destination_name']
        result['expected_arrival'] = movement_plan['expected_arrival']
    return result

async def broadcast_open_incident_accountability(db):
    open_incidents = db.execute("SELECT * FROM incidents WHERE status = 'open'").fetchall()
    personnel_rows = db.execute('SELECT * FROM personnel').fetchall()

    for incident in open_incidents:
        in_zone = []
        for p in personnel_rows:
            if p['current_lat'] is not None and p['current_lng'] is not None:
                dist = haversine_distance(incident['location_lat'], incident['location_lng'], p['current_lat'], p['current_lng'])
                if dist <= incident['affected_radius_m']:
                    in_zone.append({
                        'id': p['id'],
                        'name': p['name'],
                        'role': p['role'],
                        'status': p['status'],
                        'distance_m': round(dist),
                    })

        expected = len(in_zone)
        confirmed_safe = sum(1 for p in in_zone if p['status'] in ('at_station', 'field', 'returned'))
        unaccounted = expected - confirmed_safe
        db.execute(
            'UPDATE incidents SET expected_count = ?, confirmed_safe_count = ?, unaccounted_count = ? WHERE id = ?',
            (expected, confirmed_safe, unaccounted, incident['id'])
        )
        await manager.broadcast({
            'type': 'accountability_update',
            'data': {
                'incident_id': incident['id'],
                'expected': expected,
                'confirmed_safe': confirmed_safe,
                'unaccounted': unaccounted,
                'personnel': in_zone,
            }
        })

    db.commit()

@router.get('')
def list_personnel():
    db = get_db()
    rows = db.execute('SELECT * FROM personnel ORDER BY name').fetchall()
    movement_plans = db.execute(
        'SELECT * FROM movement_plans ORDER BY departure_time DESC'
    ).fetchall()
    latest_plans = {}
    for plan in movement_plans:
        latest_plans.setdefault(plan['personnel_id'], plan)

    now = datetime.now(timezone.utc)
    return [
        _personnel_with_tracking_status(row, latest_plans.get(row['id']), now)
        for row in rows
    ]

@router.get('/movement-plans')
def list_movement_plans():
    db = get_db()
    rows = db.execute(
        'SELECT mp.*, p.name as personnel_name, p.status as personnel_status, '
        'p.current_lat, p.current_lng, p.last_update_at '
        'FROM movement_plans mp LEFT JOIN personnel p ON mp.personnel_id = p.id '
        'ORDER BY mp.departure_time DESC'
    ).fetchall()
    now = datetime.now(timezone.utc)
    plans = []
    for row in rows:
        plan = dict(row)
        personnel = {
            'status': row['personnel_status'],
            'current_lat': row['current_lat'],
            'current_lng': row['current_lng'],
            'last_update_at': row['last_update_at'],
        }
        plan.update(_tracking_status(personnel, row, now))
        plans.append(plan)
    return plans

@router.get('/{personnel_id}')
def get_personnel(personnel_id: str):
    db = get_db()
    row = db.execute('SELECT * FROM personnel WHERE id = ?', (personnel_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail='Personnel not found')
    return dict(row)

@router.post('/movement-plans', dependencies=[Depends(require_key)])
async def create_movement_plan(data: MovementPlanCreate):
    db = get_db()
    plan_id = 'mp-' + str(uuid.uuid4())[:8]
    route_json = json.dumps(data.planned_route)
    db.execute(
        'INSERT INTO movement_plans (id, personnel_id, origin_lat, origin_lng, destination_lat, destination_lng, destination_name, planned_route, departure_time, expected_arrival, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        (plan_id, data.personnel_id, data.origin_lat, data.origin_lng, data.destination_lat, data.destination_lng, data.destination_name, route_json, data.departure_time, data.expected_arrival, 'planned')
    )
    # Update personnel status
    db.execute('UPDATE personnel SET status = ? WHERE id = ?', ('in_transit', data.personnel_id))
    db.commit()
    
    # Get personnel name
    p = db.execute('SELECT name FROM personnel WHERE id = ?', (data.personnel_id,)).fetchone()
    name = p['name'] if p else data.personnel_id
    await log_event('personnel', f'Movement plan created for {name}: → {data.destination_name}', 'commander', plan_id)
    
    return {'id': plan_id, 'status': 'planned', **data.model_dump()}

@router.post('/{personnel_id}/simulate-move', dependencies=[Depends(require_key)])
async def simulate_move(personnel_id: str):
    db = get_db()
    person = db.execute('SELECT * FROM personnel WHERE id = ?', (personnel_id,)).fetchone()
    if not person:
        raise HTTPException(status_code=404, detail='Personnel not found')

    position = get_next_position(personnel_id, db)
    if position is None:
        # Simulation complete — arrived at destination
        db.execute('UPDATE personnel SET status = ? WHERE id = ?', ('field', personnel_id))
        mp = db.execute('SELECT id FROM movement_plans WHERE personnel_id = ? ORDER BY departure_time DESC LIMIT 1', (personnel_id,)).fetchone()
        if mp:
            db.execute('UPDATE movement_plans SET status = ? WHERE id = ?', ('arrived', mp['id']))
        db.commit()
        await log_event('personnel', f'{person["name"]} arrived at destination', 'gps_system', personnel_id)
        await broadcast_open_incident_accountability(db)
        return {'status': 'arrived', 'personnel_id': personnel_id}

    now = datetime.now(timezone.utc).isoformat()
    db.execute(
        'UPDATE personnel SET current_lat = ?, current_lng = ?, last_update_at = ?, status = ? WHERE id = ?',
        (position['lat'], position['lng'], now, 'in_transit', personnel_id)
    )
    db.commit()
    
    # Check geofences
    geofences = db.execute('SELECT * FROM geofences').fetchall()
    gf_list = [dict(g) for g in geofences]
    inside = check_geofences(position['lat'], position['lng'], gf_list)
    
    alert = None
    for gf in inside:
        if gf['type'] == 'restricted':
            alert = {'type': 'geofence_violation', 'geofence': gf['name'], 'personnel': person['name'], 'personnel_id': personnel_id}
            # Update movement plan status
            mp = db.execute('SELECT id FROM movement_plans WHERE personnel_id = ? ORDER BY departure_time DESC LIMIT 1', (personnel_id,)).fetchone()
            if mp:
                db.execute('UPDATE movement_plans SET status = ? WHERE id = ?', ('deviated', mp['id']))
                db.commit()
            await log_event('personnel', f'ALERT: {person["name"]} entered restricted zone "{gf["name"]}"', 'gps_system', personnel_id, {'geofence': gf, 'position': position})
            break
    
    # Check route deviation
    planned = get_planned_route()
    deviated = check_route_deviation(position['lat'], position['lng'], planned)
    if deviated and not alert:
        mp = db.execute('SELECT id FROM movement_plans WHERE personnel_id = ? ORDER BY departure_time DESC LIMIT 1', (personnel_id,)).fetchone()
        if mp:
            db.execute('UPDATE movement_plans SET status = ? WHERE id = ?', ('deviated', mp['id']))
            db.commit()
        await log_event('personnel', f'{person["name"]} deviating from planned route', 'gps_system', personnel_id, {'position': position})
    
    # Broadcast GPS update
    await manager.broadcast({
        'type': 'gps_update',
        'data': {
            'personnel_id': personnel_id,
            'name': person['name'],
            'lat': position['lat'],
            'lng': position['lng'],
            'last_update_at': now,
            'alert': alert
        }
    })
    
    if alert:
        await manager.broadcast({'type': 'alert', 'data': alert})

    await broadcast_open_incident_accountability(db)
    
    return {'personnel_id': personnel_id, 'position': position, 'alert': alert}

@router.post('/{personnel_id}/reset-simulation', dependencies=[Depends(require_key)])
def reset_sim(personnel_id: str):
    db = get_db()
    reset_simulation(personnel_id, db)
    # Restore to original seeded position for this person
    origin_coords = {
        'per-priya':  (-70.767, 11.731),
        'per-arjun':  (-70.769, 11.735),
        'per-vikram': (-70.771, 11.728),
        'per-meera':  (-70.765, 11.738),
        'per-raj':    (-70.773, 11.734),
        'per-ananya': (-70.763, 11.729),
    }
    lat, lng = origin_coords.get(personnel_id, (-70.767, 11.731))
    db.execute(
        'UPDATE personnel SET current_lat = ?, current_lng = ?, status = ?, simulation_step = 0 WHERE id = ?',
        (lat, lng, 'at_station', personnel_id)
    )
    db.commit()
    return {'status': 'reset', 'personnel_id': personnel_id}

@router.post('/{personnel_id}/sos', dependencies=[Depends(require_key)])
async def trigger_sos(personnel_id: str):
    db = get_db()
    person = db.execute('SELECT * FROM personnel WHERE id = ?', (personnel_id,)).fetchone()
    if not person:
        raise HTTPException(status_code=404, detail='Personnel not found')

    # Create incident at personnel's current location
    incident_id = 'inc-' + str(uuid.uuid4())[:8]
    lat = person['current_lat'] or -70.767
    lng = person['current_lng'] or 11.731
    radius = 3000

    # Compute accountability at the time of SOS
    expected, safe, unaccounted, personnel_list = compute_accountability(db, lat, lng, radius)

    db.execute(
        'INSERT INTO incidents (id, type, location_lat, location_lng, affected_radius_m, severity, status, expected_count, confirmed_safe_count, unaccounted_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        (incident_id, 'medical', lat, lng, radius, 'critical', 'open', expected, safe, unaccounted)
    )
    db.commit()

    await log_event('emergency', f'SOS triggered by {person["name"]} at ({lat}, {lng})', 'sos_system', incident_id)
    await manager.broadcast({'type': 'alert', 'data': {'type': 'sos', 'personnel': person['name'], 'lat': lat, 'lng': lng, 'incident_id': incident_id}})
    await manager.broadcast({'type': 'accountability_update', 'data': {'incident_id': incident_id, 'expected': expected, 'confirmed_safe': safe, 'unaccounted': unaccounted, 'personnel': personnel_list}})

    return {'incident_id': incident_id, 'personnel': person['name'], 'expected_count': expected, 'confirmed_safe': safe, 'unaccounted': unaccounted}

@router.get('/accountability/check')
def check_accountability(lat: float, lng: float, radius: float = 5000):
    db = get_db()
    personnel = db.execute('SELECT * FROM personnel').fetchall()
    in_zone = []
    for p in personnel:
        if p['current_lat'] and p['current_lng']:
            dist = haversine_distance(lat, lng, p['current_lat'], p['current_lng'])
            if dist <= radius:
                in_zone.append({'id': p['id'], 'name': p['name'], 'role': p['role'], 'status': p['status'], 'distance_m': round(dist)})
    
    expected = len(in_zone)
    confirmed_safe = sum(1 for p in in_zone if p['status'] in ('at_station', 'field'))
    unaccounted = expected - confirmed_safe
    
    return {'expected': expected, 'confirmed_safe': confirmed_safe, 'unaccounted': unaccounted, 'personnel': in_zone}

@router.patch('/{personnel_id}/status', dependencies=[Depends(require_key)])
async def update_status(personnel_id: str, body: dict):
    db = get_db()
    new_status = body.get('status', 'at_station')
    db.execute('UPDATE personnel SET status = ? WHERE id = ?', (new_status, personnel_id))
    db.commit()
    p = db.execute('SELECT name FROM personnel WHERE id = ?', (personnel_id,)).fetchone()
    name = p['name'] if p else personnel_id
    await log_event('personnel', f'{name} status updated to {new_status}', 'commander', personnel_id)
    await manager.broadcast({'type': 'personnel_update', 'data': {'personnel_id': personnel_id, 'status': new_status}})
    await broadcast_open_incident_accountability(db)
    return {'id': personnel_id, 'status': new_status}
