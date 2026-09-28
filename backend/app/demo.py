"""A mid-season operational picture, for demonstrations and first-run consoles.

`seed.py` establishes *reference* data — who is on the roster, what is in the
store, where the geofences are. It deliberately plants no operational records,
because those are what an exercise creates and what a reset clears.

The consequence is that a console booted from the seed alone shows an empty
Cargo board and an empty Emergency page. To an operator, and to anyone being
shown the console for the first time, that is indistinguishable from a backend
that is down. This module fills that gap: one call puts a plausible season on
every station, so each module has something real to display.

Two decisions worth defending:

* **Consignments and traverses go through the route handlers, not INSERT.** A
  second copy of the shipment-creation logic here would drift from the real
  one, and would skip the audit entries, the risk scoring and the cascade that
  a genuine write performs. Those records are therefore real records,
  indistinguishable from ones an operator typed — because that is what they
  are.

* **The closed incident does not.** Declaring an emergency and standing it
  down a millisecond later is not what a historical incident is; it would fire
  the station-wide alarm on every open console, for an emergency nobody
  declared and that was already over. Recording that one happened and was
  closed is a different operation from declaring one, so it is written
  directly.
* **It says what it is.** The season is announced in the audit log as
  synthetic. A demo that cannot be told apart from live operations is not a
  demo, it is a misrepresentation, and the station's record is the wrong place
  to start one.
"""

import logging

from .events import log_event
from .seed import STATION_ORIGINS

logger = logging.getLogger('prahari.demo')

# Hours from now until each consignment is due. Negative backdates the ETA,
# which is how the stalled-convoy path becomes visible without waiting a
# fortnight for a real sea leg to slip.
#
# One overdue consignment exists on purpose, and only at Maitri: an operator
# should meet the overdue treatment somewhere, and three simultaneously stalled
# convoys across three stations is not a season, it is a catastrophe.
# `scans` advances a consignment along dispatched -> in_transit -> arrived.
# A board on which every crate is still 'dispatched' is not a mid-season
# picture, and the dashboard's "consignments in transit" reads zero against a
# full board. Nothing is advanced to 'unloaded': that moves stock, and the
# season should leave the store at its seeded figures.
CONSIGNMENTS = {
    'Maitri': [
        {'item_name': 'Diesel Fuel', 'category': 'fuel', 'weight_kg': 8400,
         'quantity': 9000, 'unit': 'L', 'inventory_item_id': 'inv-fuel',
         'priority': 'critical', 'eta_hours': 132, 'scans': 1},
        {'item_name': 'Medical Supplies', 'category': 'medical', 'weight_kg': 310,
         'quantity': 90, 'unit': 'units', 'inventory_item_id': 'inv-med',
         'priority': 'high', 'eta_hours': 38, 'scans': 2,
         # Takes the 2-8C medical band by default. The readings walk it out
         # of band and back, so the board shows a crate that recovered and
         # still carries the excursion on its record - which is the case an
         # operator most needs to see, and the one a current-reading-only
         # display would report as fine.
         'temperatures': [4.2, 11.6, 5.1]},
        {'item_name': 'Thermal Blankets', 'category': 'equipment', 'weight_kg': 260,
         'quantity': 40, 'unit': 'units', 'inventory_item_id': 'inv-blankets',
         'priority': 'normal', 'eta_hours': -26, 'scans': 1},
    ],
    'Bharati': [
        {'item_name': 'Emergency Rations', 'category': 'food', 'weight_kg': 1200,
         'quantity': 1100, 'unit': 'kg', 'inventory_item_id': 'inv-bha-rat',
         'priority': 'high', 'eta_hours': 76, 'scans': 1,
         'temperatures': [-19.4]},
        {'item_name': 'Generator Spares', 'category': 'equipment', 'weight_kg': 480,
         'quantity': 18, 'unit': 'units', 'inventory_item_id': 'inv-bha-parts',
         'priority': 'normal', 'eta_hours': 210, 'scans': 0},
    ],
    'Himadri': [
        {'item_name': 'Diesel Fuel', 'category': 'fuel', 'weight_kg': 4200,
         'quantity': 5000, 'unit': 'L', 'inventory_item_id': 'inv-him-fuel',
         'priority': 'critical', 'eta_hours': 64, 'scans': 1},
    ],
}

# Traverses in planning. Each is sized against what the station actually holds,
# so the readiness figures the cards show are meaningful rather than uniformly
# green or uniformly red. Maitri's is deliberately short on fuel — the seed
# leaves 6500 L on hand — so the feasibility panel has a real shortfall to
# explain.
EXPEDITIONS = {
    'Maitri': {'name': 'Schirmacher Ice Core Traverse', 'personnel_required': 6,
               'fuel_required_l': 7200, 'crew': 3,
               'raw_request': 'Six-week ice core traverse from Maitri with six crew.'},
    'Bharati': {'name': 'Larsemann Coastal Survey', 'personnel_required': 4,
                'fuel_required_l': 3200, 'crew': 2,
                'raw_request': 'Coastal survey out of Bharati with four crew.'},
    'Himadri': {'name': 'Ny-Alesund Glaciology Run', 'personnel_required': 2,
                'fuel_required_l': 900, 'crew': 2,
                'raw_request': 'Short glaciology run from Himadri with two crew.'},
}

# One closed incident per station. It is resolved rather than open: the
# Emergency module should open on a station that is safe, with a record behind
# it, not on a live emergency nobody declared.
PAST_INCIDENTS = {
    'Maitri': {'type': 'power_failure', 'severity': 'high'},
    'Bharati': {'type': 'severe_weather', 'severity': 'medium'},
    'Himadri': {'type': 'structural', 'severity': 'low'},
}

# Blizzard load left on the board at Maitri. Small enough that nothing is in
# crisis, large enough that the depletion formula is visibly doing something
# rather than multiplying by one.
STANDING_DELTA_T = {'Maitri': 6.0}


# Keys on a consignment spec that steer the planting rather than describing
# the crate. Everything else is passed straight to ShipmentCreate, so a field
# added to the model needs no change here.
_PLANTING_KEYS = ('scans', 'temperatures')


async def _plant_consignments(station: str) -> int:
    from .models import ShipmentCreate, TemperatureReading
    from .routes.shipments import create_shipment, record_temperature, scan_shipment

    planted = 0
    for spec in CONSIGNMENTS.get(station, []):
        payload = {k: v for k, v in spec.items() if k not in _PLANTING_KEYS}
        shipment = await create_shipment(ShipmentCreate(destination_station=station, **payload))
        for _ in range(spec.get('scans', 0)):
            await scan_shipment(shipment['id'])
        for temp_c in spec.get('temperatures', ()):
            await record_temperature(shipment['id'],
                                     TemperatureReading(temp_c=temp_c, source='logger'))
        planted += 1
    return planted


async def _plant_expedition(station: str) -> int:
    from .database import get_db
    from .models import ExpeditionCreate
    from .routes.expeditions import create_expedition

    spec = EXPEDITIONS.get(station)
    if not spec:
        return 0
    # Crew are named from the station's own roster. An unnamed traverse cannot
    # be activated, so a demo expedition with no crew would present a dead end
    # rather than a plan.
    crew = [r['id'] for r in get_db().execute(
        'SELECT id FROM personnel WHERE station = ? ORDER BY id LIMIT ?',
        (station, spec['crew'])).fetchall()]
    await create_expedition(ExpeditionCreate(
        name=spec['name'], station=station,
        personnel_required=spec['personnel_required'],
        fuel_required_l=spec['fuel_required_l'],
        raw_request=spec['raw_request'], crew_ids=crew))
    return 1


async def _plant_past_incident(station: str) -> int:
    """Record that an incident happened here and was closed.

    Written directly rather than declared and stood down, because those are
    different operations: declaring fires the station-wide alarm on every open
    console, and an alarm for an emergency nobody declared and that was over
    before it rendered is the sort of noise an operator learns to ignore.
    """
    import uuid

    from .database import get_db
    from .geo import haversine_distance
    from .routes.incidents import _ensure_sop_tasks, compute_accountability
    from .timeutil import utc_now_iso

    spec = PAST_INCIDENTS.get(station)
    if not spec:
        return 0
    db = get_db()
    lat, lng = STATION_ORIGINS[station]
    radius = 2000.0
    expected, safe, unaccounted, _ = compute_accountability(db, lat, lng, radius)
    inc_id = 'inc-' + str(uuid.uuid4())[:8]
    db.execute(
        'INSERT INTO incidents (id, type, location_lat, location_lng, affected_radius_m, '
        'severity, status, expected_count, confirmed_safe_count, unaccounted_count, station, '
        'created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        (inc_id, spec['type'], lat, lng, radius, spec['severity'], 'resolved',
         expected, safe, unaccounted, station, utc_now_iso()))
    db.commit()
    # The response protocol is part of the record: an incident with no steps
    # against it reads as one nobody worked.
    _ensure_sop_tasks(db, inc_id, spec['type'])
    db.execute('UPDATE incident_tasks SET done = 1, done_at = ?, done_by = ? '
               'WHERE incident_id = ?', (utc_now_iso(), 'commander', inc_id))
    db.commit()

    await log_event('emergency',
                    f'Closed {spec["type"].replace("_", " ")} incident on record at {station} '
                    f'- {expected} in the zone, all accounted for',
                    'commander', inc_id,
                    {'type': spec['type'], 'severity': spec['severity'], 'demo': True},
                    station=station)
    return 1


async def load_demo_season() -> dict:
    """Plant a season across every station. Expects a freshly restored baseline.

    Returns what was created, so the console can report it rather than claiming
    success over a partial run.
    """
    from .conditions import set_delta_t

    created = {'shipments': 0, 'expeditions': 0, 'incidents': 0}
    for station in STATION_ORIGINS:
        created['shipments'] += await _plant_consignments(station)
        created['expeditions'] += await _plant_expedition(station)
        created['incidents'] += await _plant_past_incident(station)

    for station, delta_t in STANDING_DELTA_T.items():
        set_delta_t(station, delta_t)

    await log_event(
        'system',
        f'Demonstration season loaded - {created["shipments"]} consignment(s), '
        f'{created["expeditions"]} traverse(s) and {created["incidents"]} closed '
        f'incident(s) across all three stations. These records are synthetic.',
        'commander', None, {'demo': True, 'created': created})
    return created
