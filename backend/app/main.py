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
from .auth import get_expected_key
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
    allow_origin_regex=os.getenv('PRAHARI_CORS_ORIGIN_REGEX', r'^https:\/\/.*\.vercel\.app$'),
    allow_credentials=True,
    allow_methods=['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allow_headers=['*'],
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
