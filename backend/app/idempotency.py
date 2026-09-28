"""Replay protection for writes that arrive twice.

The offline queue replays a mutation when the link returns. The case it cannot
distinguish on its own is the write the station *did* receive and act on,
whose response never made it back: the socket dropped after the row was
written. The console sees a network error, keeps the entry, and replays it —
and the station issues the stock twice, or declares a second incident for the
same emergency.

An `Idempotency-Key` header makes the retry safe. The first request to carry a
given key has its status and body recorded against it; a later request with
the same key is answered from that record without touching the database again.
The client keeps one key per queued entry for the life of that entry, so a
replay is recognisable as the same intent rather than as a new one.

Deliberately scoped:

* **Only mutating methods, and only with a key.** A caller that does not send
  one gets the old behaviour. Nothing is inferred from the body, because two
  genuinely separate identical actions — issuing 10 litres twice — must both
  land.
* **Only successful responses are recorded.** Replaying a 500 back at a client
  would make a transient station failure permanent for that entry.
* **The key is scoped to the method and path**, so the same key arriving at a
  different endpoint is a client bug rather than a cache hit.
* **Sign-in is excluded.** Only the status and body are recorded, not the
  response headers — replaying a login would therefore answer
  `{"authenticated": true}` with no `Set-Cookie`, leaving the console
  convinced it had signed in and holding no session. Nothing sends a key to
  `/auth` today, because only the offline queue sends keys and sign-in is
  never queued; this is here so that stays true if that changes.
"""

import json
import time

from .database import get_db

# Long enough to cover a station that is offline for days and replays on
# reconnect; short enough that the table does not grow without bound.
RETENTION_SECONDS = 14 * 24 * 3600

MUTATING_METHODS = frozenset({'POST', 'PUT', 'PATCH', 'DELETE'})

# Paths whose response is more than its body. See the note above.
EXCLUDED_PREFIXES = ('/auth',)
HEADER = 'idempotency-key'
# A key is an opaque client token. Cap it so a hostile client cannot use the
# table as storage.
MAX_KEY_LENGTH = 200


def lookup(db, key: str, method: str, path: str) -> dict | None:
    """The recorded response for this key, or None if it is the first time."""
    row = db.execute(
        'SELECT status_code, body, method, path FROM idempotency_keys WHERE key = ?',
        (key,)).fetchone()
    if row is None:
        return None
    if row['method'] != method or row['path'] != path:
        # The same key against a different endpoint is a client bug, not a
        # replay. Saying so beats silently answering with someone else's body.
        return {'conflict': True, 'method': row['method'], 'path': row['path']}
    return {'conflict': False, 'status_code': row['status_code'], 'body': row['body']}


def record(db, key: str, method: str, path: str, status_code: int, body: bytes) -> None:
    db.execute(
        'INSERT OR REPLACE INTO idempotency_keys '
        '(key, method, path, status_code, body, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        (key, method, path, status_code, body.decode('utf-8', 'replace'), time.time()))
    db.commit()


def prune(db, *, now: float = None) -> int:
    """Drop keys past their retention. Called opportunistically on write, so
    there is no scheduler on a station that may be offline for days."""
    cutoff = (now or time.time()) - RETENTION_SECONDS
    cursor = db.execute('DELETE FROM idempotency_keys WHERE created_at < ?', (cutoff,))
    db.commit()
    return cursor.rowcount


async def replay_guard(request, call_next):
    """HTTP middleware. See the module docstring for what it does and does not do."""
    from starlette.responses import Response

    key = (request.headers.get(HEADER) or '').strip()
    if (request.method not in MUTATING_METHODS
            or not key
            or request.url.path.startswith(EXCLUDED_PREFIXES)):
        return await call_next(request)
    if len(key) > MAX_KEY_LENGTH:
        return Response(
            content=json.dumps({'detail': f'Idempotency-Key must be at most '
                                          f'{MAX_KEY_LENGTH} characters.'}),
            status_code=400, media_type='application/json')

    db = get_db()
    path = request.url.path
    seen = lookup(db, key, request.method, path)
    if seen and seen['conflict']:
        return Response(
            content=json.dumps({
                'detail': f'This Idempotency-Key was already used for '
                          f'{seen["method"]} {seen["path"]}. Use a new key for a '
                          f'different request.'}),
            status_code=409, media_type='application/json')
    if seen:
        return Response(content=seen['body'], status_code=seen['status_code'],
                        media_type='application/json',
                        headers={'Idempotent-Replay': 'true'})

    response = await call_next(request)

    # Buffer the body so it can be both recorded and returned. Streaming
    # responses would otherwise be consumed by reading them.
    chunks = [chunk async for chunk in response.body_iterator]
    body = b''.join(chunks)

    if 200 <= response.status_code < 300:
        record(db, key, request.method, path, response.status_code, body)
        prune(db)

    return Response(content=body, status_code=response.status_code,
                    headers=dict(response.headers), media_type=response.media_type)
