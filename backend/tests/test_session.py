"""Session sign-in, the signed token, and the rate limit protecting it.

The reason this exists: the commander key used to ship in the browser bundle as
`NEXT_PUBLIC_COMMANDER_KEY`, so anyone who opened devtools on the hosted
console could read the credential that authorises every write.
"""

import time

import pytest

from app import auth, ratelimit


class TestSessionToken:
    def test_a_token_this_server_issued_is_accepted(self):
        token, _ = auth.issue_session()
        assert auth.read_session(token)['sub'] == 'commander'

    def test_a_tampered_payload_is_rejected(self):
        token, _ = auth.issue_session()
        payload, signature = token.split('.')
        assert auth.read_session(f'{payload}x.{signature}') is None

    def test_a_forged_signature_is_rejected(self):
        payload = auth.issue_session()[0].split('.')[0]
        assert auth.read_session(f'{payload}.notarealsignature') is None

    def test_an_expired_token_is_rejected(self):
        token, _ = auth.issue_session(ttl=-1)
        assert auth.read_session(token) is None

    @pytest.mark.parametrize('rubbish', [None, '', 'nodot', 'too.many.dots', '.', 'a.'])
    def test_malformed_tokens_do_not_crash(self, rubbish):
        assert auth.read_session(rubbish) is None

    def test_rotating_the_key_invalidates_live_sessions(self, monkeypatch):
        """The secret is derived from the commander key when none is set, so
        rotation means what an operator expects it to mean."""
        monkeypatch.setenv('PRAHARI_API_KEY', 'first-key')
        token, _ = auth.issue_session()
        assert auth.read_session(token) is not None

        monkeypatch.setenv('PRAHARI_API_KEY', 'rotated-key')
        assert auth.read_session(token) is None

    def test_an_explicit_secret_survives_key_rotation(self, monkeypatch):
        monkeypatch.setenv('PRAHARI_SESSION_SECRET', 'a-stable-secret')
        monkeypatch.setenv('PRAHARI_API_KEY', 'first-key')
        token, _ = auth.issue_session()
        monkeypatch.setenv('PRAHARI_API_KEY', 'rotated-key')
        assert auth.read_session(token) is not None

    def test_the_expiry_is_reported_so_a_console_can_renew(self):
        _, expires_at = auth.issue_session()
        assert expires_at > time.time()


class TestSignIn:
    def test_the_right_key_returns_a_cookie(self, station):
        response = station.client.post('/auth/login',
                                       json={'key': auth.get_expected_key()})
        assert response.status_code == 200
        assert response.json()['authenticated'] is True
        assert auth.SESSION_COOKIE in response.cookies

    def test_the_cookie_is_not_readable_by_page_script(self, station):
        """httpOnly is the whole point: an XSS on the console must not be able
        to lift the credential and use it later from anywhere."""
        response = station.client.post('/auth/login',
                                       json={'key': auth.get_expected_key()})
        header = response.headers['set-cookie'].lower()
        assert 'httponly' in header
        assert 'samesite=lax' in header

    def test_a_cookie_issued_over_tls_is_marked_secure(self, station):
        """Decided per request: a fixed secure=True would silently break every
        local console, because the browser simply does not store a Secure
        cookie over plain HTTP — sign-in would appear to work and the next
        request would be anonymous."""
        response = station.client.post('/auth/login',
                                       json={'key': auth.get_expected_key()},
                                       headers={'X-Forwarded-Proto': 'https'})
        assert 'secure' in response.headers['set-cookie'].lower()

    def test_a_cookie_issued_over_plain_http_is_not(self, station):
        response = station.client.post('/auth/login',
                                       json={'key': auth.get_expected_key()})
        assert 'secure' not in response.headers['set-cookie'].lower()

    def test_the_wrong_key_is_refused(self, station):
        assert station.client.post('/auth/login',
                                   json={'key': 'guessed'}).status_code == 401

    def test_an_empty_key_is_refused_by_the_schema(self, station):
        assert station.client.post('/auth/login', json={'key': ''}).status_code == 422

    def test_a_session_then_authorises_reads_and_writes(self, station):
        client = station.client
        assert client.get('/inventory').status_code == 401

        client.post('/auth/login', json={'key': auth.get_expected_key()})
        assert client.get('/inventory').status_code == 200
        assert client.patch('/inventory/inv-fuel',
                            json={'quantity': 6000, 'station': 'Maitri'}).status_code == 200

    def test_signing_out_ends_it(self, station):
        client = station.client
        client.post('/auth/login', json={'key': auth.get_expected_key()})
        assert client.get('/inventory').status_code == 200

        client.post('/auth/logout')
        client.cookies.clear()
        assert client.get('/inventory').status_code == 401

    def test_sign_in_and_sign_out_are_both_recorded(self, station):
        client = station.client
        client.post('/auth/login', json={'key': auth.get_expected_key()})
        client.post('/auth/logout')
        actions = station.event_actions(module='system', limit=50)
        assert any('signed in' in a for a in actions)
        assert any('signed out' in a for a in actions)

    def test_the_api_key_header_still_works_for_machine_callers(self, station):
        """A scanner or a script has nowhere to keep a cookie and no login
        screen to fill in."""
        assert station.client.get(
            '/inventory', headers={'X-Commander-Key': auth.get_expected_key()}
        ).status_code == 200


class TestSessionState:
    def test_it_can_be_asked_before_there_is_a_session(self, station):
        """The console has to be able to ask, and the answer is about the
        caller rather than about the station."""
        state = station.client.get('/auth/session').json()
        assert state['authenticated'] is False

    def test_it_reports_how_the_caller_was_recognised(self, station):
        by_key = station.client.get('/auth/session',
                                    headers={'X-Commander-Key': auth.get_expected_key()}).json()
        assert by_key['via'] == 'api_key'

        station.client.post('/auth/login', json={'key': auth.get_expected_key()})
        assert station.client.get('/auth/session').json()['via'] == 'session'

    def test_it_says_whether_the_demo_key_is_in_use(self, station):
        """So the sign-in screen can offer it rather than making someone go
        and find it."""
        state = station.client.get('/auth/session').json()
        assert state['demo_key_enabled'] is True
        assert state['demo_key'] == auth.DEMO_KEY

    def test_a_real_key_is_never_handed_out(self, db_path, monkeypatch, offline_llm):
        """The demo key is public by definition - it is printed in the README.
        A configured key is not, and the sign-in convenience must not turn into
        an endpoint that reads it back."""
        monkeypatch.setenv('PRAHARI_API_KEY', 'a-real-station-key')
        from fastapi.testclient import TestClient
        from app.main import app
        with TestClient(app) as client:
            state = client.get('/auth/session').json()
            assert state['demo_key_enabled'] is False
            assert state['demo_key'] is None


class TestLoginRateLimit:
    def test_repeated_failures_are_locked_out(self, station):
        """The key is a single shared secret; without a limit it is
        brute-forceable at network speed."""
        for _ in range(ratelimit.LOGIN_MAX_ATTEMPTS):
            assert station.client.post('/auth/login',
                                       json={'key': 'wrong'}).status_code == 401
        blocked = station.client.post('/auth/login', json={'key': 'wrong'})
        assert blocked.status_code == 429
        assert 'Retry-After' in blocked.headers

    def test_the_lockout_also_blocks_the_correct_key(self, station):
        """Otherwise an attacker simply keeps guessing until they are right."""
        for _ in range(ratelimit.LOGIN_MAX_ATTEMPTS):
            station.client.post('/auth/login', json={'key': 'wrong'})
        assert station.client.post('/auth/login',
                                   json={'key': auth.get_expected_key()}).status_code == 429

    def test_a_success_clears_the_history(self, station):
        """An operator who mistypes twice must not then be locked out by their
        own successful sign-in."""
        for _ in range(2):
            station.client.post('/auth/login', json={'key': 'wrong'})
        assert station.client.post('/auth/login',
                                   json={'key': auth.get_expected_key()}).status_code == 200
        for _ in range(ratelimit.LOGIN_MAX_ATTEMPTS):
            assert station.client.post('/auth/login',
                                       json={'key': 'wrong'}).status_code == 401


class TestWriteRateLimit:
    def test_a_runaway_client_is_throttled(self, station):
        limit = ratelimit.WRITE_MAX_REQUESTS
        codes = [station.patch('/inventory/inv-fuel',
                               json={'quantity': 6000, 'station': 'Maitri'}).status_code
                 for _ in range(limit + 3)]
        assert codes.count(429) >= 1
        assert codes[0] == 200, 'ordinary use must not be affected'

    def test_reads_are_never_throttled(self, station):
        """An operator refreshing a dashboard during an incident is the
        behaviour this console exists to serve."""
        assert all(station.get('/personnel').status_code == 200 for _ in range(60))


class TestSecurityHeaders:
    @pytest.mark.parametrize('header, value', [
        ('X-Content-Type-Options', 'nosniff'),
        ('X-Frame-Options', 'DENY'),
        ('Referrer-Policy', 'no-referrer'),
    ])
    def test_are_present(self, station, header, value):
        assert station.get('/inventory').headers[header] == value

    def test_an_authenticated_response_is_not_shared_cache_material(self, station):
        """The next operator through the same proxy must not be served the
        last one's roster."""
        assert 'no-store' in station.get('/personnel').headers['Cache-Control']


class TestWebSocketGate:
    def test_an_unauthenticated_socket_is_refused(self, station):
        from starlette.websockets import WebSocketDisconnect
        with pytest.raises(WebSocketDisconnect):
            with station.client.websocket_connect('/ws'):
                pass

    def test_a_signed_in_console_gets_telemetry(self, station):
        station.client.post('/auth/login', json={'key': auth.get_expected_key()})
        with station.client.websocket_connect('/ws') as socket:
            assert socket is not None


class TestWebSocketTicket:
    """The credential the telemetry socket carries when a cookie cannot reach it.

    A hosted console talks to this backend through the frontend's own origin,
    so its session cookie belongs to that host, and a platform rewrite will
    not carry a WebSocket upgrade for the cookie to travel on. The socket is
    opened against this origin directly instead, and a browser cannot put a
    header on a handshake — so the credential goes in the query string, and
    everything below is about that being safe.
    """

    def test_a_ticket_this_server_issued_is_accepted(self):
        ticket, _ = auth.issue_ws_ticket({'sub': 'commander', 'role': 'commander'})
        assert auth.read_ws_ticket(ticket)['sub'] == 'commander'

    def test_it_carries_the_role_rather_than_upgrading_it(self):
        ticket, _ = auth.issue_ws_ticket({'sub': 'observer', 'role': 'observer'})
        assert auth.read_ws_ticket(ticket)['role'] == 'observer'

    def test_a_forged_signature_is_rejected(self):
        payload = auth.issue_ws_ticket({'sub': 'commander'})[0].split('.')[0]
        assert auth.read_ws_ticket(f'{payload}.notarealsignature') is None

    def test_it_expires_within_the_minute(self):
        _, expires_at = auth.issue_ws_ticket({'sub': 'commander'})
        assert 0 < expires_at - time.time() <= auth.WS_TICKET_TTL_SECONDS

    def test_an_expired_ticket_is_rejected(self, monkeypatch):
        monkeypatch.setattr(auth, 'WS_TICKET_TTL_SECONDS', -1)
        ticket, _ = auth.issue_ws_ticket({'sub': 'commander'})
        assert auth.read_ws_ticket(ticket) is None

    @pytest.mark.parametrize('rubbish', [None, '', 'nodot', 'too.many.dots', '.', 'a.'])
    def test_malformed_tickets_do_not_crash(self, rubbish):
        assert auth.read_ws_ticket(rubbish) is None

    # ── The separation that makes a credential in a URL acceptable ───────

    def test_a_ticket_cannot_be_used_as_a_session(self):
        """The one that matters. A ticket rides in a query string and so ends
        up in proxy and access logs; if it also authenticated the REST API,
        anyone reading a log would hold a full session for its lifetime."""
        ticket, _ = auth.issue_ws_ticket({'sub': 'commander', 'role': 'commander'})
        assert auth.read_session(ticket) is None

    def test_a_session_cookie_cannot_be_used_as_a_ticket(self):
        """The other direction, so the socket path cannot be fed a long-lived
        credential in a URL where the short-lived one belongs."""
        token, _ = auth.issue_session()
        assert auth.read_ws_ticket(token) is None

    def test_a_session_issued_before_tickets_existed_still_works(self):
        """Tokens already in operators' browsers carry no `use` claim. They
        are sessions, and the deploy that adds tickets must not sign everyone
        out."""
        import json

        legacy = auth._b64(json.dumps(
            {'sub': 'commander', 'exp': int(time.time()) + 600, 'role': 'commander'},
            separators=(',', ':'), sort_keys=True).encode())
        import hashlib
        import hmac
        signature = auth._b64(
            hmac.new(auth._session_secret(), legacy.encode(), hashlib.sha256).digest())

        assert auth.read_session(f'{legacy}.{signature}')['sub'] == 'commander'

    def test_rotating_the_key_invalidates_live_tickets(self, monkeypatch):
        monkeypatch.setenv('PRAHARI_API_KEY', 'first-key')
        ticket, _ = auth.issue_ws_ticket({'sub': 'commander'})
        assert auth.read_ws_ticket(ticket) is not None

        monkeypatch.setenv('PRAHARI_API_KEY', 'rotated-key')
        assert auth.read_ws_ticket(ticket) is None
