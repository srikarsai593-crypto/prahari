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
        -- seq is the ordering key. created_at is a second-resolution string, so
        -- several events logged by one action collide and come back in arbitrary
        -- order when sorted by time alone. seq gives the timeline causal order.
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT UNIQUE NOT NULL,
        module TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT DEFAULT 'system',
        related_id TEXT,
        metadata TEXT,
        -- Which station the event belongs to. NULL means station-agnostic
        -- (a system or cross-station event) and is shown on every console.
        -- Without this the Maitri dashboard listed Bharati's activity.
        station TEXT,
        created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_module_seq ON events(module, seq DESC);
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
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS shipments (
        id TEXT PRIMARY KEY,
        barcode_id TEXT UNIQUE NOT NULL,
        expedition_id TEXT,
        item_name TEXT NOT NULL,
        category TEXT NOT NULL,
        weight_kg REAL,
        -- What the crate actually contains, in the receiving station's own
        -- units. weight_kg is the shipping weight (capacity and risk); this is
        -- the figure that lands in inventory on unload. Adding kilograms onto
        -- a row counted in litres invented stock out of a unit mismatch.
        quantity REAL,
        unit TEXT,
        -- Explicit target row, so unloading cannot restock the wrong item.
        inventory_item_id TEXT,
        priority TEXT DEFAULT 'normal',
        -- NULL means an external resupply vessel. A station id means an
        -- inter-station transfer: stock leaves the origin at dispatch.
        origin_station TEXT,
        destination_station TEXT NOT NULL,
        status TEXT DEFAULT 'dispatched',
        dispatch_date DATETIME,
        eta DATETIME,
        risk_score INTEGER DEFAULT 0,
        delay_reason TEXT,
        last_scanned_at DATETIME,
        updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
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
        updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS personnel (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT,
        -- Home station. Without it every roster query was station-blind, so the
        -- Bharati dashboard counted Maitri's crew and the berth check for one
        -- station subtracted the headcount of all three.
        station TEXT NOT NULL DEFAULT 'Maitri',
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
        status TEXT DEFAULT 'planned',
        simulation_step INTEGER DEFAULT 0
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
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS station_conditions (
        station TEXT PRIMARY KEY,
        delta_t REAL NOT NULL DEFAULT 0,
        updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS emergency_assets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        lat REAL NOT NULL,
        lng REAL NOT NULL,
        station TEXT DEFAULT 'Maitri',
        status TEXT DEFAULT 'available',
        updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    ''')
    _run_migrations(conn)
    _seed_emergency_assets(conn)
    conn.commit()


def _add_column(conn, table: str, column: str, ddl: str) -> None:
    """Idempotent ALTER. SQLite has no ADD COLUMN IF NOT EXISTS, and re-running
    a migration on an up-to-date database must not be an error."""
    existing = {r['name'] for r in conn.execute(f'PRAGMA table_info({table})').fetchall()}
    if column not in existing:
        conn.execute(f'ALTER TABLE {table} ADD COLUMN {column} {ddl}')


def _run_migrations(conn) -> None:
    """Bring a database created by an earlier schema up to the current one.

    Every step is idempotent so init_db() can run on every boot.
    """
    # Simulation cursors — added when GPS playback became resumable.
    _add_column(conn, 'movement_plans', 'simulation_step', 'INTEGER DEFAULT 0')
    _add_column(conn, 'personnel', 'simulation_step', 'INTEGER DEFAULT 0')

    # Station-scoped audit log — see the events table definition above.
    _add_column(conn, 'events', 'station', 'TEXT')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_events_station_seq ON events(station, seq DESC)')

    # Shipment payload and routing — see the shipments table definition above.
    _add_column(conn, 'shipments', 'quantity', 'REAL')
    _add_column(conn, 'shipments', 'unit', 'TEXT')
    _add_column(conn, 'shipments', 'inventory_item_id', 'TEXT')
    _add_column(conn, 'shipments', 'origin_station', 'TEXT')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_shipments_dest ON shipments(destination_station)')

    # Incidents carry the station whose response radius they fell in when they
    # were declared, so the roster that owns them is recorded rather than
    # recomputed from coordinates on every read.
    _add_column(conn, 'incidents', 'station', 'TEXT')

    # Home station — see the personnel table definition above.
    _add_column(conn, 'personnel', 'station', "TEXT NOT NULL DEFAULT 'Maitri'")
    conn.execute("UPDATE personnel SET station = 'Maitri' WHERE station IS NULL OR station = ''")
    # Indexed here rather than in the CREATE TABLE script above: on a database
    # that predates the column, CREATE TABLE IF NOT EXISTS is a no-op and the
    # index would reference a column that only this ALTER creates.
    conn.execute('CREATE INDEX IF NOT EXISTS idx_personnel_station ON personnel(station)')

    # Legacy rows seeded before personnel had distinct coordinates stacked on a
    # single point, which rendered as one map marker for the whole roster.
    for lat, lng, pid in (
        (-70.767, 11.731, 'per-priya'),
        (-70.769, 11.735, 'per-arjun'),
        (-70.771, 11.728, 'per-vikram'),
        (-70.765, 11.738, 'per-meera'),
        (-70.773, 11.734, 'per-raj'),
        (-70.763, 11.729, 'per-ananya'),
    ):
        conn.execute(
            'UPDATE personnel SET current_lat = ?, current_lng = ? WHERE id = ? '
            'AND (current_lat IS NULL OR current_lng IS NULL OR current_lat = current_lng)',
            (lat, lng, pid)
        )
    conn.commit()


def _seed_emergency_assets(conn) -> None:
    """Search-and-rescue assets for every station Prahari covers.

    Keyed by a stable id rather than "is the table empty", so adding a station
    later tops the table up instead of being skipped because Maitri's rows exist.
    """
    # One-time cleanup: the first version of this seed used random uuid ids, so
    # re-seeding would duplicate every Maitri asset rather than match it.
    conn.execute("DELETE FROM emergency_assets WHERE id NOT LIKE 'ast-%'")

    assets = [
        # id, name, type, lat, lng, station, status
        ('ast-mai-cat',  'Snowcat Alpha',        'vehicle',   -70.770, 11.740, 'Maitri',  'available'),
        ('ast-mai-sled', 'Emergency Sled',       'equipment', -70.780, 11.760, 'Maitri',  'available'),
        ('ast-mai-med',  'Medical Kit Station',  'medical',   -70.767, 11.735, 'Maitri',  'available'),
        ('ast-mai-heli', 'Rescue Helicopter',    'aircraft',  -70.765, 11.725, 'Maitri',  'standby'),
        ('ast-bha-cat',  'Snowcat Bravo',        'vehicle',   -69.410, 76.190, 'Bharati', 'available'),
        ('ast-bha-med',  'Medical Kit Bharati',  'medical',   -69.407, 76.187, 'Bharati', 'available'),
        ('ast-bha-boat', 'Rescue Boat Larsemann', 'vessel',   -69.401, 76.180, 'Bharati', 'standby'),
        ('ast-him-atv',  'Arctic ATV',           'vehicle',    78.925, 11.930, 'Himadri', 'available'),
        ('ast-him-med',  'Medical Kit Himadri',  'medical',    78.923, 11.923, 'Himadri', 'available'),
    ]
    conn.executemany(
        'INSERT OR IGNORE INTO emergency_assets '
        '(id, name, type, lat, lng, station, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
        assets
    )
    conn.commit()
