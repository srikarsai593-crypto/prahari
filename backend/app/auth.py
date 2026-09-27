"""Authentication for the station console.

Two ways to prove you are the commander, for two different callers:

* **A session cookie**, which the browser console uses. The operator exchanges
  the commander key for it once at `POST /auth/login`, and the key itself never
  goes into the JavaScript bundle. Previously it shipped as
  `NEXT_PUBLIC_COMMANDER_KEY`, which meant anyone who opened devtools on the
  hosted console could read the credential that authorises every write.

* **The `X-Commander-Key` header**, which scripts, the barcode scanner and the
  test suite use. Unchanged, because a machine caller has nowhere to keep a
  cookie and no login screen to fill in.

Reads are gated by default. The roster carries live GPS positions for every
person on the ice, and serving that to anyone who knows the URL is not a
defensible default for a hosted deployment. `PRAHARI_PUBLIC_READS=true` opens
them again for a kiosk or a public demo.

The session token is signed with HMAC over a server secret, so the server keeps
no session table and a restart does not log everybody out. When no explicit
secret is configured the secret is derived from the commander key, which gives
the useful property that rotating the key invalidates every live session.
"""

import base64
import hashlib
import hmac
import json
import os
import time

from fastapi import HTTPException, Request, status
from fastapi.security import APIKeyHeader

_API_KEY_HEADER = APIKeyHeader(name='X-Commander-Key', auto_error=False)
DEMO_KEY = 'prahari-demo-2024'

SESSION_COOKIE = 'prahari_session'
SESSION_TTL_SECONDS = int(os.getenv('PRAHARI_SESSION_TTL_SECONDS', str(12 * 3600)))

# PRAHARI_API_KEY is the documented name. PRAHARI_COMMANDER_KEY is accepted
# because the Render blueprint set that one, and a key that is configured but
# read under a different name is worse than no key at all: the deployment looks
# secured while every write is in fact still accepting the public demo key.
_KEY_ENV_NAMES = ('PRAHARI_API_KEY', 'PRAHARI_COMMANDER_KEY')


def get_expected_key() -> str | None:
    for name in _KEY_ENV_NAMES:
        configured = (os.getenv(name) or '').strip()
        if configured:
            return configured
    allow_demo = os.getenv('PRAHARI_ALLOW_DEMO_KEY', 'true').lower() in {'1', 'true', 'yes'}
    return DEMO_KEY if allow_demo else None


def reads_are_public() -> bool:
    return os.getenv('PRAHARI_PUBLIC_READS', 'false').lower() in {'1', 'true', 'yes'}


def _session_secret() -> bytes:
    """Deriving from the commander key when no secret is set is deliberate:
    rotating the key then invalidates every issued session, which is what an
    operator expects rotation to mean."""
    explicit = (os.getenv('PRAHARI_SESSION_SECRET') or '').strip()
    if explicit:
        return explicit.encode()
    return hashlib.sha256(f'prahari-session::{get_expected_key()}'.encode()).digest()


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip('=')


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))


def issue_session(actor: str = 'commander', ttl: int = None) -> tuple[str, int]:
    """Return (token, expiry epoch seconds)."""
    expires_at = int(time.time()) + (ttl or SESSION_TTL_SECONDS)
    payload = _b64(json.dumps({'sub': actor, 'exp': expires_at},
                              separators=(',', ':'), sort_keys=True).encode())
    signature = _b64(hmac.new(_session_secret(), payload.encode(), hashlib.sha256).digest())
    return f'{payload}.{signature}', expires_at


def read_session(token: str | None) -> dict | None:
    """The claims in a token this server issued and that has not expired."""
    if not token or token.count('.') != 1:
        return None
    payload, signature = token.split('.')
    expected = _b64(hmac.new(_session_secret(), payload.encode(), hashlib.sha256).digest())
    # Constant time: a fast reject on the first wrong byte leaks the signature
    # one byte at a time to anyone willing to measure.
    if not hmac.compare_digest(signature, expected):
        return None
    try:
        claims = json.loads(_unb64(payload))
    except (ValueError, TypeError):
        return None
    if not isinstance(claims, dict) or claims.get('exp', 0) < time.time():
        return None
    return claims


def _bearer(request: Request) -> str | None:
    header = request.headers.get('authorization', '')
    return header[7:].strip() if header.lower().startswith('bearer ') else None


def identify(request: Request) -> dict | None:
    """Who is calling, by whichever credential they presented."""
    expected_key = get_expected_key()
    if expected_key is None:
        return None

    presented = request.headers.get('X-Commander-Key')
    if presented and hmac.compare_digest(presented, expected_key):
        return {'sub': 'commander', 'via': 'api_key'}

    for token in (request.cookies.get(SESSION_COOKIE), _bearer(request)):
        claims = read_session(token)
        if claims:
            return {**claims, 'via': 'session'}
    return None


def _no_key_configured() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail='This station backend has no commander key configured, so it is refusing '
               'every write. Set PRAHARI_API_KEY in backend/.env (or '
               'PRAHARI_ALLOW_DEMO_KEY=true for a local demo) and restart it.',
    )


async def require_commander(request: Request) -> dict:
    """Dependency for every write. Accepts a session cookie or the API key."""
    if get_expected_key() is None:
        raise _no_key_configured()

    identity = identify(request)
    if identity is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail='Station write rejected: sign in with the commander key, or send it as '
                   'X-Commander-Key. If you were signed in, the session has expired or the '
                   'station key was rotated. Reads are unaffected.',
            headers={'WWW-Authenticate': 'Cookie'},
        )
    return identity


async def require_reader(request: Request) -> dict | None:
    """Dependency for reads. Open when PRAHARI_PUBLIC_READS is set."""
    if reads_are_public():
        return identify(request)

    if get_expected_key() is None:
        raise _no_key_configured()

    identity = identify(request)
    if identity is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail='This station console requires sign-in. The roster carries live positions '
                   'for people in the field, so it is not served anonymously. Set '
                   'PRAHARI_PUBLIC_READS=true to open reads for a kiosk or public demo.',
            headers={'WWW-Authenticate': 'Cookie'},
        )
    return identity


# Kept so existing call sites and any external scripts keep working.
require_key = require_commander
