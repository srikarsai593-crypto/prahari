"""Cross-module propagation.

A readiness score stored at planning time is a claim about a moment that has
passed. These tests are about the chain that keeps it honest: a write anywhere
that moves station conditions has to reach the module that was counting on
those conditions.
"""

from app.cascade import DEGRADE_TOLERANCE


def viable_traverse(station, **overrides):
    """A traverse the station can currently support, with its baseline fixed."""
    body = {'personnel_required': 2, 'fuel_required_l': 5000}
    body.update(overrides)
    expedition = station.plan_expedition(**body)
    return station.json('post', f'/expeditions/{expedition["id"]}/rescore')


def reload(station, expedition_id):
    return station.json('get', f'/expeditions/{expedition_id}')


class TestReadinessDegradation:
    def test_a_stock_write_re_scores_open_traverses(self, station):
        traverse = viable_traverse(station)
        assert traverse['live_readiness_score'] == 100

        station.set_quantity('inv-fuel', 1500)
        after = reload(station, traverse['id'])
        assert after['live_readiness_score'] < traverse['baseline_readiness_score']
        assert after['readiness_degraded'] is True

    def test_the_baseline_is_preserved_so_the_drop_is_visible(self, station):
        traverse = viable_traverse(station)
        station.set_quantity('inv-fuel', 1500)
        after = reload(station, traverse['id'])
        assert after['baseline_readiness_score'] == traverse['baseline_readiness_score']

    def test_the_degradation_names_what_is_now_short(self, station):
        traverse = viable_traverse(station)
        station.set_quantity('inv-fuel', 1500)
        shortfalls = [i for i in reload(station, traverse['id'])['live_feasibility']
                      if not i['ok']]
        assert any(i['label'].startswith('Fuel') for i in shortfalls)

    def test_it_is_written_to_the_audit_log(self, station):
        viable_traverse(station)
        station.set_quantity('inv-fuel', 1500)
        assert any('FEASIBILITY DEGRADED' in a
                   for a in station.event_actions(module='expedition', station='Maitri'))

    def test_a_small_movement_is_not_an_alarm(self, station):
        """Crew step out to the workshop and a litre of fuel gets drawn. An
        alarm on every write is one an operator learns to dismiss."""
        traverse = viable_traverse(station)
        station.set_quantity('inv-fuel', 6400)
        assert reload(station, traverse['id'])['readiness_degraded'] is False

    def test_the_alarm_announces_a_crossing_not_a_state(self, station):
        """Re-announcing on every write while the blizzard sits at +25 is how
        an operator learns to stop reading the banner."""
        viable_traverse(station)
        station.set_quantity('inv-fuel', 1500)
        first = sum('FEASIBILITY DEGRADED' in a
                    for a in station.event_actions(module='expedition', station='Maitri'))
        station.set_quantity('inv-fuel', 1400)
        station.set_quantity('inv-fuel', 1300)
        after = sum('FEASIBILITY DEGRADED' in a
                    for a in station.event_actions(module='expedition', station='Maitri'))
        assert after == first == 1

    def test_crew_leaving_degrades_readiness_too(self, station):
        traverse = viable_traverse(station, personnel_required=5, fuel_required_l=100)
        for person in station.personnel()[:4]:
            station.patch(f'/personnel/{person["id"]}/status', json={'status': 'in_transit'})
        assert reload(station, traverse['id'])['readiness_degraded'] is True

    def test_a_closed_traverse_is_not_monitored(self, station):
        """It cannot degrade; it is already over."""
        traverse = viable_traverse(station, personnel_required=0)
        station.patch(f'/expeditions/{traverse["id"]}', json={'status': 'cancelled'})
        station.set_quantity('inv-fuel', 100)
        assert reload(station, traverse['id'])['readiness_degraded'] is False

    def test_another_station_s_traverse_is_untouched(self, station):
        elsewhere = station.plan_expedition(station='Bharati', personnel_required=2,
                                            fuel_required_l=1000)
        station.json('post', f'/expeditions/{elsewhere["id"]}/rescore')
        station.set_quantity('inv-fuel', 100)
        assert reload(station, elsewhere['id'])['readiness_degraded'] is False

    def test_rescoring_clears_the_alarm(self, station):
        traverse = viable_traverse(station)
        station.set_quantity('inv-fuel', 1500)
        assert reload(station, traverse['id'])['readiness_degraded'] is True
        station.json('post', f'/expeditions/{traverse["id"]}/rescore')
        assert reload(station, traverse['id'])['readiness_degraded'] is False

    def test_the_tolerance_is_a_real_threshold(self, station):
        assert DEGRADE_TOLERANCE > 0


class TestWeatherCascade:
    def test_weather_delays_cargo_and_announces_the_chain(self, station):
        station.ship(priority='critical')
        station.set_weather(40)
        cascade = [a for a in station.event_actions(station='Maitri', limit=200)
                   if 'SUPPLY CHAIN CASCADE' in a]
        assert cascade and 'delayed' in cascade[0]

    def test_a_delayed_consignment_alone_does_not_condemn_a_traverse(self, station):
        """Weather does not remove litres from the tank — it raises the rate
        they are burned at, and feasibility asks what is in store *now*. So a
        blizzard reaches an expedition only through its delayed cargo, which is
        worth a few points and is deliberately below the alarm threshold. An
        operator told a traverse is unviable every time a crate slips would
        stop reading the alarm."""
        traverse = viable_traverse(station, fuel_required_l=6000)
        station.ship(priority='critical')
        result = station.set_weather(40)

        assert result['delayed'] >= 1
        after = reload(station, traverse['id'])
        assert after['live_readiness_score'] < traverse['baseline_readiness_score']
        assert after['readiness_degraded'] is False

    def test_weather_on_top_of_a_thin_store_does_condemn_it(self, station):
        """The case the cascade exists for: the store was already tight, and
        the blizzard is what takes the traverse past the line."""
        traverse = viable_traverse(station, fuel_required_l=5000)
        station.set_quantity('inv-fuel', 1500)
        station.ship(priority='critical')
        result = station.set_weather(40)
        assert any(e['expedition_id'] == traverse['id']
                   for e in result['degraded_expeditions'])

    def test_the_whole_chain_is_recorded_as_one_event(self, station):
        """Weather -> cargo -> expedition, said once, rather than three
        unrelated lines an operator has to join up."""
        viable_traverse(station, fuel_required_l=5000)
        station.set_quantity('inv-fuel', 1500)
        station.ship(priority='critical')
        station.set_weather(40)
        cascade = [a for a in station.event_actions(station='Maitri', limit=200)
                   if 'SUPPLY CHAIN CASCADE' in a]
        assert cascade
        assert 'delayed' in cascade[0] and 'readiness' in cascade[0]

    def test_calm_weather_with_nothing_affected_raises_nothing(self, station):
        station.set_weather(0)
        assert not [a for a in station.event_actions(station='Maitri', limit=200)
                    if 'SUPPLY CHAIN CASCADE' in a]

    def test_the_blizzard_also_puts_stock_below_its_buffer(self, station):
        station.set_weather(30)
        assert station.json('get', '/inventory/alerts?station=Maitri')


class TestArrivalRecovery:
    def test_unloading_cargo_lifts_a_traverse_back_out_of_shortfall(self, station):
        """The cascade has to run in both directions, or the alarm sticks
        after the thing that caused it has been resolved."""
        station.set_quantity('inv-fuel', 1500)
        traverse = viable_traverse(station, fuel_required_l=5000)
        assert traverse['live_readiness_score'] < 100

        shipment = station.ship(quantity=8000)
        for _ in range(3):
            station.post(f'/shipments/{shipment["id"]}/scan')
        after = reload(station, traverse['id'])
        assert after['live_readiness_score'] > traverse['live_readiness_score']

    def test_restocking_clears_the_standing_stock_alert(self, station):
        station.set_quantity('inv-fuel', 100)
        assert station.json('get', '/inventory/alerts?station=Maitri')
        shipment = station.ship(quantity=20_000)
        for _ in range(3):
            station.post(f'/shipments/{shipment["id"]}/scan')
        remaining = [a['name'] for a in station.json('get', '/inventory/alerts?station=Maitri')]
        assert 'Diesel Fuel' not in remaining


class TestAuthorisingPropagates:
    def test_drawing_fuel_re_scores_the_other_traverses(self, station):
        """Fuel left the store and crew left the roster, so every other
        traverse at this station was just scored against numbers that no
        longer hold."""
        crew = [p['id'] for p in station.personnel()[:2]]
        first = station.plan_expedition(name='First', personnel_required=2,
                                        fuel_required_l=6000, crew_ids=crew)
        second = viable_traverse(station, name='Second', personnel_required=2,
                                 fuel_required_l=5000)
        station.patch(f'/expeditions/{first["id"]}', json={'status': 'active'})
        assert reload(station, second['id'])['readiness_degraded'] is True
