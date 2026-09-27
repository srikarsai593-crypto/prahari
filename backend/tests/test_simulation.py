"""GPS track densification, playback cursor and derived telemetry."""

import pytest

from app.geo import haversine_distance
from app.simulation import FIXES_PER_LEG, build_track, get_planned_route, get_telemetry

MAITRI = {'lat': -70.767, 'lng': 11.731}
CAMP_ALPHA = {'lat': -70.850, 'lng': 11.950}
CREVASSE = (-70.820, 11.880, 800)     # lat, lng, radius_m


def straight_route(segments=5):
    return [{'lat': round(MAITRI['lat'] + (CAMP_ALPHA['lat'] - MAITRI['lat']) * i / segments, 6),
             'lng': round(MAITRI['lng'] + (CAMP_ALPHA['lng'] - MAITRI['lng']) * i / segments, 6)}
            for i in range(segments + 1)]


def plan(route, step, departure='2026-01-01T00:00:00Z', arrival='2026-01-01T06:00:00Z'):
    """The subset of a movement_plans row the simulator reads."""
    import json
    return {'planned_route': json.dumps(route), 'simulation_step': step,
            'departure_time': departure, 'expected_arrival': arrival}


class TestBuildTrack:
    def test_densifies_every_leg(self):
        route = straight_route(segments=5)
        assert len(build_track(route)) == 1 + 5 * FIXES_PER_LEG

    def test_keeps_the_authorised_endpoints_exactly(self):
        track = build_track(straight_route())
        assert track[0] == pytest.approx(straight_route()[0], abs=1e-9)
        assert track[-1]['lat'] == pytest.approx(CAMP_ALPHA['lat'], abs=1e-6)
        assert track[-1]['lng'] == pytest.approx(CAMP_ALPHA['lng'], abs=1e-6)

    def test_every_authorised_waypoint_survives_densification(self):
        """Fixes are inserted between waypoints, never instead of them — the
        corridor an operator authorised has to be the one that is walked."""
        route = straight_route(segments=5)
        track = build_track(route)
        for i, waypoint in enumerate(route):
            fix = track[i * FIXES_PER_LEG]
            assert fix['lat'] == pytest.approx(waypoint['lat'], abs=1e-9)
            assert fix['lng'] == pytest.approx(waypoint['lng'], abs=1e-9)

    def test_is_long_enough_to_be_watched(self):
        """The reason FIXES_PER_LEG is not 2. At a 1.5 s console tick a track
        this long plays for roughly a minute and a half; at 2 fixes per leg the
        same traverse was over in about twenty seconds."""
        assert len(build_track(straight_route())) >= 40

    def test_reaches_the_crevasse_well_before_the_scenario_guard(self):
        """The guided walkthrough walks until the geofence alarm fires. This
        pins the fix it fires on, so raising the fix density again cannot
        silently move the alarm past the runaway guard (120) the way going
        from 2 to 8 moved it past the old hard-coded 12."""
        track = build_track(straight_route())
        first_hit = next(i for i, p in enumerate(track)
                         if haversine_distance(p['lat'], p['lng'],
                                               CREVASSE[0], CREVASSE[1]) <= CREVASSE[2])
        assert 12 < first_hit < 120

    def test_empty_route_yields_no_track(self):
        assert build_track([]) == []

    def test_single_waypoint_yields_one_fix(self):
        assert build_track([MAITRI]) == [MAITRI]


class TestPlannedRoute:
    def test_reads_a_json_string(self):
        assert get_planned_route({'planned_route': '[{"lat": 1, "lng": 2}]'}) \
            == [{'lat': 1, 'lng': 2}]

    def test_malformed_json_is_no_route_rather_than_a_crash(self):
        assert get_planned_route({'planned_route': 'not json'}) == []

    def test_null_route_is_empty(self):
        assert get_planned_route({'planned_route': None}) == []


class TestTelemetry:
    def test_absent_before_the_first_fix(self):
        assert get_telemetry(plan(straight_route(), step=0)) is None

    def test_needs_a_route_with_something_to_walk(self):
        assert get_telemetry(plan([MAITRI], step=1)) is None

    def test_heading_is_a_compass_bearing(self):
        telemetry = get_telemetry(plan(straight_route(), step=5))
        assert 0 <= telemetry['heading_deg'] <= 360
        assert telemetry['heading_compass'] in (
            'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
            'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW')

    def test_heading_points_south_east_towards_camp_alpha(self):
        telemetry = get_telemetry(plan(straight_route(), step=5))
        assert telemetry['heading_compass'] in ('SE', 'SSE', 'ESE')

    def test_speed_comes_from_the_authorised_schedule(self):
        """Not from wall-clock time between console ticks. A 14 km traverse
        authorised over 6 hours is a ~2.3 km/h walk however fast the operator's
        browser is polling; timing the tick would report thousands of km/h."""
        route = straight_route()
        track_length_km = sum(
            haversine_distance(a['lat'], a['lng'], b['lat'], b['lng'])
            for a, b in zip(route, route[1:])) / 1000
        telemetry = get_telemetry(plan(route, step=5))
        assert telemetry['speed_kmh'] == pytest.approx(track_length_km / 6, rel=0.05)

    def test_halving_the_authorised_duration_doubles_the_speed(self):
        route = straight_route()
        slow = get_telemetry(plan(route, step=5, arrival='2026-01-01T06:00:00Z'))
        fast = get_telemetry(plan(route, step=5, arrival='2026-01-01T03:00:00Z'))
        # Reported to one decimal, so the slow figure carries up to 0.05 of
        # rounding error which doubling turns into 0.1, plus 0.05 of its own.
        assert fast['speed_kmh'] == pytest.approx(slow['speed_kmh'] * 2, abs=0.15)

    def test_distance_remaining_falls_monotonically(self):
        route = straight_route()
        total = len(build_track(route))
        remaining = [get_telemetry(plan(route, step=s))['distance_remaining_km']
                     for s in range(1, total + 1)]
        assert all(a >= b for a, b in zip(remaining, remaining[1:]))

    def test_distance_remaining_reaches_zero_at_the_destination(self):
        route = straight_route()
        final = get_telemetry(plan(route, step=len(build_track(route))))
        assert final['distance_remaining_km'] == pytest.approx(0, abs=0.01)

    def test_eta_shrinks_as_the_party_advances(self):
        route = straight_route()
        early = get_telemetry(plan(route, step=2))['eta_minutes']
        late = get_telemetry(plan(route, step=30))['eta_minutes']
        assert late < early

    def test_eta_is_reported_as_a_wall_clock_time_too(self):
        telemetry = get_telemetry(plan(straight_route(), step=5))
        assert telemetry['eta_at'].endswith('Z')

    def test_a_plan_with_no_duration_still_reports_position_facts(self):
        """Distance remaining does not depend on the schedule, so an arrival
        time that is missing or inverted must not take the whole read-out with
        it — it only removes the figures that are genuinely unknowable."""
        telemetry = get_telemetry(plan(straight_route(), step=5,
                                       arrival='2026-01-01T00:00:00Z'))
        assert telemetry['speed_kmh'] is None
        assert telemetry['eta_minutes'] is None
        assert telemetry['distance_remaining_km'] > 0
        assert telemetry['heading_deg'] is not None

    def test_a_step_past_the_end_does_not_run_off_the_track(self):
        route = straight_route()
        assert get_telemetry(plan(route, step=len(build_track(route)) + 50)) is not None
