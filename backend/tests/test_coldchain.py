"""Temperature-controlled cargo.

Vaccines, reagents and fresh food arrive useless if they spent hours outside
their band, and the crate looks identical either way. These pin the two checks
that catch different failures — a breach, and a load losing control of its
temperature before it breaches — and the honesty about where a reading came
from, since Prahari has no sensors.
"""

from datetime import timedelta

import pytest

from app.coldchain import (DEFAULT_BANDS, MIN_RATE_INTERVAL_MINUTES,
                           RATE_OF_CHANGE_LIMIT_C_PER_H, assess, classify,
                           rate_of_change)
from app.timeutil import utc_now


def _reading(station, shipment, temp_c, source='manual'):
    return station.json('post', f'/shipments/{shipment["id"]}/temperature',
                        json={'temp_c': temp_c, 'source': source})


@pytest.fixture
def vaccines(station):
    """A medical consignment, which takes the 2–8 °C band by default."""
    return station.ship(item_name='Vaccine Pallet', category='medical',
                        quantity=40, unit='units', inventory_item_id='inv-med',
                        weight_kg=180)


class TestBands:
    def test_medical_cargo_is_monitored_without_being_asked(self, station, vaccines):
        """The crate that most needs a band is the one an operator is least
        likely to remember to set one on."""
        assert vaccines['cold_chain']['monitored'] is True
        assert (vaccines['temp_min'], vaccines['temp_max']) == DEFAULT_BANDS['medical']

    def test_ordinary_cargo_is_not(self, station):
        """A crate of generator spares has no temperature it must be kept at.
        Giving it a band would produce alerts nobody should act on."""
        spares = station.ship(item_name='Generator Spares', category='equipment',
                              quantity=4, unit='units', inventory_item_id=None)
        assert spares['cold_chain']['monitored'] is False

    def test_an_explicit_band_overrides_the_category_default(self, station):
        crate = station.ship(item_name='Blood Products', category='medical',
                             inventory_item_id='inv-med', quantity=10, unit='units',
                             temp_min=-30, temp_max=-18)
        assert (crate['temp_min'], crate['temp_max']) == (-30, -18)

    def test_a_band_can_be_put_on_cargo_that_has_none_by_default(self, station):
        crate = station.ship(item_name='Field Batteries', category='equipment',
                             temp_min=-20, temp_max=40)
        assert crate['cold_chain']['monitored'] is True

    def test_an_inverted_band_is_refused(self, station):
        assert station.post('/shipments', json={
            'item_name': 'X', 'category': 'medical', 'weight_kg': 10,
            'destination_station': 'Maitri', 'temp_min': 8, 'temp_max': 2,
        }).status_code == 422

    def test_a_reading_against_unmonitored_cargo_is_refused(self, station):
        """Silently accepting it would put a figure on the record that nothing
        will ever judge."""
        spares = station.ship(item_name='Generator Spares', category='equipment')
        response = station.post(f'/shipments/{spares["id"]}/temperature',
                                json={'temp_c': 4})
        assert response.status_code == 409
        assert 'not a temperature-controlled' in response.json()['detail']


class TestThresholdBreach:
    def test_a_reading_inside_the_band_is_not_an_excursion(self, station, vaccines):
        result = _reading(station, vaccines, 5.0)
        assert result['excursion'] is False and result['band_state'] == 'within'

    def test_a_reading_above_the_band_is(self, station, vaccines):
        result = _reading(station, vaccines, 14.0)
        assert result['excursion'] is True and result['band_state'] == 'above'
        assert result['deviation_c'] == 6.0

    def test_a_reading_below_the_band_is_too(self, station, vaccines):
        """Frozen vaccine is as destroyed as cooked vaccine, and only one of
        the two is what people think of as a cold-chain failure."""
        result = _reading(station, vaccines, -4.0)
        assert result['excursion'] is True and result['band_state'] == 'below'
        assert result['deviation_c'] == 6.0

    def test_it_records_how_far_out_not_only_that_it_was_out(self, station, vaccines):
        """0.5 °C over is a conversation; 8 °C over is a write-off."""
        assert _reading(station, vaccines, 8.5)['deviation_c'] == 0.5
        assert classify(16.0, 2.0, 8.0)['deviation_c'] == 8.0


class TestRateOfChange:
    def test_a_load_climbing_fast_inside_its_band_is_caught(self, station, vaccines):
        """The failure this exists for: a compressor has stopped, and the
        crate is still inside its band for the first hour."""
        shipment = {'temp_min': 2, 'temp_max': 8, 'last_temp_c': 3.0,
                    'last_temp_at': (utc_now() - timedelta(hours=1)).strftime(
                        '%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'}
        verdict = assess(shipment, 7.0)
        assert verdict['band_state'] == 'within', 'still inside the band'
        assert verdict['drifting'] is True and verdict['excursion'] is True
        assert verdict['rate_c_per_h'] == 4.0

    def test_ordinary_drift_does_not_trip_it(self, station):
        shipment = {'temp_min': 2, 'temp_max': 8, 'last_temp_c': 4.0,
                    'last_temp_at': (utc_now() - timedelta(hours=4)).strftime(
                        '%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'}
        verdict = assess(shipment, 5.0)
        assert verdict['drifting'] is False and verdict['excursion'] is False

    def test_the_first_reading_has_no_rate_to_report(self, station, vaccines):
        assert _reading(station, vaccines, 5.0)['rate_c_per_h'] is None

    def test_two_readings_seconds_apart_produce_no_rate(self, station, vaccines):
        """Dividing by a couple of seconds turns sensor jitter into a
        runaway."""
        _reading(station, vaccines, 5.0)
        assert _reading(station, vaccines, 5.4)['rate_c_per_h'] is None

    def test_the_limit_is_a_rate_not_a_difference(self):
        """Two degrees over ten hours is a stable load; two degrees over ten
        minutes is a failing one."""
        base = (utc_now() - timedelta(hours=10)).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'
        assert abs(rate_of_change(4.0, base, 6.0)) < RATE_OF_CHANGE_LIMIT_C_PER_H
        fast = (utc_now() - timedelta(minutes=10)).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'
        assert abs(rate_of_change(4.0, fast, 6.0)) >= RATE_OF_CHANGE_LIMIT_C_PER_H

    def test_a_rapid_fall_counts_too(self):
        """A refrigerated load plunging towards frozen is losing control in
        the other direction."""
        recent = (utc_now() - timedelta(minutes=30)).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'
        verdict = assess({'temp_min': 2, 'temp_max': 8, 'last_temp_c': 7.0,
                          'last_temp_at': recent}, 3.0)
        assert verdict['drifting'] is True

    def test_the_minimum_interval_is_stated_not_guessed(self):
        assert MIN_RATE_INTERVAL_MINUTES > 0


class TestTheRecord:
    def test_an_excursion_is_written_to_the_audit_log(self, station, vaccines):
        _reading(station, vaccines, 15.0)
        assert any('COLD CHAIN EXCURSION' in a
                   for a in station.event_actions(module='cargo', station='Maitri'))

    def test_a_normal_reading_is_logged_too_rather_than_discarded(self, station, vaccines):
        """The value of a cold chain is the unbroken record, not the alerts."""
        _reading(station, vaccines, 5.0)
        assert any('within band' in a for a in station.event_actions(module='cargo'))

    def test_every_entry_names_where_the_reading_came_from(self, station, vaccines):
        """Prahari has no sensor network. An entry that did not distinguish a
        typed figure from a logger read-out would be asserting one."""
        _reading(station, vaccines, 5.0, source='logger')
        assert any('(logger)' in a for a in station.event_actions(module='cargo'))
        _reading(station, vaccines, 6.0, source='manual')
        assert any('(manual)' in a for a in station.event_actions(module='cargo'))

    def test_a_crate_that_recovered_still_reports_its_excursion(self, station, vaccines):
        """The question on arrival is "was it ever out of band". A crate back
        inside its band reads as fine unless the history is carried."""
        _reading(station, vaccines, 15.0)
        recovered = _reading(station, vaccines, 5.0)
        assert recovered['band_state'] == 'within'
        assert recovered['excursion_count'] == 1
        assert '1 excursion' in recovered['cold_chain']['breach_summary']

    def test_the_count_survives_onto_the_cargo_board(self, station, vaccines):
        _reading(station, vaccines, 15.0)
        _reading(station, vaccines, 16.0)
        board = station.json('get', '/shipments?station=Maitri')
        crate = next(s for s in board if s['id'] == vaccines['id'])
        assert crate['cold_chain']['excursion_count'] == 2
        assert crate['cold_chain']['state'] == 'out_of_band'

    def test_a_monitored_crate_with_no_reading_says_so(self, station, vaccines):
        """"Awaiting a reading" and "within band" are different states, and
        only one of them is reassuring."""
        assert vaccines['cold_chain']['state'] == 'awaiting_reading'


class TestItReachesTheCascade:
    def test_an_excursion_re_scores_the_station(self, station, vaccines):
        """A consignment that can no longer be relied on is one the readiness
        score was counting on arriving."""
        crew = [p['id'] for p in station.personnel()[:1]]
        station.plan_expedition(personnel_required=1, fuel_required_l=100, crew_ids=crew)
        station.db.execute('UPDATE expeditions SET live_readiness_score = NULL')
        station.db.commit()

        _reading(station, vaccines, 15.0)

        checked = station.scalar(
            'SELECT COUNT(*) FROM expeditions WHERE readiness_checked_at IS NOT NULL')
        assert checked >= 1, 'the excursion did not reach the readiness monitor'

    def test_a_normal_reading_does_not_churn_the_cascade(self, station, vaccines):
        """Re-scoring every traverse on every routine reading is work for
        nothing, and it buries the entries that matter."""
        _reading(station, vaccines, 5.0)
        assert not any('FEASIBILITY DEGRADED' in a for a in station.event_actions(limit=50))
