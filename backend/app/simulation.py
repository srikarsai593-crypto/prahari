"""GPS track simulation.

The simulator walks a person along the *actual* track recorded on their movement
plan. That track is derived from the authorised `planned_route` at plan-creation
time, so what the map draws and what the simulator replays always agree - the
previous version replayed a hard-coded module-level route regardless of where
the plan actually went, so every person walked the same Maitri -> Camp Alpha
line no matter what was authorised.
"""

import json

# Number of GPS fixes emitted between two consecutive authorised waypoints.
FIXES_PER_LEG = 2


def _interpolate(a: dict, b: dict, steps: int) -> list[dict]:
    """Straight-line fixes from a (exclusive) to b (inclusive)."""
    return [
        {
            'lat': a['lat'] + (b['lat'] - a['lat']) * (i / steps),
            'lng': a['lng'] + (b['lng'] - a['lng']) * (i / steps),
        }
        for i in range(1, steps + 1)
    ]


def build_track(planned_route: list[dict]) -> list[dict]:
    """Densify an authorised route into the fix-by-fix track the GPS replays."""
    if not planned_route:
        return []
    track = [dict(planned_route[0])]
    for a, b in zip(planned_route, planned_route[1:]):
        track.extend(_interpolate(a, b, FIXES_PER_LEG))
    return track


def _plan_track(movement_plan) -> list[dict]:
    raw = movement_plan['planned_route']
    try:
        route = json.loads(raw) if isinstance(raw, str) else (raw or [])
    except (TypeError, ValueError):
        return []
    return build_track(route)


def get_latest_plan(personnel_id: str, db):
    return db.execute(
        'SELECT * FROM movement_plans WHERE personnel_id = ? '
        'ORDER BY departure_time DESC LIMIT 1',
        (personnel_id,)
    ).fetchone()


def get_next_position(personnel_id: str, db) -> dict | None:
    """Advance one fix along the plan's track.

    Returns the new position, or None when the track is exhausted. The step
    index lives in movement_plans.simulation_step, so a backend restart resumes
    where it left off instead of teleporting the person back to the start.
    """
    plan = get_latest_plan(personnel_id, db)
    if not plan:
        return None

    track = _plan_track(plan)
    step = plan['simulation_step'] or 0
    if step >= len(track):
        return None

    position = track[step]
    db.execute('UPDATE movement_plans SET simulation_step = ? WHERE id = ?',
               (step + 1, plan['id']))
    db.commit()
    return position


def get_progress(personnel_id: str, db) -> dict | None:
    """How far along the authorised track this person is."""
    plan = get_latest_plan(personnel_id, db)
    if not plan:
        return None
    track = _plan_track(plan)
    step = min(plan['simulation_step'] or 0, len(track))
    return {'step': step, 'total': len(track),
            'percent': round(100 * step / len(track)) if track else 0}


def reset_simulation(personnel_id: str, db) -> bool:
    """Rewind this person's latest plan to its first fix."""
    plan = get_latest_plan(personnel_id, db)
    if not plan:
        return False
    db.execute("UPDATE movement_plans SET simulation_step = 0, status = 'planned' WHERE id = ?",
               (plan['id'],))
    db.commit()
    return True


def get_planned_route(movement_plan) -> list[dict]:
    """The authorised waypoints for this plan - the baseline deviation is measured against."""
    raw = movement_plan['planned_route']
    try:
        return json.loads(raw) if isinstance(raw, str) else (raw or [])
    except (TypeError, ValueError):
        return []
