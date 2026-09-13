from fastapi import APIRouter
from ..database import get_db
from ..events import log_event
import json

router = APIRouter(prefix='/events', tags=['events'])

@router.get('')
def list_events(module: str = None, limit: int = 100):
    """This IS the shared events table — the single source of truth for ALL modules.
    The Emergency module's 'timeline' view is simply this endpoint.
    Do not build a second logging table."""
    db = get_db()
    query = 'SELECT * FROM events'
    params = []
    if module:
        query += ' WHERE module = ?'
        params.append(module)
    query += ' ORDER BY created_at DESC LIMIT ?'
    params.append(limit)
    rows = db.execute(query, params).fetchall()
    result = []
    for r in rows:
        d = dict(r)
        if d.get('metadata'):
            try:
                d['metadata'] = json.loads(d['metadata'])
            except:
                pass
        result.append(d)
    return result

@router.post('')
async def create_event(body: dict):
    event_id = await log_event(
        module=body.get('module', 'system'),
        action=body.get('action', 'Unknown action'),
        actor=body.get('actor', 'system'),
        related_id=body.get('related_id'),
        metadata=body.get('metadata')
    )
    return {'id': event_id}
