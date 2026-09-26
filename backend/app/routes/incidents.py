from fastapi import APIRouter, HTTPException, Depends, Query
import uuid
from ..database import get_db
from typing import Optional

from ..models import (IncidentCreate, IncidentUpdateRequest, AssetUpdateRequest,
                      PowerFailureRequest, Station)
from ..seed import STATION_ORIGINS
from ..events import log_event
from ..ws_manager import manager
from ..geo import haversine_distance
from ..auth import require_key
from ..timeutil import utc_now_iso, to_utc_iso

router = APIRouter(prefix='/incidents', tags=['incidents'])

# In an emergency, only these statuses mean a person has been physically
# verified at a known safe location. Everyone else is UNACCOUNTED until
# someone confirms them - counting them as safe is how people get left behind.
VERIFIED_SAFE_STATUSES = ('at_station', 'returned')

# How far from a station an incident is still that station's problem. Maitri,
# Bharati and Himadri are thousands of kilometres apart with separate response
# teams, so "near the station" is generous but finite.
STATION_RESPONSE_RADIUS_M = 500_000


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
    results = [{**dict(r), 'distance_m': round(haversine_distance(lat, lng, r['lat'], r['lng']))}
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
@router.post('/power-failure', dependencies=[Depends(require_key)])
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


@router.patch('/assets/{asset_id}', dependencies=[Depends(require_key)])
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
              'nearby_assets': get_nearby_assets(db, d['location_lat'], d['location_lng'])})
    return d


@router.post('', dependencies=[Depends(require_key)])
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


@router.patch('/{incident_id}', dependencies=[Depends(require_key)])
async def update_incident(incident_id: str, body: IncidentUpdateRequest):
    db = get_db()
    row = db.execute('SELECT * FROM incidents WHERE id = ?', (incident_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail='Incident not found')

    if body.status == 'resolved' and (row['unaccounted_count'] or 0) > 0:
        # Closing an incident while people are still unaccounted for is exactly
        # the failure this module exists to prevent.
        raise HTTPException(
            status_code=409,
            detail=f'Cannot resolve: {row["unaccounted_count"]} personnel still unaccounted for. '
                   f'Confirm every person safe first.'
        )

    db.execute('UPDATE incidents SET status = ? WHERE id = ?', (body.status, incident_id))
    db.commit()
    label = str(row['type']).replace('_', ' ')
    action = (f'Incident {incident_id} ({label}) resolved - everyone accounted for'
              if body.status == 'resolved'
              else f'Incident {incident_id} ({label}) reopened')
    await log_event('emergency', action, 'commander', incident_id, station=row['station'])
    await manager.broadcast({'type': 'incident_update',
                             'data': {'incident_id': incident_id, 'status': body.status,
                                      'station': row['station']}})
    return {'id': incident_id, 'status': body.status, 'station': row['station']}


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
