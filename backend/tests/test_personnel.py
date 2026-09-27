"""Roster, movement plans, GPS playback and the status state machine."""

import pytest


class TestRoster:
    def test_is_scoped_to_one_station(self, station):
        assert {p['station'] for p in station.personnel('Bharati')} == {'Bharati'}

    def test_everyone_starts_at_base_with_a_distinct_position(self, station):
        crew = station.personnel()
        assert {p['status'] for p in crew} == {'at_station'}
        positions = {(p['current_lat'], p['current_lng']) for p in crew}
        assert len(positions) == len(crew), 'stacked markers render as one dot'

    def test_nobody_at_base_is_flagged_for_a_stale_fix(self, station):
        """A stale-GPS warning on every row of the roster is how operators
        learn to ignore warnings. It only means something for someone out."""
        assert not any(p['location_update_warning'] for p in station.personnel())


class TestStatusMachine:
    def test_a_legal_transition_is_accepted(self, station):
        person = station.personnel()[0]
        result = station.json('patch', f'/personnel/{person["id"]}/status',
                              json={'status': 'in_transit'})
        assert result['status'] == 'in_transit'

    def test_you_cannot_appear_in_the_field_without_going_there(self, station):
        """'field' -> 'at_station' without passing through a transit state
        would quietly make someone count as confirmed safe during an incident."""
        person = station.personnel()[0]
        station.patch(f'/personnel/{person["id"]}/status', json={'status': 'in_transit'})
        station.patch(f'/personnel/{person["id"]}/status', json={'status': 'field'})
        response = station.patch(f'/personnel/{person["id"]}/status',
                                 json={'status': 'at_station'})
        assert response.status_code == 409

    def test_the_refusal_says_what_is_allowed_instead(self, station):
        person = station.personnel()[0]
        response = station.patch(f'/personnel/{person["id"]}/status',
                                 json={'status': 'returned'})
        assert response.status_code == 409
        assert 'in_transit' in response.json()['detail']

    def test_a_deviation_is_cleared_by_an_operator_not_by_the_tracker(self, station):
        """Someone has to say the person is back on route."""
        from app.routes.personnel import VALID_TRANSITIONS
        assert 'at_station' not in VALID_TRANSITIONS['deviated']
        assert VALID_TRANSITIONS['deviated'] >= {'in_transit', 'returned'}

    def test_a_closed_status_is_rejected_by_the_schema(self, station):
        person = station.personnel()[0]
        assert station.patch(f'/personnel/{person["id"]}/status',
                             json={'status': 'on_holiday'}).status_code == 422


class TestMovementPlans:
    def test_creating_one_puts_the_person_in_transit(self, station):
        person = station.personnel()[0]
        station.authorise_movement(person['id'])
        updated = next(p for p in station.personnel() if p['id'] == person['id'])
        assert updated['status'] == 'in_transit'
        assert updated['has_movement_plan'] is True

    def test_the_pre_flight_check_flags_the_crevasse_corridor(self, station):
        """The seed puts the Crevasse Zone on the Maitri -> Camp Alpha line on
        purpose, so the geofence engine raises this rather than a script."""
        plan = station.authorise_movement(station.personnel()[0]['id'])
        assert plan['route_warnings'] == ['Crevasse Zone']

    def test_a_corridor_routed_around_it_is_clean(self, station):
        detour = [{'lat': -70.767, 'lng': 11.731}, {'lat': -70.8319, 'lng': 11.7550},
                  {'lat': -70.850, 'lng': 11.950}]
        plan = station.authorise_movement(station.personnel()[0]['id'], route=detour)
        assert plan['route_warnings'] == []

    def test_the_warning_is_recorded_not_just_shown(self, station):
        station.authorise_movement(station.personnel()[0]['id'])
        assert any('PRE-FLIGHT WARNING' in a
                   for a in station.event_actions(module='personnel', station='Maitri'))

    def test_an_arrival_before_departure_is_refused(self, station):
        person = station.personnel()[0]
        response = station.post('/personnel/movement-plans', json={
            'personnel_id': person['id'],
            'origin_lat': -70.767, 'origin_lng': 11.731,
            'destination_lat': -70.85, 'destination_lng': 11.95,
            'destination_name': 'Camp Alpha',
            'planned_route': [{'lat': -70.767, 'lng': 11.731},
                              {'lat': -70.85, 'lng': 11.95}],
            'departure_time': '2026-01-01T06:00:00Z',
            'expected_arrival': '2026-01-01T00:00:00Z'})
        assert response.status_code == 422

    def test_an_unknown_person_is_a_404(self, station):
        response = station.post('/personnel/movement-plans', json={
            'personnel_id': 'per-nobody',
            'origin_lat': -70.767, 'origin_lng': 11.731,
            'destination_lat': -70.85, 'destination_lng': 11.95,
            'destination_name': 'Camp Alpha',
            'planned_route': [{'lat': -70.767, 'lng': 11.731},
                              {'lat': -70.85, 'lng': 11.95}],
            'departure_time': '2026-01-01T00:00:00Z',
            'expected_arrival': '2026-01-01T06:00:00Z'})
        assert response.status_code == 404


class TestGpsPlayback:
    def test_tracking_without_a_plan_refuses_instead_of_pretending(self, station):
        """This used to return 'arrived' and flip the person to 'field', so
        Start GPS appeared to work while moving nobody."""
        person = station.personnel()[0]
        assert station.post(f'/personnel/{person["id"]}/simulate-move').status_code == 409

    def test_each_tick_advances_one_fix(self, station):
        person = station.personnel()[0]
        station.authorise_movement(person['id'])
        steps = [tick['progress']['step'] for tick in
                 (station.json('post', f'/personnel/{person["id"]}/simulate-move')
                  for _ in range(5))]
        assert steps == [1, 2, 3, 4, 5]

    def test_progress_is_reported_on_every_tick(self, station):
        person = station.personnel()[0]
        station.authorise_movement(person['id'])
        tick = station.json('post', f'/personnel/{person["id"]}/simulate-move')
        assert tick['progress']['total'] > 12
        assert 0 <= tick['progress']['percent'] <= 100

    def test_telemetry_appears_once_there_is_movement_to_describe(self, station):
        person = station.personnel()[0]
        station.authorise_movement(person['id'])
        for _ in range(3):
            tick = station.json('post', f'/personnel/{person["id"]}/simulate-move')
        assert tick['telemetry']['speed_kmh'] > 0
        assert tick['telemetry']['distance_remaining_km'] > 0

    def test_the_roster_carries_progress_so_a_reload_does_not_blank_it(self, station):
        person = station.personnel()[0]
        station.authorise_movement(person['id'])
        for _ in range(4):
            station.post(f'/personnel/{person["id"]}/simulate-move')
        tracked = next(p for p in station.personnel() if p['id'] == person['id'])
        assert tracked['progress']['step'] == 4
        assert tracked['telemetry'] is not None

    def test_walking_the_corridor_trips_the_geofence(self, station):
        person = station.personnel()[0]
        station.authorise_movement(person['id'])
        alerts = [tick.get('alert') for tick in station.walk(person['id'])]
        violations = [a for a in alerts if a and a['type'] == 'geofence_violation']
        assert violations, 'the seeded route runs through the Crevasse Zone'
        assert violations[0]['severity'] == 'critical'

    def test_a_violation_sticks_to_the_person_not_just_the_plan(self, station):
        """Writing it only onto the plan meant the roster snapped back to "in
        transit" on the next refresh and the red state lasted one render."""
        person = station.personnel()[0]
        station.authorise_movement(person['id'])
        for tick in station.walk(person['id']):
            if tick.get('alert'):
                break
        assert next(p for p in station.personnel()
                    if p['id'] == person['id'])['status'] == 'deviated'

    def test_a_deviated_person_is_not_quietly_reset_by_the_next_fix(self, station):
        person = station.personnel()[0]
        station.authorise_movement(person['id'])
        for tick in station.walk(person['id']):
            if tick.get('alert'):
                break
        station.post(f'/personnel/{person["id"]}/simulate-move')
        assert next(p for p in station.personnel()
                    if p['id'] == person['id'])['status'] == 'deviated'

    def test_the_track_ends_in_an_arrival(self, station):
        person = station.personnel()[0]
        detour = [{'lat': -70.767, 'lng': 11.731}, {'lat': -70.8319, 'lng': 11.7550},
                  {'lat': -70.850, 'lng': 11.950}]
        station.authorise_movement(person['id'], route=detour)
        ticks = list(station.walk(person['id']))
        assert ticks[-1]['status'] == 'arrived'
        assert ticks[-1]['destination'] == 'Camp Alpha'

    def test_a_reset_rewinds_to_the_plan_origin(self, station):
        """Not to a hard-coded Maitri coordinate — a Bharati plan rewinds to
        where that plan actually started."""
        person = station.personnel()[0]
        plan = station.authorise_movement(person['id'])
        for _ in range(5):
            station.post(f'/personnel/{person["id"]}/simulate-move')
        result = station.json('post', f'/personnel/{person["id"]}/reset-simulation')
        assert result['position']['lat'] == pytest.approx(plan['origin_lat'])
        assert next(p for p in station.personnel()
                    if p['id'] == person['id'])['status'] == 'at_station'

    def test_playback_survives_a_restart(self, station):
        """The cursor lives in the database, not in process memory, so a
        backend restart resumes instead of teleporting the person home."""
        person = station.personnel()[0]
        station.authorise_movement(person['id'])
        for _ in range(3):
            station.post(f'/personnel/{person["id"]}/simulate-move')
        assert station.scalar(
            'SELECT simulation_step FROM movement_plans WHERE personnel_id = ?',
            (person['id'],)) == 3


class TestSos:
    def test_declares_a_critical_incident_at_the_last_known_position(self, station):
        person = station.personnel()[0]
        result = station.json('post', f'/personnel/{person["id"]}/sos')
        incident = station.json('get', f'/incidents/{result["incident_id"]}')
        assert incident['severity'] == 'critical'
        assert incident['location_lat'] == pytest.approx(person['current_lat'])

    def test_the_person_is_no_longer_in_transit(self, station):
        person = station.personnel()[0]
        station.post(f'/personnel/{person["id"]}/sos')
        assert next(p for p in station.personnel()
                    if p['id'] == person['id'])['status'] == 'sos'

    def test_without_a_position_it_refuses_rather_than_guessing(self, station):
        person = station.personnel()[0]
        station.db.execute('UPDATE personnel SET current_lat = NULL, current_lng = NULL '
                           'WHERE id = ?', (person['id'],))
        station.db.commit()
        assert station.post(f'/personnel/{person["id"]}/sos').status_code == 409


class TestAccountability:
    def test_only_verified_locations_count_as_safe(self, station):
        """'field' means out there somewhere, not confirmed safe. Counting it
        as safe is how people get left behind."""
        result = station.json('get', '/personnel/accountability/check'
                                     '?lat=-70.767&lng=11.731&radius=5000')
        assert result['unaccounted'] == 0

        person = station.personnel()[0]
        station.patch(f'/personnel/{person["id"]}/status', json={'status': 'in_transit'})
        after = station.json('get', '/personnel/accountability/check'
                                    '?lat=-70.767&lng=11.731&radius=5000')
        assert after['unaccounted'] == 1

    def test_the_read_only_check_does_not_write(self, station):
        before = station.scalar('SELECT COUNT(*) FROM events')
        station.get('/personnel/accountability/check?lat=-70.767&lng=11.731&radius=5000')
        assert station.scalar('SELECT COUNT(*) FROM events') == before
