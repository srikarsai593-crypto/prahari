"""The shared audit log, and the hash chain that makes it tamper-evident.

Every module writes here and no module keeps its own trail. Two properties are
worth defending:

* **`seq` orders the timeline, not `created_at`.** One user action emits
  several events inside the same second, and second-resolution timestamps
  sorted alone put effects before causes.

* **Each row commits to the one before it.** `entry_hash` is a SHA-256 over
  this row's own fields *and* the previous row's hash, so altering or removing
  any historical row breaks every link after it. The console claims that every
  action is on the record; without a chain that claim rests on nobody having
  edited the database file, which is not a property anyone can check. With
  one, `GET /events/verify` can be run in front of a sceptic.

  This is tamper-*evident*, not tamper-proof: whoever can write the file can
  recompute the whole chain. It raises forgery from "UPDATE one row" to
  "rewrite every row since", and it makes casual or partial tampering
  detectable. Anchoring the head hash somewhere the station does not control
  is what would close the gap, and Prahari has no such channel.
"""

import hashlib
import json
import uuid

from .database import get_db
from .ws_manager import manager
from .timeutil import utc_now_iso

# The hash a chain's first row links to. A fixed, recognisable value, so
# "this is the start of the chain" and "the previous hash is missing" are
# different states rather than both being an empty string.
GENESIS_HASH = '0' * 64


def compute_entry_hash(prev_hash: str, *, event_id: str, module: str, action: str,
                       actor: str, related_id, metadata, station, created_at: str) -> str:
    """The digest a row commits to.

    Serialised as canonical JSON with sorted keys, so the same row always
    hashes the same way regardless of dict ordering. Everything an auditor
    would care about is inside: change any field and the digest moves.
    """
    payload = json.dumps({
        'prev': prev_hash,
        'id': event_id,
        'module': module,
        'action': action,
        'actor': actor,
        'related_id': related_id,
        'metadata': metadata,
        'station': station,
        'created_at': created_at,
    }, sort_keys=True, separators=(',', ':'), default=str)
    return hashlib.sha256(payload.encode('utf-8')).hexdigest()


def head_hash(db=None) -> str:
    """The digest of the newest row — what the next one will link to."""
    db = db or get_db()
    row = db.execute('SELECT entry_hash FROM events ORDER BY seq DESC LIMIT 1').fetchone()
    return (row['entry_hash'] if row and row['entry_hash'] else GENESIS_HASH)


def verify_chain(db=None, limit: int = None) -> dict:
    """Recompute every link and report the first row that does not match.

    Reads in `seq` order and stops at the first break: after one, every
    later link is invalid as a consequence, and a report listing all of them
    says less than one naming where the record stops being trustworthy.
    """
    db = db or get_db()
    query = 'SELECT * FROM events ORDER BY seq ASC'
    if limit:
        query += f' LIMIT {int(limit)}'
    rows = db.execute(query).fetchall()

    prev = GENESIS_HASH
    for row in rows:
        stored = row['entry_hash']
        if not stored:
            return {'ok': False, 'checked': len(rows), 'broken_at_seq': row['seq'],
                    'reason': 'This entry carries no hash, so nothing after it is anchored.'}
        try:
            metadata = json.loads(row['metadata']) if row['metadata'] else None
        except (TypeError, ValueError):
            metadata = row['metadata']
        expected = compute_entry_hash(
            prev, event_id=row['id'], module=row['module'], action=row['action'],
            actor=row['actor'], related_id=row['related_id'], metadata=metadata,
            station=row['station'], created_at=row['created_at'])
        if row['prev_hash'] != prev:
            return {'ok': False, 'checked': len(rows), 'broken_at_seq': row['seq'],
                    'reason': 'This entry does not link to the one before it — a row was '
                              'removed or inserted.'}
        if stored != expected:
            return {'ok': False, 'checked': len(rows), 'broken_at_seq': row['seq'],
                    'reason': 'This entry has been altered since it was written.'}
        prev = stored

    return {'ok': True, 'checked': len(rows), 'broken_at_seq': None,
            'head': prev, 'reason': None}


async def log_event(module: str, action: str, actor: str = 'system',
                    related_id: str = None, metadata: dict = None,
                    station: str = None) -> str:
    """Append to the shared audit log and push it to every live client.

    `station` is the base the event belongs to. Leave it None only for events
    that genuinely concern every console (process-level or cross-station);
    anything a single station did must name it, or the Maitri timeline reports
    Bharati's activity as its own.
    """
    event_id = str(uuid.uuid4())
    created_at = utc_now_iso()
    db = get_db()
    meta_str = json.dumps(metadata) if metadata else None

    prev_hash = head_hash(db)
    entry_hash = compute_entry_hash(
        prev_hash, event_id=event_id, module=module, action=action, actor=actor,
        related_id=related_id, metadata=metadata, station=station, created_at=created_at)

    cursor = db.execute(
        'INSERT INTO events (id, module, action, actor, related_id, metadata, station, '
        'created_at, prev_hash, entry_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        (event_id, module, action, actor, related_id, meta_str, station, created_at,
         prev_hash, entry_hash)
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
            'entry_hash': entry_hash,
        }
    })
    return event_id
