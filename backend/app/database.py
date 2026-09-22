import sqlite3
import os
import threading

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'prahari.db')

# Thread-local storage for connections
_local = threading.local()

def get_db() -> sqlite3.Connection:
    if not hasattr(_local, 'conn') or _local.conn is None:
        _local.conn = sqlite3.connect(DB_PATH)
        _local.conn.row_factory = sqlite3.Row
        _local.conn.execute('PRAGMA journal_mode=WAL')
        _local.conn.execute('PRAGMA foreign_keys=ON')
        _local.conn.execute('PRAGMA busy_timeout=5000')
    return _local.conn

def init_db():
    conn = get_db()
    conn.executescript('''
    CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        module TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT DEFAULT 'system',
        related_id TEXT,
        metadata TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS expeditions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        raw_request TEXT,
        station TEXT NOT NULL,
        start_date DATE,
        end_date DATE,
        personnel_required INTEGER,
        fuel_required_l REAL,
        status TEXT DEFAULT 'draft',
        readiness_score INTEGER,
        readiness_breakdown TEXT,
        feasibility_result TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS shipments (
        id TEXT PRIMARY KEY,
        barcode_id TEXT UNIQUE NOT NULL,
        expedition_id TEXT,
        item_name TEXT NOT NULL,
        category TEXT NOT NULL,
        weight_kg REAL,
        priority TEXT DEFAULT 'normal',
        destination_station TEXT NOT NULL,
        status TEXT DEFAULT 'dispatched',
        dispatch_date DATETIME,
        eta DATETIME,
        risk_score INTEGER DEFAULT 0,
        delay_reason TEXT,
        last_scanned_at DATETIME,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS inventory_items (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        station TEXT NOT NULL,
        quantity REAL NOT NULL,
        unit TEXT,
        base_burn_rate REAL,
        beta REAL DEFAULT 0.15,
        days_of_cover REAL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS personnel (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT,
        expedition_id TEXT,
        status TEXT DEFAULT 'at_station',
        current_lat REAL,
        current_lng REAL,
        last_update_at DATETIME
    );
    CREATE TABLE IF NOT EXISTS movement_plans (
        id TEXT PRIMARY KEY,
        personnel_id TEXT,
        origin_lat REAL,
        origin_lng REAL,
        destination_lat REAL,
        destination_lng REAL,
        destination_name TEXT,
        planned_route TEXT,
        departure_time DATETIME,
        expected_arrival DATETIME,
        status TEXT DEFAULT 'planned'
    );
    CREATE TABLE IF NOT EXISTS geofences (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        center_lat REAL,
        center_lng REAL,
        radius_m REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS incidents (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        location_lat REAL,
        location_lng REAL,
        affected_radius_m REAL DEFAULT 5000,
        severity TEXT DEFAULT 'medium',
        status TEXT DEFAULT 'open',
        expected_count INTEGER,
        confirmed_safe_count INTEGER DEFAULT 0,
        unaccounted_count INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    ''')
    conn.commit()

    # ── Migration 1: Add simulation_step column (idempotent) ──────────────────
    try:
        conn.execute('ALTER TABLE personnel ADD COLUMN simulation_step INTEGER DEFAULT 0')
        conn.commit()
    except Exception:
        pass  # Column already exists — safe to ignore

    # ── Migration 2: Spread personnel coordinates (idempotent UPDATEs) ────────
    # Each person gets a unique position around Maitri Station so they don't
    # stack on top of each other. Running on every startup is safe — same values.
    coordinate_updates = [
        (-70.767, 11.731, 'per-priya'),    # Base — Maitri ops centre
        (-70.769, 11.735, 'per-arjun'),    # ~300 m SE
        (-70.771, 11.728, 'per-vikram'),   # ~450 m S
        (-70.765, 11.738, 'per-meera'),    # ~400 m NE
        (-70.773, 11.734, 'per-raj'),      # ~660 m S
        (-70.763, 11.729, 'per-ananya'),   # ~450 m N
    ]
    for lat, lng, pid in coordinate_updates:
        conn.execute(
            'UPDATE personnel SET current_lat = ?, current_lng = ? WHERE id = ? AND current_lat = current_lng',
            (lat, lng, pid)
        )
        # Unconditional update for the ID — ensures correct position even if lat!=lng
        conn.execute(
            'UPDATE personnel SET current_lat = ?, current_lng = ? WHERE id = ?',
            (lat, lng, pid)
        )
    conn.commit()

