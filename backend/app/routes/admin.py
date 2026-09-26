"""Station housekeeping.

A demo console that is run repeatedly accumulates every expedition, consignment
and incident it has ever created, and nothing archives or clears them — after a
few walkthroughs the dashboard reports eight expeditions and four open incidents
that nobody declared this session. This gives the operator one deliberate,
confirmed way to put the station back to its seeded baseline.
"""

from fastapi import APIRouter, Depends

from ..database import get_db
from ..models import ResetRequest
from ..events import log_event
from ..ws_manager import manager
from ..auth import require_key
from ..seed import seed_data, PERSONNEL, STATION_ORIGINS
from ..conditions import set_delta_t

router = APIRouter(prefix='/admin', tags=['admin'])

# Operational state — everything an exercise creates. The reference tables
# (personnel, inventory, geofences, emergency assets) are re-seeded rather than
# dropped, so a reset restores the baseline instead of emptying the console.
OPERATIONAL_TABLES = ('movement_plans', 'incidents', 'shipments', 'expeditions')


@router.get('/counts')
def operational_counts():
    """What a reset would clear. Shown in the UI before the operator confirms."""
    db = get_db()
    counts = {t: db.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0]
              for t in OPERATIONAL_TABLES}
    counts['events'] = db.execute('SELECT COUNT(*) FROM events').fetchone()[0]
    counts['open_incidents'] = db.execute(
        "SELECT COUNT(*) FROM incidents WHERE status = 'open'").fetchone()[0]
    return counts


@router.post('/reset', dependencies=[Depends(require_key)])
async def reset_station(body: ResetRequest):
    """Clear operational records and restore the seeded baseline.

    `scope='operational'` keeps the audit log, so the reset itself and what came
    before it stay on the record. `scope='all'` also truncates the events table,
    for a genuinely clean demo run.
    """
    db = get_db()
    before = operational_counts()

    for table in OPERATIONAL_TABLES:
        db.execute(f'DELETE FROM {table}')

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
    db.execute("UPDATE emergency_assets SET status = 'available'")

    if body.scope == 'all':
        db.execute('DELETE FROM events')
    db.commit()

    seed_data()
    for station in STATION_ORIGINS:
        set_delta_t(station, 0)

    await log_event('system', f'Station reset to seeded baseline ({body.scope}) - cleared '
                    f'{before["expeditions"]} expedition(s), {before["shipments"]} '
                    f'consignment(s), {before["incidents"]} incident(s) and '
                    f'{before["movement_plans"]} movement plan(s)',
                    'commander', None, {'cleared': before, 'scope': body.scope})
    await manager.broadcast({'type': 'station_reset', 'data': {'scope': body.scope,
                                                               'cleared': before}})
    return {'status': 'reset', 'scope': body.scope, 'cleared': before,
            'now': operational_counts()}
