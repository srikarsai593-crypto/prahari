import uuid, json
from .database import get_db
from .ws_manager import manager
from .timeutil import utc_now_iso


async def log_event(module: str, action: str, actor: str = 'system',
                    related_id: str = None, metadata: dict = None,
                    station: str = None) -> str:
    """Append to the shared audit log and push it to every live client.

    The row's `seq` (autoincrement) is what orders the timeline — several events
    logged by a single user action share the same second, and sorting by
    created_at alone would show them in arbitrary order.

    `station` is the base the event belongs to. Leave it None only for events
    that genuinely concern every console (process-level or cross-station);
    anything a single station did must name it, or the Maitri timeline reports
    Bharati's activity as its own.
    """
    event_id = str(uuid.uuid4())
    created_at = utc_now_iso()
    db = get_db()
    meta_str = json.dumps(metadata) if metadata else None
    cursor = db.execute(
        'INSERT INTO events (id, module, action, actor, related_id, metadata, station, '
        'created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        (event_id, module, action, actor, related_id, meta_str, station, created_at)
    )
    db.commit()

    await manager.broadcast({
        'type': 'event',
        'data': {
            'seq': cursor.lastrowid,
            'id': event_id,
            'module': module,
            'action': action,
            'actor': actor,
            'related_id': related_id,
            'metadata': metadata,
            'station': station,
            'created_at': created_at,
        }
    })
    return event_id
