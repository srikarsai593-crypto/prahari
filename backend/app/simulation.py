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

# Track simulation state per personnel (in-memory)
simulation_state: dict[str, int] = {}

def get_next_position(personnel_id: str) -> dict | None:
    """Advance one step along the demo route. Returns new position or None if complete."""
    current = simulation_state.get(personnel_id, 0)
    if current >= len(DEMO_ROUTE):
        return None
    position = DEMO_ROUTE[current]
    simulation_state[personnel_id] = current + 1
    return position

def reset_simulation(personnel_id: str):
    simulation_state[personnel_id] = 0

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
