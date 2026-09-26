"""Reference data for the three stations Prahari covers.

Every station the UI offers in its switcher must have a roster, stock and
geofences of its own — a station that exists in the picker but not in the
database presents an empty dashboard that is indistinguishable from an outage.

Seeding is keyed on stable ids and uses INSERT OR IGNORE, so adding a station
here tops an existing database up instead of being skipped wholesale.
"""

import uuid
from datetime import datetime, timedelta, timezone

from .database import get_db

# Station coordinates. These are the real positions and must agree with
# frontend/src/lib/stations.ts and the geofence rows below.
STATION_ORIGINS = {
    'Maitri':  (-70.767, 11.731),
    'Bharati': (-69.407, 76.187),
    'Himadri': (78.923, 11.923),
}

# ── Rosters ──────────────────────────────────────────────────────────────────
# id, name, role, station, lat offset, lng offset
PERSONNEL = [
    ('per-priya',   'Dr. Priya Sharma',   'Researcher',      'Maitri',   0.000,  0.000),
    ('per-arjun',   'Dr. Arjun Patel',    'Researcher',      'Maitri',  -0.002,  0.004),
    ('per-vikram',  'Cmdr. Vikram Singh', 'Commander',       'Maitri',  -0.004, -0.003),
    ('per-meera',   'Lt. Meera Iyer',     'Engineer',        'Maitri',   0.002,  0.007),
    ('per-raj',     'Sgt. Raj Kumar',     'Logistics',       'Maitri',  -0.006,  0.003),
    ('per-ananya',  'Dr. Ananya Reddy',   'Medical Officer', 'Maitri',   0.004, -0.002),

    ('per-kavya',   'Dr. Kavya Nair',     'Researcher',      'Bharati',  0.000,  0.000),
    ('per-rohan',   'Lt. Rohan Desai',    'Engineer',        'Bharati', -0.003,  0.005),
    ('per-sneha',   'Dr. Sneha Joshi',    'Medical Officer', 'Bharati',  0.003, -0.004),
    ('per-imran',   'Cmdr. Imran Qureshi', 'Commander',      'Bharati', -0.005, -0.002),
    ('per-tara',    'Sgt. Tara Bhatt',    'Logistics',       'Bharati',  0.005,  0.003),

    ('per-nikhil',  'Dr. Nikhil Menon',   'Researcher',      'Himadri',  0.000,  0.000),
    ('per-farah',   'Lt. Farah Siddiqui', 'Engineer',        'Himadri',  0.003,  0.004),
    ('per-devang',  'Dr. Devang Rao',     'Medical Officer', 'Himadri', -0.003,  0.002),
]

# ── Stock ────────────────────────────────────────────────────────────────────
# id, name, category, station, quantity, unit, base_burn_rate, beta
#
# Maitri's fuel is deliberately below the seeded expedition's requirement
# (6500 L on hand vs 8000 L required) so the feasibility check has something
# real to fail on.
INVENTORY = [
    ('inv-fuel',      'Diesel Fuel',        'consumable', 'Maitri',  6500, 'L',     350,  0.15),
    ('inv-med',       'Medical Supplies',   'consumable', 'Maitri',   120, 'units',   4,  0.05),
    ('inv-blankets',  'Thermal Blankets',   'reusable',   'Maitri',    45, 'units',   0.5, 0.02),
    ('inv-rations',   'Emergency Rations',  'consumable', 'Maitri',   800, 'kg',     25,  0.08),

    ('inv-bha-fuel',  'Diesel Fuel',        'consumable', 'Bharati', 9200, 'L',     280,  0.15),
    ('inv-bha-med',   'Medical Supplies',   'consumable', 'Bharati',  180, 'units',   3,  0.05),
    ('inv-bha-rat',   'Emergency Rations',  'consumable', 'Bharati',  950, 'kg',     22,  0.08),
    ('inv-bha-parts', 'Generator Spares',   'reusable',   'Bharati',   30, 'units',   0.4, 0.02),

    ('inv-him-fuel',  'Diesel Fuel',        'consumable', 'Himadri', 3100, 'L',     140,  0.18),
    ('inv-him-med',   'Medical Supplies',   'consumable', 'Himadri',   75, 'units',   2,  0.05),
    ('inv-him-rat',   'Emergency Rations',  'consumable', 'Himadri',  420, 'kg',     12,  0.08),
]

# ── Geofences ────────────────────────────────────────────────────────────────
# id, name, type, lat, lng, radius_m
#
# The Crevasse Zone sits on the Maitri → Camp Alpha corridor on purpose: the
# guided scenario routes straight through it so the geofence engine, not a
# script, raises the violation.
GEOFENCES = [
    ('gf-maitri',   'Maitri Station',  'station',    -70.767, 11.731, 2000),
    ('gf-campa',    'Camp Alpha',      'field_camp', -70.850, 11.950, 1500),
    ('gf-crevasse', 'Crevasse Zone',   'restricted', -70.820, 11.880,  800),
    ('gf-bharati',  'Bharati Station', 'station',    -69.407, 76.187, 2000),
    ('gf-grovnes',  'Grovnes Camp',    'field_camp', -69.380, 76.240, 1200),
    ('gf-seaice',   'Sea Ice Margin',  'restricted', -69.360, 76.150,  900),
    ('gf-himadri',  'Himadri Station', 'station',     78.923, 11.923, 1500),
    ('gf-glacier',  'Glacier Front',   'restricted',  78.940, 11.990,  700),
]


def _seed_personnel(db) -> None:
    for pid, name, role, station, dlat, dlng in PERSONNEL:
        origin_lat, origin_lng = STATION_ORIGINS[station]
        db.execute(
            'INSERT OR IGNORE INTO personnel '
            '(id, name, role, station, expedition_id, status, current_lat, current_lng) '
            "VALUES (?, ?, ?, ?, NULL, 'at_station', ?, ?)",
            (pid, name, role, station, origin_lat + dlat, origin_lng + dlng)
        )
        # Rows that predate the station column landed on the 'Maitri' default.
        db.execute('UPDATE personnel SET station = ? WHERE id = ?', (station, pid))


def _seed_inventory(db) -> None:
    db.executemany(
        'INSERT OR IGNORE INTO inventory_items '
        '(id, name, category, station, quantity, unit, base_burn_rate, beta) '
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        INVENTORY
    )


def _seed_geofences(db) -> None:
    db.executemany(
        'INSERT OR IGNORE INTO geofences '
        '(id, name, type, center_lat, center_lng, radius_m) VALUES (?, ?, ?, ?, ?, ?)',
        GEOFENCES
    )


def _seed_station_conditions(db) -> None:
    """Give every station a weather row so the dashboard can tell "calm" apart
    from "this station has no record", which both read as 0 otherwise."""
    db.executemany(
        'INSERT OR IGNORE INTO station_conditions (station, delta_t, updated_at) '
        "VALUES (?, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
        [(s,) for s in STATION_ORIGINS]
    )


def _seed_expedition(db) -> None:
    if db.execute('SELECT COUNT(*) FROM expeditions').fetchone()[0] > 0:
        return
    now = datetime.now(timezone.utc)
    db.execute(
        'INSERT INTO expeditions (id, name, raw_request, station, start_date, end_date, '
        'personnel_required, fuel_required_l, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ('exp-' + str(uuid.uuid4())[:8], 'Antarctic Survey Alpha',
         'Survey mission to Maitri station', 'Maitri',
         (now + timedelta(days=10)).strftime('%Y-%m-%d'),
         (now + timedelta(days=40)).strftime('%Y-%m-%d'),
         8, 8000, 'draft')
    )


def seed_data():
    db = get_db()
    _seed_personnel(db)
    _seed_inventory(db)
    _seed_geofences(db)
    _seed_station_conditions(db)
    _seed_expedition(db)
    db.commit()
