"""Observed burn rate, derived from the audit log.

`base_burn_rate` is a provisioning assumption that nothing had ever checked
against what the station actually consumed — and `days_of_cover` is built
entirely on top of it. These pin what counts as consumption, what the figure
refuses to claim, and that the log really is a ledger rather than prose.
"""

import json

import pytest

from app.stock_ledger import (CONSUMING_REASONS, MIN_MOVEMENTS, REASON_COMMAND,
                              REASON_CORRECTION, REASON_EXPEDITION_DRAW,
                              REASON_TRANSFER_OUT, REASON_UNLOAD,
                              compare_to_configured, observed_burn_rates)
from app.timeutil import utc_now


def _movements(station, item_id='inv-fuel'):
    """Every ledger entry for an item, newest last."""
    rows = station.db.execute(
        "SELECT metadata FROM events WHERE module = 'inventory' AND metadata IS NOT NULL "
        'ORDER BY seq ASC').fetchall()
    out = []
    for row in rows:
        meta = json.loads(row['metadata'])
        if meta.get('item_id') == item_id and 'stock_delta' in meta:
            out.append(meta)
    return out


def _backdate(station, days: float, reason: str = REASON_COMMAND):
    """Push the earliest movement of that reason back in time.

    A rate needs elapsed time, and a test cannot wait two days for it.
    """
    from datetime import timedelta
    target = station.db.execute(
        "SELECT seq FROM events WHERE module = 'inventory' "
        "AND metadata LIKE ? ORDER BY seq ASC LIMIT 1", (f'%"{reason}"%',)).fetchone()
    assert target, f'no {reason} movement to backdate'
    when = (utc_now() - timedelta(days=days)).strftime('%Y-%m-%dT%H:%M:%S.%fZ')
    station.db.execute('UPDATE events SET created_at = ? WHERE seq = ?', (when, target['seq']))
    station.db.commit()


def _backdate_all(station, days: float, reason: str = REASON_COMMAND):
    """Push every movement of that reason back by the same amount.

    Distinct from `_backdate`: that one only moves the first, which leaves the
    most recent movement sitting at "now" — so it cannot tell a window
    measured to now from one measured to the last draw.
    """
    from datetime import timedelta
    when = (utc_now() - timedelta(days=days)).strftime('%Y-%m-%dT%H:%M:%S.%fZ')
    station.db.execute(
        "UPDATE events SET created_at = ? WHERE module = 'inventory' AND metadata LIKE ?",
        (when, f'%"{reason}"%'))
    station.db.commit()


class TestTheLogIsALedger:
    def test_a_stock_command_records_a_signed_delta(self, station):
        """The quantities used to live only in the sentence, so nothing could
        read the movement back without parsing prose."""
        station.json('post', '/inventory/command',
                     json={'transcript': 'Removed 200 litres of diesel fuel',
                           'station': 'Maitri', 'dry_run': False})
        moved = _movements(station)[-1]
        assert moved['stock_delta'] == -200
        assert moved['old_quantity'] == 6500 and moved['new_quantity'] == 6300
        assert moved['reason'] == REASON_COMMAND

    def test_every_path_that_moves_stock_records_a_reason(self, station):
        """Six call sites each wrote their own UPDATE and their own sentence.
        A movement with no reason cannot be classified, so it silently drops
        out of the rate."""
        station.json('post', '/inventory/command',
                     json={'transcript': 'Removed 100 litres of diesel fuel',
                           'station': 'Maitri', 'dry_run': False})
        station.set_quantity('inv-fuel', 6000)
        shipment = station.ship(quantity=500)
        for _ in range(3):
            station.json('post', f'/shipments/{shipment["id"]}/scan')

        reasons = {m['reason'] for m in _movements(station)}
        assert {REASON_COMMAND, REASON_CORRECTION, REASON_UNLOAD} <= reasons
        assert all(m.get('reason') for m in _movements(station))

    def test_an_inter_station_transfer_is_recorded_against_the_origin(self, station):
        station.ship(origin_station='Bharati', destination_station='Maitri',
                     inventory_item_id='inv-fuel', quantity=400)
        moved = _movements(station, 'inv-bha-fuel')[-1]
        assert moved['stock_delta'] == -400
        assert moved['reason'] == REASON_TRANSFER_OUT


class TestWhatCountsAsBurn:
    def test_a_recorded_usage_counts(self, station):
        for litres in (200, 300):
            station.json('post', '/inventory/command',
                         json={'transcript': f'Removed {litres} litres of diesel fuel',
                               'station': 'Maitri', 'dry_run': False})
        _backdate(station, 4)
        observed = observed_burn_rates(station.db, 'Maitri')['inv-fuel']
        assert observed['consumed'] == 500
        assert observed['rate'] == pytest.approx(500 / 4, rel=0.02)

    def test_a_stocktake_correction_does_not(self, station):
        """A correction is a measurement being put right. Counting it would
        make the observed rate a record of how often someone recounted."""
        station.set_quantity('inv-fuel', 2000)
        station.set_quantity('inv-fuel', 1000)
        _backdate(station, 5, REASON_CORRECTION)
        assert 'inv-fuel' not in observed_burn_rates(station.db, 'Maitri')

    def test_a_transfer_to_another_station_does_not(self, station):
        """Stock moving house is not stock being burned. The origin's cover
        drops either way; its rate should not."""
        for _ in range(2):
            station.ship(origin_station='Bharati', destination_station='Maitri',
                         inventory_item_id='inv-fuel', quantity=300)
        _backdate(station, 5, REASON_TRANSFER_OUT)
        assert 'inv-bha-fuel' not in observed_burn_rates(station.db, 'Bharati')

    def test_fuel_loaded_onto_a_traverse_does(self, station):
        """It is fuel the station will burn, and it is the largest single
        draw the console ever records."""
        crew = [p['id'] for p in station.personnel()[:2]]
        expedition = station.plan_expedition(personnel_required=2, fuel_required_l=1200,
                                             crew_ids=crew)
        station.patch(f'/expeditions/{expedition["id"]}', json={'status': 'active'})
        assert any(m['reason'] == REASON_EXPEDITION_DRAW for m in _movements(station))

    def test_restocking_never_counts_as_negative_burn(self, station):
        station.json('post', '/inventory/command',
                     json={'transcript': 'Removed 200 litres of diesel fuel',
                           'station': 'Maitri', 'dry_run': False})
        station.json('post', '/inventory/command',
                     json={'transcript': 'Added 900 litres of diesel fuel',
                           'station': 'Maitri', 'dry_run': False})
        _backdate(station, 4)
        observed = observed_burn_rates(station.db, 'Maitri')['inv-fuel']
        assert observed['consumed'] == 200

    def test_the_consuming_set_is_narrow_by_design(self):
        assert set(CONSUMING_REASONS) == {REASON_COMMAND, REASON_EXPEDITION_DRAW}


class TestItRefusesToGuess:
    def test_a_single_movement_reports_no_rate(self, station):
        """One 200 L draw an hour ago is not a 4800 L/day habit, and a figure
        beside the configured one is read as being just as authoritative."""
        station.json('post', '/inventory/command',
                     json={'transcript': 'Removed 200 litres of diesel fuel',
                           'station': 'Maitri', 'dry_run': False})
        observed = observed_burn_rates(station.db, 'Maitri')['inv-fuel']
        assert observed['rate'] is None
        assert 'not enough' in observed['reason']

    def test_movements_inside_a_few_hours_report_no_rate(self, station):
        for litres in (100, 100, 100):
            station.json('post', '/inventory/command',
                         json={'transcript': f'Removed {litres} litres of diesel fuel',
                               'station': 'Maitri', 'dry_run': False})
        observed = observed_burn_rates(station.db, 'Maitri')['inv-fuel']
        assert observed['movements'] >= MIN_MOVEMENTS
        assert observed['rate'] is None, 'too little elapsed time to divide by'

    def test_one_movement_is_not_a_rate_however_long_ago_it_was(self, station):
        """Elapsed time alone is not enough. A single 200 L draw a month ago
        says the station drew 200 L once, not that it draws 6.6 L a day."""
        station.json('post', '/inventory/command',
                     json={'transcript': 'Removed 200 litres of diesel fuel',
                           'station': 'Maitri', 'dry_run': False})
        _backdate(station, 20)
        observed = observed_burn_rates(station.db, 'Maitri')['inv-fuel']
        assert observed['movements'] == 1
        assert observed['observed_days'] > 2
        assert observed['rate'] is None

    def test_an_item_never_drawn_is_simply_absent(self, station):
        """Absent means "not observed". A zero would claim it never depletes."""
        assert 'inv-blankets' not in observed_burn_rates(station.db, 'Maitri')

    def test_a_station_that_stopped_consuming_reports_a_falling_rate(self, station):
        """The window ends at now, not at the last draw.

        Measured to the last draw, a station that burned 400 L over two days
        and then stopped for a month still reports 200 L/day for ever — the
        arithmetic freezes at the moment consumption did.
        """
        for litres in (200, 200):
            station.json('post', '/inventory/command',
                         json={'transcript': f'Removed {litres} litres of diesel fuel',
                               'station': 'Maitri', 'dry_run': False})
        # Both movements two days ago: 400 L over ~2 days.
        _backdate_all(station, 2)
        busy = observed_burn_rates(station.db, 'Maitri')['inv-fuel']
        assert busy['rate'] == pytest.approx(200, rel=0.05)

        # Same two movements, now twenty days back and nothing since.
        _backdate_all(station, 20)
        quiet = observed_burn_rates(station.db, 'Maitri')['inv-fuel']
        assert quiet['consumed'] == busy['consumed'], 'the same fuel, longer ago'
        assert quiet['rate'] == pytest.approx(20, rel=0.05)
        assert quiet['rate'] < busy['rate']

    def test_movements_outside_the_window_are_not_counted(self, station):
        for litres in (200, 200):
            station.json('post', '/inventory/command',
                         json={'transcript': f'Removed {litres} litres of diesel fuel',
                               'station': 'Maitri', 'dry_run': False})
        _backdate(station, 400)
        observed = observed_burn_rates(station.db, 'Maitri').get('inv-fuel')
        assert observed is None or observed['consumed'] == 200


class TestTheComparison:
    def test_it_says_when_the_station_is_burning_faster_than_planned(self):
        """This is the point of showing both: a cover figure built on the
        configured rate is optimistic by exactly this much."""
        verdict = compare_to_configured(350, {'rate': 700})
        assert verdict['ratio'] == 2.0 and 'faster' in verdict['verdict']

    def test_a_rate_close_to_the_plan_is_not_flagged(self):
        assert 'in line' in compare_to_configured(350, {'rate': 360})['verdict']

    def test_it_says_when_the_station_is_burning_slower(self):
        assert 'slower' in compare_to_configured(350, {'rate': 100})['verdict']

    def test_there_is_nothing_to_compare_without_an_observation(self):
        assert compare_to_configured(350, {'rate': None}) is None
        assert compare_to_configured(350, None) is None


class TestItReachesTheApi:
    def test_the_stock_row_carries_both_figures(self, station):
        for litres in (200, 300):
            station.json('post', '/inventory/command',
                         json={'transcript': f'Removed {litres} litres of diesel fuel',
                               'station': 'Maitri', 'dry_run': False})
        _backdate(station, 4)
        fuel = station.item('Diesel Fuel')
        assert fuel['base_burn_rate'] == 350
        assert fuel['observed_burn']['rate'] == pytest.approx(125, rel=0.02)
        assert fuel['observed_vs_configured']['verdict']

    def test_an_unobserved_row_says_so_rather_than_omitting_the_field(self, station):
        """A missing key and a measured zero must not look the same to the UI."""
        blankets = station.item('Thermal Blankets')
        assert 'observed_burn' in blankets
        assert blankets['observed_burn'] is None
        assert blankets['observed_vs_configured'] is None
