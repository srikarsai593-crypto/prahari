"""Sign-in, sign-out and "who am I".

The console exchanges the commander key for a session cookie once, here, so the
key never has to live in the browser bundle. The cookie is httpOnly — script on
the page cannot read it, which is the whole point — and SameSite=Lax, so it is
not sent on a cross-site form post.
"""

import logging
import os

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status

from ..auth import (DEMO_KEY, SESSION_COOKIE, SESSION_TTL_SECONDS, get_expected_key,
                    identify, issue_session, reads_are_public, require_commander)
from ..events import log_event
from ..models import LoginRequest
from ..ratelimit import guard_login, login_attempts
from ..timeutil import utc_now_iso

logger = logging.getLogger('prahari.auth')
router = APIRouter(prefix='/auth', tags=['auth'])


def _is_https(request: Request) -> bool:
    """Whether *this* request arrived over TLS.

    Decided per request rather than per deployment. A Secure cookie is simply
    not stored by the browser over plain HTTP, so a fixed `secure=True` would
    silently break every local console — sign-in would appear to succeed and
    the next request would be anonymous. Behind Render/Vercel the socket is
    plain HTTP and the proxy records the real scheme in a header.
    """
    if os.getenv('PRAHARI_INSECURE_COOKIES', 'false').lower() in {'1', 'true', 'yes'}:
        return False
    forwarded = request.headers.get('x-forwarded-proto', '').split(',')[0].strip().lower()
    return (forwarded or request.url.scheme) == 'https'


def _set_session_cookie(request: Request, response: Response, token: str) -> None:
    response.set_cookie(
        SESSION_COOKIE, token,
        max_age=SESSION_TTL_SECONDS,
        httponly=True,                  # script on the page cannot read it
        secure=_is_https(request),
        samesite='lax',
        path='/',
    )


@router.get('/session')
def read_session_state(request: Request):
    """Whether this caller is signed in. Deliberately open — the console has to
    be able to ask before it has a session, and the answer is about the caller,
    not about the station."""
    identity = identify(request)
    return {
        'authenticated': identity is not None,
        'actor': identity.get('sub') if identity else None,
        'via': identity.get('via') if identity else None,
        'public_reads': reads_are_public(),
        # So the sign-in screen can offer the demo key rather than making
        # someone go and find it. Sent only when it is genuinely the active
        # key, in which case it is public by definition - it is printed in the
        # README. The value comes from here rather than being hardcoded in the
        # console so that no credential-shaped literal ships in the bundle at
        # all, whatever this station is configured with.
        'demo_key_enabled': get_expected_key() == DEMO_KEY,
        'demo_key': DEMO_KEY if get_expected_key() == DEMO_KEY else None,
        'server_time': utc_now_iso(),
    }


@router.post('/login')
async def login(request: Request, response: Response, body: LoginRequest):
    """Exchange the commander key for a session."""
    client = guard_login(request)

    expected = get_expected_key()
    if expected is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail='This station backend has no commander key configured, so nobody can '
                   'sign in. Set PRAHARI_API_KEY and restart it.')

    import hmac
    if not hmac.compare_digest(body.key.strip(), expected):
        # Only failures are counted, so an operator who signs in successfully
        # is never locked out by their own traffic.
        login_attempts.record(client)
        logger.warning('Rejected sign-in from %s', client)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail='That is not the commander key for this station.')

    login_attempts.forget(client)
    token, expires_at = issue_session()
    _set_session_cookie(request, response, token)
    await log_event('system', 'Commander signed in to the station console', 'commander')
    return {'authenticated': True, 'actor': 'commander', 'expires_at': expires_at}


@router.post('/logout', dependencies=[Depends(require_commander)])
async def logout(response: Response):
    response.delete_cookie(SESSION_COOKIE, path='/')
    await log_event('system', 'Commander signed out of the station console', 'commander')
    return {'authenticated': False}
