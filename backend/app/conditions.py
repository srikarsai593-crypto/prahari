"""Station weather conditions (the blizzard ΔT) shared by Cargo and Inventory.

Previously this was a module-level float in routes/shipments.py that every other
module reached into. That had three defects:
  * it was global, so a ΔT applied to one shipment changed the depletion curve
    for *every* station at once;
  * it was unbounded, so a single bad value drove all days-of-cover to zero;
  * it lived in process memory, so it silently reset on every backend restart
    while the shipment rows kept their elevated risk scores.

It is now per-station and persisted, so Cargo and Inventory always agree and
survive a restart.
"""

from .database import get_db
from .timeutil import utc_now_iso

MAX_DELTA_T = 60.0   # °C — matches models.MAX_DELTA_T
DEFAULT_DELTA_T = 0.0


def _clamp(delta_t: float) -> float:
    return max(0.0, min(float(delta_t), MAX_DELTA_T))


def set_delta_t(station: str, delta_t: float) -> float:
    value = _clamp(delta_t)
    db = get_db()
    db.execute(
        'INSERT INTO station_conditions (station, delta_t, updated_at) VALUES (?, ?, ?) '
        'ON CONFLICT(station) DO UPDATE SET delta_t = excluded.delta_t, '
        'updated_at = excluded.updated_at',
        (station, value, utc_now_iso())
    )
    db.commit()
    return value


def get_delta_t(station: str) -> float:
    row = get_db().execute(
        'SELECT delta_t FROM station_conditions WHERE station = ?', (station,)
    ).fetchone()
    return _clamp(row['delta_t']) if row else DEFAULT_DELTA_T


def all_delta_t() -> dict[str, float]:
    """Every station Prahari covers, not just the ones with a weather row.

    A station missing from this map made the dashboard render a blank where it
    should read "nominal" — absence of a reading is not the same as bad weather,
    but it is also not the same as no station.
    """
    from .models import Station  # local import: models imports nothing from here
    from typing import get_args

    readings = {s: DEFAULT_DELTA_T for s in get_args(Station)}
    for row in get_db().execute('SELECT station, delta_t FROM station_conditions').fetchall():
        readings[row['station']] = _clamp(row['delta_t'])
    return readings
