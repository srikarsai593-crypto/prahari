from fastapi import APIRouter, HTTPException, Depends, Query
import uuid, json, os
from datetime import datetime, timezone
from ..database import get_db
from typing import Optional

from ..models import MovementPlanCreate, PersonnelStatusRequest, Station
from ..events import log_event
from ..ws_manager import manager
from ..geo import haversine_distance, check_geofences, check_route_deviation
from ..simulation import (get_next_position, reset_simulation, get_planned_route,
                          get_latest_plan, get_progress, build_track)
from .incidents import compute_accountability, VERIFIED_SAFE_STATUSES
from ..auth import require_key
from ..timeutil import utc_now, utc_now_iso, to_utc_iso

router = APIRouter(prefix='/personnel', tags=['personnel'])

DEFAULT_LOCATION_UPDATE_TIMEOUT_MINUTES = 10
DESTINATION_REACHED_RADIUS_M = 250
ROUTE_DEVIATION_THRESHOLD_M = 2000

# A person's status is a state machine, not a free-form label. Allowing any
# transition let a person go from 'field' straight to 'at_station' without ever
# being in transit, which quietly makes them "confirmed safe" during an incident.
VALID_TRANSITIONS = {
    'at_station': {'in_transit', 'field'},
    'in_transit': {'field', 'returned', 'at_station', 'deviated', 'sos'},
    'field':      {'in_transit', 'returned', 'deviated', 'sos'},
    'returned':   {'at_station', 'in_transit'},
    # A deviation or an SOS is cleared by an operator, not by the tracker:
    # someone has to say the person is back on route or back at base.
    'deviated':   {'in_transit', 'field', 'returned', 'sos'},
    'sos':        {'in_transit', 'field', 'returned'},
}


def _location_update_timeout_minutes() -> float:
    try:
        timeout = float(os.getenv('PERSONNEL_LOCATION_UPDATE_TIMEOUT_MINUTES',
                                  DEFAULT_LOCATION_UPDATE_TIMEOUT_MINUTES))
        return timeout if timeout > 0 else DEFAULT_LOCATION_UPDATE_TIMEOUT_MINUTES
    except (TypeError, ValueError):
        return DEFAULT_LOCATION_UPDATE_TIMEOUT_MINUTES


def _parse_timestamp(value):
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    except (TypeError, ValueError):
        return None
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None \
        else parsed.astimezone(timezone.utc)


def _has_reached_destination(personnel, movement_plan) -> bool:
    if not movement_plan:
        return False
    if movement_plan['status'] in ('arrived', 'completed'):
        return True
    lat, lng = personnel['current_lat'], personnel['current_lng']
    dlat, dlng = movement_plan['destination_lat'], movement_plan['destination_lng']
    if None in (lat, lng, dlat, dlng):
        return False
    return haversine_distance(dlat, dlng, lat, lng) <= DESTINATION_REACHED_RADIUS_M


def _tracking_status(personnel, movement_plan, now=None):
    now = now or utc_now()
    timeout_minutes = _location_update_timeout_minutes()
    last_update = _parse_timestamp(personnel['last_update_at'])
    expected_arrival = _parse_timestamp(movement_plan['expected_arrival']) if movement_plan else None

    overdue = bool(movement_plan and expected_arrival and now > expected_arrival
                   and not _has_reached_destination(personnel, movement_plan))

    # A stale GPS fix only means something for someone who is actually out.
    # Raising it for every person sitting in the hut put an amber warning on
    # every row of the roster, which is how operators learn to ignore warnings.
    tracking_expected = personnel['status'] in ('in_transit', 'field', 'deviated', 'sos')
    stale_fix = (last_update is None
                 or (now - last_update).total_seconds() > timeout_minutes * 60)
    no_recent_update = tracking_expected and stale_fix

    return {
        'movement_status': 'overdue' if overdue
                           else (movement_plan['status'] if movement_plan else personnel['status']),
        'overdue': overdue,
        'overdue_reason': (f'Expected arrival at {movement_plan["destination_name"]} has passed'
                           if overdue else None),
        'location_update_status': 'no_recent_location_update' if no_recent_update else 'current',
        'location_update_warning': (
            f'No position fix in over {timeout_minutes:.0f} min while deployed'
            if no_recent_update else None),
        'location_update_timeout_minutes': timeout_minutes,
        'last_update_age_minutes': (round(max(0, (now - last_update).total_seconds()) / 60, 1)
                                    if last_update else None),
    }


def _personnel_with_tracking_status(personnel, movement_plan, now=None):
    result = dict(personnel)
    result['last_update_at'] = to_utc_iso(result.get('last_update_at'))
    result.update(_tracking_status(personnel, movement_plan, now))
    result['effective_status'] = 'overdue' if result['overdue'] else personnel['status']
    result['has_movement_plan'] = movement_plan is not None
    if movement_plan:
        result['movement_plan_id'] = movement_plan['id']
        result['destination_name'] = movement_plan['destination_name']
        result['expected_arrival'] = to_utc_iso(movement_plan['expected_arrival'])
        result['plan_status'] = movement_plan['status']
    return result


async def broadcast_open_incident_accountability(db):
    """Re-run the head-count for every open incident after anyone moves."""
    open_incidents = db.execute("SELECT * FROM incidents WHERE status = 'open'").fetchall()
    for incident in open_incidents:
        expected, safe, unaccounted, in_zone = compute_accountability(
            db, incident['location_lat'], incident['location_lng'], incident['affected_radius_m'])
        db.execute('UPDATE incidents SET expected_count = ?, confirmed_safe_count = ?, '
                   'unaccounted_count = ? WHERE id = ?',
                   (expected, safe, unaccounted, incident['id']))
        await manager.broadcast({'type': 'accountability_update',
                                 'data': {'incident_id': incident['id'], 'expected': expected,
                                          'confirmed_safe': safe, 'unaccounted': unaccounted,
                                          'personnel': in_zone}})
    db.commit()


@router.get('')
def list_personnel(station: Optional[Station] = None):
    """Roster, optionally narrowed to one station.

    The console's station switcher needs this: without it every module showed
    all three stations' crew no matter which one the operator was looking at.
    """
    db = get_db()
    if station:
        rows = db.execute('SELECT * FROM personnel WHERE station = ? ORDER BY name',
                          (station,)).fetchall()
    else:
        rows = db.execute('SELECT * FROM personnel ORDER BY name').fetchall()
    plans = db.execute('SELECT * FROM movement_plans ORDER BY departure_time DESC').fetchall()
    latest = {}
    for plan in plans:
        latest.setdefault(plan['personnel_id'], plan)
    now = utc_now()
    return [_personnel_with_tracking_status(r, latest.get(r['id']), now) for r in rows]


# NOTE: static sub-routes MUST precede /{personnel_id} or FastAPI binds the
# literal segment as a path parameter.
@router.get('/movement-plans')
def list_movement_plans(station: Optional[Station] = None):
    db = get_db()
    query = (
        'SELECT mp.*, p.name AS personnel_name, p.status AS personnel_status, '
        'p.station AS station, p.current_lat, p.current_lng, p.last_update_at '
        'FROM movement_plans mp LEFT JOIN personnel p ON mp.personnel_id = p.id '
    )
    params: list = []
    if station:
        query += 'WHERE p.station = ? '
        params.append(station)
    rows = db.execute(query + 'ORDER BY mp.departure_time DESC', params).fetchall()
    now = utc_now()
    plans = []
    for row in rows:
        plan = dict(row)
        plan['departure_time'] = to_utc_iso(plan['departure_time'])
        plan['expected_arrival'] = to_utc_iso(plan['expected_arrival'])
        plan['last_update_at'] = to_utc_iso(plan['last_update_at'])
        personnel = {'status': row['personnel_status'], 'current_lat': row['current_lat'],
                     'current_lng': row['current_lng'], 'last_update_at': row['last_update_at']}
        plan.update(_tracking_status(personnel, row, now))
        plans.append(plan)
    return plans


@router.get('/accountability/check')
def check_accountability(lat: float = Query(ge=-90, le=90),
                         lng: float = Query(ge=-180, le=180),
                         radius: float = Query(5000, gt=0, le=500_000)):
    expected, safe, unaccounted, in_zone = compute_accountability(get_db(), lat, lng, radius)
    return {'expected': expected, 'confirmed_safe': safe,
            'unaccounted': unaccounted, 'personnel': in_zone}


@router.post('/movement-plans', dependencies=[Depends(require_key)])
async def create_movement_plan(data: MovementPlanCreate):
    db = get_db()
    person = db.execute('SELECT * FROM personnel WHERE id = ?', (data.personnel_id,)).fetchone()
    if not person:
        raise HTTPException(status_code=404, detail='Personnel not found')

    departure = _parse_timestamp(data.departure_time)
    arrival = _parse_timestamp(data.expected_arrival)
    if not departure or not arrival:
        raise HTTPException(status_code=422,
                            detail='departure_time and expected_arrival must be ISO-8601')
    if arrival <= departure:
        raise HTTPException(status_code=422,
                            detail='expected_arrival must be after departure_time')

    # Pre-flight check: flag an authorised route that already crosses a
    # restricted zone, rather than waiting for someone to walk into it.
    geofences = [dict(g) for g in db.execute('SELECT * FROM geofences').fetchall()]
    restricted_hits = []
    for wp in build_track(data.planned_route):
        for gf in check_geofences(wp['lat'], wp['lng'], geofences):
            if gf['type'] == 'restricted' and gf['name'] not in restricted_hits:
                restricted_hits.append(gf['name'])

    plan_id = 'mp-' + str(uuid.uuid4())[:8]
    db.execute(
        'INSERT INTO movement_plans (id, personnel_id, origin_lat, origin_lng, destination_lat, '
        'destination_lng, destination_name, planned_route, departure_time, expected_arrival, '
        'status, simulation_step) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)',
        (plan_id, data.personnel_id, data.origin_lat, data.origin_lng, data.destination_lat,
         data.destination_lng, data.destination_name, json.dumps(data.planned_route),
         to_utc_iso(departure), to_utc_iso(arrival), 'planned')
    )
    db.execute("UPDATE personnel SET status = 'in_transit' WHERE id = ?", (data.personnel_id,))
    db.commit()

    await log_event('personnel', f'Movement plan created for {person["name"]}: '
                    f'-> {data.destination_name}', 'commander', plan_id,
                    station=person['station'])
    if restricted_hits:
        warning = (f'Authorised route for {person["name"]} crosses restricted zone(s): '
                   f'{", ".join(restricted_hits)}')
        await log_event('personnel', f'PRE-FLIGHT WARNING: {warning}', 'gps_system', plan_id,
                        {'restricted_zones': restricted_hits}, station=person['station'])
        await manager.broadcast({'type': 'alert',
                                 'data': {'type': 'route_pre_flight_warning',
                                          'personnel': person['name'], 'personnel_id': person['id'],
                                          'zones': restricted_hits, 'message': warning}})

    return {'id': plan_id, 'status': 'planned', 'route_warnings': restricted_hits,
            **data.model_dump()}


@router.get('/{personnel_id}')
def get_personnel(personnel_id: str):
    db = get_db()
    row = db.execute('SELECT * FROM personnel WHERE id = ?', (personnel_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail='Personnel not found')
    plan = get_latest_plan(personnel_id, db)
    result = _personnel_with_tracking_status(row, plan)
    result['progress'] = get_progress(personnel_id, db)
    return result


@router.post('/{personnel_id}/simulate-move', dependencies=[Depends(require_key)])
async def simulate_move(personnel_id: str):
    db = get_db()
    person = db.execute('SELECT * FROM personnel WHERE id = ?', (personnel_id,)).fetchone()
    if not person:
        raise HTTPException(status_code=404, detail='Personnel not found')

    plan = get_latest_plan(personnel_id, db)
    if not plan:
        # Previously this returned {'status': 'arrived'} and flipped the person
        # to 'field' - so "Start GPS" appeared to work while moving nobody.
        raise HTTPException(
            status_code=409,
            detail=f'{person["name"]} has no movement plan. Create one before starting GPS tracking.'
        )

    position = get_next_position(personnel_id, db)
    if position is None:
        db.execute("UPDATE personnel SET status = 'field' WHERE id = ?", (personnel_id,))
        db.execute("UPDATE movement_plans SET status = 'arrived' WHERE id = ?", (plan['id'],))
        db.commit()
        await log_event('personnel', f'{person["name"]} arrived at {plan["destination_name"]}',
                        'gps_system', personnel_id, station=person['station'])
        await manager.broadcast({'type': 'personnel_update',
                                 'data': {'personnel_id': personnel_id, 'status': 'field',
                                          'plan_status': 'arrived'}})
        await broadcast_open_incident_accountability(db)
        return {'status': 'arrived', 'personnel_id': personnel_id,
                'destination': plan['destination_name']}

    now = utc_now_iso()
    # A person already flagged deviated or in SOS keeps that status: overwriting
    # it with 'in_transit' on the next fix is what made the alert state vanish.
    if person['status'] in ('deviated', 'sos'):
        db.execute('UPDATE personnel SET current_lat = ?, current_lng = ?, last_update_at = ? '
                   'WHERE id = ?', (position['lat'], position['lng'], now, personnel_id))
    else:
        db.execute('UPDATE personnel SET current_lat = ?, current_lng = ?, last_update_at = ?, '
                   "status = 'in_transit' WHERE id = ?",
                   (position['lat'], position['lng'], now, personnel_id))
    db.commit()

    geofences = [dict(g) for g in db.execute('SELECT * FROM geofences').fetchall()]
    inside = check_geofences(position['lat'], position['lng'], geofences)

    alert = None
    for gf in inside:
        if gf['type'] == 'restricted':
            alert = {'type': 'geofence_violation', 'geofence': gf['name'],
                     'personnel': person['name'], 'personnel_id': personnel_id,
                     'severity': 'critical',
                     'message': f'{person["name"]} entered restricted zone "{gf["name"]}"'}
            # The person's own status has to carry the deviation too. Writing
            # it only onto the plan meant the roster snapped back to "in
            # transit" on the next refresh and the red state lasted one render.
            db.execute("UPDATE movement_plans SET status = 'deviated' WHERE id = ?", (plan['id'],))
            db.execute("UPDATE personnel SET status = 'deviated' WHERE id = ?", (personnel_id,))
            db.commit()
            await log_event('personnel',
                            f'ALERT: {person["name"]} entered restricted zone "{gf["name"]}"',
                            'gps_system', personnel_id,
                            {'geofence': gf, 'position': position},
                            station=person['station'])
            break

    # Deviation is measured against THIS plan's authorised waypoints, not a
    # hard-coded global route.
    if not alert:
        planned = get_planned_route(plan)
        if check_route_deviation(position['lat'], position['lng'], planned,
                                 ROUTE_DEVIATION_THRESHOLD_M):
            db.execute("UPDATE movement_plans SET status = 'deviated' WHERE id = ?", (plan['id'],))
            db.execute("UPDATE personnel SET status = 'deviated' WHERE id = ?", (personnel_id,))
            db.commit()
            alert = {'type': 'route_deviation', 'personnel': person['name'],
                     'personnel_id': personnel_id, 'severity': 'high',
                     'message': f'{person["name"]} is off the authorised route'}
            await log_event('personnel', f'{person["name"]} deviating from planned route',
                            'gps_system', personnel_id, {'position': position},
                            station=person['station'])

    await manager.broadcast({'type': 'gps_update',
                             'data': {'personnel_id': personnel_id, 'name': person['name'],
                                      'lat': position['lat'], 'lng': position['lng'],
                                      'last_update_at': now, 'alert': alert}})
    if alert:
        await manager.broadcast({'type': 'alert', 'data': alert})

    await broadcast_open_incident_accountability(db)
    return {'personnel_id': personnel_id, 'position': position, 'alert': alert,
            'progress': get_progress(personnel_id, db)}


@router.post('/{personnel_id}/reset-simulation', dependencies=[Depends(require_key)])
async def reset_sim(personnel_id: str):
    db = get_db()
    plan = get_latest_plan(personnel_id, db)
    if not plan:
        raise HTTPException(status_code=409, detail='No movement plan to reset')
    reset_simulation(personnel_id, db)
    # Rewind to the plan's own origin, not a hard-coded Maitri coordinate.
    db.execute("UPDATE personnel SET current_lat = ?, current_lng = ?, last_update_at = ?, "
               "status = 'at_station' WHERE id = ?",
               (plan['origin_lat'], plan['origin_lng'], utc_now_iso(), personnel_id))
    db.commit()
    await manager.broadcast({'type': 'personnel_update',
                             'data': {'personnel_id': personnel_id, 'status': 'at_station'}})
    return {'status': 'reset', 'personnel_id': personnel_id,
            'position': {'lat': plan['origin_lat'], 'lng': plan['origin_lng']}}


@router.post('/{personnel_id}/sos', dependencies=[Depends(require_key)])
async def trigger_sos(personnel_id: str):
    db = get_db()
    person = db.execute('SELECT * FROM personnel WHERE id = ?', (personnel_id,)).fetchone()
    if not person:
        raise HTTPException(status_code=404, detail='Personnel not found')
    if person['current_lat'] is None or person['current_lng'] is None:
        raise HTTPException(status_code=409,
                            detail=f'No known position for {person["name"]} - cannot locate SOS')

    lat, lng, radius = person['current_lat'], person['current_lng'], 5000
    expected, safe, unaccounted, _ = compute_accountability(db, lat, lng, radius)

    incident_id = 'inc-' + str(uuid.uuid4())[:8]
    db.execute(
        'INSERT INTO incidents (id, type, location_lat, location_lng, affected_radius_m, '
        'severity, status, expected_count, confirmed_safe_count, unaccounted_count, station, '
        'created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        (incident_id, 'medical', lat, lng, radius, 'critical', 'open',
         expected, safe, unaccounted, person['station'], utc_now_iso())
    )
    # Someone who has raised an SOS is not "in transit" any more.
    db.execute("UPDATE personnel SET status = 'sos' WHERE id = ?", (personnel_id,))
    db.commit()

    await log_event('emergency', f'SOS triggered by {person["name"]} at ({lat:.4f}, {lng:.4f})',
                    'sos_system', incident_id, station=person['station'])
    await manager.broadcast({'type': 'alert',
                             'data': {'type': 'sos', 'severity': 'critical',
                                      'personnel': person['name'], 'personnel_id': personnel_id,
                                      'lat': lat, 'lng': lng, 'incident_id': incident_id,
                                      'message': f'SOS from {person["name"]}'}})
    return {'incident_id': incident_id, 'personnel': person['name'],
            'expected': expected, 'confirmed_safe': safe, 'unaccounted': unaccounted}


@router.patch('/{personnel_id}/status', dependencies=[Depends(require_key)])
async def update_status(personnel_id: str, body: PersonnelStatusRequest):
    db = get_db()
    person = db.execute('SELECT * FROM personnel WHERE id = ?', (personnel_id,)).fetchone()
    if not person:
        raise HTTPException(status_code=404, detail='Personnel not found')

    current, new_status = person['status'], body.status
    if new_status != current and new_status not in VALID_TRANSITIONS.get(current, set()):
        raise HTTPException(
            status_code=409,
            detail=f"Invalid transition '{current}' -> '{new_status}'. "
                   f"Allowed from '{current}': {sorted(VALID_TRANSITIONS.get(current, set()))}"
        )

    db.execute('UPDATE personnel SET status = ? WHERE id = ?', (new_status, personnel_id))
    db.commit()
    await log_event('personnel', f'{person["name"]} status: {current} -> {new_status}',
                    'commander', personnel_id, station=person['station'])
    await manager.broadcast({'type': 'personnel_update',
                             'data': {'personnel_id': personnel_id, 'status': new_status}})
    await broadcast_open_incident_accountability(db)
    return {'id': personnel_id, 'status': new_status, 'previous_status': current}
