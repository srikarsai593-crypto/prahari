from fastapi import APIRouter, HTTPException, Depends, Query
import uuid
from ..database import get_db
from typing import Optional

from ..models import (IncidentCreate, IncidentUpdateRequest, AssetUpdateRequest,
                      AssetDeployRequest, IncidentTaskRequest, PowerFailureRequest, Station,
                      IncidentType)
from ..seed import STATION_ORIGINS
from ..events import log_event
from ..ws_manager import manager
from ..geo import haversine_distance
from ..ratelimit import guard_write
from ..auth import require_key, require_reader
from ..timeutil import utc_now_iso, to_utc_iso
from .. import incident_lifecycle as lifecycle

# Reads are gated at the router, so a route added later inherits the gate
# instead of quietly shipping open. PRAHARI_PUBLIC_READS opens them again.
router = APIRouter(prefix='/incidents', tags=['incidents'],
                   dependencies=[Depends(require_reader)])

# In an emergency, only these statuses mean a person has been physically
# verified at a known safe location. Everyone else is UNACCOUNTED until
# someone confirms them - counting them as safe is how people get left behind.
VERIFIED_SAFE_STATUSES = ('at_station', 'returned')

# How far from a station an incident is still that station's problem. Maitri,
# Bharati and Himadri are thousands of kilometres apart with separate response
# teams, so "near the station" is generous but finite.
STATION_RESPONSE_RADIUS_M = 500_000


# --- Standard Operating Procedures ------------------------------------------
# The module could say who was missing and could not say what to do about it.
# In a real Antarctic emergency the commander is not improvising: a fuel fire
# means foam, manifold isolation and a muster at the secondary module, in that
# order. The catalogue lives here rather than in the database because it is
# doctrine, not station data; what gets recorded is which steps were actually
# taken, by whom, and when.
SOP_PLAYBOOKS: dict[str, list[tuple[str, str]]] = {
    'fire': [
        ('klaxon',   'Sound station-wide klaxon / evacuation alarm'),
        ('manifold', 'Isolate main fuel manifold and tank valves'),
        ('suppress', 'Deploy snowcat with fire-suppression sled'),
        ('muster',   'Verify crew muster at secondary habitation module'),
        ('satcom',   'Establish satcom comms with NCPOR base command'),
    ],
    'medical': [
        ('officer',  'Dispatch medical officer to field location'),
        ('trauma',   'Mobilise trauma kit and hypothermia blanket unit'),
        ('medevac',  'Place rescue helicopter on medevac standby'),
        ('satcom',   'Relay casualty status to NCPOR base command'),
    ],
    'power_failure': [
        ('ats',      'Verify automatic transfer switch to diesel generator 2'),
        ('circuits', 'Prioritise critical life-support heating circuits'),
        ('vhf',      'Radio all outlying field camps on emergency VHF'),
        ('fuel',     'Confirm generator day-tank level and reserve fuel'),
    ],
    'severe_weather': [
        ('condition', 'Declare weather condition and confine crew to buildings'),
        ('lifelines', 'Rig inter-building lifelines and confirm they are in place'),
        ('recall',    'Recall every party in the field to the nearest shelter'),
        ('secure',    'Secure external loads, vehicles and antennae'),
    ],
    'structural': [
        ('evacuate', 'Evacuate and cordon the affected structure'),
        ('utilities', 'Isolate power, fuel and water to the structure'),
        ('assess',   'Assess load-bearing damage before any re-entry'),
        ('muster',   'Verify crew muster and account for every occupant'),
    ],
}


def _ensure_sop_tasks(db, incident_id: str, incident_type: str) -> None:
    """Materialise the playbook for an incident. Idempotent, so it can run on
    every read of an incident declared before this existed."""
    playbook = SOP_PLAYBOOKS.get(incident_type)
    if not playbook:
        return
    db.executemany(
        'INSERT OR IGNORE INTO incident_tasks (incident_id, task_key, label, position) '
        'VALUES (?, ?, ?, ?)',
        [(incident_id, key, label, i) for i, (key, label) in enumerate(playbook)]
    )
    db.commit()


def _sop_tasks(db, incident_id: str, incident_type: str) -> list[dict]:
    _ensure_sop_tasks(db, incident_id, incident_type)
    rows = db.execute(
        'SELECT * FROM incident_tasks WHERE incident_id = ? ORDER BY position',
        (incident_id,)
    ).fetchall()
    return [{**dict(r), 'done': bool(r['done']), 'done_at': to_utc_iso(r['done_at'])}
            for r in rows]


def _with_stage(row) -> dict:
    """An incident plus what its stage means and whether it is still live.

    The word alone does not tell an operator that `contained` is not `closed`,
    and every console would otherwise have to keep its own copy of that.
    """
    d = dict(row)
    d['created_at'] = to_utc_iso(d.get('created_at'))
    for field in ('acknowledged_at', 'responding_at', 'contained_at', 'resolved_at'):
        if field in d:
            d[field] = to_utc_iso(d[field])
    d['status'] = lifecycle.normalise(d.get('status'))
    d['is_active'] = lifecycle.is_active(d['status'])
    d['stage_description'] = lifecycle.DESCRIPTIONS.get(d['status'])
    d['next_stages'] = [stage for stage in lifecycle.LIFECYCLE
                        if lifecycle.can_transition(d['status'], stage)[0]
                        and stage != d['status']]
    return d


def _within_station(station: str, lat, lng) -> bool:
    origin = STATION_ORIGINS.get(station)
    if origin is None or lat is None or lng is None:
        return True  # unknown station or position — do not silently hide it
    return haversine_distance(origin[0], origin[1], lat, lng) <= STATION_RESPONSE_RADIUS_M


def _owning_station(lat, lng) -> str | None:
    """The station whose response radius this position falls in, nearest first.

    Recorded on the incident row at declaration time so the roster that owns an
    incident is a stored fact rather than a distance calculation repeated on
    every list request.
    """
    if lat is None or lng is None:
        return None
    ranked = sorted(
        ((haversine_distance(o[0], o[1], lat, lng), name)
         for name, o in STATION_ORIGINS.items()),
        key=lambda pair: pair[0])
    nearest_distance, nearest = ranked[0]
    return nearest if nearest_distance <= STATION_RESPONSE_RADIUS_M else None


# How much each factor is worth when ranking a callout. Distance dominates,
# because on the ice it usually should — but not to the exclusion of
# everything else, which is what ranking by distance alone amounted to.
ASSET_WEIGHTS = {
    'proximity': 0.45,
    'fuel': 0.20,
    'reach': 0.20,      # can it get there and back on what it has
    'medic': 0.15,
}

# Beyond this an asset is far enough that the difference between 60 km and
# 70 km stops mattering to the ranking.
FAR_M = 50_000

# At or above this, an asset is simply fuelled and gets full marks. Ranking
# 82% below 100% for a short callout is a distinction without a difference.
COMFORTABLE_FUEL = 0.5


def score_asset(asset: dict, distance_m: float, *, needs_medic: bool) -> dict:
    """How suitable this asset is for this callout, and why.

    Distance alone sent the nearest snowcat to a casualty while a helicopter
    with a medic aboard sat eight minutes further out — and it ranked a
    vehicle on a quarter tank above one that was fuelled and ten metres
    behind it.

    Every component is returned alongside the score. A commander overruling a
    ranking needs to see what it was weighing, and a number with no workings
    is one nobody should act on during an emergency.
    """
    proximity = max(0.0, 1.0 - min(distance_m, FAR_M) / FAR_M)
    fuel_pct = asset.get('fuel_pct')
    raw_fuel = (float(fuel_pct) / 100) if fuel_pct is not None else 0.5
    # Reserve, not tank level. Above the comfortable mark there is nothing to
    # choose between 82% and 100% for a two-kilometre callout, and scoring
    # them apart ranked a full sled 1.3 km away above the snowcat parked
    # outside. Below it, every point matters. Whether the fuel is enough for
    # *this* trip is a separate question, answered by `reach`.
    fuel = min(1.0, raw_fuel / COMFORTABLE_FUEL)

    # Range is what it can do on a full tank, so the distance it can actually
    # cover now is that scaled by what is in it. Doubled because the asset has
    # to come back, which is the half of the trip a range figure omits.
    range_km = float(asset.get('range_km') or 0)
    reachable_km = range_km * raw_fuel
    needed_km = (distance_m / 1000) * 2
    if range_km <= 0:
        # Static kit — a medical cache does not travel. Not unreachable, just
        # not scored on reach.
        reach = 0.0
        out_of_range = distance_m > 0
    else:
        reach = 1.0 if needed_km <= reachable_km else max(0.0, reachable_km / max(needed_km, 1))
        out_of_range = needed_km > reachable_km

    medic = 1.0 if asset.get('medic_aboard') else 0.0
    weights = dict(ASSET_WEIGHTS)
    if not needs_medic:
        # On a fire or a structural callout a medic aboard is not the
        # deciding factor; redistributing keeps the score comparable across
        # incident types instead of capping non-medical responses at 0.85.
        weights['proximity'] += weights.pop('medic')
        medic = 0.0

    score = (weights.get('proximity', 0) * proximity
             + weights['fuel'] * fuel
             + weights['reach'] * reach
             + weights.get('medic', 0) * medic)

    eta_minutes = None
    speed = float(asset.get('speed_kmh') or 0)
    if speed > 0:
        eta_minutes = round((distance_m / 1000) / speed * 60)

    reasons = []
    if asset.get('medic_aboard') and needs_medic:
        reasons.append('medic aboard')
    if out_of_range and range_km > 0:
        reasons.append(f'beyond its round-trip range on {fuel_pct:g}% fuel')
    elif range_km <= 0 and distance_m > 0:
        reasons.append('static kit — cannot travel to the scene')
    if raw_fuel < 0.35:
        reasons.append(f'low fuel ({fuel_pct:g}%)')

    return {
        'suitability': round(score, 3),
        'eta_minutes': eta_minutes,
        'out_of_range': out_of_range,
        'factors': {'proximity': round(proximity, 3), 'fuel': round(fuel, 3),
                    'reach': round(reach, 3), 'medic': medic},
        'notes': reasons,
    }


def get_nearby_assets(db, lat: float, lng: float, limit: int = 10,
                      incident_type: str = None) -> list:
    """Assets ranked by how suitable they are, not only by how near they are.

    `distance_m` is still reported and still the largest single factor — a
    commander reads it first and should be able to. What changed is that it
    is no longer the only one.
    """
    needs_medic = incident_type in ('medical', 'structural', None)
    rows = db.execute("SELECT * FROM emergency_assets WHERE status != 'unavailable'").fetchall()
    results = []
    for r in rows:
        asset = {**dict(r), 'updated_at': to_utc_iso(r['updated_at'])}
        asset['distance_m'] = round(haversine_distance(lat, lng, r['lat'], r['lng']))
        asset.update(score_asset(asset, asset['distance_m'], needs_medic=needs_medic))
        results.append(asset)
    # Best first; distance breaks a tie, because between two equally suitable
    # assets the nearer one is the answer.
    results.sort(key=lambda x: (-x['suitability'], x['distance_m']))
    return results[:limit]


def compute_accountability(db, lat, lng, radius):
    personnel = db.execute('SELECT * FROM personnel').fetchall()
    in_zone = []
    for p in personnel:
        # Explicit None checks: `if p['current_lat']` treats a valid 0.0
        # coordinate as missing.
        if p['current_lat'] is None or p['current_lng'] is None:
            continue
        dist = haversine_distance(lat, lng, p['current_lat'], p['current_lng'])
        if dist <= radius:
            in_zone.append({'id': p['id'], 'name': p['name'], 'role': p['role'],
                            'status': p['status'], 'distance_m': round(dist)})
    expected = len(in_zone)
    confirmed_safe = sum(1 for p in in_zone if p['status'] in VERIFIED_SAFE_STATUSES)
    return expected, confirmed_safe, expected - confirmed_safe, in_zone


def _persist_accountability(db, incident_id, expected, safe, unaccounted):
    db.execute('UPDATE incidents SET expected_count = ?, confirmed_safe_count = ?, '
               'unaccounted_count = ? WHERE id = ?',
               (expected, safe, unaccounted, incident_id))
    db.commit()


@router.get('')
def list_incidents(status: str = None,
                   station: Optional[Station] = None,
                   limit: int = Query(100, ge=1, le=500)):
    """Open and historic incidents.

    `station` narrows the list to incidents within that station's response
    radius. Incidents carry coordinates rather than a station column — an
    incident happens at a place, not at an organisation — so this is a
    geographic filter, not a lookup.
    """
    db = get_db()
    query = 'SELECT * FROM incidents'
    params = []
    if status == 'open':
        # The legacy filter, and still the useful question: everything a
        # commander has not finished with, whatever stage it reached.
        query += f' WHERE status IN ({",".join("?" * len(lifecycle.ACTIVE_STATUSES_SQL))})'
        params.extend(lifecycle.ACTIVE_STATUSES_SQL)
    elif status:
        query += ' WHERE status = ?'
        params.append(status)
    query += ' ORDER BY created_at DESC LIMIT ?'
    params.append(limit)
    rows = db.execute(query, params).fetchall()
    if station:
        rows = [r for r in rows
                if (r['station'] == station if r['station']
                    else _within_station(station, r['location_lat'], r['location_lng']))]
    return [_with_stage(r) for r in rows]


# NOTE: static sub-routes MUST be declared before /{incident_id}, otherwise
# FastAPI matches the literal segment as a path parameter.
@router.post('/power-failure', dependencies=[Depends(require_key), Depends(guard_write)])
async def simulate_power_failure(body: PowerFailureRequest = PowerFailureRequest()):
    """Declare a station-wide power failure.

    This used to log a line and broadcast a toast, changing nothing: the
    incident list, the accountability count and the map were all unaffected, so
    the drill exercised none of the machinery it was meant to. It now declares a
    real incident at the station, which is exactly what the module responds to.
    """
    db = get_db()
    station = body.station
    origin = STATION_ORIGINS.get(station)
    if origin is None:
        raise HTTPException(status_code=422, detail=f'Unknown station {station}')
    lat, lng = origin
    radius = 2000.0

    expected, safe, unaccounted, personnel_list = compute_accountability(db, lat, lng, radius)
    inc_id = 'inc-' + str(uuid.uuid4())[:8]
    db.execute(
        'INSERT INTO incidents (id, type, location_lat, location_lng, affected_radius_m, '
        'severity, status, expected_count, confirmed_safe_count, unaccounted_count, station, '
        'created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        (inc_id, 'power_failure', lat, lng, radius, 'high', 'open',
         expected, safe, unaccounted, station, utc_now_iso())
    )
    db.commit()

    _ensure_sop_tasks(db, inc_id, 'power_failure')
    await log_event('emergency', f'Power failure declared at {station} - '
                    f'{unaccounted} of {expected} in the affected zone unaccounted for',
                    'commander', inc_id,
                    {'type': 'power_failure', 'station': station}, station=station)
    await manager.broadcast({'type': 'alert',
                             'data': {'type': 'power_failure', 'station': station,
                                      'incident_id': inc_id, 'severity': 'high',
                                      'lat': lat, 'lng': lng,
                                      'message': f'ALERT: Power failure at {station}'}})
    await manager.broadcast({'type': 'accountability_update',
                             'data': {'incident_id': inc_id, 'expected': expected,
                                      'confirmed_safe': safe, 'unaccounted': unaccounted,
                                      'personnel': personnel_list}})
    return {'status': 'declared', 'station': station, 'incident_id': inc_id,
            'expected_count': expected, 'confirmed_safe_count': safe,
            'unaccounted_count': unaccounted}


@router.get('/nearby-assets/search')
def search_nearby_assets(lat: float = Query(ge=-90, le=90),
                         lng: float = Query(ge=-180, le=180),
                         incident_type: Optional[IncidentType] = None):
    """Assets ranked for a callout at this position.

    `incident_type` decides whether a medic aboard counts. On a fuel fire it
    is not what makes one snowcat better than another, and weighting it
    anyway would rank a medical cache above the vehicle that can actually
    get there.
    """
    return get_nearby_assets(get_db(), lat, lng, incident_type=incident_type)


@router.get('/assets')
def list_assets(station: Optional[Station] = None):
    """Search-and-rescue assets, optionally for one station only."""
    db = get_db()
    if station:
        rows = db.execute(
            'SELECT * FROM emergency_assets WHERE station = ? ORDER BY name', (station,)
        ).fetchall()
    else:
        rows = db.execute('SELECT * FROM emergency_assets ORDER BY name').fetchall()
    return [{**dict(r), 'updated_at': to_utc_iso(r['updated_at'])} for r in rows]


@router.patch('/assets/{asset_id}', dependencies=[Depends(require_key), Depends(guard_write)])
async def update_asset(asset_id: str, body: AssetUpdateRequest):
    """Update an asset's position or status when a snowcat or helicopter relocates."""
    db = get_db()
    row = db.execute('SELECT * FROM emergency_assets WHERE id = ?', (asset_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail='Asset not found')
    lat = body.lat if body.lat is not None else row['lat']
    lng = body.lng if body.lng is not None else row['lng']
    status = body.status or row['status']
    now = utc_now_iso()
    db.execute('UPDATE emergency_assets SET lat = ?, lng = ?, status = ?, updated_at = ? '
               'WHERE id = ?', (lat, lng, status, now, asset_id))
    db.commit()
    await log_event('emergency', f'Asset "{row["name"]}" position/status updated',
                    'commander', asset_id, station=row['station'])
    return {**dict(row), 'lat': lat, 'lng': lng, 'status': status, 'updated_at': now}


@router.patch('/assets/{asset_id}/dispatch', dependencies=[Depends(require_key), Depends(guard_write)])
async def dispatch_asset(asset_id: str, body: AssetDeployRequest):
    """Commit a search-and-rescue asset to an incident, or release it.

    The assets table and the update route both existed; nothing in the console
    ever called them, so "Nearest Assets" was a distance readout and a snowcat
    could not actually be sent anywhere.
    """
    db = get_db()
    row = db.execute('SELECT * FROM emergency_assets WHERE id = ?', (asset_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail='Asset not found')

    now = utc_now_iso()
    if body.incident_id:
        incident = db.execute('SELECT * FROM incidents WHERE id = ?',
                              (body.incident_id,)).fetchone()
        if not incident:
            raise HTTPException(status_code=404, detail='Incident not found')
        if not lifecycle.is_active(incident['status']):
            raise HTTPException(status_code=409,
                                detail='That incident is closed - nothing to deploy to.')
        if row['status'] == 'unavailable':
            raise HTTPException(
                status_code=409,
                detail=f'{row["name"]} is unavailable and cannot be tasked.')
        if row['assigned_incident_id'] and row['assigned_incident_id'] != body.incident_id:
            raise HTTPException(
                status_code=409,
                detail=f'{row["name"]} is already committed to '
                       f'{row["assigned_incident_id"]} - release it first.')

        # The asset converges on the incident: its position is what the map
        # draws, so leaving it at base would show help that never moved.
        db.execute('UPDATE emergency_assets SET status = ?, assigned_incident_id = ?, '
                   'lat = ?, lng = ?, updated_at = ? WHERE id = ?',
                   ('deployed', body.incident_id, incident['location_lat'],
                    incident['location_lng'], now, asset_id))
        # Committing an asset *is* responding. Leaving the stage at
        # 'declared' while a snowcat is on the ice would make the lifecycle a
        # dropdown nobody remembers to update rather than a record of what
        # happened.
        if lifecycle.rank(incident['status']) < lifecycle.rank(lifecycle.RESPONDING):
            db.execute('UPDATE incidents SET status = ?, responding_at = ? WHERE id = ?',
                       (lifecycle.RESPONDING, now, body.incident_id))
        db.commit()
        label = str(incident['type']).replace('_', ' ')
        await log_event('emergency',
                        f'{row["name"]} deployed to {label} incident {body.incident_id}',
                        'commander', asset_id,
                        {'incident_id': body.incident_id, 'asset_id': asset_id},
                        station=row['station'])
    else:
        previous = row['assigned_incident_id']
        db.execute('UPDATE emergency_assets SET status = ?, assigned_incident_id = NULL, '
                   'lat = ?, lng = ?, updated_at = ? WHERE id = ?',
                   ('available', row['lat'], row['lng'], now, asset_id))
        db.commit()
        await log_event('emergency',
                        f'{row["name"]} released'
                        f'{f" from {previous}" if previous else ""} and returned to service',
                        'commander', asset_id, {'asset_id': asset_id}, station=row['station'])

    updated = db.execute('SELECT * FROM emergency_assets WHERE id = ?', (asset_id,)).fetchone()
    result = {**dict(updated), 'updated_at': to_utc_iso(updated['updated_at'])}
    await manager.broadcast({'type': 'asset_update', 'data': result})
    return result


@router.get('/{incident_id}/sop')
def get_incident_sop(incident_id: str):
    """The response protocol for this incident, and what has been done so far."""
    db = get_db()
    row = db.execute('SELECT type FROM incidents WHERE id = ?', (incident_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail='Incident not found')
    tasks = _sop_tasks(db, incident_id, row['type'])
    return {'incident_id': incident_id, 'type': row['type'], 'tasks': tasks,
            'completed': sum(1 for t in tasks if t['done']), 'total': len(tasks)}


@router.patch('/{incident_id}/sop/{task_key}', dependencies=[Depends(require_key), Depends(guard_write)])
async def update_incident_sop(incident_id: str, task_key: str, body: IncidentTaskRequest):
    """Tick or untick one protocol step, and put it in the audit timeline."""
    db = get_db()
    incident = db.execute('SELECT * FROM incidents WHERE id = ?', (incident_id,)).fetchone()
    if not incident:
        raise HTTPException(status_code=404, detail='Incident not found')
    _ensure_sop_tasks(db, incident_id, incident['type'])
    task = db.execute('SELECT * FROM incident_tasks WHERE incident_id = ? AND task_key = ?',
                      (incident_id, task_key)).fetchone()
    if not task:
        raise HTTPException(status_code=404,
                            detail=f'No protocol step "{task_key}" for this incident type')

    now = utc_now_iso() if body.done else None
    db.execute('UPDATE incident_tasks SET done = ?, done_at = ?, done_by = ? '
               'WHERE incident_id = ? AND task_key = ?',
               (1 if body.done else 0, now, 'commander' if body.done else None,
                incident_id, task_key))
    db.commit()

    await log_event('emergency',
                    f'Response protocol step {"completed" if body.done else "reopened"} for '
                    f'{incident_id}: {task["label"]}',
                    'commander', incident_id,
                    {'task_key': task_key, 'done': body.done}, station=incident['station'])
    tasks = _sop_tasks(db, incident_id, incident['type'])
    payload = {'incident_id': incident_id, 'tasks': tasks,
               'completed': sum(1 for t in tasks if t['done']), 'total': len(tasks)}
    await manager.broadcast({'type': 'incident_sop_update', 'data': payload})
    return payload


@router.get('/{incident_id}')
def get_incident(incident_id: str):
    db = get_db()
    row = db.execute('SELECT * FROM incidents WHERE id = ?', (incident_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail='Incident not found')
    d = _with_stage(row)
    expected, safe, unaccounted, personnel = compute_accountability(
        db, d['location_lat'], d['location_lng'], d['affected_radius_m'])
    d.update({'expected_count': expected, 'confirmed_safe_count': safe,
              'unaccounted_count': unaccounted, 'personnel_in_zone': personnel,
              # Ranked for *this* incident's type: a medic aboard decides a
              # medical callout and is beside the point on a fuel fire.
              'nearby_assets': get_nearby_assets(db, d['location_lat'], d['location_lng'],
                                                 incident_type=d['type']),
              'sop_tasks': _sop_tasks(db, incident_id, d['type'])})
    return d


@router.post('', dependencies=[Depends(require_key), Depends(guard_write)])
async def create_incident(data: IncidentCreate):
    db = get_db()
    inc_id = 'inc-' + str(uuid.uuid4())[:8]
    expected, safe, unaccounted, personnel_list = compute_accountability(
        db, data.location_lat, data.location_lng, data.affected_radius_m)

    station = _owning_station(data.location_lat, data.location_lng)
    db.execute(
        'INSERT INTO incidents (id, type, location_lat, location_lng, affected_radius_m, '
        'severity, status, expected_count, confirmed_safe_count, unaccounted_count, station, '
        'created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        (inc_id, data.type, data.location_lat, data.location_lng, data.affected_radius_m,
         data.severity, lifecycle.DECLARED, expected, safe, unaccounted, station,
         utc_now_iso())
    )
    db.commit()

    _ensure_sop_tasks(db, inc_id, data.type)
    await log_event('emergency', f'Incident created: {data.type} (severity: {data.severity})',
                    'commander', inc_id, {'type': data.type, 'severity': data.severity},
                    station=station)
    await manager.broadcast({'type': 'alert',
                             'data': {'type': 'incident', 'incident_id': inc_id,
                                      'incident_type': data.type, 'severity': data.severity,
                                      'station': station,
                                      'lat': data.location_lat, 'lng': data.location_lng}})
    await manager.broadcast({'type': 'accountability_update',
                             'data': {'incident_id': inc_id, 'expected': expected,
                                      'confirmed_safe': safe, 'unaccounted': unaccounted,
                                      'personnel': personnel_list}})

    return {'id': inc_id, 'status': lifecycle.DECLARED, 'station': station,
            'expected_count': expected,
            'confirmed_safe_count': safe, 'unaccounted_count': unaccounted,
            'personnel_in_zone': personnel_list, **data.model_dump()}


@router.patch('/{incident_id}', dependencies=[Depends(require_key), Depends(guard_write)])
async def update_incident(incident_id: str, body: IncidentUpdateRequest):
    db = get_db()
    row = db.execute('SELECT * FROM incidents WHERE id = ?', (incident_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail='Incident not found')

    if body.status is None and body.severity is None and body.affected_radius_m is None:
        raise HTTPException(status_code=422,
                            detail='Send at least one of status, severity or affected_radius_m.')

    target = lifecycle.normalise(body.status)
    if target is not None:
        allowed, why = lifecycle.can_transition(row['status'], target)
        if not allowed:
            raise HTTPException(status_code=409, detail=why)

    if target == lifecycle.RESOLVED and (row['unaccounted_count'] or 0) > 0:
        # Closing an incident while people are still unaccounted for is exactly
        # the failure this module exists to prevent.
        raise HTTPException(
            status_code=409,
            detail=f'Cannot resolve: {row["unaccounted_count"]} personnel still unaccounted for. '
                   f'Confirm every person safe first.'
        )

    label = str(row['type']).replace('_', ' ')
    status = target or lifecycle.normalise(row['status'])
    severity = body.severity or row['severity']
    radius = body.affected_radius_m if body.affected_radius_m is not None \
        else row['affected_radius_m']
    notes: list[str] = []
    escalated_to_critical = severity == 'critical' and row['severity'] != 'critical'

    # A wider perimeter is a different question about who is inside it, so the
    # head-count is re-run against the new circle rather than left reporting
    # the old one. That is the whole point of being able to widen it: the
    # previous workaround - resolve and redeclare - threw the count away.
    accountability = None
    if body.affected_radius_m is not None and radius != row['affected_radius_m']:
        expected, safe, unaccounted, personnel = compute_accountability(
            db, row['location_lat'], row['location_lng'], radius)
        _persist_accountability(db, incident_id, expected, safe, unaccounted)
        accountability = {'expected': expected, 'confirmed_safe': safe,
                          'unaccounted': unaccounted, 'personnel': personnel}
        notes.append(f'perimeter {row["affected_radius_m"]:,.0f} m -> {radius:,.0f} m '
                     f'({unaccounted} of {expected} unaccounted in the widened zone)')
    if body.severity is not None and severity != row['severity']:
        notes.append(f'severity {row["severity"]} -> {severity}')

    db.execute('UPDATE incidents SET status = ?, severity = ?, affected_radius_m = ? '
               'WHERE id = ?', (status, severity, radius, incident_id))
    # Stamp the moment the stage was entered. Every stage the response passed
    # through keeps its own timestamp, so a debrief can say how long the
    # station took to acknowledge and how long to get moving — which is the
    # question asked after every callout and the one a single status column
    # could never answer.
    stage_column = lifecycle.STAGE_TIMESTAMP.get(status)
    if stage_column and status != lifecycle.normalise(row['status']):
        db.execute(f'UPDATE incidents SET {stage_column} = ? WHERE id = ?',
                   (utc_now_iso(), incident_id))
    db.commit()

    if target is not None and status != lifecycle.normalise(row['status']):
        if status == lifecycle.RESOLVED:
            action = f'Incident {incident_id} ({label}) resolved - everyone accounted for'
        elif lifecycle.normalise(row['status']) == lifecycle.RESOLVED:
            action = f'Incident {incident_id} ({label}) reopened - back to responding'
        else:
            action = (f'Incident {incident_id} ({label}) '
                      f'{lifecycle.normalise(row["status"])} -> {status}')
        await log_event('emergency', action, 'commander', incident_id,
                        {'stage': status}, station=row['station'])
    if notes:
        await log_event('emergency',
                        f'Incident {incident_id} ({label}) updated: {"; ".join(notes)}',
                        'commander', incident_id,
                        {'severity': severity, 'affected_radius_m': radius},
                        station=row['station'])

    await manager.broadcast({'type': 'incident_update',
                             'data': {'incident_id': incident_id, 'status': status,
                                      'severity': severity, 'affected_radius_m': radius,
                                      'station': row['station']}})
    if accountability:
        await manager.broadcast({'type': 'accountability_update',
                                 'data': {'incident_id': incident_id, **accountability}})
    if escalated_to_critical and lifecycle.is_active(status):
        # A critical escalation is not a card update: it is the thing that puts
        # the full-width red banner on every console in the station.
        await manager.broadcast({'type': 'alert',
                                 'data': {'type': 'incident_escalation', 'severity': 'critical',
                                          'incident_id': incident_id, 'incident_type': row['type'],
                                          'station': row['station'],
                                          'lat': row['location_lat'], 'lng': row['location_lng'],
                                          'message': f'ESCALATED TO CRITICAL: {label} incident '
                                                     f'{incident_id} at {row["station"]}'}})

    if status == 'resolved':
        # An asset left flagged 'deployed' against a closed incident is help
        # the next emergency believes it does not have.
        released = db.execute(
            'SELECT id, name FROM emergency_assets WHERE assigned_incident_id = ?',
            (incident_id,)).fetchall()
        if released:
            db.execute("UPDATE emergency_assets SET status = 'available', "
                       'assigned_incident_id = NULL, updated_at = ? WHERE assigned_incident_id = ?',
                       (utc_now_iso(), incident_id))
            db.commit()
            await log_event('emergency',
                            f'{len(released)} asset(s) released on closure of {incident_id}: '
                            f'{", ".join(r["name"] for r in released)}',
                            'system', incident_id, station=row['station'])
            await manager.broadcast({'type': 'asset_update',
                                     'data': {'released_incident_id': incident_id}})
            notes.append(f'{len(released)} asset(s) returned to service')

    result = {'id': incident_id, 'status': status, 'severity': severity,
              'affected_radius_m': radius, 'station': row['station'], 'notes': notes}
    if accountability:
        result['accountability'] = {k: v for k, v in accountability.items() if k != 'personnel'}
    return result


@router.post('/{incident_id}/accountability')
async def refresh_accountability(incident_id: str):
    """Recompute and persist the live head-count for an incident.

    This is a POST because it writes: the previous GET mutated rows and
    broadcast to every client, so any cache, prefetch or refresh silently
    rewrote emergency state.
    """
    db = get_db()
    row = db.execute('SELECT * FROM incidents WHERE id = ?', (incident_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail='Incident not found')
    incident = dict(row)
    expected, safe, unaccounted, personnel = compute_accountability(
        db, incident['location_lat'], incident['location_lng'], incident['affected_radius_m'])
    _persist_accountability(db, incident_id, expected, safe, unaccounted)
    await manager.broadcast({'type': 'accountability_update',
                             'data': {'incident_id': incident_id, 'expected': expected,
                                      'confirmed_safe': safe, 'unaccounted': unaccounted,
                                      'personnel': personnel}})
    return {'incident_id': incident_id, 'expected': expected, 'confirmed_safe': safe,
            'unaccounted': unaccounted, 'personnel': personnel}


@router.get('/{incident_id}/accountability')
def read_accountability(incident_id: str):
    """Read-only head-count. Does not write and does not broadcast."""
    db = get_db()
    row = db.execute('SELECT * FROM incidents WHERE id = ?', (incident_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail='Incident not found')
    incident = dict(row)
    expected, safe, unaccounted, personnel = compute_accountability(
        db, incident['location_lat'], incident['location_lng'], incident['affected_radius_m'])
    return {'incident_id': incident_id, 'expected': expected, 'confirmed_safe': safe,
            'unaccounted': unaccounted, 'personnel': personnel}
