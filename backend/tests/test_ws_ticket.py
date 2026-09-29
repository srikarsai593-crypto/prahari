"""Opening the telemetry socket from a console that is not same-origin with it.

The defect these cover: a hosted console reaches this backend through the
frontend's own origin, so its session cookie belongs to *that* host. The
telemetry socket cannot take the same route — a platform rewrite does not
carry a WebSocket upgrade — so it is opened against this origin directly,
where the cookie is never sent. Every handshake was refused, the console
retried forever, and both link indicators sat red while the rest of the
console worked perfectly.
"""

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app import auth


def _ticket(station) -> str:
    response = station.client.post('/auth/ws-ticket', headers=station.headers)
    assert response.status_code == 200
    return response.json()['ticket']


class TestMintingATicket:
    def test_a_signed_in_console_can_get_one(self, station):
        body = station.client.post('/auth/ws-ticket', headers=station.headers).json()
        assert auth.read_ws_ticket(body['ticket'])['sub'] == 'commander'

    def test_it_says_how_long_it_lasts(self, station):
        body = station.client.post('/auth/ws-ticket', headers=station.headers).json()
        assert body['expires_in'] == auth.WS_TICKET_TTL_SECONDS

    def test_an_anonymous_caller_is_refused(self, station):
        assert station.client.post('/auth/ws-ticket').status_code == 401

    def test_an_observer_gets_one_too(self, station, monkeypatch):
        """They are entitled to the telemetry they can already read over HTTP."""
        monkeypatch.setenv('PRAHARI_ALLOW_OBSERVER', 'true')
        station.client.post('/auth/observer')

        body = station.client.post('/auth/ws-ticket').json()
        assert auth.read_ws_ticket(body['ticket'])['role'] == 'observer'

    def test_an_observers_ticket_does_not_promote_them(self, station, monkeypatch):
        monkeypatch.setenv('PRAHARI_ALLOW_OBSERVER', 'true')
        station.client.post('/auth/observer')

        ticket = station.client.post('/auth/ws-ticket').json()['ticket']
        assert auth.read_ws_ticket(ticket)['role'] != 'commander'


class TestOpeningTheSocket:
    def test_a_ticket_opens_it(self, station):
        with station.client.websocket_connect(f'/ws?ticket={_ticket(station)}') as ws:
            assert ws is not None

    def test_a_cookie_still_opens_it_where_the_socket_is_same_origin(self, station):
        """Local development, where the console and the socket share a host.
        The ticket is an addition, not a replacement."""
        station.client.post('/auth/login', json={'key': auth.DEMO_KEY})
        with station.client.websocket_connect('/ws') as ws:
            assert ws is not None

    def test_no_credential_is_refused(self, station):
        with pytest.raises(WebSocketDisconnect):
            with station.client.websocket_connect('/ws'):
                pass

    def test_a_forged_ticket_is_refused(self, station):
        payload = _ticket(station).split('.')[0]
        with pytest.raises(WebSocketDisconnect):
            with station.client.websocket_connect(f'/ws?ticket={payload}.forged'):
                pass

    def test_an_expired_ticket_is_refused(self, station, monkeypatch):
        monkeypatch.setattr(auth, 'WS_TICKET_TTL_SECONDS', -1)
        stale, _ = auth.issue_ws_ticket({'sub': 'commander', 'role': 'commander'})
        with pytest.raises(WebSocketDisconnect):
            with station.client.websocket_connect(f'/ws?ticket={stale}'):
                pass

    def test_a_session_cookie_is_not_accepted_as_a_ticket(self, station):
        """A long-lived credential must not be usable in the one place that
        ends up in access logs."""
        token, _ = auth.issue_session()
        with pytest.raises(WebSocketDisconnect):
            with station.client.websocket_connect(f'/ws?ticket={token}'):
                pass

    def test_it_is_open_where_the_station_serves_public_reads(self, station, monkeypatch):
        monkeypatch.setenv('PRAHARI_PUBLIC_READS', 'true')
        with station.client.websocket_connect('/ws') as ws:
            assert ws is not None


class TestTheTicketIsNotASession:
    """A ticket travels in a URL and so reaches proxy and access logs. That is
    only acceptable while it buys nothing but the socket."""

    def test_it_cannot_be_presented_as_a_session_cookie(self, station):
        ticket = _ticket(station)
        fresh = TestClient(station.client.app)
        fresh.cookies.set(auth.SESSION_COOKIE, ticket)

        assert fresh.get('/personnel').status_code == 401

    def test_it_cannot_be_presented_as_a_bearer_token(self, station):
        ticket = _ticket(station)
        fresh = TestClient(station.client.app)

        assert fresh.get('/personnel',
                         headers={'Authorization': f'Bearer {ticket}'}).status_code == 401

    def test_it_cannot_authorise_a_write(self, station):
        ticket = _ticket(station)
        fresh = TestClient(station.client.app)
        fresh.cookies.set(auth.SESSION_COOKIE, ticket)

        response = fresh.post('/admin/demo-season')
        assert response.status_code in (401, 403)
