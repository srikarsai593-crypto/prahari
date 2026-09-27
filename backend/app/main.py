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
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from .database import init_db
from .seed import seed_data
from .ws_manager import manager
from .auth import DEMO_KEY, get_expected_key
from .llm import GEMINI_MODEL, get_gemini_api_key
from .routes import (expeditions, shipments, inventory, personnel, incidents,
                     events_routes, geofences, admin)

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


# Preview deployments get a fresh hostname per branch, so the hosted console is
# matched by pattern rather than by an exhaustive list. The default is broad on
# purpose - it has to keep working for whoever deploys this - so the boot check
# below says out loud what it is admitting.
DEFAULT_CORS_ORIGIN_REGEX = r'^https://.*\.vercel\.app$'


def _cors_origin_regex() -> str | None:
    """Origin pattern for hosted consoles. Empty string disables it entirely."""
    raw = os.getenv('PRAHARI_CORS_ORIGIN_REGEX', DEFAULT_CORS_ORIGIN_REGEX)
    return raw.strip() or None


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
    if _cors_origin_regex() == DEFAULT_CORS_ORIGIN_REGEX:
        logger.warning(
            'CORS is admitting every *.vercel.app origin, which includes deployments that '
            'are not yours. Set PRAHARI_CORS_ORIGIN_REGEX to your own hostname pattern, or '
            'PRAHARI_CORS_ORIGINS to an exact list, for anything but a demo.')

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

for router in (expeditions, shipments, inventory, personnel, incidents,
               events_routes, geofences, admin):
    app.include_router(router.router)


@app.websocket('/ws')
async def websocket_endpoint(websocket: WebSocket):
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
    }
