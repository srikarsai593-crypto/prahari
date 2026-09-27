"""Depletion model, supply policy, standing alerts and cross-station lookup."""

import pytest

from app.routes.inventory import (NOMINAL_HEADCOUNT, RISK_CLASS_POLICY, UNBOUNDED_COVER_DAYS,
                                  compute_depletion, policy_for, risk_class)


def item(**overrides):
    base = {'name': 'Diesel Fuel', 'category': 'consumable', 'quantity': 6500,
            'unit': 'L', 'base_burn_rate': 350, 'beta': 0.15}
    base.update(overrides)
    return base


class TestRiskClass:
    @pytest.mark.parametrize('name, expected', [
        ('Diesel Fuel', 'fuel'),
        ('Aviation Turbine Fuel', 'fuel'),
        ('Medical Supplies', 'medical'),
        ('Emergency Rations', 'rations'),
        ('Drinking Water', 'rations'),
    ])
    def test_is_read_off_what_the_row_actually_is(self, name, expected):
        """The `category` column only ever holds consumable/reusable, so the
        policy band cannot come from it."""
        assert risk_class(item(name=name)) == expected

    def test_reusable_kit_is_treated_as_spares(self):
        assert risk_class(item(name='Thermal Blankets', category='reusable')) == 'spare_parts'

    def test_an_unrecognised_consumable_falls_back_to_the_generic_band(self):
        assert risk_class(item(name='Widgets')) == 'consumable'

    def test_medicine_is_judged_far_more_harshly_than_diesel(self):
        """A medical flight cannot land at Maitri mid-winter, so 20 days of
        pharmaceuticals is an emergency while 20 days of diesel is a normal
        interval between tanker runs."""
        assert (RISK_CLASS_POLICY['medical']['critical_days']
                > RISK_CLASS_POLICY['fuel']['critical_days'])

    @pytest.mark.parametrize('band, critical, warning', [
        ('medical', 25, 45),
        ('fuel', 14, 30),
        ('rations', 20, 35),
        ('spare_parts', 10, 20),
        ('consumable', 15, 30),
    ])
    def test_the_matrix_is_pinned(self, band, critical, warning):
        """These are resupply-cadence judgements, not arbitrary constants.
        Changing one is a domain decision and should have to be made here too,
        rather than drifting silently under tests that read the constant back."""
        assert RISK_CLASS_POLICY[band] == {'critical_days': critical,
                                           'warning_days': warning}

    def test_every_band_warns_before_it_condemns(self):
        for band, policy in RISK_CLASS_POLICY.items():
            assert policy['warning_days'] > policy['critical_days'], band


class TestPolicy:
    def test_class_defaults_apply_when_nothing_is_configured(self):
        assert policy_for(item())['critical_days'] == RISK_CLASS_POLICY['fuel']['critical_days']

    def test_an_explicit_floor_replaces_the_class_default(self):
        assert policy_for(item(safety_stock_days=30))['critical_days'] == 30

    def test_the_warning_band_never_sinks_below_the_critical_one(self):
        """Inheriting the class warning band alongside a custom critical band
        could put "depleting" *below* "critical", so a row would go straight
        from green to red with the amber state unreachable."""
        for configured in (1, 5, 14, 40, 200):
            policy = policy_for(item(safety_stock_days=configured))
            assert policy['warning_days'] > policy['critical_days']


class TestDepletion:
    def test_the_documented_formula(self):
        result = compute_depletion(item(), delta_t=0)
        assert result['depletion_rate'] == pytest.approx(350)
        assert result['days_of_cover'] == pytest.approx(6500 / 350, abs=0.1)

    def test_a_blizzard_shortens_the_runway(self):
        calm = compute_depletion(item(), delta_t=0)['days_of_cover']
        storm = compute_depletion(item(), delta_t=30)['days_of_cover']
        assert storm < calm / 4

    def test_a_large_negative_delta_cannot_produce_negative_cover(self):
        """The multiplier is floored at 0.1 so a bad reading cannot flip the
        rate negative and render as a real, reassuring number."""
        result = compute_depletion(item(), delta_t=-1000)
        assert result['depletion_rate'] > 0
        assert result['days_of_cover'] > 0

    def test_an_item_that_is_not_consumed_reads_as_unbounded(self):
        result = compute_depletion(item(base_burn_rate=0), delta_t=0)
        assert result['days_of_cover'] == UNBOUNDED_COVER_DAYS

    def test_cover_is_capped_rather_than_reported_as_five_digits(self):
        result = compute_depletion(item(quantity=10**9, base_burn_rate=0.001), delta_t=0)
        assert result['days_of_cover'] == UNBOUNDED_COVER_DAYS

    def test_negative_stock_is_treated_as_empty(self):
        assert compute_depletion(item(quantity=-50), delta_t=0)['days_of_cover'] == 0

    def test_headcount_scales_what_the_crew_consumes(self):
        one_crew = compute_depletion(item(name='Emergency Rations'), 0, headcount_factor=1.0)
        double = compute_depletion(item(name='Emergency Rations'), 0, headcount_factor=2.0)
        assert double['depletion_rate'] == pytest.approx(one_crew['depletion_rate'] * 2)
        assert double['days_of_cover'] == pytest.approx(one_crew['days_of_cover'] / 2, rel=0.01)

    def test_headcount_does_not_scale_reusable_kit(self):
        """Blankets and generator spares wear out and fail; they are not eaten."""
        blankets = item(name='Thermal Blankets', category='reusable', base_burn_rate=0.5)
        assert (compute_depletion(blankets, 0, headcount_factor=3.0)['depletion_rate']
                == compute_depletion(blankets, 0, headcount_factor=1.0)['depletion_rate'])

    def test_state_bands_follow_the_policy(self):
        assert compute_depletion(item(quantity=350 * 5), 0)['stock_state'] == 'critical'
        assert compute_depletion(item(quantity=350 * 20), 0)['stock_state'] == 'depleting'
        assert compute_depletion(item(quantity=350 * 60), 0)['stock_state'] == 'nominal'

    def test_a_configured_floor_is_reported_independently_of_days(self):
        """Quantity and cover answer different questions: a battery bank that
        must never fall below ten units is short at ten units however slowly
        it is being drawn down."""
        result = compute_depletion(item(quantity=6500, minimum_threshold=7000), delta_t=0)
        assert result['is_below_minimum'] is True

    def test_no_floor_configured_is_not_a_breach(self):
        assert compute_depletion(item(), delta_t=0)['is_below_minimum'] is False


class TestInventoryEndpoint:
    def test_lists_only_the_requested_station(self, station):
        assert {i['station'] for i in station.inventory('Bharati')} == {'Bharati'}

    def test_every_row_carries_its_policy_verdict(self, station):
        for row in station.inventory():
            assert row['stock_state'] in ('critical', 'depleting', 'nominal')
            assert row['critical_days'] < row['warning_days']

    def test_weather_moves_every_row_at_that_station(self, station):
        before = {i['id']: i['days_of_cover'] for i in station.inventory()}
        station.set_weather(30)
        after = {i['id']: i['days_of_cover'] for i in station.inventory()}
        moved = [k for k in before if after[k] < before[k]]
        assert len(moved) >= 3

    def test_weather_at_one_station_leaves_the_others_alone(self, station):
        before = {i['id']: i['days_of_cover'] for i in station.inventory('Bharati')}
        station.set_weather(30, station='Maitri')
        assert {i['id']: i['days_of_cover'] for i in station.inventory('Bharati')} == before

    def test_headcount_basis_is_reported(self, station):
        basis = station.json('get', '/inventory/headcount/Maitri')
        assert basis['headcount'] == NOMINAL_HEADCOUNT['Maitri']
        assert basis['factor'] == 1.0

    def test_crew_leaving_on_a_traverse_slows_consumable_burn(self, station):
        """The cross-module wire: the roster is what the stores are feeding."""
        before = station.item('Emergency Rations')['depletion_rate']
        for person in station.personnel()[:3]:
            station.patch(f'/personnel/{person["id"]}/status', json={'status': 'in_transit'})
        after = station.item('Emergency Rations')['depletion_rate']
        assert after < before

    def test_the_burn_rate_floor_keeps_an_empty_station_finite(self, station):
        """An empty base still runs its heating and its freezers, so cover must
        not read as infinite just because nobody is signed in."""
        for person in station.personnel():
            station.patch(f'/personnel/{person["id"]}/status', json={'status': 'in_transit'})
        rations = station.item('Emergency Rations')
        assert 0 < rations['depletion_rate']
        assert rations['days_of_cover'] < UNBOUNDED_COVER_DAYS


class TestPolicyEndpoint:
    def test_setting_a_floor_changes_the_verdict(self, station):
        fuel = station.item('Diesel Fuel')
        assert fuel['stock_state'] != 'critical'
        updated = station.json('patch', f'/inventory/{fuel["id"]}/policy',
                               json={'safety_stock_days': 40, 'station': 'Maitri'})
        assert updated['critical_days'] == 40
        assert updated['stock_state'] == 'critical'

    def test_a_floor_can_be_cleared_again(self, station):
        fuel = station.item('Diesel Fuel')
        station.json('patch', f'/inventory/{fuel["id"]}/policy',
                     json={'safety_stock_days': 40, 'minimum_threshold': 9000})
        cleared = station.json('patch', f'/inventory/{fuel["id"]}/policy',
                               json={'clear_safety_stock_days': True, 'clear_minimum': True})
        assert cleared['minimum_threshold'] is None
        assert cleared['critical_days'] == RISK_CLASS_POLICY['fuel']['critical_days']

    def test_a_policy_cannot_be_written_across_stations(self, station):
        fuel = station.item('Diesel Fuel')
        response = station.patch(f'/inventory/{fuel["id"]}/policy',
                                 json={'safety_stock_days': 40, 'station': 'Bharati'})
        assert response.status_code == 403

    def test_an_unknown_item_is_a_404(self, station):
        assert station.patch('/inventory/nope/policy',
                             json={'safety_stock_days': 10}).status_code == 404


class TestStandingAlerts:
    def test_crossing_a_floor_writes_a_record_that_outlives_the_tab(self, station):
        station.set_weather(30)
        alerts = station.json('get', '/inventory/alerts?station=Maitri')
        assert alerts, 'a blizzard should put consumables below their buffer'
        assert any('CRITICAL STOCK ALERT' in a
                   for a in station.event_actions(module='inventory', station='Maitri'))

    def test_recovery_clears_the_alert(self, station):
        station.set_weather(30)
        assert station.json('get', '/inventory/alerts?station=Maitri')
        station.set_weather(0)
        assert station.json('get', '/inventory/alerts?station=Maitri') == []
        assert any('STOCK ALERT CLEARED' in a
                   for a in station.event_actions(module='inventory', station='Maitri'))

    def test_reading_the_page_does_not_log_the_same_alert_again(self, station):
        """The evaluation hangs off writes, not reads. Logging on every poll
        would bury the operator's own actions under a heartbeat."""
        station.set_weather(30)
        before = sum('CRITICAL STOCK ALERT' in a
                     for a in station.event_actions(module='inventory', station='Maitri'))
        for _ in range(5):
            station.inventory()
            station.json('get', '/inventory/alerts?station=Maitri')
        after = sum('CRITICAL STOCK ALERT' in a
                    for a in station.event_actions(module='inventory', station='Maitri'))
        assert after == before

    def test_an_alert_does_not_re_fire_while_it_stays_breached(self, station):
        station.set_weather(30)
        before = sum('CRITICAL STOCK ALERT' in a
                     for a in station.event_actions(module='inventory', station='Maitri'))
        station.set_weather(31)
        station.set_weather(32)
        after = sum('CRITICAL STOCK ALERT' in a
                    for a in station.event_actions(module='inventory', station='Maitri'))
        assert after == before

    def test_alerts_are_scoped_to_their_station(self, station):
        station.set_weather(30, station='Maitri')
        assert station.json('get', '/inventory/alerts?station=Bharati') == []


class TestCrossStation:
    def test_finds_the_item_at_every_station_that_holds_it(self, station):
        result = station.json('get', '/inventory/cross-station?item_name=Diesel')
        assert {i['station'] for i in result['items']} == {'Maitri', 'Bharati', 'Himadri'}

    def test_names_the_deepest_reserve(self, station):
        result = station.json('get', '/inventory/cross-station?item_name=Diesel')
        deepest = max(result['items'], key=lambda i: i['days_of_cover'])
        assert result['best_source'] == deepest['station']

    def test_reports_the_units_in_play_so_incomparable_rows_are_visible(self, station):
        result = station.json('get', '/inventory/cross-station?item_name=e')
        assert len(result['units']) >= 2

    def test_no_match_is_an_empty_answer_not_an_error(self, station):
        result = station.json('get', '/inventory/cross-station?item_name=unobtanium')
        assert result['matched'] == 0 and result['best_source'] is None


class TestStockCommand:
    def test_a_dry_run_writes_nothing(self, station):
        before = station.item('Diesel Fuel')['quantity']
        preview = station.json('post', '/inventory/command', json={
            'transcript': 'Removed 200 litres of diesel fuel',
            'station': 'Maitri', 'dry_run': True})
        assert preview['applied'] is False
        assert preview['new_quantity'] == before - 200
        assert station.item('Diesel Fuel')['quantity'] == before

    def test_applying_moves_the_stock(self, station):
        before = station.item('Diesel Fuel')['quantity']
        result = station.json('post', '/inventory/command', json={
            'transcript': 'Removed 200 litres of diesel fuel',
            'station': 'Maitri', 'dry_run': False})
        assert result['applied'] is True
        assert station.item('Diesel Fuel')['quantity'] == before - 200

    def test_an_ambiguous_item_is_refused_with_its_candidates(self, station):
        station.db.execute(
            "INSERT INTO inventory_items (id, name, category, station, quantity, unit, "
            "base_burn_rate, beta) VALUES ('t-av', 'Aviation Turbine Fuel', 'consumable', "
            "'Maitri', 3200, 'L', 90, 0.15)")
        station.db.commit()
        result = station.json('post', '/inventory/command', json={
            'transcript': 'Removed 200 litres of fuel',
            'station': 'Maitri', 'dry_run': True})
        assert result['applied'] is False
        assert sorted(result['ambiguous_matches']) == ['Aviation Turbine Fuel', 'Diesel Fuel']

    def test_issuing_more_than_is_held_says_so_rather_than_clamping_silently(self, station):
        result = station.json('post', '/inventory/command', json={
            'transcript': 'Removed 99999 litres of diesel fuel',
            'station': 'Maitri', 'dry_run': False})
        assert station.item('Diesel Fuel')['quantity'] == 0
        assert 'could not be issued' in result['warning']

    def test_a_command_is_confined_to_the_active_station(self, station):
        before = station.item('Diesel Fuel', 'Bharati')['quantity']
        station.json('post', '/inventory/command', json={
            'transcript': 'Removed 200 litres of diesel fuel',
            'station': 'Maitri', 'dry_run': False})
        assert station.item('Diesel Fuel', 'Bharati')['quantity'] == before

    def test_a_write_needs_the_commander_key(self, station):
        response = station.client.post('/inventory/command', json={
            'transcript': 'Removed 200 litres of diesel fuel',
            'station': 'Maitri', 'dry_run': False})
        assert response.status_code == 401

    def test_the_write_itself_refuses_to_take_direction_from_a_sign(
            self, station, monkeypatch):
        """Defence in depth, deliberately tested past the layer above it.

        `LLMStockCommandParse` rejects a negative quantity, so in normal
        operation the route's own guard is never reached — which is exactly
        why it needs its own test. If the parse bounds are ever relaxed or
        bypassed, this is the line standing between a malformed parse and a
        station believing it has fuel it does not have.
        """
        import app.routes.inventory as inventory_routes

        async def rogue_parse(_transcript):
            return {'action': 'decrement', 'quantity': -200, 'item': 'Diesel Fuel',
                    'location': 'Maitri', 'parse_source': 'gemini'}

        monkeypatch.setattr(inventory_routes, 'parse_stock_command', rogue_parse)
        before = station.item('Diesel Fuel')['quantity']
        station.json('post', '/inventory/command', json={
            'transcript': 'Removed 200 litres of diesel fuel',
            'station': 'Maitri', 'dry_run': False})
        assert station.item('Diesel Fuel')['quantity'] == before - 200

    def test_a_model_returning_a_negative_quantity_cannot_invent_stock(
            self, db_path, llm_backed):
        """A well-formed but wrong parse, which only a model can produce: a
        'decrement' of -200. The bounds reject it, the chain falls through to
        the regex rules, and the removal is applied as a removal."""
        from fastapi.testclient import TestClient
        from app.main import app
        from tests.conftest import Station

        llm_backed('{"action": "decrement", "quantity": -200, '
                   '"item": "Diesel Fuel", "location": "Maitri"}')
        with TestClient(app) as client:
            sta = Station(client)
            before = sta.item('Diesel Fuel')['quantity']
            result = sta.json('post', '/inventory/command', json={
                'transcript': 'Removed 200 litres of diesel fuel',
                'station': 'Maitri', 'dry_run': False})
            assert result['parsed']['parse_source'] == 'fallback'
            assert sta.item('Diesel Fuel')['quantity'] == before - 200


class TestExactCount:
    def test_is_a_plain_aggregate_not_an_estimate(self, station):
        result = station.json('get', '/inventory/Maitri/count?item=Diesel')
        assert result['method'] == 'direct_sql_aggregate'
        assert result['quantity'] == station.item('Diesel Fuel')['quantity']

    def test_refuses_to_sum_incompatible_units(self, station):
        """Adding litres to kilograms would return a plausible wrong number,
        which is the one thing a stock count must never do."""
        assert station.get('/inventory/Maitri/count?item=e').status_code == 409

    def test_an_unknown_item_is_a_404(self, station):
        assert station.get('/inventory/Maitri/count?item=unobtanium').status_code == 404
