from fastapi import APIRouter, HTTPException
import uuid
from datetime import datetime, timezone
from ..database import get_db
from ..models import VoiceCommandRequest
from ..events import log_event
from ..llm import parse_voice_command
from ..ws_manager import manager

router = APIRouter(prefix='/inventory', tags=['inventory'])

def compute_depletion(item: dict, delta_t: float) -> dict:
    """Compute depletion rate and days of cover using the formula:
    depletion_rate = base_burn_rate * (1 + beta * delta_T_blizzard)
    days_of_cover = quantity / depletion_rate
    """
    base_burn_rate = item.get('base_burn_rate') or 0
    beta = item.get('beta') or 0.15
    quantity = item.get('quantity') or 0
    
    depletion_multiplier = max(0.1, 1 + beta * delta_t)
    depletion_rate = base_burn_rate * depletion_multiplier
    days_of_cover = quantity / depletion_rate if depletion_rate > 0 else float('inf')
    
    return {
        'base_burn_rate': base_burn_rate,
        'beta': beta,
        'delta_t': delta_t,
        'depletion_rate': round(depletion_rate, 2),
        'days_of_cover': round(days_of_cover, 1) if days_of_cover != float('inf') else 9999
    }

@router.get('')
def list_inventory(station: str = None, category: str = None):
    from .shipments import current_delta_t
    db = get_db()
    query = 'SELECT * FROM inventory_items WHERE 1=1'
    params = []
    if station:
        query += ' AND station = ?'
        params.append(station)
    if category:
        query += ' AND category = ?'
        params.append(category)
    query += ' ORDER BY name'
    rows = db.execute(query, params).fetchall()
    result = []
    for r in rows:
        d = dict(r)
        depletion = compute_depletion(d, current_delta_t)
        d.update(depletion)
        result.append(d)
    return result

@router.get('/{station}/count')
def exact_count(station: str, item: str = None):
    """Direct deterministic SQL query — no approximation, no RAG, no LLM.
    A vector/RAG approach would approximate this via semantic similarity 
    and could hallucinate a close-but-wrong value. A direct SQL query cannot."""
    db = get_db()
    if item:
        row = db.execute('SELECT quantity, unit, name FROM inventory_items WHERE station = ? AND LOWER(name) LIKE ?', 
            (station, f'%{item.lower()}%')).fetchone()
    else:
        row = db.execute('SELECT SUM(quantity) as quantity, "mixed" as unit, "all items" as name FROM inventory_items WHERE station = ?', (station,)).fetchone()
    if not row or row['quantity'] is None:
        raise HTTPException(status_code=404, detail='Item not found')
    return {'item': row['name'], 'quantity': row['quantity'], 'unit': row['unit'], 'method': 'direct_sql_query'}

@router.get('/item/{item_id}')
def get_item(item_id: str):
    from .shipments import current_delta_t
    db = get_db()
    row = db.execute('SELECT * FROM inventory_items WHERE id = ?', (item_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail='Item not found')
    d = dict(row)
    depletion = compute_depletion(d, current_delta_t)
    d.update(depletion)
    return d

@router.post('/voice-command')
async def process_voice_command(req: VoiceCommandRequest):
    result = await parse_voice_command(req.transcript)
    db = get_db()
    # Find matching item
    item_name = result['item']
    row = db.execute('SELECT * FROM inventory_items WHERE LOWER(name) LIKE ?', (f'%{item_name.lower()}%',)).fetchone()
    if not row:
        return {'parsed': result, 'applied': False, 'error': f'Item "{item_name}" not found in inventory'}
    
    item = dict(row)
    old_qty = item['quantity']
    if result['action'] == 'decrement':
        new_qty = max(0, old_qty - result['quantity'])
    else:
        new_qty = old_qty + result['quantity']
    
    now = datetime.now(timezone.utc).isoformat()
    db.execute('UPDATE inventory_items SET quantity = ?, updated_at = ? WHERE id = ?', (new_qty, now, item['id']))
    db.commit()
    
    await log_event('inventory', f'Voice command: {result["action"]} {result["quantity"]} {item["name"]} (was {old_qty}, now {new_qty})', 'voice_system', item['id'], {'parsed': result})
    await manager.broadcast({'type': 'inventory_update', 'data': {'item_id': item['id'], 'new_quantity': new_qty}})
    
    return {'parsed': result, 'applied': True, 'old_quantity': old_qty, 'new_quantity': new_qty, 'item_name': item['name']}

@router.patch('/{item_id}')
async def update_item(item_id: str, body: dict):
    db = get_db()
    row = db.execute('SELECT * FROM inventory_items WHERE id = ?', (item_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail='Item not found')
    
    quantity = body.get('quantity', row['quantity'])
    now = datetime.now(timezone.utc).isoformat()
    db.execute('UPDATE inventory_items SET quantity = ?, updated_at = ? WHERE id = ?', (quantity, now, item_id))
    db.commit()
    await log_event('inventory', f'Inventory updated: {row["name"]} quantity → {quantity}', 'commander', item_id)
    await manager.broadcast({'type': 'inventory_update', 'data': {'item_id': item_id, 'new_quantity': quantity}})
    return {'id': item_id, 'quantity': quantity}
