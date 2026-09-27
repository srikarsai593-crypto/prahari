from pathlib import Path

try:
    from dotenv import load_dotenv
    _env_file = Path(__file__).resolve().parent.parent / '.env'
    if _env_file.exists():
        load_dotenv(dotenv_path=_env_file)
except ImportError:  # pragma: no cover - python-dotenv is a hard requirement
    pass

import logging
import os
import re
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from .database import init_db
from .seed import seed_data
from .ws_manager import manager
from .auth import DEMO_KEY, SESSION_COOKIE, get_expected_key, identify, reads_are_public
from .llm import GEMINI_MODEL, get_gemini_api_key
from .routes import (expeditions, shipments, inventory, personnel, incidents,
                     events_routes, geofences, admin, auth_routes)

logging.basicConfig(level=os.getenv('PRAHARI_LOG_LEVEL', 'INFO'),
                    format='%(asctime)s %(levelname)-8s %(name)s: %(message)s')
logger = logging.getLogger('prahari')


def _cors_origins() -> list[str]:
    """Allowed browser origins.

    Hard-coding localhost meant the app could not be served from the station LAN
    address that field tablets actually use.
    """
    raw = os.getenv('PRAHARI_CORS_ORIGINS', 'http://localhost:3000,http://127.0.0.1:3000')
    return [o.strip() for o in raw.split(',') if o.strip()]


def _project_origin_regex(project: str) -> str:
    """Vercel URLs for one project, and only that project.

    Production is `https://<project>.vercel.app`; previews append a build or
    branch suffix. Anchored at both ends and with the slug escaped, so a
    project called `prahari` does not also admit `prahari-evil-clone`... which
    it would, were the suffix group not itself constrained to Vercel's own
    `-<hash>-<team>` shape.
    """
    return rf'^https://{re.escape(project)}(-[a-z0-9]+)*\.vercel\.app$'


def _cors_origin_regex() -> str | None:
    """Origin pattern for hosted consoles, or None to allow no pattern at all.

    Precedence: an explicit regex, else a project-scoped one, else nothing.
    "Nothing" is the default because the alternative was a pattern that
    admitted every deployment on vercel.app, including other people's.
    """
    explicit = (os.getenv('PRAHARI_CORS_ORIGIN_REGEX') or '').strip()
    if explicit:
        return explicit
    project = (os.getenv('PRAHARI_CORS_PROJECT') or '').strip()
    return _project_origin_regex(project) if project else None


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    seed_data()

    # Fail loudly at boot rather than 503-ing on the first write.
    if get_expected_key() is None:
        raise RuntimeError(
            'No commander key configured. Set PRAHARI_API_KEY in backend/.env '
            '(or PRAHARI_ALLOW_DEMO_KEY=true for a throwaway local demo).'
        )

    # State the real AI posture at boot so nobody demos believing Gemini is live.
    if get_gemini_api_key():
        logger.info('LLM chain: Gemini (%s) -> Ollama -> regex fallback', GEMINI_MODEL)
    else:
        logger.warning('LLM chain: no GEMINI_API_KEY set - Ollama -> regex fallback only')

    # Two deployment postures that are fine locally and are not fine on the
    # public internet. Both are stated at boot rather than left to be
    # discovered, because neither one announces itself at runtime.
    if get_expected_key() == DEMO_KEY:
        logger.warning(
            'Running on the PUBLIC demo commander key. Anyone who knows it can write to '
            'this station. Set PRAHARI_API_KEY and PRAHARI_ALLOW_DEMO_KEY=false before '
            'exposing this backend beyond a trusted LAN.')
    origins, pattern = _cors_origins(), _cors_origin_regex()
    if pattern and '.*' in pattern:
        logger.warning(
            'CORS pattern %s is broad enough to admit origins that are not yours. Prefer '
            'PRAHARI_CORS_PROJECT=<your-vercel-project> or an exact PRAHARI_CORS_ORIGINS '
            'list.', pattern)
    elif not pattern and all('localhost' in o or '127.0.0.1' in o for o in origins):
        logger.warning(
            'CORS is allowing only local origins (%s). A hosted console will be refused by '
            'the browser until PRAHARI_CORS_ORIGINS names it, or PRAHARI_CORS_PROJECT names '
            'the Vercel project it is deployed as.', ', '.join(origins))
    if reads_are_public():
        logger.warning(
            'PRAHARI_PUBLIC_READS is set: the roster, with live positions for everyone in '
            'the field, is being served to anyone who knows the URL.')

    logger.info('Prahari backend started - database initialised and seeded.')
    yield
    logger.info('Prahari backend shutting down.')


app = FastAPI(
    title='Prahari - Antarctic Operations Intelligence',
    version='1.1.0',
    description='Antarctic Logistics & Safety Intelligence Platform - Team 36 OURS | SIH26062',
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins(),
    allow_origin_regex=_cors_origin_regex(),
    allow_credentials=True,
    # Explicit, not '*'. A wildcard here is not honoured by browsers once
    # credentials are in play, and it invites any header a caller cares to
    # invent; these two are the only ones the console actually sends.
    allow_methods=['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allow_headers=['Content-Type', 'X-Commander-Key'],
)

# Headers the API can set for itself. The console's own headers are set by
# Next (next.config.ts); these cover direct API calls and the docs page, which
# the browser will happily render as a document.
_SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=()',
}


@app.middleware('http')
async def security_headers(request, call_next):
    response = await call_next(request)
    for header, value in _SECURITY_HEADERS.items():
        response.headers.setdefault(header, value)
    # An authenticated station response must never be held in a shared cache:
    # the next operator on the same proxy would be served the last one's data.
    if request.url.path.startswith('/auth') or identify(request) is not None:
        response.headers.setdefault('Cache-Control', 'no-store, private')
    return response


for router in (auth_routes, expeditions, shipments, inventory, personnel, incidents,
               events_routes, geofences, admin):
    app.include_router(router.router)


@app.websocket('/ws')
async def websocket_endpoint(websocket: WebSocket):
    # The socket carries the same operational data as the REST reads - GPS
    # fixes, accountability counts, stock alerts - so it is gated the same way.
    # Closing before accept() is deliberate: an unauthenticated client gets a
    # handshake failure rather than an open socket that silently says nothing.
    if not reads_are_public() and identify(websocket) is None:
        await websocket.close(code=1008, reason='Sign in to receive station telemetry')
        return
    await manager.connect(websocket)
    try:
        while True:
            # Prahari's WS channel is server -> client only. Reading keeps the
            # connection alive and surfaces the disconnect promptly.
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await manager.disconnect(websocket)


@app.get('/')
def root():
    return {'name': 'Prahari', 'team': '36 OURS', 'version': '1.1.0', 'status': 'operational'}


@app.get('/health')
def health():
    """Liveness plus the two facts an operator needs before trusting a demo:
    whether the AI path is live and how many clients are receiving telemetry."""
    return {
        'status': 'healthy',
        'llm': {'gemini_configured': bool(get_gemini_api_key()), 'model': GEMINI_MODEL},
        'websocket_clients': manager.connection_count,
        # The posture, so it can be read from outside rather than only found
        # in a log line at boot.
        'security': {
            'commander_key_configured': get_expected_key() is not None,
            'using_demo_key': get_expected_key() == DEMO_KEY,
            'public_reads': reads_are_public(),
        },
    }
