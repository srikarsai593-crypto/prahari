"""GPS track simulation.

The simulator walks a person along the *actual* track recorded on their movement
plan. That track is derived from the authorised `planned_route` at plan-creation
time, so what the map draws and what the simulator replays always agree - the
previous version replayed a hard-coded module-level route regardless of where
the plan actually went, so every person walked the same Maitri -> Camp Alpha
line no matter what was authorised.
"""

import json

from datetime import timedelta

from .geo import bearing_deg, compass_point, haversine_distance, path_length_m
from .timeutil import to_utc_iso

# Number of GPS fixes emitted between two consecutive authorised waypoints.
#
# At 2, a four-segment route produced 9 fixes: a "6-hour traverse" was over in
# ~13 ticks and the dot teleported across the map faster than an operator could
# read a geofence boundary. At 8, the same route yields 33 fixes, and an
# 8-segment authorised route yields 65 - a continuous 90-130 s playback at the
# console's 1.5 s tick.
FIXES_PER_LEG = 8


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


def _utc_now():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc)


def _parse_iso(value):
    from datetime import datetime, timezone
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def get_telemetry(plan, track=None) -> dict | None:
    """Heading, ground speed, distance remaining and ETA for the current fix.

    Speed is derived from the authorised schedule rather than from wall-clock
    time between ticks: the plan says the traverse takes N hours and the track
    has M fixes, so each fix represents N/(M-1) hours of travel. Timing it
    against the operator's 1.5 s tick would report a snowcat doing 12,000 km/h.
    """
    track = _plan_track(plan) if track is None else track
    if len(track) < 2:
        return None
    step = min(plan['simulation_step'] or 0, len(track))
    if step < 1:
        return None
    index = min(step - 1, len(track) - 1)      # the fix just emitted
    current = track[index]
    previous = track[max(0, index - 1)]

    departure = _parse_iso(plan['departure_time'])
    arrival = _parse_iso(plan['expected_arrival'])
    total_hours = ((arrival - departure).total_seconds() / 3600
                   if departure and arrival and arrival > departure else None)
    hours_per_fix = total_hours / (len(track) - 1) if total_hours else None

    leg_m = haversine_distance(previous['lat'], previous['lng'], current['lat'], current['lng'])
    speed_kmh = round((leg_m / 1000) / hours_per_fix, 1) if hours_per_fix else None

    remaining_m = path_length_m(track[index:])
    eta_minutes = (round((len(track) - 1 - index) * hours_per_fix * 60)
                   if hours_per_fix is not None else None)

    if leg_m < 1:                               # degenerate leg carries no heading
        heading = None
    else:
        heading = bearing_deg(previous['lat'], previous['lng'], current['lat'], current['lng'])

    return {
        'heading_deg': round(heading) if heading is not None else None,
        'heading_compass': compass_point(heading) if heading is not None else None,
        'speed_kmh': speed_kmh,
        'distance_remaining_km': round(remaining_m / 1000, 2),
        'eta_minutes': eta_minutes,
        # Wall-clock arrival, so the card can render a real UTC time rather
        # than only a countdown that resets whenever the operator reloads.
        'eta_at': (to_utc_iso(_utc_now() + timedelta(minutes=eta_minutes))
                   if eta_minutes is not None else None),
    }


def progress_for(plan, track=None) -> dict | None:
    """How far along the authorised track this person is.

    Takes the plan row rather than an id, and optionally a track that has
    already been built. The roster renders progress and telemetry for every
    person, and each of those used to re-query the plan and re-parse and
    re-densify its route - three times the work, N times over.
    """
    if plan is None:
        return None
    track = _plan_track(plan) if track is None else track
    step = min(plan['simulation_step'] or 0, len(track))
    return {'step': step, 'total': len(track),
            'percent': round(100 * step / len(track)) if track else 0}


def playback_state(plan) -> dict:
    """Progress and telemetry from a single parse of the plan's route."""
    if plan is None:
        return {'progress': None, 'telemetry': None}
    track = _plan_track(plan)
    return {'progress': progress_for(plan, track),
            'telemetry': get_telemetry(plan, track)}


def get_progress(personnel_id: str, db) -> dict | None:
    """Convenience for callers that hold an id rather than the plan row."""
    return progress_for(get_latest_plan(personnel_id, db))


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
