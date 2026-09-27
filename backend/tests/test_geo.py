"""Geodesy.

Pure functions, no database — and the place where a plausible-looking wrong
answer is most dangerous, because every distance, alarm and heading in the
console is built on them.
"""

import math

import pytest

from app.geo import (bearing_deg, check_geofences, check_route_deviation, compass_point,
                     distance_from_route_m, distance_to_segment_m, haversine_distance,
                     path_length_m)

MAITRI = (-70.767, 11.731)
CAMP_ALPHA = (-70.850, 11.950)
CREVASSE = {'id': 'gf-crevasse', 'name': 'Crevasse Zone', 'type': 'restricted',
            'center_lat': -70.820, 'center_lng': 11.880, 'radius_m': 800}


class TestHaversine:
    def test_zero_distance_to_itself(self):
        assert haversine_distance(*MAITRI, *MAITRI) == pytest.approx(0, abs=1e-6)

    def test_is_symmetric(self):
        there = haversine_distance(*MAITRI, *CAMP_ALPHA)
        back = haversine_distance(*CAMP_ALPHA, *MAITRI)
        assert there == pytest.approx(back)

    def test_one_degree_of_latitude_is_about_111km(self):
        assert haversine_distance(0, 0, 1, 0) == pytest.approx(111_195, rel=0.001)

    def test_a_degree_of_longitude_shrinks_towards_the_pole(self):
        """The reason a flat lat/lng delta cannot be used for bearing or
        distance at Antarctic latitudes: at Maitri's -70.8 a degree of
        longitude is roughly a third of what it is at the equator."""
        at_equator = haversine_distance(0, 0, 0, 1)
        at_maitri = haversine_distance(-70.767, 0, -70.767, 1)
        assert at_maitri < at_equator / 3

    def test_antipodal_points_do_not_blow_up(self):
        """The `a` term is clamped to [0, 1]; floating point can push it just
        past 1 for antipodes and make the sqrt return NaN."""
        distance = haversine_distance(0, 0, 0, 180)
        assert math.isfinite(distance)
        assert distance == pytest.approx(math.pi * 6371000, rel=0.001)


class TestBearing:
    @pytest.mark.parametrize('lat, lng, expected', [
        (1, 0, 0),      # due north
        (0, 1, 90),     # due east
        (-1, 0, 180),   # due south
        (0, -1, 270),   # due west
    ])
    def test_cardinal_directions_from_the_equator(self, lat, lng, expected):
        assert bearing_deg(0, 0, lat, lng) == pytest.approx(expected, abs=0.5)

    def test_is_always_in_range(self):
        for lat in (-80, -45, 0, 45, 80):
            for lng in (-170, -30, 30, 170):
                assert 0 <= bearing_deg(-70.767, 11.731, lat, lng) < 360

    def test_differs_from_the_flat_approximation_at_polar_latitude(self):
        """`atan2(dlng, dlat)` is the shortcut this function exists to avoid.
        At Maitri it is wrong by tens of degrees, which would point a heading
        read-out at the wrong part of the horizon."""
        spherical = bearing_deg(*MAITRI, *CAMP_ALPHA)
        flat = (math.degrees(math.atan2(CAMP_ALPHA[1] - MAITRI[1],
                                        CAMP_ALPHA[0] - MAITRI[0])) + 360) % 360
        assert abs(spherical - flat) > 20


class TestCompassPoint:
    @pytest.mark.parametrize('bearing, expected', [
        (0, 'N'), (22.5, 'NNE'), (45, 'NE'), (90, 'E'), (135, 'SE'),
        (180, 'S'), (225, 'SW'), (270, 'W'), (315, 'NW'),
    ])
    def test_sector_centres(self, bearing, expected):
        assert compass_point(bearing) == expected

    def test_sector_boundaries_land_on_the_nearer_point(self):
        """Sectors are 22.5 degrees wide and centred on their own point, so the
        NNE/NE boundary is 33.75 — not 45, and not 22.5. Getting this wrong
        shifts every label by half a sector."""
        assert compass_point(33.7) == 'NNE'
        assert compass_point(33.8) == 'NE'

    def test_wraps_past_360(self):
        assert compass_point(361) == compass_point(1)
        assert compass_point(-1) == compass_point(359)

    def test_359_degrees_reads_north_not_north_northwest(self):
        """Rounding, not truncation: the boundary is at 348.75."""
        assert compass_point(359) == 'N'


class TestSegmentDistance:
    def test_point_on_the_segment_is_at_zero(self):
        a, b = {'lat': -70.8, 'lng': 11.8}, {'lat': -70.9, 'lng': 11.9}
        midpoint = {'lat': -70.85, 'lng': 11.85}
        assert distance_to_segment_m(midpoint['lat'], midpoint['lng'], a, b) < 15

    def test_clamps_to_the_endpoint_rather_than_the_infinite_line(self):
        """A point beyond the end of a segment is measured to the endpoint. An
        unclamped projection would report it as being on the route."""
        a, b = {'lat': -70.80, 'lng': 11.80}, {'lat': -70.81, 'lng': 11.81}
        far_past_b = (-70.90, 11.90)
        to_segment = distance_to_segment_m(*far_past_b, a, b)
        to_endpoint = haversine_distance(*far_past_b, b['lat'], b['lng'])
        assert to_segment == pytest.approx(to_endpoint, rel=0.02)

    def test_degenerate_segment_does_not_divide_by_zero(self):
        a = b = {'lat': -70.8, 'lng': 11.8}
        assert distance_to_segment_m(-70.9, 11.9, a, b) > 0


class TestRouteDeviation:
    def test_walking_the_line_between_distant_waypoints_is_not_a_deviation(self):
        """The bug this replaced: measuring to the nearest *vertex* flags
        someone walking exactly the authorised line whenever two waypoints are
        more than twice the threshold apart."""
        route = [{'lat': -70.767, 'lng': 11.731}, {'lat': -70.850, 'lng': 11.950}]
        midpoint = (-70.8085, 11.8405)
        nearest_vertex = min(haversine_distance(*midpoint, wp['lat'], wp['lng'])
                             for wp in route)
        assert nearest_vertex > 2000                      # would have tripped a vertex check
        assert not check_route_deviation(*midpoint, route, threshold_m=2000)

    def test_a_genuine_excursion_is_flagged(self):
        route = [{'lat': -70.767, 'lng': 11.731}, {'lat': -70.850, 'lng': 11.950}]
        assert check_route_deviation(-70.60, 11.40, route, threshold_m=2000)

    def test_no_route_means_nothing_to_deviate_from(self):
        assert distance_from_route_m(-70.8, 11.8, []) is None
        assert not check_route_deviation(-70.8, 11.8, [])

    def test_single_waypoint_falls_back_to_point_distance(self):
        route = [{'lat': -70.767, 'lng': 11.731}]
        assert distance_from_route_m(*MAITRI, route) == pytest.approx(0, abs=1)


class TestGeofences:
    def test_a_point_inside_the_disc_is_reported(self):
        hits = check_geofences(CREVASSE['center_lat'], CREVASSE['center_lng'], [CREVASSE])
        assert [h['name'] for h in hits] == ['Crevasse Zone']

    def test_a_point_outside_is_not(self):
        assert check_geofences(*MAITRI, [CREVASSE]) == []

    def test_results_are_ordered_nearest_first(self):
        near = {**CREVASSE, 'id': 'near', 'name': 'Near', 'radius_m': 50_000}
        far = {**CREVASSE, 'id': 'far', 'name': 'Far',
               'center_lat': -70.9, 'radius_m': 50_000}
        hits = check_geofences(CREVASSE['center_lat'], CREVASSE['center_lng'], [near, far])
        assert [h['name'] for h in hits] == ['Near', 'Far']


class TestPathLength:
    def test_empty_and_single_point_paths_are_zero(self):
        assert path_length_m([]) == 0
        assert path_length_m([{'lat': -70.8, 'lng': 11.8}]) == 0

    def test_sums_the_legs(self):
        a = {'lat': -70.767, 'lng': 11.731}
        b = {'lat': -70.800, 'lng': 11.800}
        c = {'lat': -70.850, 'lng': 11.950}
        expected = (haversine_distance(a['lat'], a['lng'], b['lat'], b['lng'])
                    + haversine_distance(b['lat'], b['lng'], c['lat'], c['lng']))
        assert path_length_m([a, b, c]) == pytest.approx(expected)

    def test_a_detour_is_longer_than_the_direct_line(self):
        direct = [{'lat': MAITRI[0], 'lng': MAITRI[1]},
                  {'lat': CAMP_ALPHA[0], 'lng': CAMP_ALPHA[1]}]
        detoured = [direct[0], {'lat': -70.832, 'lng': 11.755}, direct[1]]
        assert path_length_m(detoured) > path_length_m(direct)
