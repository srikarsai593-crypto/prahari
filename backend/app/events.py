import uuid, json
from datetime import datetime, timezone
from .database import get_db
from .ws_manager import manager

async def log_event(module: str, action: str, actor: str = 'system', related_id: str = None, metadata: dict = None) -> str:
    event_id = str(uuid.uuid4())
    db = get_db()
    meta_str = json.dumps(metadata) if metadata else None
    db.execute(
        'INSERT INTO events (id, module, action, actor, related_id, metadata) VALUES (?, ?, ?, ?, ?, ?)',
        (event_id, module, action, actor, related_id, meta_str)
    )
    db.commit()
    # Broadcast to all WebSocket clients
    await manager.broadcast({
        'type': 'event',
        'data': {
            'id': event_id,
            'module': module,
            'action': action,
            'actor': actor,
            'related_id': related_id,
            'metadata': metadata,
            'created_at': datetime.now(timezone.utc).isoformat()
        }
    })
    return event_id
