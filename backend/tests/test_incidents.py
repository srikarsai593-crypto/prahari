"""Accountability, response protocols, asset dispatch and live escalation."""

import pytest

from app.routes.incidents import SOP_PLAYBOOKS


class TestAccountability:
    def test_declaring_an_incident_counts_who_is_inside_it(self, station):
        incident = station.declare_incident(affected_radius_m=5000)
        assert incident['expected_count'] == len(station.personnel())
        assert incident['unaccounted_count'] == 0

    def test_someone_out_in_the_field_is_unaccounted_for(self, station):
        person = station.personnel()[0]
        station.patch(f'/personnel/{person["id"]}/status', json={'status': 'in_transit'})
        incident = station.declare_incident(affected_radius_m=5000)
        assert incident['unaccounted_count'] == 1

    def test_the_count_follows_people_as_they_report_in(self, station):
        person = station.personnel()[0]
        station.patch(f'/personnel/{person["id"]}/status', json={'status': 'in_transit'})
        incident = station.declare_incident(affected_radius_m=5000)
        assert incident['unaccounted_count'] == 1

        station.patch(f'/personnel/{person["id"]}/status', json={'status': 'returned'})
        recount = station.json('post', f'/incidents/{incident["id"]}/accountability')
        assert recount['unaccounted'] == 0

    def test_reading_the_count_does_not_rewrite_it(self, station):
        """This used to be a GET that mutated rows and broadcast, so any cache
        or prefetch silently rewrote emergency state."""
        incident = station.declare_incident()
        before = station.scalar('SELECT COUNT(*) FROM events')
        station.get(f'/incidents/{incident["id"]}/accountability')
        assert station.scalar('SELECT COUNT(*) FROM events') == before

    def test_an_incident_cannot_be_closed_over_a_missing_person(self, station):
        person = station.personnel()[0]
        station.patch(f'/personnel/{person["id"]}/status', json={'status': 'in_transit'})
        incident = station.declare_incident(affected_radius_m=5000)
        response = station.patch(f'/incidents/{incident["id"]}', json={'status': 'resolved'})
        assert response.status_code == 409
        assert 'unaccounted' in response.json()['detail']

    def test_it_closes_once_everyone_is_confirmed(self, station):
        incident = station.declare_incident(affected_radius_m=5000)
        assert station.json('patch', f'/incidents/{incident["id"]}',
                            json={'status': 'resolved'})['status'] == 'resolved'


class TestStationScope:
    def test_an_incident_is_attributed_to_the_nearest_station(self, station):
        assert station.declare_incident()['station'] == 'Maitri'

    def test_another_station_does_not_inherit_it(self, station):
        station.declare_incident()
        assert station.json('get', '/incidents?station=Bharati') == []

    def test_one_thousands_of_kilometres_away_belongs_to_its_own_base(self, station):
        incident = station.declare_incident(location_lat=-69.407, location_lng=76.187)
        assert incident['station'] == 'Bharati'


class TestResponseProtocol:
    def test_a_playbook_is_materialised_on_declaration(self, station):
        incident = station.declare_incident(type='fire')
        sop = station.json('get', f'/incidents/{incident["id"]}/sop')
        assert sop['total'] == len(SOP_PLAYBOOKS['fire'])
        assert sop['completed'] == 0

    @pytest.mark.parametrize('incident_type', sorted(SOP_PLAYBOOKS))
    def test_every_incident_type_has_one(self, station, incident_type):
        incident = station.declare_incident(type=incident_type)
        assert station.json('get', f'/incidents/{incident["id"]}/sop')['total'] > 0

    def test_ticking_a_step_records_who_and_when(self, station):
        incident = station.declare_incident(type='fire')
        result = station.json('patch', f'/incidents/{incident["id"]}/sop/manifold',
                              json={'done': True})
        step = next(t for t in result['tasks'] if t['task_key'] == 'manifold')
        assert step['done'] is True
        assert step['done_at'].endswith('Z')
        assert step['done_by'] == 'commander'

    def test_each_step_lands_in_the_audit_timeline(self, station):
        incident = station.declare_incident(type='fire')
        station.patch(f'/incidents/{incident["id"]}/sop/klaxon', json={'done': True})
        assert any('Response protocol step completed' in a
                   for a in station.event_actions(module='emergency', station='Maitri'))

    def test_a_step_can_be_reopened(self, station):
        incident = station.declare_incident(type='fire')
        station.patch(f'/incidents/{incident["id"]}/sop/klaxon', json={'done': True})
        result = station.json('patch', f'/incidents/{incident["id"]}/sop/klaxon',
                              json={'done': False})
        assert result['completed'] == 0

    def test_a_step_that_is_not_in_this_playbook_is_a_404(self, station):
        incident = station.declare_incident(type='fire')
        assert station.patch(f'/incidents/{incident["id"]}/sop/make_tea',
                             json={'done': True}).status_code == 404

    def test_the_playbook_is_idempotent_across_reads(self, station):
        incident = station.declare_incident(type='fire')
        for _ in range(3):
            station.json('get', f'/incidents/{incident["id"]}/sop')
        assert station.scalar('SELECT COUNT(*) FROM incident_tasks WHERE incident_id = ?',
                              (incident['id'],)) == len(SOP_PLAYBOOKS['fire'])


class TestAssetDispatch:
    def snowcat(self, station):
        return next(a for a in station.json('get', '/incidents/assets?station=Maitri')
                    if a['name'] == 'Snowcat Alpha')

    def test_deploying_commits_the_asset_and_moves_it_to_the_incident(self, station):
        incident = station.declare_incident()
        asset = self.snowcat(station)
        result = station.json('patch', f'/incidents/assets/{asset["id"]}/dispatch',
                              json={'incident_id': incident['id']})
        assert result['status'] == 'deployed'
        assert result['assigned_incident_id'] == incident['id']
        assert result['lat'] == pytest.approx(incident['location_lat'])

    def test_releasing_returns_it_to_service(self, station):
        incident = station.declare_incident()
        asset = self.snowcat(station)
        station.patch(f'/incidents/assets/{asset["id"]}/dispatch',
                      json={'incident_id': incident['id']})
        released = station.json('patch', f'/incidents/assets/{asset["id"]}/dispatch',
                                json={'incident_id': None})
        assert released['status'] == 'available'
        assert released['assigned_incident_id'] is None

    def test_one_asset_cannot_be_promised_to_two_incidents(self, station):
        first = station.declare_incident()
        second = station.declare_incident(type='medical')
        asset = self.snowcat(station)
        station.patch(f'/incidents/assets/{asset["id"]}/dispatch',
                      json={'incident_id': first['id']})
        response = station.patch(f'/incidents/assets/{asset["id"]}/dispatch',
                                 json={'incident_id': second['id']})
        assert response.status_code == 409
        assert 'already committed' in response.json()['detail']

    def test_re_deploying_to_the_same_incident_is_harmless(self, station):
        incident = station.declare_incident()
        asset = self.snowcat(station)
        station.patch(f'/incidents/assets/{asset["id"]}/dispatch',
                      json={'incident_id': incident['id']})
        assert station.patch(f'/incidents/assets/{asset["id"]}/dispatch',
                             json={'incident_id': incident['id']}).status_code == 200

    def test_closing_an_incident_hands_its_assets_back(self, station):
        """An asset left flagged deployed against a closed incident is help the
        next emergency believes it does not have."""
        incident = station.declare_incident(affected_radius_m=5000)
        asset = self.snowcat(station)
        station.patch(f'/incidents/assets/{asset["id"]}/dispatch',
                      json={'incident_id': incident['id']})
        station.patch(f'/incidents/{incident["id"]}', json={'status': 'resolved'})
        freed = self.snowcat(station)
        assert freed['status'] == 'available'
        assert freed['assigned_incident_id'] is None

    def test_deploying_to_a_closed_incident_is_refused(self, station):
        incident = station.declare_incident(affected_radius_m=5000)
        station.patch(f'/incidents/{incident["id"]}', json={'status': 'resolved'})
        assert station.patch(f'/incidents/assets/{self.snowcat(station)["id"]}/dispatch',
                             json={'incident_id': incident['id']}).status_code == 409

    def test_nearest_assets_are_ordered_by_distance(self, station):
        distances = [a['distance_m'] for a in station.json(
            'get', '/incidents/nearby-assets/search?lat=-70.767&lng=11.731')]
        assert distances == sorted(distances)


class TestEscalation:
    def test_severity_can_be_raised_on_a_live_incident(self, station):
        """Frozen severity meant an escalating fire could only be represented
        by resolving the record and declaring a new one — which discards the
        running head-count and the audit trail with it."""
        incident = station.declare_incident(severity='medium')
        result = station.json('patch', f'/incidents/{incident["id"]}',
                              json={'severity': 'critical'})
        assert result['severity'] == 'critical'
        assert 'severity medium -> critical' in ' '.join(result['notes'])

    def test_widening_the_perimeter_re_runs_the_head_count(self, station):
        """The whole point of being able to widen it. The old workaround —
        resolve and redeclare — threw the running count away."""
        crew = station.personnel()
        # Someone seeded away from the station origin, so a tight circle
        # genuinely excludes them and a wide one genuinely picks them up.
        outlying = max(crew, key=lambda p: abs(p['current_lat'] + 70.767))
        station.patch(f'/personnel/{outlying["id"]}/status', json={'status': 'in_transit'})

        incident = station.declare_incident(affected_radius_m=100)
        assert incident['expected_count'] < len(crew)
        assert incident['unaccounted_count'] == 0, 'the deployed member is outside the circle'

        widened = station.json('patch', f'/incidents/{incident["id"]}',
                               json={'affected_radius_m': 8000})
        assert widened['accountability']['expected'] == len(crew)
        assert widened['accountability']['unaccounted'] == 1

    def test_narrowing_the_perimeter_also_recounts(self, station):
        incident = station.declare_incident(affected_radius_m=8000)
        assert incident['expected_count'] == len(station.personnel())
        narrowed = station.json('patch', f'/incidents/{incident["id"]}',
                                json={'affected_radius_m': 100})
        assert narrowed['accountability']['expected'] < len(station.personnel())

    def test_the_incident_keeps_its_identity_and_its_history(self, station):
        incident = station.declare_incident(type='fire')
        station.patch(f'/incidents/{incident["id"]}/sop/klaxon', json={'done': True})
        station.json('patch', f'/incidents/{incident["id"]}',
                     json={'severity': 'critical', 'affected_radius_m': 6000})
        sop = station.json('get', f'/incidents/{incident["id"]}/sop')
        assert sop['completed'] == 1, 'the protocol record must survive an escalation'

    def test_an_empty_patch_is_refused(self, station):
        incident = station.declare_incident()
        assert station.patch(f'/incidents/{incident["id"]}', json={}).status_code == 422

    def test_status_alone_still_works(self, station):
        incident = station.declare_incident(affected_radius_m=5000)
        assert station.json('patch', f'/incidents/{incident["id"]}',
                            json={'status': 'resolved'})['status'] == 'resolved'

    def test_an_unknown_incident_is_a_404(self, station):
        assert station.patch('/incidents/inc-nope', json={'severity': 'high'}).status_code == 404


class TestPowerFailure:
    def test_declares_a_real_incident_not_just_a_toast(self, station):
        """This used to log a line and broadcast a notification, changing
        nothing: the drill exercised none of the machinery it was meant to."""
        result = station.json('post', '/incidents/power-failure', json={'station': 'Maitri'})
        incident = station.json('get', f'/incidents/{result["incident_id"]}')
        assert incident['type'] == 'power_failure'
        assert incident['status'] == 'open'

    def test_it_comes_with_its_own_protocol(self, station):
        result = station.json('post', '/incidents/power-failure', json={'station': 'Maitri'})
        assert station.json('get', f'/incidents/{result["incident_id"]}/sop')['total'] > 0
