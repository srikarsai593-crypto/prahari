"""Cross-cutting platform behaviour: credentials, CORS, the audit log, reset.

These are the pieces that decide whether a *deployment* is sound, as opposed to
whether a feature works.
"""

import pytest

from app import auth
from app.routes.incidents import SOP_PLAYBOOKS


class TestCommanderKey:
    """Regression cover for a live misconfiguration: the Render blueprint set
    PRAHARI_COMMANDER_KEY while the code read PRAHARI_API_KEY, so the key was
    never read and every write fell through to the published demo key."""

    @pytest.fixture(autouse=True)
    def clean_env(self, monkeypatch):
        for name in ('PRAHARI_API_KEY', 'PRAHARI_COMMANDER_KEY', 'PRAHARI_ALLOW_DEMO_KEY'):
            monkeypatch.delenv(name, raising=False)

    def test_the_documented_name_is_read(self, monkeypatch):
        monkeypatch.setenv('PRAHARI_API_KEY', 'documented')
        assert auth.get_expected_key() == 'documented'

    def test_the_blueprint_s_name_is_read_too(self, monkeypatch):
        monkeypatch.setenv('PRAHARI_COMMANDER_KEY', 'blueprint')
        assert auth.get_expected_key() == 'blueprint'

    def test_the_documented_name_wins_when_both_are_set(self, monkeypatch):
        monkeypatch.setenv('PRAHARI_API_KEY', 'documented')
        monkeypatch.setenv('PRAHARI_COMMANDER_KEY', 'blueprint')
        assert auth.get_expected_key() == 'documented'

    @pytest.mark.parametrize('blank', ['', '   '])
    def test_a_blank_value_does_not_count_as_configured(self, monkeypatch, blank):
        monkeypatch.setenv('PRAHARI_API_KEY', blank)
        monkeypatch.setenv('PRAHARI_COMMANDER_KEY', 'blueprint')
        assert auth.get_expected_key() == 'blueprint'

    def test_no_key_with_the_demo_disabled_means_no_service(self, monkeypatch):
        """Fail closed: a hosted backend with no key refuses to start rather
        than coming up accepting a key anyone can read in the README."""
        monkeypatch.setenv('PRAHARI_ALLOW_DEMO_KEY', 'false')
        assert auth.get_expected_key() is None

    def test_the_demo_key_is_available_only_when_asked_for(self, monkeypatch):
        monkeypatch.setenv('PRAHARI_ALLOW_DEMO_KEY', 'true')
        assert auth.get_expected_key() == auth.DEMO_KEY


class TestWriteProtection:
    @pytest.mark.parametrize('method, url, body', [
        ('post', '/incidents', {'type': 'fire', 'location_lat': -70.7, 'location_lng': 11.7}),
        ('post', '/expeditions', {'name': 'X', 'station': 'Maitri',
                                  'personnel_required': 1, 'fuel_required_l': 1}),
        ('post', '/shipments', {'item_name': 'X', 'category': 'fuel', 'weight_kg': 1,
                                'destination_station': 'Maitri'}),
        ('post', '/shipments/weather', {'station': 'Maitri', 'delta_t': 10}),
        ('patch', '/inventory/inv-fuel', {'quantity': 1}),
        ('patch', '/inventory/inv-fuel/policy', {'safety_stock_days': 10}),
        ('post', '/admin/reset', {'confirm': 'RESET'}),
    ])
    def test_a_write_without_the_key_is_refused(self, station, method, url, body):
        response = getattr(station.client, method)(url, json=body)
        assert response.status_code == 401

    def test_a_wrong_key_is_refused(self, station):
        response = station.client.patch('/inventory/inv-fuel', json={'quantity': 1},
                                        headers={'X-Commander-Key': 'guessed'})
        assert response.status_code == 401

    @pytest.mark.parametrize('url', ['/inventory', '/personnel', '/incidents',
                                     '/shipments', '/expeditions', '/events', '/geofences'])
    def test_reads_are_open(self, station, url):
        assert station.client.get(url).status_code == 200


class TestCors:
    def test_the_headers_the_console_sends_are_allowed(self, station):
        response = station.client.options('/inventory', headers={
            'Origin': 'http://localhost:3000',
            'Access-Control-Request-Method': 'GET',
            'Access-Control-Request-Headers': 'x-commander-key, content-type'})
        assert response.status_code == 200
        assert 'X-Commander-Key' in response.headers['access-control-allow-headers']

    def test_the_allow_list_is_not_a_wildcard(self, station):
        """A wildcard is not honoured by browsers once credentials are in play,
        and it admits any header a caller cares to invent."""
        response = station.client.options('/inventory', headers={
            'Origin': 'http://localhost:3000',
            'Access-Control-Request-Method': 'GET',
            'Access-Control-Request-Headers': 'content-type'})
        assert response.headers['access-control-allow-headers'].strip() != '*'

    def test_an_undeclared_header_is_refused_at_preflight(self, station):
        response = station.client.options('/inventory', headers={
            'Origin': 'http://localhost:3000',
            'Access-Control-Request-Method': 'GET',
            'Access-Control-Request-Headers': 'x-smuggled'})
        allowed = response.headers.get('access-control-allow-headers', '').lower()
        assert response.status_code != 200 or 'x-smuggled' not in allowed

    def test_an_unlisted_origin_gets_no_grant(self, station):
        response = station.client.get('/inventory', headers={'Origin': 'http://evil.example'})
        assert 'access-control-allow-origin' not in response.headers


class TestAuditLog:
    def test_events_are_ordered_causally_not_by_the_clock(self, station):
        """A single action emits several events inside the same second;
        sorting by created_at alone shows effects before causes."""
        station.declare_incident()
        events = station.events(limit=50)
        assert [e['seq'] for e in events] == sorted((e['seq'] for e in events), reverse=True)

    def test_a_station_sees_its_own_entries_plus_system_wide_ones(self, station):
        station.declare_incident()
        stations = {e['station'] for e in station.events(station='Maitri', limit=200)}
        assert stations <= {'Maitri', None}

    def test_one_station_s_activity_is_not_reported_as_another_s(self, station):
        station.set_quantity('inv-fuel', 100)
        bharati = station.event_actions(station='Bharati', module='inventory', limit=200)
        assert not any('Maitri' in a for a in bharati)

    def test_the_browser_cannot_write_arbitrary_entries(self, station):
        """A client-writable trail with a free-form module, actor and message
        can be forged or flooded, and every other module is judged against it."""
        assert station.post('/events', json={'module': 'system', 'action': 'all clear'}
                            ).status_code in (404, 405)

    def test_the_queue_sync_report_composes_its_own_text(self, station):
        """The caller supplies counts, not prose."""
        station.json('post', '/events/sync-report',
                     json={'flushed': 3, 'dropped': 1, 'station': 'Maitri'})
        assert any('3 queued changes synced' in a and '1 rejected' in a
                   for a in station.event_actions(module='system', limit=50))

    def test_timestamps_are_all_zulu(self, station):
        station.declare_incident()
        assert all(e['created_at'].endswith('Z') for e in station.events(limit=50))


class TestStationReset:
    def test_it_reports_what_it_would_clear_before_it_is_run(self, station):
        station.declare_incident()
        assert station.json('get', '/admin/counts')['open_incidents'] == 1

    def test_operational_records_go_and_the_baseline_returns(self, station):
        station.declare_incident()
        station.ship()
        station.set_quantity('inv-fuel', 100)
        station.json('post', '/admin/reset', json={'confirm': 'RESET', 'scope': 'operational'})

        counts = station.json('get', '/admin/counts')
        assert counts['incidents'] == 0 and counts['shipments'] == 0
        assert station.item('Diesel Fuel')['quantity'] == 6500

    def test_orphaned_protocol_rows_are_cleared(self, station):
        """Nothing enforces a foreign key here, so they would otherwise
        accumulate across every exercise and never be reachable again."""
        incident = station.declare_incident(type='fire')
        station.patch(f'/incidents/{incident["id"]}/sop/klaxon', json={'done': True})
        assert station.scalar('SELECT COUNT(*) FROM incident_tasks') == len(
            SOP_PLAYBOOKS['fire'])

        station.json('post', '/admin/reset', json={'confirm': 'RESET'})
        assert station.scalar('SELECT COUNT(*) FROM incident_tasks') == 0

    def test_assets_are_released_not_just_marked_available(self, station):
        """Clearing the status without clearing the commitment leaves an asset
        pinned to a deleted incident, and dispatch then refuses it for ever."""
        incident = station.declare_incident()
        asset = next(a for a in station.json('get', '/incidents/assets?station=Maitri')
                     if a['name'] == 'Snowcat Alpha')
        station.patch(f'/incidents/assets/{asset["id"]}/dispatch',
                      json={'incident_id': incident['id']})

        station.json('post', '/admin/reset', json={'confirm': 'RESET'})
        assert station.scalar('SELECT COUNT(*) FROM emergency_assets '
                              'WHERE assigned_incident_id IS NOT NULL') == 0

        # The consequence that matters: it can be tasked again.
        fresh = station.declare_incident(type='medical')
        assert station.patch(f'/incidents/assets/{asset["id"]}/dispatch',
                             json={'incident_id': fresh['id']}).status_code == 200

    def test_crew_come_back_to_base_unassigned(self, station):
        crew = [p['id'] for p in station.personnel()[:2]]
        expedition = station.plan_expedition(personnel_required=2, crew_ids=crew)
        station.patch(f'/expeditions/{expedition["id"]}', json={'status': 'active'})

        station.json('post', '/admin/reset', json={'confirm': 'RESET'})
        assert all(p['status'] == 'at_station' and p['expedition_id'] is None
                   for p in station.personnel())

    def test_the_weather_returns_to_calm(self, station):
        station.set_weather(40)
        station.json('post', '/admin/reset', json={'confirm': 'RESET'})
        assert station.json('get', '/shipments/delta-t/current')['stations']['Maitri'] == 0

    def test_the_operational_scope_keeps_the_record_of_the_reset_itself(self, station):
        station.declare_incident()
        station.json('post', '/admin/reset', json={'confirm': 'RESET', 'scope': 'operational'})
        assert any('Station reset' in a for a in station.event_actions(limit=50))

    def test_the_wrong_confirmation_word_changes_nothing(self, station):
        station.declare_incident()
        assert station.post('/admin/reset', json={'confirm': 'yes'}).status_code == 422
        assert station.json('get', '/admin/counts')['open_incidents'] == 1


class TestServiceSurface:
    def test_health_states_the_ai_posture_and_client_count(self, station):
        """The two facts an operator needs before trusting a demo."""
        health = station.json('get', '/health')
        assert health['status'] == 'healthy'
        assert 'gemini_configured' in health['llm']
        assert isinstance(health['websocket_clients'], int)

    def test_the_internal_audit_suppression_flag_is_not_a_query_parameter(self, station):
        """Otherwise any caller could silently suppress the audit entry for a
        readiness check by appending ?log=false."""
        spec = station.json('get', '/openapi.json')
        params = spec['paths']['/expeditions/feasibility']['post'].get('parameters', [])
        assert not any(p['name'] == 'log' for p in params)

    def test_static_sub_routes_are_not_swallowed_by_path_parameters(self, station):
        """FastAPI matches in declaration order, so a literal segment declared
        after /{id} is bound as an id instead."""
        for url in ('/inventory/alerts', '/inventory/cross-station?item_name=fuel',
                    '/incidents/assets', '/personnel/movement-plans',
                    '/shipments/delta-t/current'):
            assert station.client.get(url).status_code == 200, url
