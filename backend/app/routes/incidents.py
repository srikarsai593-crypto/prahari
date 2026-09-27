from fastapi import APIRouter, HTTPException, Depends, Query
import uuid
from ..database import get_db
from typing import Optional

from ..models import (IncidentCreate, IncidentUpdateRequest, AssetUpdateRequest,
                      AssetDeployRequest, IncidentTaskRequest, PowerFailureRequest, Station)
from ..seed import STATION_ORIGINS
from ..events import log_event
from ..ws_manager import manager
from ..geo import haversine_distance
from ..ratelimit import guard_write
from ..auth import require_key, require_reader
from ..timeutil import utc_now_iso, to_utc_iso

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


def get_nearby_assets(db, lat: float, lng: float, limit: int = 10) -> list:
    """Assets ranked by great-circle distance. Coordinates come from the DB."""
    rows = db.execute("SELECT * FROM emergency_assets WHERE status != 'unavailable'").fetchall()
    results = [{**dict(r), 'updated_at': to_utc_iso(r['updated_at']),
                'distance_m': round(haversine_distance(lat, lng, r['lat'], r['lng']))}
               for r in rows]
    results.sort(key=lambda x: x['distance_m'])
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
    if status:
        query += ' WHERE status = ?'
        params.append(status)
    query += ' ORDER BY created_at DESC LIMIT ?'
    params.append(limit)
    rows = db.execute(query, params).fetchall()
    if station:
        rows = [r for r in rows
                if (r['station'] == station if r['station']
                    else _within_station(station, r['location_lat'], r['location_lng']))]
    return [{**dict(r), 'created_at': to_utc_iso(r['created_at'])} for r in rows]


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
                         lng: float = Query(ge=-180, le=180)):
    return get_nearby_assets(get_db(), lat, lng)


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
        if incident['status'] != 'open':
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
    d = dict(row)
    d['created_at'] = to_utc_iso(d['created_at'])
    expected, safe, unaccounted, personnel = compute_accountability(
        db, d['location_lat'], d['location_lng'], d['affected_radius_m'])
    d.update({'expected_count': expected, 'confirmed_safe_count': safe,
              'unaccounted_count': unaccounted, 'personnel_in_zone': personnel,
              'nearby_assets': get_nearby_assets(db, d['location_lat'], d['location_lng']),
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
         data.severity, 'open', expected, safe, unaccounted, station, utc_now_iso())
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

    return {'id': inc_id, 'status': 'open', 'station': station, 'expected_count': expected,
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

    if body.status == 'resolved' and (row['unaccounted_count'] or 0) > 0:
        # Closing an incident while people are still unaccounted for is exactly
        # the failure this module exists to prevent.
        raise HTTPException(
            status_code=409,
            detail=f'Cannot resolve: {row["unaccounted_count"]} personnel still unaccounted for. '
                   f'Confirm every person safe first.'
        )

    label = str(row['type']).replace('_', ' ')
    status = body.status or row['status']
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
    db.commit()

    if body.status is not None and status != row['status']:
        action = (f'Incident {incident_id} ({label}) resolved - everyone accounted for'
                  if status == 'resolved'
                  else f'Incident {incident_id} ({label}) reopened')
        await log_event('emergency', action, 'commander', incident_id, station=row['station'])
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
    if escalated_to_critical and status == 'open':
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
