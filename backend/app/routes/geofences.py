from fastapi import APIRouter, HTTPException
from ..database import get_db

router = APIRouter(prefix='/geofences', tags=['geofences'])

@router.get('')
def list_geofences():
    """Return all geofences from the database for live map rendering."""
    db = get_db()
    rows = db.execute('SELECT * FROM geofences').fetchall()
    return [dict(r) for r in rows]

@router.get('/{geofence_id}')
def get_geofence(geofence_id: str):
    db = get_db()
    row = db.execute('SELECT * FROM geofences WHERE id = ?', (geofence_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail='Geofence not found')
    return dict(row)
