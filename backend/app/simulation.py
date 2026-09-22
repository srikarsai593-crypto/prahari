import json

# Pre-scripted demo route: Maitri -> Camp Alpha with deliberate deviation into Crevasse Zone
DEMO_ROUTE = [
    {'lat': -70.767, 'lng': 11.731},    # Start: Maitri Station
    {'lat': -70.775, 'lng': 11.750},    # Step 1: heading southeast
    {'lat': -70.783, 'lng': 11.770},    # Step 2
    {'lat': -70.790, 'lng': 11.800},    # Step 3
    {'lat': -70.800, 'lng': 11.830},    # Step 4
    {'lat': -70.810, 'lng': 11.860},    # Step 5
    {'lat': -70.815, 'lng': 11.875},    # Step 6: veering toward restricted zone
    {'lat': -70.820, 'lng': 11.880},    # Step 7: INSIDE Crevasse Zone -> ALERT
    {'lat': -70.825, 'lng': 11.885},    # Step 8: still in restricted zone
    {'lat': -70.840, 'lng': 11.930},    # Step 9: back on route
    {'lat': -70.850, 'lng': 11.950},    # Step 10: Camp Alpha
]


def get_next_position(personnel_id: str, db) -> dict | None:
    """Advance one step along the demo route using DB-persisted step index.
    Returns new position or None if simulation is complete.
    State is stored in movement_plans.simulation_step — backend restarts are safe."""
    mp = db.execute(
        'SELECT id, simulation_step FROM movement_plans WHERE personnel_id = ? ORDER BY departure_time DESC LIMIT 1',
        (personnel_id,)
    ).fetchone()

    if not mp:
        return None

    current_step = mp['simulation_step'] or 0
    if current_step >= len(DEMO_ROUTE):
        return None

    position = DEMO_ROUTE[current_step]
    db.execute(
        'UPDATE movement_plans SET simulation_step = ? WHERE id = ?',
        (current_step + 1, mp['id'])
    )
    db.commit()
    return position


def reset_simulation(personnel_id: str, db):
    """Reset simulation step to 0 in the DB for this person's latest plan."""
    db.execute(
        'UPDATE movement_plans SET simulation_step = 0 WHERE personnel_id = ?',
        (personnel_id,)
    )
    db.commit()


def get_planned_route():
    """Return the normal planned route (excluding deviation waypoints)."""
    return [
        {'lat': -70.767, 'lng': 11.731},
        {'lat': -70.775, 'lng': 11.750},
        {'lat': -70.783, 'lng': 11.770},
        {'lat': -70.790, 'lng': 11.800},
        {'lat': -70.800, 'lng': 11.830},
        {'lat': -70.810, 'lng': 11.860},
        {'lat': -70.840, 'lng': 11.930},
        {'lat': -70.850, 'lng': 11.950},
    ]

