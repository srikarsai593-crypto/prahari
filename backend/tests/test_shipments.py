"""Consignment lifecycle, unit-safe restock, weather risk and overdue convoys."""

import pytest

from app.routes.shipments import CAPACITY_KG, _score_risk


class TestRiskModel:
    def test_calm_weather_is_low_risk(self):
        assert _score_risk(0, 'normal') < 50

    def test_risk_rises_with_the_blizzard(self):
        assert _score_risk(40, 'normal') > _score_risk(10, 'normal')

    def test_critical_cargo_carries_extra_exposure(self):
        assert _score_risk(20, 'critical') > _score_risk(20, 'normal')

    def test_the_score_stays_a_percentage(self):
        for delta_t in (0, 30, 60, 500):
            for priority in ('low', 'normal', 'critical'):
                assert 0 <= _score_risk(delta_t, priority) <= 100


class TestCreation:
    def test_a_consignment_defaults_to_the_nominal_sea_leg(self, station):
        assert station.ship()['eta'].endswith('Z')

    def test_the_payload_inherits_the_destination_row_s_unit(self, station):
        """So the two can never disagree and unloading cannot add kilograms
        onto a row counted in litres."""
        assert station.ship(unit=None)['unit'] == 'L'

    def test_a_barcode_is_unique_per_consignment(self, station):
        codes = {station.ship()['barcode_id'] for _ in range(8)}
        assert len(codes) == 8, 'a COUNT(*)-based scheme races on concurrent creates'

    def test_an_overweight_crate_is_flagged_rather_than_refused(self, station):
        result = station.ship(weight_kg=CAPACITY_KG + 1)
        assert 'exceeds vessel capacity' in result['capacity_warning']

    def test_a_consignment_matching_no_stock_row_says_it_will_not_restock(self, station):
        result = station.ship(item_name='Mystery Crate', category='equipment',
                              inventory_item_id=None, quantity=None)
        assert 'restock_warning' in result

    def test_stock_cannot_be_booked_against_another_station_s_row(self, station):
        response = station.post('/shipments', json={
            'item_name': 'Diesel Fuel', 'category': 'fuel', 'weight_kg': 100,
            'inventory_item_id': 'inv-bha-fuel', 'destination_station': 'Maitri'})
        assert response.status_code == 422


class TestInterStationTransfer:
    def test_stock_leaves_the_origin_at_dispatch(self, station):
        """The crate cannot both sit at the origin and be in the hold."""
        before = station.item('Diesel Fuel', 'Bharati')['quantity']
        station.ship(origin_station='Bharati', quantity=1000)
        assert station.item('Diesel Fuel', 'Bharati')['quantity'] == before - 1000

    def test_a_transfer_needs_a_stated_quantity(self, station):
        response = station.post('/shipments', json={
            'item_name': 'Diesel Fuel', 'category': 'fuel', 'weight_kg': 100,
            'inventory_item_id': 'inv-fuel', 'origin_station': 'Bharati',
            'destination_station': 'Maitri'})
        assert response.status_code == 422

    def test_the_origin_cannot_send_what_it_does_not_have(self, station):
        response = station.post('/shipments', json={
            'item_name': 'Diesel Fuel', 'category': 'fuel', 'weight_kg': 100,
            'quantity': 999_999, 'unit': 'L', 'inventory_item_id': 'inv-fuel',
            'origin_station': 'Bharati', 'destination_station': 'Maitri'})
        assert response.status_code == 409


class TestScanning:
    def test_walks_the_status_chain(self, station):
        shipment = station.ship()
        statuses = [station.json('post', f'/shipments/{shipment["id"]}/scan')['new_status']
                    for _ in range(3)]
        assert statuses == ['in_transit', 'arrived', 'unloaded']

    def test_unloading_restocks_the_row_it_was_booked_against(self, station):
        before = station.item('Diesel Fuel')['quantity']
        shipment = station.ship(quantity=4000)
        for _ in range(3):
            station.post(f'/shipments/{shipment["id"]}/scan')
        assert station.item('Diesel Fuel')['quantity'] == before + 4000

    def test_a_fully_processed_crate_cannot_be_scanned_again(self, station):
        shipment = station.ship()
        for _ in range(3):
            station.post(f'/shipments/{shipment["id"]}/scan')
        assert station.post(f'/shipments/{shipment["id"]}/scan').status_code == 409

    def test_a_unit_mismatch_blocks_the_restock_and_records_why(self, station):
        """Adding kilograms onto a row counted in litres invents stock."""
        before = station.item('Diesel Fuel')['quantity']
        shipment = station.ship(quantity=500, unit='kg')
        for _ in range(3):
            station.post(f'/shipments/{shipment["id"]}/scan')
        assert station.item('Diesel Fuel')['quantity'] == before
        assert any('unit mismatch' in a for a in station.event_actions(module='cargo'))

    def test_scanning_by_barcode_works_too(self, station):
        shipment = station.ship()
        result = station.json('post', '/shipments/scan-barcode',
                              json={'barcode_id': shipment['barcode_id']})
        assert result['new_status'] == 'in_transit'

    def test_an_unknown_barcode_is_a_404(self, station):
        assert station.post('/shipments/scan-barcode',
                            json={'barcode_id': 'SHP-NOPE'}).status_code == 404


class TestWeather:
    def test_every_consignment_to_the_station_is_re_scored(self, station):
        """Weather is a property of the station, not of one crate. Scoring a
        single selected shipment left the rest on the previous weather."""
        for _ in range(3):
            station.ship()
        assert station.set_weather(30)['affected'] == 3

    def test_severe_weather_delays_and_pushes_the_eta_back(self, station):
        shipment = station.ship(priority='critical')
        original_eta = shipment['eta']
        station.set_weather(40)
        updated = station.json('get', f'/shipments/{shipment["id"]}')
        assert updated['status'] == 'delayed'
        assert updated['eta'] > original_eta

    def test_repeated_weather_updates_do_not_compound_the_delay(self, station):
        """The ETA is recomputed from the original dispatch date, not from an
        already-delayed one."""
        shipment = station.ship(priority='critical')
        station.set_weather(40)
        once = station.json('get', f'/shipments/{shipment["id"]}')['eta']
        station.set_weather(40)
        assert station.json('get', f'/shipments/{shipment["id"]}')['eta'] == once

    def test_the_blizzard_lifting_releases_a_weather_hold(self, station):
        """A shipment held for weather resumes rather than staying delayed for
        ever because nothing ever cleared it."""
        shipment = station.ship(priority='critical')
        station.set_weather(40)
        assert station.json('get', f'/shipments/{shipment["id"]}')['status'] == 'delayed'
        station.set_weather(0)
        assert station.json('get', f'/shipments/{shipment["id"]}')['status'] == 'in_transit'

    def test_weather_does_not_touch_another_station_s_cargo(self, station):
        station.ship(destination_station='Bharati', inventory_item_id='inv-bha-fuel')
        assert station.set_weather(40, station='Maitri')['affected'] == 0


class TestOverdueConvoys:
    def test_a_crate_past_its_eta_with_no_scan_is_flagged(self, station):
        """A sled convoy bogged in soft snow does not announce itself; nothing
        was ever comparing the clock against the ETA."""
        shipment = station.ship(eta_hours=-6.5)
        listed = next(s for s in station.json('get', '/shipments?station=Maitri')
                      if s['id'] == shipment['id'])
        assert listed['is_overdue'] is True
        assert listed['hours_overdue'] == pytest.approx(6.5, abs=0.2)
        assert 'never scanned since dispatch' in listed['stalled_warning']

    def test_a_crate_still_in_its_window_is_not(self, station):
        shipment = station.ship(eta_hours=48)
        listed = next(s for s in station.json('get', '/shipments?station=Maitri')
                      if s['id'] == shipment['id'])
        assert listed['is_overdue'] is False
        assert listed['stalled_warning'] is None

    def test_an_arrived_crate_is_never_overdue(self, station):
        """It is not late; it is here."""
        shipment = station.ship(eta_hours=-6.5)
        for _ in range(2):
            station.post(f'/shipments/{shipment["id"]}/scan')
        listed = next(s for s in station.json('get', '/shipments?station=Maitri')
                      if s['id'] == shipment['id'])
        assert listed['is_overdue'] is False

    def test_stalled_convoys_sort_to_the_top(self, station):
        station.ship(eta_hours=48)
        late = station.ship(item_name='Snowcat Tracks', category='equipment',
                            inventory_item_id=None, quantity=None, eta_hours=-6.5)
        assert station.json('get', '/shipments?station=Maitri')[0]['id'] == late['id']

    def test_lateness_is_derived_on_read_so_it_is_never_stale(self, station):
        """No background job, which matters for a station that may be offline
        for days: there is no backlog to catch up on."""
        shipment = station.ship(eta_hours=-1)
        assert station.json('get', f'/shipments/{shipment["id"]}')['is_overdue'] is True


class TestBeaconPing:
    def test_records_the_request_and_the_last_known_facts(self, station):
        shipment = station.ship(eta_hours=-6.5)
        result = station.json('post', f'/shipments/{shipment["id"]}/beacon-ping')
        assert result['is_overdue'] is True
        assert 'no live satellite link' in result['note']

    def test_it_lands_in_the_audit_trail(self, station):
        shipment = station.ship(eta_hours=-6.5)
        station.post(f'/shipments/{shipment["id"]}/beacon-ping')
        assert any('Beacon ping requested' in a
                   for a in station.event_actions(module='cargo', station='Maitri'))

    def test_a_crate_that_has_arrived_cannot_be_interrogated(self, station):
        shipment = station.ship()
        for _ in range(2):
            station.post(f'/shipments/{shipment["id"]}/scan')
        assert station.post(f'/shipments/{shipment["id"]}/beacon-ping').status_code == 409


class TestQrCodes:
    def test_images_are_not_inlined_into_the_list(self, station):
        """Encoding a PNG per row on every poll made the list O(n) image
        encodes and added ~10 kB per shipment to the payload."""
        station.ship()
        assert all('qr_code' not in s for s in station.json('get', '/shipments'))

    def test_one_is_fetched_only_when_it_is_displayed(self, station):
        shipment = station.ship()
        assert station.json('get', f'/shipments/{shipment["id"]}/qr')['qr_code']
