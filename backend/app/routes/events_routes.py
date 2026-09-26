from fastapi import APIRouter, Depends, Query
from typing import Optional
from ..database import get_db
from ..events import log_event
from ..auth import require_key
from ..models import Station, SyncReportRequest
from ..timeutil import to_utc_iso
import json

router = APIRouter(prefix='/events', tags=['events'])


@router.get('')
def list_events(module: str = None,
                station: Optional[Station] = None,
                limit: int = Query(100, ge=1, le=500),
                offset: int = Query(0, ge=0)):
    """This IS the shared events table — the single source of truth for ALL modules.
    The Emergency module's 'timeline' view is simply this endpoint.
    Do not build a second logging table.

    Ordered by `seq`, not `created_at`: created_at has second resolution, so a
    single user action produces several rows with identical timestamps.

    `station` returns that base's events plus the station-agnostic ones (rows
    with a NULL station — process-level and cross-station entries). Filtering on
    equality alone would hide every system event from every console.
    """
    db = get_db()
    clauses = []
    params: list = []
    if module:
        clauses.append('module = ?')
        params.append(module)
    if station:
        clauses.append('(station = ? OR station IS NULL)')
        params.append(station)
    query = 'SELECT * FROM events'
    if clauses:
        query += ' WHERE ' + ' AND '.join(clauses)
    query += ' ORDER BY seq DESC LIMIT ? OFFSET ?'
    params.extend([limit, offset])
    rows = db.execute(query, params).fetchall()

    result = []
    for r in rows:
        d = dict(r)
        d['created_at'] = to_utc_iso(d.get('created_at'))
        if d.get('metadata'):
            try:
                d['metadata'] = json.loads(d['metadata'])
            except (TypeError, ValueError):
                pass
        result.append(d)
    return result

# There is deliberately no general-purpose POST here. The audit log is written
# by the modules that own each action, never by the browser: a client-writable
# trail with a free-form module, actor and message can be forged or flooded, and
# every other module is judged against it.
#
# The one thing only the browser knows is whether its offline queue replayed,
# so that gets a narrow endpoint with a fixed shape instead.


@router.post('/sync-report', dependencies=[Depends(require_key)])
async def report_queue_sync(body: SyncReportRequest):
    """Record that a console drained its offline queue.

    The caller supplies counts, not prose: the event text is composed here, so
    the trail cannot be made to say something that did not happen.
    """
    parts = [f'{body.flushed} queued change{"" if body.flushed == 1 else "s"} synced']
    if body.dropped:
        parts.append(f'{body.dropped} rejected by the station')
    if body.pending:
        parts.append(f'{body.pending} still pending')
    event_id = await log_event(
        module='system',
        action=f'Console reconnected - {", ".join(parts)}',
        actor='offline_queue',
        metadata={'flushed': body.flushed, 'dropped': body.dropped, 'pending': body.pending},
        station=body.station,
    )
    return {'id': event_id}
