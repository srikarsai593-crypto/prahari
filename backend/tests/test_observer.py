"""Read-only observer access.

Someone handed the link — an evaluator, a visiting scientist — otherwise
meets a key prompt and a console correctly refusing to show them anything.
These pin the middle ground: a real session that reads everything and writes
nothing, and that cannot promote itself.
"""

import pytest

from app import auth


@pytest.fixture
def open_station(db_path, offline_llm, monkeypatch):
    """A station that offers observer access."""
    monkeypatch.setenv('PRAHARI_ALLOW_OBSERVER', 'true')
    from fastapi.testclient import TestClient

    from app.main import app
    from tests.conftest import Station
    with TestClient(app) as client:
        yield Station(client)


class TestTakingAView:
    def test_it_is_refused_unless_the_station_offers_it(self, station):
        """Whether the roster is shareable is a decision for whoever runs the
        station, not a default."""
        response = station.client.post('/auth/observer')
        assert response.status_code == 403
        assert 'does not offer observer access' in response.json()['detail']

    def test_an_observer_can_take_a_session_without_the_key(self, open_station):
        response = open_station.client.post('/auth/observer')
        assert response.status_code == 200
        assert response.json()['role'] == auth.OBSERVER
        assert response.json()['can_write'] is False

    def test_the_session_is_a_real_cookie_not_an_open_door(self, open_station):
        response = open_station.client.post('/auth/observer')
        assert 'set-cookie' in {h.lower() for h in response.headers}
        assert response.json()['expires_at'] > 0

    def test_the_sign_in_screen_is_told_when_it_is_offered(self, open_station):
        assert open_station.client.get('/auth/session').json()['observer_enabled'] is True

    def test_the_sign_in_screen_is_told_when_it_is_not(self, station):
        assert station.client.get('/auth/session').json()['observer_enabled'] is False

    def test_arriving_is_on_the_record(self, open_station):
        open_station.client.post('/auth/observer')
        assert any('Observer opened a read-only view' in a
                   for a in open_station.event_actions(module='system', limit=20))


class TestWhatAnObserverCanSee:
    def test_every_module_reads(self, open_station):
        open_station.client.post('/auth/observer')
        for url in ('/inventory?station=Maitri', '/shipments?station=Maitri',
                    '/personnel?station=Maitri', '/incidents', '/expeditions',
                    '/events?limit=5', '/incidents/assets'):
            assert open_station.client.get(url).status_code == 200, url

    def test_the_session_endpoint_reports_the_limit(self, open_station):
        open_station.client.post('/auth/observer')
        state = open_station.client.get('/auth/session').json()
        assert state['authenticated'] is True
        assert state['role'] == auth.OBSERVER
        assert state['can_write'] is False


class TestWhatAnObserverCannotDo:
    @pytest.mark.parametrize('method, url, body', [
        ('post', '/incidents', {'type': 'fire', 'location_lat': -70.7, 'location_lng': 11.7}),
        ('post', '/shipments', {'item_name': 'X', 'category': 'fuel', 'weight_kg': 1,
                                'destination_station': 'Maitri'}),
        ('patch', '/inventory/inv-fuel', {'quantity': 1}),
        ('post', '/shipments/weather', {'station': 'Maitri', 'delta_t': 10}),
        ('post', '/admin/reset', {'confirm': 'RESET'}),
        ('post', '/admin/demo-season', {}),
    ])
    def test_every_write_is_refused(self, open_station, method, url, body):
        open_station.client.post('/auth/observer')
        response = getattr(open_station.client, method)(url, json=body)
        assert response.status_code == 403
        assert 'read-only' in response.json()['detail']

    def test_the_refusal_is_403_not_401(self, open_station):
        """Signing in again will not help — the caller is already who they say
        they are. The console reads the status to decide whether to offer a
        sign-in or explain the limit."""
        open_station.client.post('/auth/observer')
        assert open_station.client.post('/incidents', json={
            'type': 'fire', 'location_lat': -70.7, 'location_lng': 11.7,
        }).status_code == 403

    def test_the_station_record_is_untouched_by_a_refused_write(self, open_station):
        open_station.client.post('/auth/observer')
        open_station.client.patch('/inventory/inv-fuel', json={'quantity': 1})
        assert open_station.item('Diesel Fuel')['quantity'] == 6500


class TestItCannotPromoteItself:
    def test_the_role_is_inside_the_signature(self, open_station):
        """An observer editing the cookie to say commander must not work."""
        import base64
        import json

        open_station.client.post('/auth/observer')
        token = open_station.client.cookies.get(auth.SESSION_COOKIE)
        payload, signature = token.split('.')
        claims = json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))
        claims['role'] = auth.COMMANDER
        forged = base64.urlsafe_b64encode(
            json.dumps(claims, separators=(',', ':'), sort_keys=True).encode()
        ).decode().rstrip('=')

        open_station.client.cookies.set(auth.SESSION_COOKIE, f'{forged}.{signature}')
        assert open_station.client.post('/incidents', json={
            'type': 'fire', 'location_lat': -70.7, 'location_lng': 11.7,
        }).status_code == 401, 'a forged role was accepted'

    def test_the_api_key_is_always_a_commander(self, open_station):
        """Presenting the key outranks holding an observer cookie — otherwise
        a script would be downgraded by whatever the browser last did."""
        open_station.client.post('/auth/observer')
        assert open_station.post('/incidents', json={
            'type': 'fire', 'location_lat': -70.7, 'location_lng': 11.7,
        }).status_code == 200


class TestSigningOut:
    def test_an_observer_can_end_their_own_session(self, open_station):
        """Gated on identity rather than write access: an observer who could
        not sign out would be stuck in a read-only console."""
        open_station.client.post('/auth/observer')
        assert open_station.client.post('/auth/logout').status_code == 200
        assert open_station.client.get('/auth/session').json()['authenticated'] is False

    def test_a_commander_still_can(self, station):
        station.client.post('/auth/login', json={'key': auth.get_expected_key()})
        assert station.client.post('/auth/logout').status_code == 200

    def test_signing_out_names_who_left(self, open_station):
        open_station.client.post('/auth/observer')
        open_station.client.post('/auth/logout')
        assert any('Observer signed out' in a
                   for a in open_station.event_actions(module='system', limit=20))


class TestCommanderSessionsAreUnaffected:
    def test_a_commander_session_can_still_write(self, station):
        station.client.post('/auth/login', json={'key': auth.get_expected_key()})
        assert station.client.post('/incidents', json={
            'type': 'fire', 'location_lat': -70.7, 'location_lng': 11.7,
        }).status_code == 200

    def test_a_token_issued_before_roles_existed_is_still_a_commander(self, station):
        """Defaulting an unclaimed token to observer would sign working
        consoles out of their own writes the moment this deployed."""
        import base64
        import hashlib
        import hmac
        import json
        import time

        claims = {'sub': 'commander', 'exp': int(time.time()) + 3600}
        payload = base64.urlsafe_b64encode(
            json.dumps(claims, separators=(',', ':'), sort_keys=True).encode()
        ).decode().rstrip('=')
        signature = base64.urlsafe_b64encode(
            hmac.new(auth._session_secret(), payload.encode(), hashlib.sha256).digest()
        ).decode().rstrip('=')

        station.client.cookies.set(auth.SESSION_COOKIE, f'{payload}.{signature}')
        assert station.client.post('/incidents', json={
            'type': 'fire', 'location_lat': -70.7, 'location_lng': 11.7,
        }).status_code == 200
