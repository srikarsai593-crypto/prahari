from fastapi import APIRouter, HTTPException, Depends
import uuid, json
from datetime import datetime, timezone
from ..database import get_db
from ..models import (ExpeditionCreate, FeasibilityRequest, FeasibilityResponse,
                      FeasibilityLineItem, ResupplyRecommendation, ParseNLRequest,
                      ExpeditionStatusRequest, ExpeditionCrewRequest, Station)
from ..ws_manager import manager
from typing import Optional
from ..events import log_event
from ..llm import parse_expedition_nl
from ..auth import require_key
from ..timeutil import utc_now, utc_now_iso, to_utc_iso
from ..cascade import propagate_station_change

router = APIRouter(prefix='/expeditions', tags=['expeditions'])

# Berths per station. Hard-coding one number for every station overstated
# capacity at the smaller outposts.
STATION_CAPACITY = {'Maitri': 40, 'Bharati': 47, 'Himadri': 25}

# Weights for the composite readiness score. They sum to 1.0 and are returned
# with the result so the number is auditable rather than a magic average.
READINESS_WEIGHTS = {'personnel': 0.35, 'inventory': 0.35, 'mission': 0.15, 'logistics': 0.15}

# An expedition is a state machine. Without one every record stayed 'draft'
# forever, so the dashboard's "Active Expeditions" was really a draft count and
# nothing could ever be closed out or called off.
VALID_TRANSITIONS = {
    'draft':     {'active', 'cancelled'},
    'active':    {'completed', 'cancelled'},
    'completed': set(),
    'cancelled': set(),
}
ACTIVE_STATUSES = ('draft', 'active')

# Crew can only be put on a traverse that has not departed or closed.
CREW_EDITABLE_STATUSES = ('draft',)

# What an expedition burns. Fuel leaves station stock when the traverse is
# authorised (it is loaded onto the vehicles) and is returned if the traverse
# is called off before it completes.
FUEL_ITEM_MATCH = '%fuel%'


# Cargo statuses that mean the crate is still coming. An arrived or unloaded
# consignment has already been counted in the stock figure the shortfall was
# measured against, so offering it as the answer would double-count it.
INBOUND_STATUSES = ('dispatched', 'in_transit', 'delayed')


def _hours_until(eta) -> float | None:
    parsed = _parse_iso(eta)
    if parsed is None:
        return None
    return round((parsed - utc_now()).total_seconds() / 3600, 1)


def _parse_iso(value):
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    except (TypeError, ValueError):
        return None
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None \
        else parsed.astimezone(timezone.utc)


def _find_resupply(db, station: str, shortfall: float, unit: str,
                   inventory_item_id: str | None, name_match: str
                   ) -> ResupplyRecommendation | None:
    """The earliest inbound consignment that would help close a shortfall.

    "You cannot depart, you are 3,500 L short" is a diagnosis. The shipments
    table already holds the answer — a tanker due in fourteen hours — and
    making the commander go and find it by hand is the difference between a
    dashboard and a decision-support system.
    """
    placeholders = ','.join('?' * len(INBOUND_STATUSES))
    params: list = [station]
    clause = ''
    if inventory_item_id:
        clause = 'AND (inventory_item_id = ? OR LOWER(item_name) LIKE ?) '
        params += [inventory_item_id, f'%{name_match.lower()}%']
    else:
        clause = 'AND LOWER(item_name) LIKE ? '
        params.append(f'%{name_match.lower()}%')
    params += list(INBOUND_STATUSES)

    row = db.execute(
        f'SELECT * FROM shipments WHERE destination_station = ? {clause}'
        f'AND status IN ({placeholders}) ORDER BY eta LIMIT 1', params
    ).fetchone()
    if not row:
        return None

    shipment = dict(row)
    quantity = shipment['quantity']
    hours = _hours_until(shipment['eta'])
    covers = quantity is not None and quantity >= shortfall

    eta_phrase = (f'in ~{hours:g} h' if hours is not None and hours > 0
                  else 'imminently' if hours is not None else 'on an unstated schedule')
    payload = (f'{quantity:,.0f} {shipment["unit"] or ""}'.strip() if quantity
               else 'an unstated quantity')
    if covers:
        verdict = (f'Shortfall resolvable: delaying departure until it lands clears the '
                   f'{shortfall:,.0f} {unit} gap in full.')
    elif quantity:
        verdict = (f'Partial cover only: it closes {quantity:,.0f} of the '
                   f'{shortfall:,.0f} {unit} gap.')
    else:
        verdict = ('The consignment carries no stated quantity, so it cannot be counted '
                   'against the shortfall until it is booked against a stock row.')
    if shipment['status'] == 'delayed':
        verdict += (f' It is itself delayed'
                    f'{" (" + shipment["delay_reason"] + ")" if shipment["delay_reason"] else ""},'
                    f' so treat the ETA as provisional.')

    return ResupplyRecommendation(
        shipment_id=shipment['id'], barcode_id=shipment['barcode_id'],
        item_name=shipment['item_name'], quantity=quantity, unit=shipment['unit'],
        eta=to_utc_iso(shipment['eta']), eta_hours=hours, status=shipment['status'],
        covers_shortfall=bool(covers),
        recommendation_text=(f'Inbound {shipment["barcode_id"]} carrying {payload} of '
                             f'{shipment["item_name"]} arrives {eta_phrase}. {verdict}'),
    )


def _crew_for(db, expedition_id: str) -> list[dict]:
    rows = db.execute(
        'SELECT id, name, role, status, station FROM personnel WHERE expedition_id = ? '
        'ORDER BY name', (expedition_id,)
    ).fetchall()
    return [dict(r) for r in rows]


def _with_crew(db, row) -> dict:
    d = dict(row)
    d['created_at'] = to_utc_iso(d['created_at'])
    d['crew'] = _crew_for(db, d['id'])
    d['crew_assigned'] = len(d['crew'])

    # Readiness as it stands now, next to the figure the traverse was approved
    # against. A card that reports only the stored score is reporting a claim
    # about a moment that has passed.
    from ..cascade import DEGRADE_TOLERANCE
    baseline = d.get('baseline_readiness_score')
    if baseline is None:
        baseline = d.get('readiness_score')
    live = d.get('live_readiness_score')
    d['baseline_readiness_score'] = baseline
    d['readiness_degraded'] = bool(
        live is not None and baseline is not None and live < baseline - DEGRADE_TOLERANCE)
    try:
        d['live_feasibility'] = json.loads(d['live_feasibility']) if d.get('live_feasibility') \
            else None
    except (TypeError, ValueError):
        d['live_feasibility'] = None
    return d


def _station_fuel_row(db, station: str):
    """The station's fuel stock row. Expeditions are costed in litres, so a
    row counted in anything else is not the one to draw from."""
    return db.execute(
        "SELECT * FROM inventory_items WHERE station = ? AND LOWER(name) LIKE ? "
        "AND LOWER(COALESCE(unit, '')) = 'l' ORDER BY quantity DESC LIMIT 1",
        (station, FUEL_ITEM_MATCH)
    ).fetchone()


def _validate_crew(db, crew_ids: list[str], station: str, expedition_id: str | None):
    """Every named person must exist, belong to this station, and not already
    be committed to a different traverse."""
    if not crew_ids:
        return []
    unique = list(dict.fromkeys(crew_ids))
    placeholders = ','.join('?' * len(unique))
    rows = db.execute(
        f'SELECT * FROM personnel WHERE id IN ({placeholders})', unique
    ).fetchall()
    found = {r['id']: r for r in rows}

    missing = [pid for pid in unique if pid not in found]
    if missing:
        raise HTTPException(status_code=404,
                            detail=f'No such crew member: {", ".join(missing)}')

    wrong_station = [found[pid]['name'] for pid in unique if found[pid]['station'] != station]
    if wrong_station:
        raise HTTPException(
            status_code=422,
            detail=f'{", ".join(wrong_station)} is not posted to {station} and cannot join a '
                   f'traverse departing from there.')

    committed = [found[pid]['name'] for pid in unique
                 if found[pid]['expedition_id'] and found[pid]['expedition_id'] != expedition_id]
    if committed:
        raise HTTPException(
            status_code=409,
            detail=f'{", ".join(committed)} is already assigned to another traverse. '
                   f'Release them first or pick someone else.')

    unavailable = [found[pid]['name'] for pid in unique
                   if found[pid]['status'] not in ('at_station', 'returned')]
    if unavailable:
        raise HTTPException(
            status_code=409,
            detail=f'{", ".join(unavailable)} is not at base and cannot be assigned yet.')

    return [found[pid] for pid in unique]


def _set_crew(db, expedition_id: str, crew_ids: list[str]) -> None:
    db.execute('UPDATE personnel SET expedition_id = NULL WHERE expedition_id = ?',
               (expedition_id,))
    for pid in dict.fromkeys(crew_ids):
        db.execute('UPDATE personnel SET expedition_id = ? WHERE id = ?', (expedition_id, pid))


@router.get('')
def list_expeditions(station: Optional[Station] = None, status: Optional[str] = None):
    """Expeditions, optionally narrowed to one base and one lifecycle state.

    The station filter belongs here rather than in the browser: every caller
    was fetching all three stations' records and discarding two thirds.
    """
    db = get_db()
    clauses, params = [], []
    if station:
        clauses.append('station = ?')
        params.append(station)
    if status:
        clauses.append('status = ?')
        params.append(status)
    query = 'SELECT * FROM expeditions'
    if clauses:
        query += ' WHERE ' + ' AND '.join(clauses)
    rows = db.execute(query + ' ORDER BY created_at DESC', params).fetchall()
    return [_with_crew(db, r) for r in rows]


@router.get('/{expedition_id}')
def get_expedition(expedition_id: str):
    db = get_db()
    row = db.execute('SELECT * FROM expeditions WHERE id = ?', (expedition_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail='Expedition not found')
    return _with_crew(db, row)


@router.post('', dependencies=[Depends(require_key)])
async def create_expedition(data: ExpeditionCreate):
    if data.start_date and data.end_date and data.end_date < data.start_date:
        raise HTTPException(status_code=422, detail='end_date cannot be before start_date')

    db = get_db()
    crew = _validate_crew(db, data.crew_ids, data.station, None)

    exp_id = 'exp-' + str(uuid.uuid4())[:8]
    breakdown_str = json.dumps(data.readiness_breakdown) if data.readiness_breakdown else None
    db.execute(
        'INSERT INTO expeditions (id, name, raw_request, station, start_date, end_date, '
        'personnel_required, fuel_required_l, status, readiness_score, readiness_breakdown, '
        'created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        (exp_id, data.name, data.raw_request, data.station, data.start_date, data.end_date,
         data.personnel_required, data.fuel_required_l, 'draft', data.readiness_score,
         breakdown_str, utc_now_iso())
    )
    _set_crew(db, exp_id, [c['id'] for c in crew])
    db.commit()

    crew_note = (f' with {len(crew)} crew assigned' if crew
                 else ' — no crew assigned yet')
    await log_event('expedition', f'Expedition "{data.name}" planned at {data.station}'
                    f'{crew_note}', 'commander', exp_id, station=data.station)
    await manager.broadcast({'type': 'expedition_update',
                             'data': {'expedition_id': exp_id, 'status': 'draft',
                                      'station': data.station}})
    return _with_crew(db, db.execute('SELECT * FROM expeditions WHERE id = ?',
                                     (exp_id,)).fetchone())


@router.patch('/{expedition_id}/crew', dependencies=[Depends(require_key)])
async def set_expedition_crew(expedition_id: str, body: ExpeditionCrewRequest):
    """Set the named roster for a traverse that has not departed."""
    db = get_db()
    row = db.execute('SELECT * FROM expeditions WHERE id = ?', (expedition_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail='Expedition not found')
    if row['status'] not in CREW_EDITABLE_STATUSES:
        raise HTTPException(
            status_code=409,
            detail=f'"{row["name"]}" is {row["status"]} — the crew can only be changed while a '
                   f'traverse is still being planned.')

    crew = _validate_crew(db, body.crew_ids, row['station'], expedition_id)
    before = {c['id'] for c in _crew_for(db, expedition_id)}
    _set_crew(db, expedition_id, [c['id'] for c in crew])
    db.commit()

    after = {c['id'] for c in crew}
    added, removed = len(after - before), len(before - after)
    if added or removed:
        changes = []
        if added:
            changes.append(f'{added} added')
        if removed:
            changes.append(f'{removed} stood down')
        await log_event('expedition', f'Crew for "{row["name"]}": {", ".join(changes)} '
                        f'({len(after)} assigned)', 'commander', expedition_id,
                        station=row['station'])
        await manager.broadcast({'type': 'expedition_update',
                                 'data': {'expedition_id': expedition_id,
                                          'status': row['status'], 'station': row['station']}})
    return _with_crew(db, db.execute('SELECT * FROM expeditions WHERE id = ?',
                                     (expedition_id,)).fetchone())


@router.post('/parse-nl', dependencies=[Depends(require_key)])
async def parse_natural_language(body: ParseNLRequest):
    result = await parse_expedition_nl(body.text)
    # parse_source is the honest signal: 'gemini'/'ollama' means a model ran,
    # 'fallback' means the regex rules did. The UI must not claim AI either way.
    return {**result, 'ai_used': result.get('parse_source') in ('gemini', 'ollama')}


@router.post('/feasibility')
async def check_feasibility(req: FeasibilityRequest) -> FeasibilityResponse:
    """Score a traverse against what the station can support right now."""
    return await score_feasibility(req, log=True)


async def score_feasibility(req: FeasibilityRequest, log: bool = True) -> FeasibilityResponse:
    """The scoring itself, separated from the route.

    `log` is False when the cascade re-scores in the background: a continuous
    monitor that writes an audit row on every recomputation buries the
    operator's own actions under its own heartbeat. It is a parameter of the
    function rather than of the endpoint because FastAPI would otherwise expose
    it as a query parameter and let any caller silently suppress the audit
    trail for a readiness check.
    """
    db = get_db()

    # ── Personnel: who is actually available to be assigned ──────────────────
    # Scoped to the departure station. Counting all three stations' crew let an
    # under-staffed outpost read as fully resourced on another station's people.
    # People already named on THIS traverse still count as available to it —
    # otherwise assigning crew made the same traverse read as short-staffed.
    available_personnel = db.execute(
        "SELECT COUNT(*) FROM personnel WHERE status IN ('at_station', 'returned') "
        'AND station = ? AND (expedition_id IS NULL OR expedition_id = ?)',
        (req.station, req.expedition_id)
    ).fetchone()[0]
    personnel_ok = available_personnel >= req.personnel_required

    # ── Fuel: on-hand stock at the departure station ─────────────────────────
    fuel_row = _station_fuel_row(db, req.station)
    available_fuel = fuel_row['quantity'] if fuel_row else 0
    fuel_ok = available_fuel >= req.fuel_required_l

    # ── Cargo: inbound resupply is a POSITIVE, not a blocker ─────────────────
    # The previous rule was `ok = (there are no pending shipments)`, which marked
    # an expedition *less* feasible precisely because resupply was on its way.
    # What actually matters is whether any inbound cargo is stuck.
    pending = db.execute(
        "SELECT eta, status, delay_reason FROM shipments "
        "WHERE destination_station = ? AND status NOT IN ('arrived', 'unloaded') "
        "ORDER BY eta", (req.station,)
    ).fetchall()
    delayed = [s for s in pending if s['status'] == 'delayed']
    cargo_ok = not delayed
    if not pending:
        cargo_detail = 'No inbound shipments - operating on stock in hand'
    elif delayed:
        cargo_detail = (f'{len(delayed)} of {len(pending)} inbound shipments delayed '
                        f'({delayed[0]["delay_reason"] or "unknown"})')
    else:
        cargo_detail = f'{len(pending)} inbound, earliest ETA {to_utc_iso(pending[0]["eta"])}'

    # ── Station capacity: berths at the destination ──────────────────────────
    station_capacity = STATION_CAPACITY.get(req.station, 25)
    current_at_station = db.execute(
        "SELECT COUNT(*) FROM personnel WHERE status IN ('at_station', 'field', 'in_transit') "
        "AND station = ?", (req.station,)
    ).fetchone()[0]
    remaining_berths = station_capacity - current_at_station
    station_ok = req.personnel_required <= remaining_berths

    items = [
        FeasibilityLineItem(label='Crew', required=req.personnel_required,
                            available=available_personnel, ok=personnel_ok,
                            detail=f'{available_personnel} available at {req.station}'
                            if personnel_ok else
                            f'{req.personnel_required - available_personnel} more needed at '
                            f'{req.station}'),
        FeasibilityLineItem(label='Fuel (L)', required=req.fuel_required_l,
                            available=available_fuel, ok=fuel_ok,
                            detail=f'{available_fuel:,.0f} L in store at {req.station}'
                            if fuel_ok else
                            f'Short by {req.fuel_required_l - available_fuel:.0f} L',
                            resupply=None if fuel_ok else _find_resupply(
                                db, req.station, req.fuel_required_l - available_fuel, 'L',
                                fuel_row['id'] if fuel_row else None, 'fuel')),
        FeasibilityLineItem(label='Inbound Supplies', required=0, available=len(pending),
                            ok=cargo_ok, detail=cargo_detail),
        FeasibilityLineItem(label='Beds at Base', required=req.personnel_required,
                            available=max(0, remaining_berths), ok=station_ok,
                            detail=f'{remaining_berths} of {station_capacity} free'),
    ]

    # Sub-scores are ratios clamped to 0..100.
    p_score = min(100, int((available_personnel / max(req.personnel_required, 1)) * 100))
    i_score = min(100, int((available_fuel / max(req.fuel_required_l, 1)) * 100))
    m_score = 100 if cargo_ok else 60
    l_score = min(100, int((max(0, remaining_berths) / max(req.personnel_required, 1)) * 100))
    breakdown = {'personnel': p_score, 'inventory': i_score,
                 'mission': m_score, 'logistics': l_score}
    readiness_score = round(sum(breakdown[k] * w for k, w in READINESS_WEIGHTS.items()))

    status = 'ready' if all(i.ok for i in items) else 'short'
    if log:
        await log_event('expedition', f'Readiness check at {req.station}: {status} '
                        f'({readiness_score}%)', 'system',
                        metadata={'breakdown': breakdown, 'weights': READINESS_WEIGHTS},
                        station=req.station)

    return FeasibilityResponse(items=items, readiness_score=readiness_score,
                               readiness_breakdown=breakdown)


@router.post('/{expedition_id}/rescore', dependencies=[Depends(require_key)])
async def rescore_expedition(expedition_id: str):
    """Re-run readiness for one traverse and adopt the result as its new baseline.

    This is what the operator presses after acting on a degradation alarm: it
    says "I have seen the new numbers and this is what the traverse is now
    measured against", which is what stops the alarm re-firing for ever.
    """
    db = get_db()
    row = db.execute('SELECT * FROM expeditions WHERE id = ?', (expedition_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail='Expedition not found')

    result = await score_feasibility(FeasibilityRequest(
        station=row['station'],
        personnel_required=row['personnel_required'] or 0,
        fuel_required_l=row['fuel_required_l'] or 0,
        expedition_id=expedition_id,
    ), log=False)

    previous = row['baseline_readiness_score'] if row['baseline_readiness_score'] is not None \
        else row['readiness_score']
    db.execute(
        'UPDATE expeditions SET readiness_score = ?, baseline_readiness_score = ?, '
        'live_readiness_score = ?, readiness_breakdown = ?, feasibility_result = ?, '
        'live_feasibility = ?, readiness_checked_at = ? WHERE id = ?',
        (result.readiness_score, result.readiness_score, result.readiness_score,
         json.dumps(result.readiness_breakdown),
         json.dumps([i.model_dump() for i in result.items]),
         json.dumps([i.model_dump() for i in result.items]),
         utc_now_iso(), expedition_id))
    db.commit()

    await log_event('expedition', f'"{row["name"]}" re-scored against live conditions: '
                    f'{previous if previous is not None else "unscored"}% -> '
                    f'{result.readiness_score}%', 'commander', expedition_id,
                    station=row['station'])
    await manager.broadcast({'type': 'expedition_update',
                             'data': {'expedition_id': expedition_id,
                                      'status': row['status'], 'station': row['station']}})
    updated = _with_crew(db, db.execute('SELECT * FROM expeditions WHERE id = ?',
                                        (expedition_id,)).fetchone())
    updated['feasibility'] = result.model_dump()
    return updated


@router.patch('/{expedition_id}', dependencies=[Depends(require_key)])
async def update_expedition_status(expedition_id: str, body: ExpeditionStatusRequest):
    """Move an expedition through its lifecycle, and move what it consumes.

    Authorising a traverse is not a label change: it commits the named crew to
    the field and draws its fuel out of station stock, which is what makes the
    next traverse's readiness check honest. Closing it brings the crew back and
    releases them for reassignment; calling off a traverse that never departed
    returns the fuel to store.
    """
    db = get_db()
    row = db.execute('SELECT * FROM expeditions WHERE id = ?', (expedition_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail='Expedition not found')

    current, new_status = row['status'], body.status
    if new_status == current:
        return _with_crew(db, row)
    allowed = VALID_TRANSITIONS.get(current, set())
    if new_status not in allowed:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot move an expedition from '{current}' to '{new_status}'. "
                   f"Allowed from '{current}': {sorted(allowed) or 'nothing - it is closed'}.")

    station = row['station']
    crew = _crew_for(db, expedition_id)
    required = row['personnel_required'] or 0
    fuel_needed = row['fuel_required_l'] or 0
    notes: list[str] = []

    # ── Authorising ───────────────────────────────────────────────────────────
    feasibility = None
    if new_status == 'active':
        if len(crew) < required:
            raise HTTPException(
                status_code=409,
                detail=f'"{row["name"]}" needs {required} crew and has {len(crew)} assigned. '
                       f'Add {required - len(crew)} more before authorising it.')

        feasibility = await score_feasibility(FeasibilityRequest(
            station=station,
            personnel_required=required,
            fuel_required_l=fuel_needed,
            expedition_id=expedition_id,
        ))
        short = [i.label for i in feasibility.items if not i.ok]
        if short:
            raise HTTPException(
                status_code=409,
                detail=f'{row["name"]} cannot be authorised: {", ".join(short)} short at '
                       f'{station} (readiness {feasibility.readiness_score}%). '
                       f'Resolve the shortfall or call the traverse off.')

        # Fuel leaves the store when the traverse is loaded.
        if fuel_needed > 0:
            fuel_row = _station_fuel_row(db, station)
            if fuel_row is None or fuel_row['quantity'] < fuel_needed:
                have = fuel_row['quantity'] if fuel_row else 0
                raise HTTPException(
                    status_code=409,
                    detail=f'{station} holds {have:,.0f} L of fuel and this traverse needs '
                           f'{fuel_needed:,.0f} L.')
            remaining = fuel_row['quantity'] - fuel_needed
            db.execute('UPDATE inventory_items SET quantity = ?, updated_at = ? WHERE id = ?',
                       (remaining, utc_now_iso(), fuel_row['id']))
            notes.append(f'{fuel_needed:,.0f} L of fuel drawn ({remaining:,.0f} L left in store)')

        # The crew are out on the traverse.
        for member in crew:
            db.execute("UPDATE personnel SET status = 'field' WHERE id = ?", (member['id'],))
        if crew:
            notes.append(f'{len(crew)} crew deployed')

    # ── Closing out ───────────────────────────────────────────────────────────
    if new_status in ('completed', 'cancelled'):
        if current == 'active' and new_status == 'cancelled' and fuel_needed > 0:
            # Called off after loading: the fuel goes back into store.
            fuel_row = _station_fuel_row(db, station)
            if fuel_row is not None:
                restored = fuel_row['quantity'] + fuel_needed
                db.execute('UPDATE inventory_items SET quantity = ?, updated_at = ? WHERE id = ?',
                           (restored, utc_now_iso(), fuel_row['id']))
                notes.append(f'{fuel_needed:,.0f} L of fuel returned to store')
        elif current == 'active' and new_status == 'completed' and fuel_needed > 0:
            notes.append(f'{fuel_needed:,.0f} L of fuel consumed')

        for member in crew:
            # Anyone who went out comes back; anyone who never left stays put.
            if member['status'] in ('field', 'in_transit', 'deviated', 'sos'):
                db.execute("UPDATE personnel SET status = 'returned' WHERE id = ?",
                           (member['id'],))
        db.execute('UPDATE personnel SET expedition_id = NULL WHERE expedition_id = ?',
                   (expedition_id,))
        if crew:
            notes.append(f'{len(crew)} crew released')

    if feasibility is not None:
        db.execute('UPDATE expeditions SET status = ?, readiness_score = ?, '
                   'readiness_breakdown = ?, feasibility_result = ? WHERE id = ?',
                   (new_status, feasibility.readiness_score,
                    json.dumps(feasibility.readiness_breakdown),
                    json.dumps([i.model_dump() for i in feasibility.items]), expedition_id))
    else:
        db.execute('UPDATE expeditions SET status = ? WHERE id = ?', (new_status, expedition_id))
    db.commit()

    WORDING = {'active': 'authorised', 'completed': 'completed', 'cancelled': 'called off'}
    detail = f' — {"; ".join(notes)}' if notes else ''
    await log_event('expedition', f'Expedition "{row["name"]}" '
                    f'{WORDING.get(new_status, new_status)}{detail}',
                    'commander', expedition_id, station=station)
    await manager.broadcast({'type': 'expedition_update',
                             'data': {'expedition_id': expedition_id, 'status': new_status,
                                      'station': station}})
    # Crew and stock both moved, so every module reading them has to re-read.
    await manager.broadcast({'type': 'personnel_update',
                             'data': {'expedition_id': expedition_id, 'status': new_status}})
    await manager.broadcast({'type': 'inventory_update',
                             'data': {'station': station}})
    # Fuel left the store and crew left the roster, so every OTHER traverse at
    # this station was just scored against numbers that no longer hold.
    from ..routes.inventory import evaluate_stock_alerts
    await evaluate_stock_alerts(station, db)
    await propagate_station_change(station, f'"{row["name"]}" {WORDING.get(new_status, new_status)}',
                                   db)

    updated = db.execute('SELECT * FROM expeditions WHERE id = ?', (expedition_id,)).fetchone()
    result = _with_crew(db, updated)
    result['notes'] = notes
    return result
