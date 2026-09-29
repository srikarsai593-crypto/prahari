"""The leg before the ship.

A consignment starts at the dock; a station's exposure starts weeks earlier
when someone orders the fuel. What makes this a supply chain rather than a
second list is that dispatching an order *creates* the consignment — so
these pin the link, not just the table.
"""

import pytest


def _order(station, **overrides):
    body = {'vendor': 'Indian Oil Corporation', 'item_name': 'Diesel Fuel',
            'category': 'fuel', 'quantity': 9000, 'unit': 'L',
            'inventory_item_id': 'inv-fuel', 'destination_station': 'Maitri'}
    body.update(overrides)
    return station.json('post', '/procurement', json=body)


def _confirm(station, order):
    return station.json('patch', f'/procurement/{order["id"]}', json={'status': 'confirmed'})


class TestRaisingAnOrder:
    def test_an_order_gets_a_reference_and_starts_as_ordered(self, station):
        order = _order(station)
        assert order['reference'].startswith('PO-')
        assert order['status'] == 'ordered'
        assert order['shipment_id'] is None

    def test_it_is_on_the_record(self, station):
        order = _order(station)
        assert any(order['reference'] in a
                   for a in station.event_actions(module='procurement'))

    def test_the_stock_row_it_will_top_up_must_exist(self, station):
        """The id is typed by hand. One that does not resolve makes the
        eventual restock a silent no-op."""
        response = station.post('/procurement', json={
            'vendor': 'X', 'item_name': 'Diesel Fuel', 'category': 'fuel',
            'destination_station': 'Maitri', 'inventory_item_id': 'inv-nope'})
        assert response.status_code == 404

    def test_it_cannot_restock_another_station(self, station):
        """An order routed to Maitri that tops up Bharati's tank is how a
        station's cover figure silently moves for someone else's delivery."""
        response = station.post('/procurement', json={
            'vendor': 'X', 'item_name': 'Diesel Fuel', 'category': 'fuel',
            'destination_station': 'Maitri', 'inventory_item_id': 'inv-bha-fuel'})
        assert response.status_code == 422
        assert 'belongs to Bharati' in response.json()['detail']

    def test_orders_are_scoped_to_a_station(self, station):
        _order(station, destination_station='Maitri', inventory_item_id='inv-fuel')
        _order(station, destination_station='Bharati', inventory_item_id='inv-bha-fuel')
        assert len(station.json('get', '/procurement?station=Maitri')) == 1


class TestTheVendorMissingTheirDate:
    def test_a_slipped_order_is_flagged(self, station):
        """At a realistic lead time nothing is ever late inside a demo, so a
        backdated promise is the only way to reach this path."""
        order = _order(station, promised_in_days=-9)
        assert order['is_overdue'] is True
        assert order['days_overdue'] >= 8
        assert 'Indian Oil' in order['slip_warning']

    def test_an_order_still_in_its_window_is_not(self, station):
        assert _order(station, promised_in_days=30)['is_overdue'] is False

    def test_an_order_with_no_promised_date_is_never_overdue(self, station):
        """No date is not a missed date."""
        assert _order(station)['is_overdue'] is False

    def test_a_shipped_order_stops_being_chased(self, station):
        """Once it is a crate on the board, lateness is the consignment's
        ETA to answer, not the vendor's promise."""
        order = _confirm(station, _order(station, promised_in_days=-30))
        station.json('post', f'/procurement/{order["id"]}/dispatch',
                     json={'weight_kg': 8000})
        assert station.json('get', f'/procurement/{order["id"]}')['is_overdue'] is False

    def test_slipped_orders_sort_to_the_top(self, station):
        _order(station, promised_in_days=40)
        _order(station, item_name='Medical Supplies', category='medical',
               inventory_item_id='inv-med', promised_in_days=-5)
        assert station.json('get', '/procurement?station=Maitri')[0]['is_overdue'] is True


class TestDispatchingIntoTheCargoChain:
    def test_it_creates_a_real_consignment(self, station):
        """The point of the whole feature: not a parallel table that
        mentions the same cargo, but the first leg of one chain."""
        order = _confirm(station, _order(station))
        result = station.json('post', f'/procurement/{order["id"]}/dispatch',
                              json={'weight_kg': 8400})

        shipment = result['shipment']
        assert shipment['barcode_id'].startswith('SHP-')
        assert shipment['id'] in {s['id'] for s in station.json('get', '/shipments')}

    def test_the_order_and_the_crate_are_linked_both_ways(self, station):
        order = _confirm(station, _order(station))
        result = station.json('post', f'/procurement/{order["id"]}/dispatch',
                              json={'weight_kg': 8400})
        assert result['order']['status'] == 'shipped'
        assert result['order']['shipment_id'] == result['shipment']['id']

    def test_the_stock_row_survives_the_handover(self, station):
        """The end-to-end consequence: unloading the crate the order became
        still tops up the item the order named."""
        before = station.item('Diesel Fuel')['quantity']
        order = _confirm(station, _order(station, quantity=4000))
        result = station.json('post', f'/procurement/{order["id"]}/dispatch',
                              json={'weight_kg': 3400})
        for _ in range(3):
            station.json('post', f'/shipments/{result["shipment"]["id"]}/scan')
        assert station.item('Diesel Fuel')['quantity'] == before + 4000

    def test_the_named_row_wins_over_the_category_default(self, station):
        """The sharper version of the test above.

        A consignment with no explicit stock row falls back to a map from
        category to item, and for `fuel` that is Diesel. An order for
        Aviation Turbine Fuel that lost its stock row at the handover would
        therefore restock the wrong tank — silently, and with the right
        total, so nothing downstream would look wrong.
        """
        diesel_before = station.item('Diesel Fuel')['quantity']
        avtur_before = station.item('Aviation Turbine Fuel')['quantity']

        order = _confirm(station, _order(
            station, item_name='Aviation Turbine Fuel', category='fuel',
            inventory_item_id='inv-avtur', quantity=3000, unit='L'))
        result = station.json('post', f'/procurement/{order["id"]}/dispatch',
                              json={'weight_kg': 2600})
        for _ in range(3):
            station.json('post', f'/shipments/{result["shipment"]["id"]}/scan')

        assert station.item('Aviation Turbine Fuel')['quantity'] == avtur_before + 3000
        assert station.item('Diesel Fuel')['quantity'] == diesel_before, \
            'the handover restocked the category default instead of the named row'

    def test_a_cold_chain_band_is_applied_to_the_crate(self, station):
        """It goes through the real creation path, so it gets everything a
        consignment gets — including the band its category carries."""
        order = _confirm(station, _order(
            station, item_name='Medical Supplies', category='medical',
            inventory_item_id='inv-med', quantity=90, unit='units'))
        result = station.json('post', f'/procurement/{order["id"]}/dispatch',
                              json={'weight_kg': 310})
        assert result['shipment']['cold_chain']['monitored'] is True

    def test_an_unconfirmed_order_cannot_be_dispatched(self, station):
        """An order the vendor has not acknowledged is not cargo, and a
        crate on the board for one nobody agreed to supply is a lie."""
        order = _order(station)
        response = station.post(f'/procurement/{order["id"]}/dispatch',
                                json={'weight_kg': 100})
        assert response.status_code == 409
        assert 'Confirm it with the vendor' in response.json()['detail']

    def test_it_cannot_be_dispatched_twice(self, station):
        order = _confirm(station, _order(station))
        station.json('post', f'/procurement/{order["id"]}/dispatch', json={'weight_kg': 100})
        assert station.post(f'/procurement/{order["id"]}/dispatch',
                            json={'weight_kg': 100}).status_code == 409

    def test_the_handover_is_on_the_record(self, station):
        order = _confirm(station, _order(station))
        station.json('post', f'/procurement/{order["id"]}/dispatch', json={'weight_kg': 100})
        assert any('dispatched as consignment' in a
                   for a in station.event_actions(module='procurement'))


class TestAmendingAnOrder:
    def test_a_vendor_acknowledgement_moves_it_to_confirmed(self, station):
        assert _confirm(station, _order(station))['status'] == 'confirmed'

    def test_an_order_can_be_called_off(self, station):
        order = _order(station)
        assert station.json('patch', f'/procurement/{order["id"]}',
                            json={'status': 'cancelled'})['status'] == 'cancelled'

    def test_a_slipped_date_can_be_re_promised(self, station):
        order = _order(station, promised_in_days=-5)
        assert order['is_overdue'] is True
        amended = station.json('patch', f'/procurement/{order["id"]}',
                               json={'promised_in_days': 14})
        assert amended['is_overdue'] is False

    def test_a_shipped_order_can_no_longer_be_edited(self, station):
        """It is a crate now. Editing the order would describe something
        that has already left."""
        order = _confirm(station, _order(station))
        station.json('post', f'/procurement/{order["id"]}/dispatch', json={'weight_kg': 100})
        response = station.patch(f'/procurement/{order["id"]}',
                                 json={'status': 'cancelled'})
        assert response.status_code == 409
        assert 'already shipped' in response.json()['detail']

    def test_an_empty_amendment_is_refused(self, station):
        order = _order(station)
        assert station.patch(f'/procurement/{order["id"]}', json={}).status_code == 422

    def test_shipped_cannot_be_set_by_hand(self, station):
        """An order becomes shipped by being dispatched, which is what
        creates the crate. Setting it directly would leave the chain
        claiming a consignment that does not exist."""
        order = _order(station)
        assert station.patch(f'/procurement/{order["id"]}',
                             json={'status': 'shipped'}).status_code == 422


class TestInTheDemonstrationSeason:
    def test_every_station_has_orders_on_the_board(self, station):
        station.json('post', '/admin/demo-season', json={})
        for name in ('Maitri', 'Bharati', 'Himadri'):
            assert station.json('get', f'/procurement?station={name}')

    def test_orders_name_stock_rows_that_exist(self, station):
        """The ids are typed by hand in demo.py."""
        from app.demo import PURCHASE_ORDERS
        station.json('post', '/admin/demo-season', json={})
        for name, orders in PURCHASE_ORDERS.items():
            rows = {i['id'] for i in station.inventory(name)}
            for spec in orders:
                assert spec['inventory_item_id'] in rows, f'{name}: {spec}'

    def test_at_least_one_vendor_has_slipped(self, station):
        """An order the vendor missed is the row this board exists for."""
        station.json('post', '/admin/demo-season', json={})
        assert any(o['is_overdue'] for o in station.json('get', '/procurement'))

    def test_the_board_shows_both_acknowledged_and_unacknowledged(self, station):
        station.json('post', '/admin/demo-season', json={})
        statuses = {o['status'] for o in station.json('get', '/procurement')}
        assert {'ordered', 'confirmed'} <= statuses

    def test_a_second_season_does_not_double_the_board(self, station):
        """purchase_orders has to be in OPERATIONAL_TABLES, or the reset
        that precedes a season leaves the old orders behind."""
        station.json('post', '/admin/demo-season', json={})
        first = len(station.json('get', '/procurement'))
        station.json('post', '/admin/demo-season', json={})
        assert len(station.json('get', '/procurement')) == first

    def test_a_reset_clears_them(self, station):
        station.json('post', '/admin/demo-season', json={})
        station.json('post', '/admin/reset', json={'confirm': 'RESET'})
        assert station.json('get', '/procurement') == []


class TestCredentials:
    @pytest.mark.parametrize('method, url, body', [
        ('post', '/procurement', {'vendor': 'X', 'item_name': 'Y', 'category': 'fuel',
                                  'destination_station': 'Maitri'}),
        ('patch', '/procurement/po-1', {'status': 'confirmed'}),
        ('post', '/procurement/po-1/dispatch', {'weight_kg': 10}),
    ])
    def test_every_write_needs_the_key(self, station, method, url, body):
        assert getattr(station.client, method)(url, json=body).status_code == 401


class TestTheSeasonShowsEveryStage:
    """One order at each stage, because each is a different control.

    An unacknowledged order offers "Vendor confirmed", a confirmed one offers
    "Dispatch as consignment", and a shipped one links to the crate it
    became. The season planted only the first two, so the third state never
    appeared on the board and the dispatch control looked like it led nowhere.
    """

    def _maitri(self, station):
        station.json('post', '/admin/demo-season', json={})
        return station.json('get', '/procurement?station=Maitri')

    def test_all_three_stages_are_on_the_board(self, station):
        by_status = {o['status'] for o in self._maitri(station)}
        assert {'ordered', 'confirmed', 'shipped'} <= by_status

    def test_the_shipped_one_points_at_a_consignment_that_exists(self, station):
        shipped = next(o for o in self._maitri(station) if o['status'] == 'shipped')

        assert shipped['shipment_id']
        crate = station.json('get', f"/shipments/{shipped['shipment_id']}")
        assert crate['item_name'] == shipped['item_name']

    def test_that_consignment_went_through_the_real_dispatch_path(self, station):
        """Written straight into the table it would have no barcode and no
        band, and the one property this table exists to show — that the two
        legs are a single chain — would be a claim rather than a fact."""
        shipped = next(o for o in self._maitri(station) if o['status'] == 'shipped')
        crate = station.json('get', f"/shipments/{shipped['shipment_id']}")

        assert crate['barcode_id'].startswith('SHP-')
        # Medical cargo carries a cold-chain band; the dispatch path applies it.
        assert crate['temp_min'] == 2.0 and crate['temp_max'] == 8.0
        assert crate['inventory_item_id'] == shipped['inventory_item_id']

    def test_the_crate_is_on_the_cargo_board_like_any_other(self, station):
        shipped = next(o for o in self._maitri(station) if o['status'] == 'shipped')
        board = station.json('get', '/shipments?station=Maitri')

        assert shipped['shipment_id'] in {c['id'] for c in board}

    def test_the_ordered_one_is_not_seeded_already_late(self, station):
        """It exists to show the "awaiting the vendor" state, which an overdue
        order does not — that one shows the chase warning instead."""
        ordered = next(o for o in self._maitri(station) if o['status'] == 'ordered')
        assert ordered['is_overdue'] is False

    def test_a_slipped_order_is_still_there_to_show_the_chase_warning(self, station):
        assert any(o['is_overdue'] for o in self._maitri(station))

    def test_the_confirmed_one_can_still_be_dispatched(self, station):
        confirmed = next(o for o in self._maitri(station)
                         if o['status'] == 'confirmed' and not o['is_overdue'])
        result = station.json('post', f"/procurement/{confirmed['id']}/dispatch",
                              json={'weight_kg': 8400})
        assert result['shipment']['barcode_id'].startswith('SHP-')
