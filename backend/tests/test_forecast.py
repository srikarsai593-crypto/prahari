"""Stockout risk, as a spread rather than a date.

`days_of_cover` answers "at today's rate". It cannot say whether that rate
is steady, and thirty days at a steady rate is a different proposition from
thirty days at a rate that swings by four. These pin the spread — and, more
importantly, the refusal to produce one from too little history.
"""

import pytest

from app.forecast import (HORIZON_DAYS, MIN_OBSERVED_DAYS, probability_lasts,
                          stockout_forecast)

# Eight days of steady 100-a-day consumption.
STEADY = {f'2026-09-{day:02d}': 100.0 for day in range(1, 9)}
# The same average, wildly uneven.
ERRATIC = {'2026-09-01': 10.0, '2026-09-02': 400.0, '2026-09-03': 5.0,
           '2026-09-04': 300.0, '2026-09-05': 20.0, '2026-09-06': 60.0,
           '2026-09-07': 5.0, '2026-09-08': 0.0}


class TestItRefusesWithoutHistory:
    def test_a_handful_of_days_produces_no_forecast(self):
        """Two draws in a week is not a distribution, and percentiles from
        three numbers are an artefact of which days happened to be seen."""
        result = stockout_forecast(quantity=1000, daily_consumption={'2026-09-01': 50.0})
        assert result['available'] is False
        assert 'at least' in result['reason']

    def test_it_says_how_much_it_had(self, station):
        result = stockout_forecast(quantity=1000,
                                   daily_consumption={'2026-09-01': 5.0, '2026-09-02': 5.0})
        assert result['observed_days'] == 2

    def test_the_threshold_is_declared(self):
        assert MIN_OBSERVED_DAYS >= 3

    def test_days_with_no_consumption_do_not_pad_the_count(self):
        """Eight calendar days of which two had a draw is two observations,
        not eight."""
        sparse = {f'2026-09-{d:02d}': (100.0 if d < 3 else 0.0) for d in range(1, 9)}
        assert stockout_forecast(quantity=500,
                                 daily_consumption=sparse)['available'] is False


class TestDailyBucketing:
    def test_two_draws_in_one_day_are_one_observation(self, station):
        """Counting them separately would make the station look twice as
        variable as it is, which is the one thing this figure is for."""
        from app.stock_ledger import consumption_by_day

        for _ in range(4):
            station.json('post', '/inventory/command', json={
                'transcript': 'Removed 50 litres of diesel fuel',
                'station': 'Maitri', 'dry_run': False})

        series = consumption_by_day(station.db, 'Maitri')['inv-fuel']
        assert len(series) == 1, 'four draws in one day became more than one day'
        assert sum(series.values()) == 200

    def test_draws_on_different_days_are_separate_observations(self, station):
        from datetime import timedelta

        from app.stock_ledger import consumption_by_day
        from app.timeutil import utc_now

        for _ in range(3):
            station.json('post', '/inventory/command', json={
                'transcript': 'Removed 50 litres of diesel fuel',
                'station': 'Maitri', 'dry_run': False})
        rows = station.db.execute(
            "SELECT seq FROM events WHERE module = 'inventory' "
            'AND metadata LIKE \'%"command"%\' ORDER BY seq ASC').fetchall()
        now = utc_now()
        for offset, row in enumerate(rows):
            when = (now - timedelta(days=offset)).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'
            station.db.execute('UPDATE events SET created_at = ? WHERE seq = ?',
                               (when, row['seq']))
        station.db.commit()

        assert len(consumption_by_day(station.db, 'Maitri')['inv-fuel']) == 3


class TestTheSpread:
    def test_a_steady_station_gets_a_tight_band(self):
        result = stockout_forecast(quantity=1000, daily_consumption=STEADY)
        assert result['available'] is True
        # Ten days at exactly 100/day: every trial lands on the same day.
        assert result['p10_days'] == result['p50_days'] == 10

    def test_an_erratic_station_gets_a_wide_one(self):
        """The whole reason for doing this: the same average, a very
        different risk."""
        steady = stockout_forecast(quantity=1000, daily_consumption=STEADY)
        erratic = stockout_forecast(quantity=1000, daily_consumption=ERRATIC)
        assert erratic['p50_days'] - erratic['p10_days'] > \
            steady['p50_days'] - steady['p10_days']

    def test_the_bad_case_is_never_later_than_the_middle_one(self):
        result = stockout_forecast(quantity=1000, daily_consumption=ERRATIC)
        assert result['p10_days'] <= result['p50_days']

    def test_it_reports_the_observed_range_in_plain_units(self):
        """A band read without a statistics background."""
        spread = stockout_forecast(quantity=1000, daily_consumption=ERRATIC)['spread']
        assert spread['low'] <= spread['median'] <= spread['high']

    def test_more_stock_runs_out_later(self):
        small = stockout_forecast(quantity=500, daily_consumption=STEADY)
        large = stockout_forecast(quantity=5000, daily_consumption=STEADY)
        assert large['p50_days'] > small['p50_days']

    def test_a_blizzard_multiplier_brings_the_date_forward(self):
        """The history was recorded under the conditions that held then; the
        forecast is asked about now."""
        calm = stockout_forecast(quantity=2000, daily_consumption=STEADY, multiplier=1.0)
        storm = stockout_forecast(quantity=2000, daily_consumption=STEADY, multiplier=2.0)
        assert storm['p50_days'] < calm['p50_days']

    def test_plentiful_stock_reports_survival_rather_than_a_date(self):
        """Past the horizon the answer is "plenty", and a 400-day figure
        invites a precision nobody should read into it."""
        result = stockout_forecast(quantity=10_000_000, daily_consumption=STEADY)
        assert result['survived_horizon_pct'] == 100.0
        assert result['horizon_days'] == HORIZON_DAYS


class TestItIsReproducible:
    def test_the_same_state_forecasts_the_same_way_every_time(self):
        """An operator who refreshes and sees P50 move four days has learned
        to distrust the number, and rightly.

        Repeated rather than compared twice: two unseeded runs agree by
        chance often enough that a single comparison is a flaky test, which
        is worse than none — it would report the seeding as working on the
        runs where luck held.
        """
        runs = [stockout_forecast(quantity=12_000, daily_consumption=ERRATIC)
                for _ in range(6)]
        assert all(run == runs[0] for run in runs)

    def test_an_explicit_seed_is_honoured(self):
        """The escape hatch the reproducibility rests on."""
        assert stockout_forecast(quantity=12_000, daily_consumption=ERRATIC, seed=1) \
            != stockout_forecast(quantity=12_000, daily_consumption=ERRATIC, seed=999)


class TestProbabilityOfLasting:
    def test_it_answers_the_question_an_operator_actually_asks(self):
        """Not "when does it run out" but "does it reach the tanker"."""
        inputs = {'quantity': 1000, 'daily_consumption': STEADY}
        assert probability_lasts(inputs, until_days=5) == 100.0
        assert probability_lasts(inputs, until_days=30) == 0.0

    def test_a_marginal_case_lands_between_the_two(self):
        inputs = {'quantity': 1000, 'daily_consumption': ERRATIC}
        chance = probability_lasts(inputs, until_days=10)
        assert 0.0 < chance < 100.0

    def test_it_refuses_without_enough_history(self):
        assert probability_lasts(
            {'quantity': 1000, 'daily_consumption': {'2026-09-01': 10.0}},
            until_days=10) is None


class TestThroughTheApi:
    def test_a_fresh_station_reports_no_forecast_rather_than_a_guess(self, station):
        result = station.json('get', '/inventory/stockout-risk?station=Maitri')
        assert result['items']
        assert all(i['forecast']['available'] is False for i in result['items'])

    def test_the_deterministic_figure_is_still_there(self, station):
        """The forecast sits beside days_of_cover, never in place of it."""
        fuel = next(i for i in station.json(
            'get', '/inventory/stockout-risk?station=Maitri')['items']
            if i['name'] == 'Diesel Fuel')
        assert fuel['days_of_cover'] > 0

    def test_it_names_its_method(self, station):
        """A percentile with no method behind it is a number people
        over-read."""
        result = station.json('get', '/inventory/stockout-risk?station=Maitri')
        assert 'bootstrap' in result['method']
        assert 'own recorded' in result['method']

    def test_recorded_consumption_produces_a_real_forecast(self, station):
        """End to end: draws recorded through the console become the
        distribution the forecast resamples."""
        from datetime import timedelta

        from app.timeutil import utc_now
        for _ in range(MIN_OBSERVED_DAYS + 2):
            station.json('post', '/inventory/command', json={
                'transcript': 'Removed 120 litres of diesel fuel',
                'station': 'Maitri', 'dry_run': False})
        # Spread them across distinct days — two draws an hour apart are one
        # day's consumption, which is the point of bucketing by day.
        rows = station.db.execute(
            "SELECT seq FROM events WHERE module = 'inventory' "
            'AND metadata LIKE \'%"command"%\' ORDER BY seq ASC').fetchall()
        now = utc_now()
        for offset, row in enumerate(rows):
            when = (now - timedelta(days=offset + 1)).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'
            station.db.execute('UPDATE events SET created_at = ? WHERE seq = ?',
                               (when, row['seq']))
        station.db.commit()

        fuel = next(i for i in station.json(
            'get', '/inventory/stockout-risk?station=Maitri')['items']
            if i['name'] == 'Diesel Fuel')
        assert fuel['forecast']['available'] is True
        assert fuel['forecast']['p50_days'] > 0

    def test_it_answers_whether_stock_reaches_a_given_horizon(self, station):
        result = station.json(
            'get', '/inventory/stockout-risk?station=Maitri&until_days=30')
        assert result['items']

    @pytest.mark.parametrize('until', [0, -5, 400])
    def test_an_absurd_horizon_is_refused(self, station, until):
        assert station.get(
            f'/inventory/stockout-risk?station=Maitri&until_days={until}'
        ).status_code == 422
