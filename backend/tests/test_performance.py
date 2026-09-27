"""Work done per request.

Not benchmarks — a wall-clock assertion on a shared CI runner is a flaky test.
These count *queries*, which is the thing that actually grew with the data, and
they pin three shapes that were fixed:

  * rendering a roster re-queried and re-parsed each person's plan three times;
  * the alert banner scanned the audit log once per stock row, so it got slower
    every time anything was logged anywhere in the station;
  * a cascade re-read the same station facts once per open traverse.

All three were invisible at seed size and linear in it, which is the worst
combination: nothing to see in a demo, and the first real deployment is where
it shows up.
"""

import sqlite3
import threading

import pytest

from app import database


class QueryLog:
    """Statements seen on every connection, across threads.

    The app runs in a worker thread under TestClient while the test body runs
    in the main one, and connections are thread-local — so this hooks
    connection *creation* rather than a particular connection.
    """

    def __init__(self):
        self.statements: list[str] = []
        self._lock = threading.Lock()

    def record(self, sql: str) -> None:
        with self._lock:
            self.statements.append(' '.join(str(sql).split()))

    def reset(self) -> None:
        with self._lock:
            self.statements.clear()

    def matching(self, *fragments: str) -> int:
        return sum(1 for s in self.statements
                   if all(f.lower() in s.lower() for f in fragments))

    @property
    def reads(self) -> int:
        return sum(1 for s in self.statements if s.lower().startswith('select'))

    def __len__(self) -> int:
        return len(self.statements)


@pytest.fixture
def queries(monkeypatch):
    """Traces every statement. Applied before any connection is opened."""
    log = QueryLog()
    real_connect = sqlite3.connect

    def traced_connect(*args, **kwargs):
        connection = real_connect(*args, **kwargs)
        connection.set_trace_callback(log.record)
        return connection

    monkeypatch.setattr(database.sqlite3, 'connect', traced_connect)
    return log


@pytest.fixture
def traced_station(queries, db_path, offline_llm):
    """A station whose every query is counted."""
    from fastapi.testclient import TestClient
    from app.main import app
    from tests.conftest import Station

    with TestClient(app) as client:
        station = Station(client)
        station.queries = queries
        yield station


class TestRosterRendering:
    def test_reads_each_persons_plan_once(self, traced_station):
        """Progress and telemetry come from the plan already in hand.

        Each used to re-query the plan and re-densify its route independently,
        so a six-person roster did twelve redundant lookups on top of the one
        query that had already fetched every plan.
        """
        for person in traced_station.personnel():
            traced_station.authorise_movement(person['id'])

        traced_station.queries.reset()
        traced_station.personnel()

        plan_lookups = traced_station.queries.matching('from movement_plans')
        assert plan_lookups <= 2, (
            f'{plan_lookups} movement_plan queries to render one roster; '
            'the list is fetched once and passed down')

    def test_the_cost_does_not_scale_with_the_roster(self, traced_station):
        """Six people and one person must cost the same number of queries."""
        for person in traced_station.personnel():
            traced_station.authorise_movement(person['id'])

        traced_station.queries.reset()
        traced_station.personnel()
        whole_station = traced_station.queries.reads

        traced_station.queries.reset()
        traced_station.get('/personnel?station=Himadri')
        one_station = traced_station.queries.reads

        # Himadri has three crew and no plans; Maitri has six and six plans.
        # A couple of queries of difference is fine; a multiple is an N+1.
        assert whole_station <= one_station + 4, (
            f'{whole_station} queries for six people vs {one_station} for three')


class TestStockAlertBanner:
    def test_does_not_scan_the_audit_log(self, traced_station):
        """The banner asks "which rows are in alert", not "what was announced
        about each row". The second question is answered by the log and gets
        slower as the station is used."""
        traced_station.set_weather(30)

        traced_station.queries.reset()
        traced_station.get('/inventory/alerts?station=Maitri')

        assert traced_station.queries.matching('from events') == 0, (
            'the standing-alert lookup is reading the audit log')

    def test_costs_one_query_regardless_of_how_much_is_in_alert(self, traced_station):
        traced_station.set_weather(30)
        assert traced_station.json('get', '/inventory/alerts?station=Maitri')

        traced_station.queries.reset()
        traced_station.get('/inventory/alerts?station=Maitri')

        # One row select, plus the per-station weather and headcount reads the
        # depletion figures need.
        assert traced_station.queries.matching('from inventory_items') <= 2

    def test_the_audit_log_is_still_written_when_state_changes(self, traced_station):
        """The column is the current answer; the log remains the history."""
        traced_station.set_weather(30)
        assert any('CRITICAL STOCK ALERT' in a
                   for a in traced_station.event_actions(module='inventory',
                                                         station='Maitri'))


class TestCascadeFanOut:
    def test_station_facts_are_read_once_for_every_traverse(self, traced_station):
        """The fuel row, the roster and the inbound cargo are the same for
        every traverse departing the same base."""
        for index in range(4):
            traced_station.plan_expedition(name=f'Traverse {index}', personnel_required=0,
                                           fuel_required_l=100)

        traced_station.queries.reset()
        traced_station.set_quantity('inv-fuel', 5000)

        fuel_lookups = traced_station.queries.matching('from inventory_items', 'like')
        assert fuel_lookups <= 2, (
            f'{fuel_lookups} fuel lookups for one stock write with four open '
            'traverses; the station snapshot is read once')

    def test_adding_traverses_does_not_multiply_the_work(self, traced_station):
        traced_station.plan_expedition(name='Only one', personnel_required=0,
                                       fuel_required_l=100)
        traced_station.queries.reset()
        traced_station.set_quantity('inv-fuel', 5100)
        with_one = traced_station.queries.reads

        for index in range(5):
            traced_station.plan_expedition(name=f'Extra {index}', personnel_required=0,
                                           fuel_required_l=100)
        traced_station.queries.reset()
        traced_station.set_quantity('inv-fuel', 5200)
        with_six = traced_station.queries.reads

        # Six traverses cost more than one — each still gets its own crew
        # lookup and its own row update — but nothing like six times as much.
        assert with_six < with_one * 2, (
            f'{with_one} queries for one traverse, {with_six} for six')


class TestScoringEquivalence:
    def test_the_snapshot_gives_the_same_answer_as_querying_per_traverse(self, station):
        """The optimisation must not change the number it produces.

        Crew counting was the subtle one: the old query asked for people who
        are unassigned *or* on this traverse, and the snapshot reconstructs
        that from two grouped counts.
        """
        crew = [p['id'] for p in station.personnel()[:2]]
        expedition = station.plan_expedition(personnel_required=2, fuel_required_l=1000,
                                             crew_ids=crew)

        from app.models import FeasibilityRequest
        from app.routes.expeditions import score_feasibility, station_snapshot
        import asyncio

        request = FeasibilityRequest(station='Maitri', personnel_required=2,
                                     fuel_required_l=1000, expedition_id=expedition['id'])

        fresh = asyncio.run(score_feasibility(request, log=False))
        pooled = asyncio.run(score_feasibility(
            request, log=False, snapshot=station_snapshot(station.db, 'Maitri')))

        assert fresh.readiness_score == pooled.readiness_score
        assert [(i.label, i.available, i.ok) for i in fresh.items] \
            == [(i.label, i.available, i.ok) for i in pooled.items]

    def test_crew_on_this_traverse_still_count_as_available_to_it(self, station):
        crew = [p['id'] for p in station.personnel()[:2]]
        expedition = station.plan_expedition(personnel_required=2, fuel_required_l=100,
                                             crew_ids=crew)
        result = station.json('post', '/expeditions/feasibility', json={
            'station': 'Maitri', 'personnel_required': 2, 'fuel_required_l': 100,
            'expedition_id': expedition['id']})
        assert next(i for i in result['items'] if i['label'] == 'Crew')['ok'] is True

    def test_crew_on_another_traverse_do_not(self, station):
        crew = [p['id'] for p in station.personnel()[:5]]
        station.plan_expedition(name='Committed elsewhere', personnel_required=5,
                                fuel_required_l=100, crew_ids=crew)
        result = station.json('post', '/expeditions/feasibility', json={
            'station': 'Maitri', 'personnel_required': 5, 'fuel_required_l': 100})
        crew_line = next(i for i in result['items'] if i['label'] == 'Crew')
        assert crew_line['available'] == len(station.personnel()) - 5
        assert crew_line['ok'] is False
