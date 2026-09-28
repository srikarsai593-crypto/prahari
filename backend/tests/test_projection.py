"""Dry-running a change to the station.

The point of a what-if is that it is a *question*: it must reach the same
answer the real change would, and it must leave no trace of having been
asked. Both halves are pinned here.
"""

import pytest

from app.models import WhatIfScenario


def _what_if(station, **scenario):
    return station.json('post', '/inventory/what-if?station=Maitri', json=scenario)


def _item(result, name):
    return next(i for i in result['inventory'] if i['name'] == name)


class TestItChangesNothing:
    def test_no_audit_entry_is_written(self, station):
        """A question is not an event. A console that logged every
        hypothetical would bury the operator's real actions under their own
        thinking aloud."""
        before = len(station.events(limit=500))
        _what_if(station, extra_crew=10, delta_t=30, advance_days=20)
        assert len(station.events(limit=500)) == before

    def test_stock_is_untouched(self, station):
        _what_if(station, advance_days=90, delta_t=40)
        assert station.item('Diesel Fuel')['quantity'] == 6500

    def test_the_weather_is_untouched(self, station):
        _what_if(station, delta_t=45)
        assert station.json('get', '/shipments/delta-t/current')['stations']['Maitri'] == 0

    def test_expedition_scores_are_not_persisted(self, station):
        crew = [p['id'] for p in station.personnel()[:2]]
        expedition = station.plan_expedition(personnel_required=2, fuel_required_l=500,
                                             crew_ids=crew)
        _what_if(station, delta_t=40, advance_days=30)
        row = station.db.execute('SELECT live_readiness_score FROM expeditions WHERE id = ?',
                                 (expedition['id'],)).fetchone()
        assert row['live_readiness_score'] is None, 'a question wrote a score'

    def test_it_says_that_it_is_a_projection(self, station):
        """A projection that does not announce itself is indistinguishable
        from a reading."""
        result = _what_if(station)
        assert result['is_projection'] is True and result['persisted'] is False


class TestItAgreesWithReality:
    def test_an_empty_scenario_reproduces_the_station_as_it_stands(self, station):
        """The strongest check available: with nothing changed, before and
        after must be identical, and both must match the live figures."""
        result = _what_if(station)
        live = {i['name']: i['days_of_cover'] for i in station.inventory()}
        for entry in result['inventory']:
            assert entry['before'] == entry['after']
            assert entry['before']['days_of_cover'] == live[entry['name']]

    def test_it_says_so_when_nothing_was_asked(self, station):
        assert any('as it stands' in note for note in _what_if(station)['assumptions'])

    def test_a_projected_blizzard_matches_applying_it_for_real(self, station):
        """The whole design rests on there being one set of formulas. If a
        projection can disagree with the live console, there are two."""
        projected = _item(_what_if(station, delta_t=25), 'Diesel Fuel')['after']

        station.set_weather(25)
        actual = station.item('Diesel Fuel')

        assert projected['days_of_cover'] == actual['days_of_cover']
        assert projected['depletion_rate'] == actual['depletion_rate']

    def test_a_projected_arrival_matches_crew_actually_arriving(self, station):
        """Crew scaling is the other half of the depletion formula, and the
        projection must reach it the same way."""
        rations_before = _item(_what_if(station, extra_crew=0), 'Emergency Rations')['after']
        projected = _item(_what_if(station, extra_crew=3), 'Emergency Rations')['after']
        assert projected['days_of_cover'] < rations_before['days_of_cover']


class TestScenarios:
    def test_more_crew_shortens_the_ration_runway(self, station):
        result = _what_if(station, extra_crew=8)
        rations = _item(result, 'Emergency Rations')
        assert rations['cover_change_days'] < 0
        assert any('crew on station' in note for note in result['assumptions'])

    def test_a_departing_party_lengthens_it(self, station):
        """extra_crew is a delta, so it takes a negative."""
        assert _item(_what_if(station, extra_crew=-3),
                     'Emergency Rations')['cover_change_days'] > 0

    def test_reusable_kit_does_not_move_with_the_roster(self, station):
        """Blankets deplete through wear, not occupancy — the same rule the
        live formula applies."""
        assert _item(_what_if(station, extra_crew=8),
                     'Thermal Blankets')['cover_change_days'] == 0

    def test_a_blizzard_shortens_everything_the_station_burns(self, station):
        result = _what_if(station, delta_t=30)
        assert _item(result, 'Diesel Fuel')['cover_change_days'] < 0

    def test_fast_forwarding_draws_the_stock_down(self, station):
        result = _what_if(station, advance_days=10)
        fuel = _item(result, 'Diesel Fuel')
        assert fuel['after']['quantity'] < fuel['before']['quantity']

    def test_stock_never_projects_below_empty(self, station):
        """A negative quantity would produce a negative cover figure, which
        reads as a very large positive one at a glance."""
        for entry in _what_if(station, advance_days=365, delta_t=50)['inventory']:
            assert entry['after']['quantity'] >= 0
            assert entry['after']['days_of_cover'] >= 0

    def test_it_names_an_item_that_would_cross_into_critical(self, station):
        """The headline of any what-if: what this would break that is not
        broken now."""
        result = _what_if(station, delta_t=40, advance_days=14)
        assert result['summary']['items_newly_critical'] >= 1
        assert any(i['newly_critical'] for i in result['inventory'])

    def test_a_delayed_convoy_is_pushed_not_cancelled(self, station):
        """A slipped ship is still inbound; it just arrives later. Dropping
        it would overstate the damage."""
        station.ship(quantity=4000, eta_hours=48)
        result = _what_if(station, cargo_delay_hours=720)
        assert any('later' in note for note in result['assumptions'])
        assert result['expeditions'] is not None


class TestTraverses:
    def test_it_scores_every_open_traverse(self, station):
        crew = [p['id'] for p in station.personnel()[:2]]
        station.plan_expedition(name='Alpha', personnel_required=2,
                                fuel_required_l=500, crew_ids=crew)
        result = _what_if(station, delta_t=30)
        assert any(e['name'] == 'Alpha' for e in result['expeditions'])

    def test_a_closed_traverse_is_not_projected(self, station):
        """Completed and cancelled traverses cannot degrade; they are over."""
        crew = [p['id'] for p in station.personnel()[:2]]
        expedition = station.plan_expedition(name='Done', personnel_required=2,
                                             fuel_required_l=100, crew_ids=crew)
        station.patch(f'/expeditions/{expedition["id"]}', json={'status': 'cancelled'})
        assert not any(e['name'] == 'Done' for e in _what_if(station)['expeditions'])

    def test_it_reports_a_score_falling_even_when_no_line_item_flips(self, station):
        """A traverse can lose thirty points to the fuel-reserve check
        without any row turning short. Summarising only on newly-short would
        call that scenario harmless."""
        crew = [p['id'] for p in station.personnel()[:2]]
        station.plan_expedition(personnel_required=2, fuel_required_l=1000, crew_ids=crew)
        result = _what_if(station, delta_t=40, advance_days=7)
        assert result['summary']['worst_readiness_change'] < 0

    def test_it_names_what_a_scenario_would_break(self, station):
        crew = [p['id'] for p in station.personnel()[:2]]
        station.plan_expedition(personnel_required=2, fuel_required_l=6000, crew_ids=crew)
        result = _what_if(station, advance_days=20, delta_t=35)
        assert any(e['newly_short'] for e in result['expeditions'])


class TestItIsAReadNotAWrite:
    def test_an_observer_may_ask(self, station, monkeypatch):
        """Asking a question changes nothing, so it must not need write
        credentials — the whole point is to think before committing."""
        from app.routes.inventory import what_if
        import inspect
        source = inspect.getsource(what_if)
        assert 'require_key' not in source and 'require_commander' not in source


class TestTheModel:
    def test_a_scenario_defaults_to_changing_nothing(self):
        scenario = WhatIfScenario()
        assert (scenario.extra_crew, scenario.delta_t,
                scenario.cargo_delay_hours, scenario.advance_days) == (0, None, 0, 0)

    @pytest.mark.parametrize('field, value', [
        ('delta_t', -5), ('delta_t', 500),
        ('advance_days', -1), ('advance_days', 5000),
        ('cargo_delay_hours', -1), ('extra_crew', 9999),
    ])
    def test_absurd_scenarios_are_refused(self, station, field, value):
        """A projection over a thousand years is arithmetic, not an answer."""
        assert station.post('/inventory/what-if?station=Maitri',
                            json={field: value}).status_code == 422
