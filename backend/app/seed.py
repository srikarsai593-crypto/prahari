import uuid
from .database import get_db
import json
from datetime import datetime, timedelta

def seed_data():
    db = get_db()
    # Check if already seeded
    count = db.execute('SELECT COUNT(*) FROM personnel').fetchone()[0]
    if count > 0:
        return
    
    # Expedition
    exp_id = 'exp-' + str(uuid.uuid4())[:8]
    db.execute('INSERT INTO expeditions (id, name, raw_request, station, start_date, end_date, personnel_required, fuel_required_l, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        (exp_id, 'Antarctic Survey Alpha', 'Survey mission to Maitri station', 'Maitri',
         (datetime.utcnow() + timedelta(days=10)).strftime('%Y-%m-%d'),
         (datetime.utcnow() + timedelta(days=40)).strftime('%Y-%m-%d'),
         8, 8000, 'draft'))
    
    # Inventory items - FUEL is deliberately below expedition requirement (6500 < 8000)
    items = [
        ('inv-fuel', 'Diesel Fuel', 'consumable', 'Maitri', 6500, 'L', 350, 0.15),
        ('inv-med', 'Medical Supplies', 'consumable', 'Maitri', 120, 'units', 4, 0.05),
        ('inv-blankets', 'Thermal Blankets', 'reusable', 'Maitri', 45, 'units', 0.5, 0.02),
        ('inv-rations', 'Emergency Rations', 'consumable', 'Maitri', 800, 'kg', 25, 0.08),
    ]
    for item in items:
        db.execute('INSERT INTO inventory_items (id, name, category, station, quantity, unit, base_burn_rate, beta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', item)
    
    # Personnel - 6 people at Maitri (expedition wants 8 -> feasibility gap)
    personnel_data = [
        ('per-priya', 'Dr. Priya Sharma', 'Researcher', exp_id, 'at_station', -70.767, 11.731),
        ('per-arjun', 'Dr. Arjun Patel', 'Researcher', exp_id, 'at_station', -70.767, 11.731),
        ('per-vikram', 'Cmdr. Vikram Singh', 'Commander', None, 'at_station', -70.767, 11.731),
        ('per-meera', 'Lt. Meera Iyer', 'Engineer', None, 'at_station', -70.767, 11.731),
        ('per-raj', 'Sgt. Raj Kumar', 'Logistics', None, 'at_station', -70.767, 11.731),
        ('per-ananya', 'Dr. Ananya Reddy', 'Medical Officer', None, 'at_station', -70.767, 11.731),
    ]
    for p in personnel_data:
        db.execute('INSERT INTO personnel (id, name, role, expedition_id, status, current_lat, current_lng) VALUES (?, ?, ?, ?, ?, ?, ?)', p)
    
    # Geofences
    geofences = [
        ('gf-maitri', 'Maitri Station', 'station', -70.767, 11.731, 2000),
        ('gf-campa', 'Camp Alpha', 'field_camp', -70.85, 11.95, 1500),
        ('gf-crevasse', 'Crevasse Zone', 'restricted', -70.82, 11.88, 800),
    ]
    for gf in geofences:
        db.execute('INSERT INTO geofences (id, name, type, center_lat, center_lng, radius_m) VALUES (?, ?, ?, ?, ?, ?)', gf)
    
    db.commit()
    print('Database seeded successfully!')
