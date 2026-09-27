"""Readiness scoring, crew commitment, lifecycle and the resupply recommender."""

import pytest

from app.routes.expeditions import READINESS_WEIGHTS, STATION_CAPACITY


class TestReadinessScoring:
    def test_the_weights_are_a_proper_average(self, station):
        assert sum(READINESS_WEIGHTS.values()) == pytest.approx(1.0)

    def test_the_breakdown_is_returned_so_the_score_is_auditable(self, station):
        result = station.json('post', '/expeditions/feasibility', json={
            'station': 'Maitri', 'personnel_required': 2, 'fuel_required_l': 1000})
        assert set(result['readiness_breakdown']) == set(READINESS_WEIGHTS)
        assert 0 <= result['readiness_score'] <= 100

    def test_a_resourced_traverse_scores_clean(self, station):
        result = station.json('post', '/expeditions/feasibility', json={
            'station': 'Maitri', 'personnel_required': 2, 'fuel_required_l': 1000})
        assert all(item['ok'] for item in result['items'])

    def test_a_fuel_shortfall_says_how_short(self, station):
        result = station.json('post', '/expeditions/feasibility', json={
            'station': 'Maitri', 'personnel_required': 2, 'fuel_required_l': 20_000})
        fuel = next(i for i in result['items'] if i['label'].startswith('Fuel'))
        assert fuel['ok'] is False
        assert '13500' in fuel['detail'].replace(',', '')

    def test_crew_is_counted_at_the_departure_station_only(self, station):
        """Counting all three stations' crew let an under-staffed outpost read
        as fully resourced on another station's people."""
        result = station.json('post', '/expeditions/feasibility', json={
            'station': 'Himadri', 'personnel_required': 10, 'fuel_required_l': 10})
        crew = next(i for i in result['items'] if i['label'] == 'Crew')
        assert crew['available'] == len(station.personnel('Himadri'))
        assert crew['ok'] is False

    def test_inbound_cargo_is_a_positive_not_a_blocker(self, station):
        """The old rule marked an expedition *less* feasible precisely because
        resupply was on its way. What matters is whether it is stuck."""
        before = station.json('post', '/expeditions/feasibility', json={
            'station': 'Maitri', 'personnel_required': 2, 'fuel_required_l': 1000})
        station.ship()
        after = station.json('post', '/expeditions/feasibility', json={
            'station': 'Maitri', 'personnel_required': 2, 'fuel_required_l': 1000})
        assert after['readiness_score'] >= before['readiness_score']

    def test_delayed_cargo_is_a_blocker(self, station):
        station.ship()
        station.set_weather(40)
        result = station.json('post', '/expeditions/feasibility', json={
            'station': 'Maitri', 'personnel_required': 2, 'fuel_required_l': 1000})
        cargo = next(i for i in result['items'] if i['label'] == 'Inbound Supplies')
        assert cargo['ok'] is False
        assert 'delayed' in cargo['detail']

    def test_berths_are_per_station(self, station):
        result = station.json('post', '/expeditions/feasibility', json={
            'station': 'Himadri', 'personnel_required': 1, 'fuel_required_l': 1})
        beds = next(i for i in result['items'] if i['label'] == 'Beds at Base')
        assert str(STATION_CAPACITY['Himadri']) in beds['detail']

    def test_assigning_crew_does_not_make_the_same_traverse_read_short(self, station):
        """People already named on THIS traverse still count as available to
        it — otherwise picking a crew made the expedition look short-staffed."""
        crew = [p['id'] for p in station.personnel()[:2]]
        expedition = station.plan_expedition(personnel_required=2, crew_ids=crew)
        result = station.json('post', '/expeditions/feasibility', json={
            'station': 'Maitri', 'personnel_required': 2, 'fuel_required_l': 1000,
            'expedition_id': expedition['id']})
        assert next(i for i in result['items'] if i['label'] == 'Crew')['ok'] is True


class TestTraverseFuelSelection:
    """Which row a traverse draws from, now that a station holds two fuels.

    Snowcats and generators run on diesel; the helicopter runs on aviation
    turbine fuel. They are not interchangeable, and the selection used to be
    "whichever row named *fuel* holds the most".
    """

    def test_a_traverse_draws_diesel_not_whichever_fuel_there_is_more_of(self, station):
        # Put aviation fuel well above diesel, which is exactly the condition
        # that would have loaded a snowcat with jet fuel.
        station.set_quantity('inv-avtur', 50_000)
        diesel_before = station.item('Diesel Fuel')['quantity']
        aviation_before = station.item('Aviation Turbine Fuel')['quantity']

        crew = [p['id'] for p in station.personnel()[:2]]
        expedition = station.plan_expedition(personnel_required=2, fuel_required_l=1000,
                                             crew_ids=crew)
        station.json('patch', f'/expeditions/{expedition["id"]}', json={'status': 'active'})

        assert station.item('Diesel Fuel')['quantity'] == diesel_before - 1000
        assert station.item('Aviation Turbine Fuel')['quantity'] == aviation_before

    def test_readiness_is_measured_against_diesel_alone(self, station):
        """Aviation fuel sitting in the next tank does not make a traverse
        viable. Counting it would report a station as resourced for a journey
        it cannot make."""
        station.set_quantity('inv-fuel', 500)
        station.set_quantity('inv-avtur', 50_000)
        result = station.json('post', '/expeditions/feasibility', json={
            'station': 'Maitri', 'personnel_required': 2, 'fuel_required_l': 5000})
        fuel = next(i for i in result['items'] if i['label'].startswith('Fuel'))
        assert fuel['available'] == 500
        assert fuel['ok'] is False

    def test_calling_a_traverse_off_returns_the_diesel(self, station):
        station.set_quantity('inv-avtur', 50_000)
        before = station.item('Diesel Fuel')['quantity']
        crew = [p['id'] for p in station.personnel()[:2]]
        expedition = station.plan_expedition(personnel_required=2, fuel_required_l=1000,
                                             crew_ids=crew)
        station.patch(f'/expeditions/{expedition["id"]}', json={'status': 'active'})
        station.patch(f'/expeditions/{expedition["id"]}', json={'status': 'cancelled'})
        assert station.item('Diesel Fuel')['quantity'] == before


class TestResupplyRecommender:
    def test_a_shortfall_names_the_inbound_consignment(self, station):
        """Telling a commander they are short and stopping there sends them to
        the Cargo page to scroll for a tanker by hand."""
        shipment = station.ship(quantity=4000, eta_hours=14)
        result = station.json('post', '/expeditions/feasibility', json={
            'station': 'Maitri', 'personnel_required': 2, 'fuel_required_l': 20_000})
        resupply = next(i for i in result['items']
                        if i['label'].startswith('Fuel'))['resupply']
        assert resupply['barcode_id'] == shipment['barcode_id']
        assert resupply['eta_hours'] == pytest.approx(14, abs=0.2)

    def test_it_says_whether_the_gap_is_actually_closed(self, station):
        station.ship(quantity=4000, eta_hours=14)
        partial = next(i for i in station.json('post', '/expeditions/feasibility', json={
            'station': 'Maitri', 'personnel_required': 2, 'fuel_required_l': 20_000})['items']
            if i['label'].startswith('Fuel'))['resupply']
        assert partial['covers_shortfall'] is False
        assert 'Partial cover' in partial['recommendation_text']

    def test_a_consignment_that_covers_the_gap_says_so(self, station):
        station.ship(quantity=9000, eta_hours=10)
        full = next(i for i in station.json('post', '/expeditions/feasibility', json={
            'station': 'Maitri', 'personnel_required': 2, 'fuel_required_l': 8000})['items']
            if i['label'].startswith('Fuel'))['resupply']
        assert full['covers_shortfall'] is True
        assert 'resolvable' in full['recommendation_text']

    def test_nothing_inbound_means_no_recommendation(self, station):
        result = station.json('post', '/expeditions/feasibility', json={
            'station': 'Maitri', 'personnel_required': 2, 'fuel_required_l': 20_000})
        assert next(i for i in result['items']
                    if i['label'].startswith('Fuel'))['resupply'] is None

    def test_cargo_already_unloaded_is_not_offered_again(self, station):
        """It has already been counted in the stock figure the shortfall was
        measured against, so offering it would double-count it."""
        shipment = station.ship(quantity=4000)
        for _ in range(3):
            station.post(f'/shipments/{shipment["id"]}/scan')
        result = station.json('post', '/expeditions/feasibility', json={
            'station': 'Maitri', 'personnel_required': 2, 'fuel_required_l': 20_000})
        assert next(i for i in result['items']
                    if i['label'].startswith('Fuel'))['resupply'] is None

    def test_a_resourced_traverse_gets_no_recommendation(self, station):
        station.ship()
        result = station.json('post', '/expeditions/feasibility', json={
            'station': 'Maitri', 'personnel_required': 2, 'fuel_required_l': 100})
        assert all(i['resupply'] is None for i in result['items'])


class TestCrew:
    def test_someone_from_another_station_cannot_join(self, station):
        outsider = station.personnel('Bharati')[0]
        response = station.post('/expeditions', json={
            'name': 'X', 'station': 'Maitri', 'personnel_required': 1,
            'fuel_required_l': 10, 'crew_ids': [outsider['id']]})
        assert response.status_code == 422

    def test_someone_already_committed_cannot_be_double_booked(self, station):
        person = station.personnel()[0]
        station.plan_expedition(name='First', crew_ids=[person['id']])
        response = station.post('/expeditions', json={
            'name': 'Second', 'station': 'Maitri', 'personnel_required': 1,
            'fuel_required_l': 10, 'crew_ids': [person['id']]})
        assert response.status_code == 409

    def test_someone_not_at_base_cannot_be_assigned(self, station):
        person = station.personnel()[0]
        station.patch(f'/personnel/{person["id"]}/status', json={'status': 'in_transit'})
        response = station.post('/expeditions', json={
            'name': 'X', 'station': 'Maitri', 'personnel_required': 1,
            'fuel_required_l': 10, 'crew_ids': [person['id']]})
        assert response.status_code == 409

    def test_an_unknown_person_is_a_404(self, station):
        response = station.post('/expeditions', json={
            'name': 'X', 'station': 'Maitri', 'personnel_required': 1,
            'fuel_required_l': 10, 'crew_ids': ['per-nobody']})
        assert response.status_code == 404

    def test_the_roster_is_frozen_once_the_traverse_departs(self, station):
        crew = [p['id'] for p in station.personnel()[:2]]
        expedition = station.plan_expedition(personnel_required=2, crew_ids=crew)
        station.patch(f'/expeditions/{expedition["id"]}', json={'status': 'active'})
        response = station.patch(f'/expeditions/{expedition["id"]}/crew',
                                 json={'crew_ids': crew[:1]})
        assert response.status_code == 409


class TestLifecycle:
    def test_authorising_needs_the_named_crew_to_be_there(self, station):
        expedition = station.plan_expedition(personnel_required=3, crew_ids=[])
        response = station.patch(f'/expeditions/{expedition["id"]}', json={'status': 'active'})
        assert response.status_code == 409
        assert 'Add 3 more' in response.json()['detail']

    def test_authorising_draws_the_fuel_and_deploys_the_crew(self, station):
        """Not a label change: it commits people to the field and takes fuel
        out of store, which is what makes the next readiness check honest."""
        crew = [p['id'] for p in station.personnel()[:2]]
        before = station.item('Diesel Fuel')['quantity']
        expedition = station.plan_expedition(personnel_required=2, fuel_required_l=1000,
                                             crew_ids=crew)
        station.json('patch', f'/expeditions/{expedition["id"]}', json={'status': 'active'})
        assert station.item('Diesel Fuel')['quantity'] == before - 1000
        assert all(p['status'] == 'field' for p in station.personnel()
                   if p['id'] in crew)

    def test_calling_off_a_loaded_traverse_returns_the_fuel(self, station):
        crew = [p['id'] for p in station.personnel()[:2]]
        before = station.item('Diesel Fuel')['quantity']
        expedition = station.plan_expedition(personnel_required=2, fuel_required_l=1000,
                                             crew_ids=crew)
        station.patch(f'/expeditions/{expedition["id"]}', json={'status': 'active'})
        station.patch(f'/expeditions/{expedition["id"]}', json={'status': 'cancelled'})
        assert station.item('Diesel Fuel')['quantity'] == before

    def test_completing_consumes_the_fuel_and_releases_the_crew(self, station):
        crew = [p['id'] for p in station.personnel()[:2]]
        before = station.item('Diesel Fuel')['quantity']
        expedition = station.plan_expedition(personnel_required=2, fuel_required_l=1000,
                                             crew_ids=crew)
        station.patch(f'/expeditions/{expedition["id"]}', json={'status': 'active'})
        station.json('patch', f'/expeditions/{expedition["id"]}', json={'status': 'completed'})
        assert station.item('Diesel Fuel')['quantity'] == before - 1000
        assert all(p['status'] == 'returned' and p['expedition_id'] is None
                   for p in station.personnel() if p['id'] in crew)

    def test_a_closed_traverse_cannot_be_reopened(self, station):
        expedition = station.plan_expedition(personnel_required=0, crew_ids=[])
        station.patch(f'/expeditions/{expedition["id"]}', json={'status': 'cancelled'})
        assert station.patch(f'/expeditions/{expedition["id"]}',
                             json={'status': 'active'}).status_code == 409

    def test_authorising_is_refused_when_the_station_is_short(self, station):
        crew = [p['id'] for p in station.personnel()[:2]]
        expedition = station.plan_expedition(personnel_required=2, fuel_required_l=999_999,
                                             crew_ids=crew)
        response = station.patch(f'/expeditions/{expedition["id"]}', json={'status': 'active'})
        assert response.status_code == 409

    def test_an_unknown_expedition_is_a_404(self, station):
        assert station.patch('/expeditions/exp-nope',
                             json={'status': 'active'}).status_code == 404


class TestRescore:
    def test_adopts_the_live_figure_as_the_new_baseline(self, station):
        """What an operator presses after acting on a degradation alarm: "I
        have seen the new numbers" — which is what stops it re-firing."""
        expedition = station.plan_expedition(fuel_required_l=1000)
        result = station.json('post', f'/expeditions/{expedition["id"]}/rescore')
        assert result['baseline_readiness_score'] == result['live_readiness_score']
        assert result['readiness_degraded'] is False

    def test_it_is_written_to_the_audit_trail(self, station):
        expedition = station.plan_expedition()
        station.post(f'/expeditions/{expedition["id"]}/rescore')
        assert any('re-scored against live conditions' in a
                   for a in station.event_actions(module='expedition', station='Maitri'))

    def test_an_unknown_expedition_is_a_404(self, station):
        assert station.post('/expeditions/exp-nope/rescore').status_code == 404


class TestParseEndpoint:
    def test_reports_honestly_which_path_ran(self, station):
        """The UI must not claim "AI parsed this" when a regex did."""
        result = station.json('post', '/expeditions/parse-nl',
                              json={'text': 'Survey at Bharati with 6 scientists for 10 days'})
        assert result['parse_source'] == 'fallback'
        assert result['ai_used'] is False

    def test_the_rules_still_extract_the_essentials(self, station):
        result = station.json('post', '/expeditions/parse-nl',
                              json={'text': 'Survey at Bharati with 6 scientists for 10 days'})
        assert result['station'] == 'Bharati'
        assert result['personnel_required'] == 6
