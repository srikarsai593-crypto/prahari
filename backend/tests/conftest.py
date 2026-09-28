"""Shared fixtures.

Two properties every test in this suite depends on:

* **A private database per test.** `database.DB_PATH` is a module global and
  connections are cached on a `threading.local`, so pointing the path at a
  tmp file is not enough on its own — the cached connections have to go with
  it, or the next test keeps writing to the previous one's file.

* **No network.** The LLM chain is stubbed out to nothing, so every parse falls
  through to the deterministic regex rules. A test that reaches Gemini is slow,
  costs money, needs a key, and — worst of all — gives a different answer on a
  different day, which is the opposite of what a regression suite is for.
  `llm_backed` opts a test back in to a scripted model response.

* **No ambient credentials.** `app.main` loads `backend/.env` at import, so a
  developer with a real `PRAHARI_API_KEY` in it ran a different suite from CI:
  the demo key was disabled underneath tests that assert it is offered. The
  environment is cleared for every test, and a test that cares about a
  configured key sets one itself.
"""

import sys
import threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

BACKEND = Path(__file__).resolve().parent.parent
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app import database, llm, ratelimit  # noqa: E402
from app.auth import get_expected_key  # noqa: E402


@pytest.fixture(autouse=True)
def clean_rate_limits():
    """Rate-limit buckets are process-global, so one test's traffic would
    otherwise count against the next one's."""
    ratelimit.login_attempts.reset()
    ratelimit.write_requests.reset()
    yield
    ratelimit.login_attempts.reset()
    ratelimit.write_requests.reset()


@pytest.fixture(autouse=True)
def clean_credentials(monkeypatch):
    """Run against a station with no key configured, whatever the developer's
    own .env says. Tests that need a configured key set one explicitly."""
    for name in ('PRAHARI_API_KEY', 'PRAHARI_COMMANDER_KEY', 'PRAHARI_SESSION_SECRET'):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv('PRAHARI_ALLOW_DEMO_KEY', 'true')


def _drop_cached_connections() -> None:
    """Replace the thread-local store so every thread reopens against DB_PATH.

    The app runs in a worker thread under TestClient while the test body runs
    in the main one; both must be pointed at the new file.
    """
    database._local = threading.local()


async def _no_llm(*_args, **_kwargs):
    return None


@pytest.fixture
def offline_llm(monkeypatch):
    """Force the deterministic regex fallback. Autouse via `station`."""
    monkeypatch.setattr(llm, 'call_gemini', _no_llm)
    monkeypatch.setattr(llm, 'call_ollama', _no_llm)


@pytest.fixture
def llm_backed(monkeypatch):
    """Script the LLM's reply, to test what the app does with a model's output.

    Used for the cases that only arise when a model answers — a parse that is
    well formed but wrong, which the regex rules cannot produce.
    """
    def _script(payload: str):
        async def _reply(*_args, **_kwargs):
            return payload
        monkeypatch.setattr(llm, 'call_gemini', _reply)
        monkeypatch.setattr(llm, 'call_ollama', _no_llm)
    return _script


@pytest.fixture
def db_path(tmp_path, monkeypatch):
    path = tmp_path / 'prahari-test.db'
    monkeypatch.setattr(database, 'DB_PATH', str(path))
    _drop_cached_connections()
    yield path
    _drop_cached_connections()


class Station:
    """A booted station: HTTP client, credentials and a direct DB handle.

    Writes need the commander key on every call, so wrapping the verbs keeps
    that out of ~200 call sites and makes an unauthenticated call something a
    test has to ask for explicitly (`client` is the raw one).
    """

    def __init__(self, client: TestClient):
        self.client = client
        self.headers = {'X-Commander-Key': get_expected_key()}

    # ── HTTP ────────────────────────────────────────────────────────────────
    # Reads are gated too, so the harness presents the key on every verb. A
    # test that wants to see an *unauthenticated* response uses `client`.
    def _with_key(self, kw: dict) -> dict:
        """Merge the caller's headers over the credential rather than
        colliding with it — a test that needs one more header (an
        Idempotency-Key, say) should not have to re-supply the key."""
        return {**kw, 'headers': {**self.headers, **(kw.get('headers') or {})}}

    def get(self, url, **kw):
        return self.client.get(url, **self._with_key(kw))

    def post(self, url, **kw):
        return self.client.post(url, **self._with_key(kw))

    def patch(self, url, **kw):
        return self.client.patch(url, **self._with_key(kw))

    def json(self, method, url, **kw):
        response = getattr(self, method)(url, **kw)
        assert response.status_code == 200, f'{method.upper()} {url} -> {response.text[:300]}'
        return response.json()

    # ── Direct database access, for asserting on what was actually stored ───
    @property
    def db(self):
        return database.get_db()

    def scalar(self, sql, params=()):
        return self.db.execute(sql, params).fetchone()[0]

    # ── Fixtures the domain needs over and over ─────────────────────────────
    def personnel(self, station='Maitri'):
        return self.json('get', f'/personnel?station={station}')

    def inventory(self, station='Maitri'):
        return self.json('get', f'/inventory?station={station}')

    def item(self, name, station='Maitri'):
        return next(i for i in self.inventory(station) if i['name'] == name)

    def events(self, **params):
        query = '&'.join(f'{k}={v}' for k, v in params.items())
        return self.json('get', f'/events?{query}' if query else '/events')

    def event_actions(self, **params):
        return [e['action'] for e in self.events(**params)]

    def declare_incident(self, **overrides):
        body = {'type': 'fire', 'location_lat': -70.767, 'location_lng': 11.731,
                'affected_radius_m': 1000, 'severity': 'medium'}
        body.update(overrides)
        return self.json('post', '/incidents', json=body)

    def authorise_movement(self, personnel_id, route=None, hours=6,
                           destination=('Camp Alpha', -70.850, 11.950)):
        """A movement plan. The default route is the straight Maitri corridor,
        which the seed deliberately runs through the Crevasse Zone."""
        name, dlat, dlng = destination
        origin = {'lat': -70.767, 'lng': 11.731}
        if route is None:
            route = [{'lat': round(origin['lat'] + (dlat - origin['lat']) * i / 5, 6),
                      'lng': round(origin['lng'] + (dlng - origin['lng']) * i / 5, 6)}
                     for i in range(6)]
        return self.json('post', '/personnel/movement-plans', json={
            'personnel_id': personnel_id,
            'origin_lat': origin['lat'], 'origin_lng': origin['lng'],
            'destination_lat': dlat, 'destination_lng': dlng,
            'destination_name': name, 'planned_route': route,
            'departure_time': '2026-01-01T00:00:00Z',
            'expected_arrival': f'2026-01-01T{hours:02d}:00:00Z',
        })

    def walk(self, personnel_id, limit=200):
        """Advance GPS fixes until arrival, yielding each tick."""
        for _ in range(limit):
            response = self.post(f'/personnel/{personnel_id}/simulate-move')
            assert response.status_code == 200, response.text[:200]
            tick = response.json()
            yield tick
            if tick.get('status') == 'arrived':
                return

    def ship(self, **overrides):
        body = {'item_name': 'Diesel Fuel', 'category': 'fuel', 'weight_kg': 3400,
                'quantity': 4000, 'unit': 'L', 'inventory_item_id': 'inv-fuel',
                'priority': 'normal', 'destination_station': 'Maitri'}
        body.update(overrides)
        return self.json('post', '/shipments', json=body)

    def plan_expedition(self, **overrides):
        body = {'name': 'Test Traverse', 'station': 'Maitri',
                'personnel_required': 2, 'fuel_required_l': 1000, 'crew_ids': []}
        body.update(overrides)
        return self.json('post', '/expeditions', json=body)

    def set_weather(self, delta_t, station='Maitri'):
        return self.json('post', '/shipments/weather',
                         json={'station': station, 'delta_t': delta_t})

    def set_quantity(self, item_id, quantity, station='Maitri'):
        return self.json('patch', f'/inventory/{item_id}',
                         json={'quantity': quantity, 'station': station})


@pytest.fixture
def station(db_path, offline_llm):
    """A running station backed by its own empty database."""
    from app.main import app
    with TestClient(app) as client:
        yield Station(client)
