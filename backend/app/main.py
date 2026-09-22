from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from contextlib import asynccontextmanager
from fastapi.middleware.cors import CORSMiddleware
from .database import init_db
from .seed import seed_data
from .ws_manager import manager
from .routes import expeditions, shipments, inventory, personnel, incidents
from .routes import events_routes, geofences

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan: runs startup logic before yield, teardown after."""
    init_db()
    seed_data()
    print('Prahari backend started - database initialized and seeded.')
    yield
    # Teardown (if needed in future) goes here


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    init_db()
    seed_data()
    print('Prahari backend started - database initialized and seeded.')
    yield
    # Shutdown (nothing to clean up for now)


app = FastAPI(
    title='Prahari - Antarctic Operations Intelligence',
    version='1.0.0',
    description='Antarctic Logistics & Safety Intelligence Platform — Team 36 OURS | SIH26062',
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=['http://localhost:3000', 'http://127.0.0.1:3000'],
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*'],
)

# Include all route groups
app.include_router(expeditions.router)
app.include_router(shipments.router)
app.include_router(inventory.router)
app.include_router(personnel.router)
app.include_router(incidents.router)
app.include_router(events_routes.router)

@app.websocket('/ws')
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)

@app.get('/')
def root():
    return {'name': 'Prahari', 'team': '36 OURS', 'version': '1.0.0', 'status': 'operational'}

@app.get('/health')
def health():
    return {'status': 'healthy'}

