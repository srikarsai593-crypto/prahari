from fastapi import APIRouter, HTTPException, Depends
import uuid, json
from ..database import get_db
from ..models import ExpeditionCreate, ExpeditionResponse, FeasibilityRequest, FeasibilityResponse, FeasibilityLineItem
from ..events import log_event
from ..llm import parse_expedition_nl
from ..auth import require_key

router = APIRouter(prefix='/expeditions', tags=['expeditions'])

@router.get('')
def list_expeditions():
    db = get_db()
    rows = db.execute('SELECT * FROM expeditions ORDER BY created_at DESC').fetchall()
    return [dict(r) for r in rows]

@router.get('/{expedition_id}')
def get_expedition(expedition_id: str):
    db = get_db()
    row = db.execute('SELECT * FROM expeditions WHERE id = ?', (expedition_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail='Expedition not found')
    return dict(row)

@router.post('', dependencies=[Depends(require_key)])
async def create_expedition(data: ExpeditionCreate):
    db = get_db()
    exp_id = 'exp-' + str(uuid.uuid4())[:8]
    breakdown_str = json.dumps(data.readiness_breakdown) if data.readiness_breakdown else None
    db.execute(
        'INSERT INTO expeditions (id, name, raw_request, station, start_date, end_date, personnel_required, fuel_required_l, status, readiness_score, readiness_breakdown) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        (exp_id, data.name, data.raw_request, data.station, data.start_date, data.end_date, data.personnel_required, data.fuel_required_l, 'draft', data.readiness_score, breakdown_str)
    )
    db.commit()
    await log_event('expedition', f'Expedition "{data.name}" created at {data.station}', 'commander', exp_id)
    return {'id': exp_id, **data.model_dump()}

@router.post('/parse-nl', dependencies=[Depends(require_key)])
async def parse_natural_language(body: dict):
    raw_text = body.get('text', '')
    if not raw_text:
        raise HTTPException(status_code=400, detail='No text provided')
    result, ai_used = await parse_expedition_nl(raw_text)
    return {**result.model_dump(), 'ai_used': ai_used}

@router.post('/feasibility')
async def check_feasibility(req: FeasibilityRequest):
    db = get_db()
    # Personnel check
    available_personnel = db.execute("SELECT COUNT(*) FROM personnel WHERE status='at_station'").fetchone()[0]
    personnel_ok = available_personnel >= req.personnel_required
    # Fuel check
    fuel_row = db.execute("SELECT COALESCE(SUM(quantity), 0) FROM inventory_items WHERE name LIKE '%Fuel%' AND station = ?", (req.station,)).fetchone()
    available_fuel = fuel_row[0] if fuel_row else 0
    fuel_ok = available_fuel >= req.fuel_required_l
    # Cargo ETA check
    eta_row = db.execute(
        "SELECT MIN(eta) FROM shipments WHERE destination_station = ? AND status NOT IN ('arrived', 'unloaded')",
        (req.station,)
    ).fetchone()
    cargo_eta = eta_row[0] if eta_row and eta_row[0] else 'No shipments'
    cargo_ok = cargo_eta == 'No shipments'  # No pending = ok
    # Station capacity (hardcoded 40 for Maitri)
    station_capacity = 40
    current_at_station = db.execute("SELECT COUNT(*) FROM personnel WHERE status IN ('at_station', 'field')").fetchone()[0]
    station_ok = (current_at_station + req.personnel_required) <= station_capacity
    
    items = [
        FeasibilityLineItem(label='Personnel', required=req.personnel_required, available=available_personnel, ok=personnel_ok),
        FeasibilityLineItem(label='Fuel (L)', required=req.fuel_required_l, available=available_fuel, ok=fuel_ok),
        FeasibilityLineItem(label='Cargo ETA', required=0, available=0, ok=cargo_ok, detail=str(cargo_eta)),
        FeasibilityLineItem(label='Station Capacity', required=req.personnel_required, available=station_capacity - current_at_station, ok=station_ok),
    ]
    
    # Readiness scores
    p_score = min(100, int((available_personnel / max(req.personnel_required, 1)) * 100))
    i_score = min(100, int((available_fuel / max(req.fuel_required_l, 1)) * 100))
    m_score = 100 if cargo_ok else 60
    l_score = 100 if station_ok else 70
    readiness_score = (p_score + i_score + m_score + l_score) // 4
    breakdown = {'personnel': p_score, 'inventory': i_score, 'mission': m_score, 'logistics': l_score}
    
    status = 'feasible' if all(item.ok for item in items) else 'under_resourced'
    await log_event('expedition', f'Feasibility check: {status} (readiness: {readiness_score}%)', 'system', metadata={'breakdown': breakdown})
    
    return FeasibilityResponse(items=items, readiness_score=readiness_score, readiness_breakdown=breakdown)
