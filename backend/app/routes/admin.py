"""Station housekeeping — the two ways to put the console into a known state.

A console that is run repeatedly accumulates every expedition, consignment and
incident it has ever created, and nothing archives or clears them: after a few
walkthroughs the dashboard reports eight expeditions and four open incidents
that nobody declared this session. `/admin/reset` is the deliberate, confirmed
way back to the seeded baseline.

`/admin/demo-season` is the other direction. The baseline has crew, stock and
geofences but nothing in flight, so Cargo and Emergency open empty — which
reads as a backend that is down rather than as a quiet day. It restores the
baseline and then plants a season on top, which is why both share
`restore_baseline` rather than each keeping their own copy of it.
"""

from fastapi import APIRouter, Depends

from ..database import get_db
from ..models import ResetRequest, DemoSeasonRequest
from ..events import log_event
from ..ws_manager import manager
from ..ratelimit import guard_write
from ..auth import require_key, require_reader
from ..seed import seed_data, PERSONNEL, STATION_ORIGINS
from ..conditions import set_delta_t
from .. import incident_lifecycle as lifecycle
from ..demo import load_demo_season

# Reads are gated at the router, so a route added later inherits the gate
# instead of quietly shipping open. PRAHARI_PUBLIC_READS opens them again.
router = APIRouter(prefix='/admin', tags=['admin'],
                   dependencies=[Depends(require_reader)])

# Operational state — everything an exercise creates. The reference tables
# (personnel, inventory, geofences, emergency assets) are re-seeded rather than
# dropped, so a reset restores the baseline instead of emptying the console.
OPERATIONAL_TABLES = ('movement_plans', 'incidents', 'shipments', 'expeditions',
                      'purchase_orders')


@router.get('/counts')
def operational_counts():
    """What a reset would clear. Shown in the UI before the operator confirms."""
    db = get_db()
    counts = {t: db.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0]
              for t in OPERATIONAL_TABLES}
    counts['events'] = db.execute('SELECT COUNT(*) FROM events').fetchone()[0]
    placeholders = ','.join('?' * len(lifecycle.ACTIVE_STATUSES_SQL))
    counts['open_incidents'] = db.execute(
        f'SELECT COUNT(*) FROM incidents WHERE status IN ({placeholders})',
        lifecycle.ACTIVE_STATUSES_SQL).fetchone()[0]
    return counts


def restore_baseline(db, *, clear_events: bool = False) -> None:
    """Drop every operational record and put the reference tables back as seeded.

    Shared by the reset endpoint and by the demo season, which has to start
    from a known state or a second click would double every consignment.
    """
    for table in OPERATIONAL_TABLES:
        db.execute(f'DELETE FROM {table}')
    # Response-protocol rows belong to incidents that no longer exist. SQLite
    # is not enforcing a foreign key here, so they would otherwise accumulate
    # across every exercise and never be reachable again.
    db.execute('DELETE FROM incident_tasks')

    # Crew go back to base, unassigned, at their seeded positions. The seed
    # uses INSERT OR IGNORE, so it will not touch rows that already exist —
    # their coordinates have to be written back here.
    db.execute("UPDATE personnel SET status = 'at_station', expedition_id = NULL, "
               'simulation_step = 0, last_update_at = NULL')
    for pid, _name, _role, station, dlat, dlng in PERSONNEL:
        origin_lat, origin_lng = STATION_ORIGINS[station]
        db.execute('UPDATE personnel SET current_lat = ?, current_lng = ? WHERE id = ?',
                   (origin_lat + dlat, origin_lng + dlng, pid))
    # Stock is rebuilt from seed, not adjusted, so quantities match the baseline.
    db.execute('DELETE FROM inventory_items')
    # Clearing the status without clearing the commitment leaves an asset
    # pinned to a deleted incident, and the dispatch route then refuses to task
    # it for ever with "already committed to inc-xxxx".
    db.execute("UPDATE emergency_assets SET status = 'available', "
               'assigned_incident_id = NULL')

    if clear_events:
        db.execute('DELETE FROM events')
    db.commit()

    seed_data()
    for station in STATION_ORIGINS:
        set_delta_t(station, 0)


@router.post('/reset', dependencies=[Depends(require_key), Depends(guard_write)])
async def reset_station(body: ResetRequest):
    """Clear operational records and restore the seeded baseline.

    `scope='operational'` keeps the audit log, so the reset itself and what came
    before it stay on the record. `scope='all'` also truncates the events table,
    for a genuinely clean run.
    """
    db = get_db()
    before = operational_counts()
    restore_baseline(db, clear_events=body.scope == 'all')

    await log_event('system', f'Station reset to seeded baseline ({body.scope}) - cleared '
                    f'{before["expeditions"]} expedition(s), {before["shipments"]} '
                    f'consignment(s), {before["incidents"]} incident(s) and '
                    f'{before["movement_plans"]} movement plan(s)',
                    'commander', None, {'cleared': before, 'scope': body.scope})
    await manager.broadcast({'type': 'station_reset', 'data': {'scope': body.scope,
                                                               'cleared': before}})
    return {'status': 'reset', 'scope': body.scope, 'cleared': before,
            'now': operational_counts()}


@router.post('/demo-season', dependencies=[Depends(require_key), Depends(guard_write)])
async def demo_season(body: DemoSeasonRequest = DemoSeasonRequest()):
    """Put a mid-season operational picture on all three stations.

    A console booted from the seed alone has crew, stock and geofences but no
    consignments, traverses or incidents - so Cargo and Emergency render empty,
    which reads as an outage rather than as a quiet day. This plants a season
    that every module has something to say about.
    """
    db = get_db()
    restore_baseline(db, clear_events=body.clear_events)
    created = await load_demo_season()
    return {'status': 'loaded', 'created': created, 'now': operational_counts()}
