"""Cross-module propagation.

A readiness score stored at planning time is a claim about a moment that has
passed. These are about the chain that keeps it honest: a write anywhere that
moves station conditions has to reach the module that was counting on them.

The seeded numbers these lean on: Maitri holds 6,500 L of diesel and burns
350 L/day in calm weather. A traverse has to leave enough behind to outlast
itself, so a nominal seven-day trip can spare roughly 4,000 L and no more.
"""

from app.cascade import DEGRADE_TOLERANCE

# Comfortably sparable: 2,000 L out leaves 4,500 L, or nearly thirteen days of
# calm-weather cover against a seven-day traverse.
SPARABLE_FUEL = 2000


def viable_traverse(station, **overrides):
    """A traverse the station can currently support, with its baseline fixed.

    "Support" means two things: enough fuel to load, and enough left behind to
    outlast the traverse at the current burn rate.
    """
    body = {'personnel_required': 2, 'fuel_required_l': SPARABLE_FUEL}
    body.update(overrides)
    expedition = station.plan_expedition(**body)
    return station.json('post', f'/expeditions/{expedition["id"]}/rescore')


def reload(station, expedition_id):
    return station.json('get', f'/expeditions/{expedition_id}')


def line(expedition, label):
    return next(i for i in expedition['live_feasibility'] if i['label'].startswith(label))


class TestReadinessDegradation:
    def test_a_stock_write_re_scores_open_traverses(self, station):
        traverse = viable_traverse(station)
        assert traverse['live_readiness_score'] == 100

        station.set_quantity('inv-fuel', 500)          # below what it needs to load
        after = reload(station, traverse['id'])
        assert after['live_readiness_score'] < traverse['baseline_readiness_score']
        assert after['readiness_degraded'] is True

    def test_the_baseline_is_preserved_so_the_drop_is_visible(self, station):
        traverse = viable_traverse(station)
        station.set_quantity('inv-fuel', 500)
        assert reload(station, traverse['id'])['baseline_readiness_score'] \
            == traverse['baseline_readiness_score']

    def test_the_degradation_names_what_is_now_short(self, station):
        traverse = viable_traverse(station)
        station.set_quantity('inv-fuel', 500)
        assert line(reload(station, traverse['id']), 'Fuel')['ok'] is False

    def test_it_is_written_to_the_audit_log(self, station):
        viable_traverse(station)
        station.set_quantity('inv-fuel', 500)
        assert any('FEASIBILITY DEGRADED' in a
                   for a in station.event_actions(module='expedition', station='Maitri'))

    def test_a_small_movement_is_not_an_alarm(self, station):
        """Crew step out to the workshop and a litre of fuel gets drawn. An
        alarm on every write is one an operator learns to dismiss."""
        traverse = viable_traverse(station)
        station.set_quantity('inv-fuel', 6400)
        assert reload(station, traverse['id'])['readiness_degraded'] is False

    def test_the_alarm_announces_a_crossing_not_a_state(self, station):
        """Re-announcing on every write while conditions stay bad is how an
        operator learns to stop reading the banner."""
        viable_traverse(station)
        station.set_quantity('inv-fuel', 500)
        raised = sum('FEASIBILITY DEGRADED' in a
                     for a in station.event_actions(module='expedition', station='Maitri'))
        assert raised == 1

        station.set_quantity('inv-fuel', 400)
        station.set_quantity('inv-fuel', 300)
        assert sum('FEASIBILITY DEGRADED' in a
                   for a in station.event_actions(module='expedition',
                                                  station='Maitri')) == raised

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

    def test_another_stations_traverse_is_untouched(self, station):
        elsewhere = station.plan_expedition(station='Bharati', personnel_required=2,
                                            fuel_required_l=1000)
        station.json('post', f'/expeditions/{elsewhere["id"]}/rescore')
        station.set_quantity('inv-fuel', 100)
        assert reload(station, elsewhere['id'])['readiness_degraded'] is False

    def test_rescoring_clears_the_alarm(self, station):
        traverse = viable_traverse(station)
        station.set_quantity('inv-fuel', 500)
        assert reload(station, traverse['id'])['readiness_degraded'] is True

        station.json('post', f'/expeditions/{traverse["id"]}/rescore')
        assert reload(station, traverse['id'])['readiness_degraded'] is False

    def test_the_tolerance_is_a_real_threshold(self, station):
        assert DEGRADE_TOLERANCE > 0


class TestStationReserve:
    """Whether the station can *spare* the fuel, not only whether it has it.

    This is what makes a blizzard reach an expedition. Weather does not take
    litres out of the tank; it raises the rate they leave it. A check that only
    asked "is there enough right now" was blind to the conditions a traverse
    would actually depart into.
    """

    def test_a_traverse_that_drains_the_station_is_refused(self, station):
        """6,500 L on hand, 5,000 L loaded, 350 L/day burned: the station has
        four days of cover left and the traverse is away for seven."""
        result = station.json('post', '/expeditions/feasibility', json={
            'station': 'Maitri', 'personnel_required': 2, 'fuel_required_l': 5000})
        reserve = next(i for i in result['items'] if i['label'] == 'Station Reserve')
        fuel = next(i for i in result['items'] if i['label'].startswith('Fuel'))

        assert fuel['ok'] is True, 'there is enough to load'
        assert reserve['ok'] is False, 'and the station cannot spare it'
        assert 'runs dry before it returns' in reserve['detail']

    def test_a_modest_traverse_is_fine(self, station):
        result = station.json('post', '/expeditions/feasibility', json={
            'station': 'Maitri', 'personnel_required': 2, 'fuel_required_l': SPARABLE_FUEL})
        assert all(i['ok'] for i in result['items'])

    def test_a_shorter_traverse_can_spare_more(self, station):
        """The reserve is measured against how long the station has to cover."""
        short = station.json('post', '/expeditions/feasibility', json={
            'station': 'Maitri', 'personnel_required': 2, 'fuel_required_l': 5000,
            'start_date': '2026-01-01', 'end_date': '2026-01-03'})
        assert next(i for i in short['items'] if i['label'] == 'Station Reserve')['ok'] is True

    def test_a_longer_traverse_can_spare_less(self, station):
        long_trip = station.json('post', '/expeditions/feasibility', json={
            'station': 'Maitri', 'personnel_required': 2, 'fuel_required_l': SPARABLE_FUEL,
            'start_date': '2026-01-01', 'end_date': '2026-03-01'})
        assert next(i for i in long_trip['items']
                    if i['label'] == 'Station Reserve')['ok'] is False

    def test_it_is_not_assessed_when_there_is_nothing_to_load(self, station):
        """A traverse that cannot depart at all is not also told its reserve is
        short; one problem, reported once."""
        result = station.json('post', '/expeditions/feasibility', json={
            'station': 'Maitri', 'personnel_required': 2, 'fuel_required_l': 99_999})
        reserve = next(i for i in result['items'] if i['label'] == 'Station Reserve')
        assert reserve['ok'] is True
        assert 'Not assessed' in reserve['detail']

    def test_a_blizzard_alone_condemns_a_traverse_that_was_viable(self, station):
        """The gap this closes. No stock moved and no cargo involved — the
        station is simply burning four times faster than it was."""
        traverse = viable_traverse(station)
        assert reload(station, traverse['id'])['readiness_degraded'] is False

        station.set_weather(30)

        after = reload(station, traverse['id'])
        assert after['readiness_degraded'] is True
        assert line(after, 'Station Reserve')['ok'] is False

    def test_the_blizzard_lifting_makes_it_viable_again(self, station):
        traverse = viable_traverse(station)
        station.set_weather(30)
        assert reload(station, traverse['id'])['readiness_degraded'] is True

        station.set_weather(0)
        assert reload(station, traverse['id'])['readiness_degraded'] is False


class TestCargoCascade:
    def test_a_delayed_consignment_alone_does_not_condemn_a_traverse(self, station):
        """A crate slipping is not the same as a traverse being unviable.

        Delayed inbound cargo is worth a few points and sits deliberately below
        the alarm threshold. The delay is set directly here rather than through
        the weather, because at this station's stock any blizzard heavy enough
        to hold a consignment also breaks the reserve — and then the test would
        be measuring two things at once.
        """
        traverse = viable_traverse(station)
        shipment = station.ship(priority='critical')
        station.db.execute("UPDATE shipments SET status = 'delayed', "
                           "delay_reason = 'weather' WHERE id = ?", (shipment['id'],))
        station.db.commit()

        station.set_quantity('inv-fuel', 6500)      # a write, to trigger the cascade

        after = reload(station, traverse['id'])
        assert line(after, 'Inbound Supplies')['ok'] is False
        assert after['live_readiness_score'] < 100
        assert after['readiness_degraded'] is False

    def test_weather_delays_cargo_and_announces_the_chain(self, station):
        station.ship(priority='critical')
        station.set_weather(40)
        cascade = [a for a in station.event_actions(station='Maitri', limit=200)
                   if 'SUPPLY CHAIN CASCADE' in a]
        assert cascade and 'delayed' in cascade[0]

    def test_the_whole_chain_is_recorded_as_one_event(self, station):
        """Weather -> cargo -> expedition, said once, rather than three
        unrelated lines an operator has to join up."""
        viable_traverse(station)
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
        """The cascade has to run in both directions, or the alarm sticks after
        the thing that caused it has been resolved."""
        station.set_quantity('inv-fuel', 1500)
        traverse = viable_traverse(station, fuel_required_l=5000)
        assert traverse['live_readiness_score'] < 100

        shipment = station.ship(quantity=20_000)
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
        traverse at this station was just scored against numbers that no longer
        hold."""
        crew = [p['id'] for p in station.personnel()[:2]]
        first = station.plan_expedition(name='First', personnel_required=2,
                                        fuel_required_l=3500, crew_ids=crew)
        second = viable_traverse(station, name='Second', personnel_required=2)

        station.patch(f'/expeditions/{first["id"]}', json={'status': 'active'})

        assert reload(station, second['id'])['readiness_degraded'] is True
