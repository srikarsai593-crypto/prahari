"""Sign-in, sign-out and "who am I".

The console exchanges the commander key for a session cookie once, here, so the
key never has to live in the browser bundle. The cookie is httpOnly — script on
the page cannot read it, which is the whole point — and SameSite=Lax, so it is
not sent on a cross-site form post.
"""

import logging
import os

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status

from ..auth import (COMMANDER, DEMO_KEY, OBSERVER, SESSION_COOKIE, SESSION_TTL_SECONDS,
                    WS_TICKET_TTL_SECONDS, get_expected_key, identify, issue_session,
                    issue_ws_ticket, observer_enabled, reads_are_public, require_identity)
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
        'role': identity.get('role') if identity else None,
        'via': identity.get('via') if identity else None,
        # What this caller may actually do. The console reads this rather than
        # inferring it from the role name, so adding a role later does not
        # mean hunting for every place the browser guessed at permissions.
        'can_write': bool(identity) and identity.get('role') != OBSERVER,
        'public_reads': reads_are_public(),
        # Whether this station will hand out a read-only session without the
        # key, so the sign-in screen knows whether to offer the button.
        'observer_enabled': observer_enabled(),
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


@router.post('/observer')
async def enter_as_observer(request: Request, response: Response):
    """Take a read-only session without the commander key.

    Someone handed the link — an evaluator, a visiting scientist, anyone who
    should see the station without being able to change it — otherwise meets
    a key prompt and a console that is, correctly, refusing to show them
    anything. This is the middle ground: a real, expiring, named session that
    can read everything and write nothing, and that the audit log can
    attribute.

    Off unless PRAHARI_ALLOW_OBSERVER is set, because the roster carries live
    positions for people in the field and whether that is shareable is a
    decision for whoever runs the station, not a default.
    """
    if not observer_enabled():
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail='This station does not offer observer access. Sign in with the '
                   'commander key, or set PRAHARI_ALLOW_OBSERVER=true on the backend '
                   'to open a read-only view.')

    token, expires_at = issue_session(actor=OBSERVER, role=OBSERVER)
    _set_session_cookie(request, response, token)
    await log_event('system', 'Observer opened a read-only view of the station console',
                    OBSERVER)
    return {'authenticated': True, 'actor': OBSERVER, 'role': OBSERVER,
            'can_write': False, 'expires_at': expires_at}


@router.post('/ws-ticket', dependencies=[Depends(require_identity)])
def mint_ws_ticket(request: Request):
    """A short-lived credential for opening the telemetry socket.

    The console talks to this backend through the frontend's own origin, so
    its session cookie belongs to that host. The socket cannot take the same
    route — a platform rewrite does not carry a WebSocket upgrade — so it is
    opened against this origin directly, where that cookie is never sent.
    Every handshake was therefore rejected and the console permanently
    reported a link that was, from where it stood, down.

    This endpoint is reached over the proxied path like every other read, so
    the cookie does arrive here. It exchanges it for a ticket the socket can
    carry in its query string, which is the only place a browser can put a
    credential on a WebSocket handshake.

    Read-only callers get one too. An observer is entitled to the same
    telemetry they can already read over HTTP, and the ticket carries their
    role rather than upgrading it.
    """
    identity = identify(request) or {}
    ticket, expires_at = issue_ws_ticket(identity)
    return {'ticket': ticket, 'expires_at': expires_at,
            'expires_in': WS_TICKET_TTL_SECONDS}


@router.post('/logout', dependencies=[Depends(require_identity)])
async def logout(request: Request, response: Response):
    """Any signed-in caller can sign out.

    Gated on identity rather than on write access: an observer who could not
    end their own session would be stuck in a read-only console with no way
    back to the sign-in screen.
    """
    identity = identify(request) or {}
    actor = identity.get('sub') or COMMANDER
    response.delete_cookie(SESSION_COOKIE, path='/')
    await log_event('system', f'{actor.capitalize()} signed out of the station console',
                    actor)
    return {'authenticated': False}
