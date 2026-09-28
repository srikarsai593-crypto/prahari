"""The demonstration season.

A console booted from the seed alone has crew, stock and geofences but no
consignments, traverses or incidents, so Cargo and Emergency render empty —
which reads as a backend that is down rather than as a quiet day. These pin the
properties that make the season worth having: that it reaches every station,
that it is made of real records rather than a second implementation of them,
that a second click does not double it, and that it says what it is.
"""

import pytest

from app.demo import CONSIGNMENTS, EXPEDITIONS, STANDING_DELTA_T

STATIONS = ('Maitri', 'Bharati', 'Himadri')


@pytest.fixture
def seasoned(station):
    station.json('post', '/admin/demo-season', json={})
    return station


class TestItFillsEveryModule:
    @pytest.mark.parametrize('station_id', STATIONS)
    def test_every_station_has_a_cargo_board(self, seasoned, station_id):
        """The empty board is the failure this exists to fix, and a judge may
        switch to any of the three."""
        assert len(seasoned.json('get', f'/shipments?station={station_id}')) == \
            len(CONSIGNMENTS[station_id])

    @pytest.mark.parametrize('station_id', STATIONS)
    def test_every_station_has_a_traverse_in_planning(self, seasoned, station_id):
        planned = seasoned.json('get', f'/expeditions?station={station_id}')
        assert any(e['name'] == EXPEDITIONS[station_id]['name'] for e in planned)

    @pytest.mark.parametrize('station_id', STATIONS)
    def test_every_station_has_an_incident_on_the_record(self, seasoned, station_id):
        assert seasoned.json('get', f'/incidents?station={station_id}')

    def test_the_traverses_are_crewed(self, seasoned):
        """An unnamed traverse cannot be activated, so one with no crew is a
        dead end rather than a plan."""
        for station_id in STATIONS:
            demo = next(e for e in seasoned.json('get', f'/expeditions?station={station_id}')
                        if e['name'] == EXPEDITIONS[station_id]['name'])
            assert len(demo['crew']) == EXPEDITIONS[station_id]['crew']


class TestTheSeasonIsOperationallyPlausible:
    def test_one_convoy_is_overdue_so_the_stalled_path_is_visible(self, seasoned):
        """At the nominal fourteen-day sea leg nothing slips inside a demo, so
        without a backdated ETA the overdue treatment is unreachable."""
        overdue = [s for s in seasoned.json('get', '/shipments') if s['is_overdue']]
        assert len(overdue) == 1
        assert overdue[0]['stalled_warning']

    def test_the_overdue_convoy_sorts_to_the_top_of_its_board(self, seasoned):
        board = seasoned.json('get', '/shipments?station=Maitri')
        assert board[0]['is_overdue']

    def test_no_incident_is_left_open(self, seasoned):
        """Emergency should open on a station that is safe with a record behind
        it, not on a live emergency nobody declared."""
        assert seasoned.json('get', '/admin/counts')['open_incidents'] == 0

    def test_the_board_is_part_way_through_its_season(self, seasoned):
        """A board on which every crate is still 'dispatched' is a board that
        was created a second ago, and the dashboard's "in transit" figure reads
        zero against a full page of consignments."""
        board = seasoned.json('get', '/shipments')
        assert any(s['status'] == 'in_transit' for s in board)
        assert any(s['status'] == 'dispatched' for s in board)

    def test_nothing_is_unloaded_so_the_store_stays_at_its_seeded_figures(self, seasoned):
        """Unloading moves stock. A season that silently topped the store up
        would make every depletion figure on the Inventory page a fiction."""
        assert all(s['status'] != 'unloaded' for s in seasoned.json('get', '/shipments'))
        assert seasoned.item('Diesel Fuel')['quantity'] == 6500

    def test_the_closed_incident_raises_no_station_alarm(self, seasoned):
        """Declaring and standing down would fire the station-wide banner on
        every open console, for an emergency nobody declared."""
        actions = seasoned.event_actions(module='emergency', limit=50)
        assert not any('Incident created' in a for a in actions)
        assert any('Closed' in a and 'on record' in a for a in actions)

    def test_the_closed_incident_carries_its_worked_protocol(self, seasoned):
        """An incident with no steps against it reads as one nobody worked."""
        incident = seasoned.json('get', '/incidents?station=Maitri')[0]
        detail = seasoned.json('get', f'/incidents/{incident["id"]}')
        assert detail['sop_tasks'] and all(t['done'] for t in detail['sop_tasks'])

    def test_a_temperature_controlled_crate_carries_its_history(self, seasoned):
        """A crate back inside its band reads as fine unless the excursion
        it had in transit is still on the record — which is the case an
        operator most needs to see on arrival."""
        board = seasoned.json('get', '/shipments?station=Maitri')
        medical = next(s for s in board if s['item_name'] == 'Medical Supplies')
        assert medical['cold_chain']['monitored'] is True
        assert medical['cold_chain']['state'] == 'within'
        assert medical['cold_chain']['excursion_count'] == 1

    def test_maitri_carries_a_standing_blizzard_load(self, seasoned):
        """Otherwise the depletion formula is visibly multiplying by one."""
        current = seasoned.json('get', '/shipments/delta-t/current')['stations']
        assert current['Maitri'] == STANDING_DELTA_T['Maitri']

    def test_the_maitri_traverse_reports_a_real_fuel_shortfall(self, seasoned):
        """The seed leaves 6500 L against a 7200 L traverse on purpose: the
        feasibility panel needs something to explain."""
        result = seasoned.json('post', '/expeditions/feasibility', json={
            'station': 'Maitri',
            'personnel_required': EXPEDITIONS['Maitri']['personnel_required'],
            'fuel_required_l': EXPEDITIONS['Maitri']['fuel_required_l']})
        assert any(not i['ok'] and 'fuel' in i['label'].lower() for i in result['items'])


class TestTheRecordsAreReal:
    def test_consignments_are_booked_against_stock_rows_that_exist(self, seasoned):
        """The specs name inventory ids by hand. One that does not resolve
        makes unloading a silent no-op, which is the whole point of the scan."""
        for station_id in STATIONS:
            stock = {i['id'] for i in seasoned.inventory(station_id)}
            for spec in CONSIGNMENTS[station_id]:
                assert spec['inventory_item_id'] in stock

    def test_unloading_a_demo_consignment_tops_up_the_named_row(self, seasoned):
        """The end-to-end consequence: these are ordinary consignments, so the
        whole scan chain works on them."""
        before = seasoned.item('Diesel Fuel')['quantity']
        fuel = next(s for s in seasoned.json('get', '/shipments?station=Maitri')
                    if s['item_name'] == 'Diesel Fuel')
        # Scan from wherever the season left it, rather than a fixed count:
        # how far each consignment has come is a property of the season.
        while seasoned.json('get', f'/shipments/{fuel["id"]}')['status'] != 'unloaded':
            seasoned.json('post', f'/shipments/{fuel["id"]}/scan')
        assert seasoned.item('Diesel Fuel')['quantity'] == before + fuel['quantity']

    def test_each_consignment_carries_a_scannable_code(self, seasoned):
        for shipment in seasoned.json('get', '/shipments'):
            assert shipment['barcode_id'].startswith('SHP-')

    def test_the_season_is_announced_as_synthetic(self, seasoned):
        """A demo indistinguishable from live operations is not a demo."""
        announcement = next(a for a in seasoned.event_actions(module='system', limit=50)
                            if 'Demonstration season' in a)
        assert 'synthetic' in announcement


class TestSeedingOnBoot:
    """A hosted station comes up empty after every deploy, and an empty
    console is indistinguishable from a broken one."""

    def _boot(self, db_path, monkeypatch, **env):
        from fastapi.testclient import TestClient

        from app.main import app
        from tests.conftest import Station
        for name, value in env.items():
            monkeypatch.setenv(name, value)
        with TestClient(app) as client:
            return Station(client).json('get', '/admin/counts')

    def test_an_empty_station_comes_up_with_a_season(
            self, db_path, offline_llm, monkeypatch):
        counts = self._boot(db_path, monkeypatch, PRAHARI_SEED_DEMO_ON_BOOT='true')
        assert counts['shipments'] > 0

    def test_it_stays_off_unless_asked(self, db_path, offline_llm, monkeypatch):
        """A real station's console must never invent records."""
        monkeypatch.delenv('PRAHARI_SEED_DEMO_ON_BOOT', raising=False)
        counts = self._boot(db_path, monkeypatch)
        assert counts['shipments'] == 0

    def test_a_restart_does_not_plant_a_second_season(
            self, db_path, offline_llm, monkeypatch):
        """It fires only on an empty station, so it can never double the
        board or overwrite what an operator recorded."""
        first = self._boot(db_path, monkeypatch, PRAHARI_SEED_DEMO_ON_BOOT='true')
        second = self._boot(db_path, monkeypatch, PRAHARI_SEED_DEMO_ON_BOOT='true')
        assert second['shipments'] == first['shipments']

    def test_it_leaves_an_operator_s_own_records_alone(
            self, db_path, offline_llm, monkeypatch):
        from fastapi.testclient import TestClient

        from app.main import app
        from tests.conftest import Station
        with TestClient(app) as client:
            Station(client).ship(item_name='Operator Crate')

        counts = self._boot(db_path, monkeypatch, PRAHARI_SEED_DEMO_ON_BOOT='true')
        assert counts['shipments'] == 1, 'the boot seed planted over a real record'


class TestRepeatability:
    def test_a_second_run_does_not_double_the_season(self, seasoned):
        first = seasoned.json('get', '/admin/counts')
        again = seasoned.json('post', '/admin/demo-season', json={})
        assert again['now']['shipments'] == first['shipments']
        assert again['now']['incidents'] == first['incidents']

    def test_it_clears_whatever_an_exercise_left_behind(self, station):
        station.ship(item_name='Stray Crate')
        station.declare_incident()
        station.json('post', '/admin/demo-season', json={})
        board = station.json('get', '/shipments')
        assert not any(s['item_name'] == 'Stray Crate' for s in board)
        assert station.json('get', '/admin/counts')['open_incidents'] == 0

    def test_a_reset_takes_the_season_back_off_again(self, seasoned):
        seasoned.json('post', '/admin/reset', json={'confirm': 'RESET'})
        counts = seasoned.json('get', '/admin/counts')
        assert counts['shipments'] == 0 and counts['incidents'] == 0
        assert seasoned.item('Diesel Fuel')['quantity'] == 6500

    def test_it_keeps_the_audit_log_by_default(self, station):
        station.declare_incident()
        station.json('post', '/admin/demo-season', json={})
        assert any('Incident created' in a for a in station.event_actions(limit=100))

    def test_clear_events_wipes_the_log_but_not_the_announcement(self, station):
        station.declare_incident()
        station.json('post', '/admin/demo-season', json={'clear_events': True})
        actions = station.event_actions(limit=100)
        assert not any('Incident created: fire' in a for a in actions)
        assert any('Demonstration season' in a for a in actions)
