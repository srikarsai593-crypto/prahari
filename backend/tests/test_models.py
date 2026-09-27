"""Edge validation.

These bounds are load-bearing. `_try_llm_parse` treats a validation failure as
"this provider did not answer" and falls through to the next one and finally to
the deterministic regex rules — so what is rejected here is what degrades to
rules instead of being believed.
"""

import pytest
from pydantic import ValidationError

from app.models import (ExpeditionCreate, IncidentCreate, IncidentUpdateRequest,
                        InventoryUpdateRequest, LLMExpeditionParse, LLMStockCommandParse,
                        MovementPlanCreate, ResetRequest, ShipmentCreate,
                        StationWeatherRequest, StockCommandRequest)


def rejects(model, **fields):
    with pytest.raises(ValidationError):
        model(**fields)


class TestStockCommandParse:
    BASE = {'action': 'decrement', 'quantity': 200, 'item': 'Diesel Fuel',
            'location': 'Maitri'}

    def test_a_well_formed_parse_is_accepted(self):
        assert LLMStockCommandParse(**self.BASE).quantity == 200

    def test_a_negative_quantity_is_refused(self):
        """The direction of a stock movement must never be able to come from
        the sign of its magnitude: a decrement of -200 reads as "removed 200"
        and would write +200, inventing life-support stock from a bad parse."""
        rejects(LLMStockCommandParse, **{**self.BASE, 'quantity': -200})

    def test_an_absurd_quantity_is_refused(self):
        rejects(LLMStockCommandParse, **{**self.BASE, 'quantity': 9e9})

    def test_an_unknown_action_is_refused(self):
        rejects(LLMStockCommandParse, **{**self.BASE, 'action': 'teleport'})

    def test_an_empty_item_is_refused(self):
        rejects(LLMStockCommandParse, **{**self.BASE, 'item': ''})

    @pytest.mark.parametrize('word', ['Removed', 'remove', 'ISSUED', 'consumed', 'decrease'])
    def test_removal_synonyms_normalise(self, word):
        assert LLMStockCommandParse(**{**self.BASE, 'action': word}).action == 'decrement'

    @pytest.mark.parametrize('word', ['Added', 'ADD', 'restocked', 'received', 'increase'])
    def test_addition_synonyms_normalise(self, word):
        assert LLMStockCommandParse(**{**self.BASE, 'action': word}).action == 'increment'


class TestExpeditionParse:
    BASE = {'name': 'Survey', 'station': 'Maitri', 'personnel_required': 4,
            'fuel_required_l': 800}

    def test_an_invented_station_is_refused(self):
        rejects(LLMExpeditionParse, **{**self.BASE, 'station': 'Atlantis'})

    def test_station_casing_and_padding_are_normalised(self):
        assert LLMExpeditionParse(**{**self.BASE, 'station': '  maitri '}).station == 'Maitri'

    def test_a_negative_crew_is_refused(self):
        rejects(LLMExpeditionParse, **{**self.BASE, 'personnel_required': -4})

    def test_an_implausible_crew_is_refused(self):
        rejects(LLMExpeditionParse, **{**self.BASE, 'personnel_required': 10_000})

    def test_negative_fuel_is_refused(self):
        rejects(LLMExpeditionParse, **{**self.BASE, 'fuel_required_l': -1})


class TestControlledVocabularies:
    """Free-form strings made "Atlantis" a valid destination and
    "bogus_priority" a valid priority, which quietly poisons every aggregate
    computed downstream."""

    def test_an_unknown_station_is_refused(self):
        rejects(ExpeditionCreate, name='X', station='Atlantis',
                personnel_required=1, fuel_required_l=1)

    def test_an_unknown_incident_type_is_refused(self):
        rejects(IncidentCreate, type='alien_contact', location_lat=0, location_lng=0)

    def test_an_unknown_cargo_category_is_refused(self):
        rejects(ShipmentCreate, item_name='X', category='contraband', weight_kg=1,
                destination_station='Maitri')


class TestPhysicalBounds:
    def test_stock_cannot_be_set_negative(self):
        """A negative quantity produced a negative days-of-cover that the
        dashboard rendered as a real reading."""
        rejects(InventoryUpdateRequest, quantity=-1)

    def test_blizzard_delta_is_bounded(self):
        rejects(StationWeatherRequest, station='Maitri', delta_t=500)
        rejects(StationWeatherRequest, station='Maitri', delta_t=-5)

    def test_an_incident_radius_must_be_positive(self):
        rejects(IncidentCreate, type='fire', location_lat=0, location_lng=0,
                affected_radius_m=0)

    def test_coordinates_must_be_on_the_planet(self):
        rejects(IncidentCreate, type='fire', location_lat=95, location_lng=0)
        rejects(IncidentCreate, type='fire', location_lat=0, location_lng=200)


class TestMovementPlan:
    BASE = {'personnel_id': 'per-priya', 'origin_lat': -70.767, 'origin_lng': 11.731,
            'destination_lat': -70.850, 'destination_lng': 11.950,
            'destination_name': 'Camp Alpha',
            'departure_time': '2026-01-01T00:00:00Z',
            'expected_arrival': '2026-01-01T06:00:00Z'}

    def test_a_route_needs_at_least_two_points(self):
        rejects(MovementPlanCreate, **self.BASE, planned_route=[{'lat': 1, 'lng': 2}])

    def test_a_waypoint_without_coordinates_is_refused(self):
        rejects(MovementPlanCreate, **self.BASE,
                planned_route=[{'lat': 1, 'lng': 2}, {'lat': 3}])

    def test_a_waypoint_off_the_planet_is_refused(self):
        rejects(MovementPlanCreate, **self.BASE,
                planned_route=[{'lat': 1, 'lng': 2}, {'lat': 999, 'lng': 2}])

    def test_a_valid_route_is_accepted(self):
        plan = MovementPlanCreate(**self.BASE,
                                  planned_route=[{'lat': 1, 'lng': 2}, {'lat': 3, 'lng': 4}])
        assert len(plan.planned_route) == 2


class TestShipmentRouting:
    def test_a_consignment_cannot_be_sent_to_where_it_already_is(self):
        rejects(ShipmentCreate, item_name='Fuel', category='fuel', weight_kg=100,
                origin_station='Maitri', destination_station='Maitri')

    def test_an_inter_station_transfer_is_accepted(self):
        shipment = ShipmentCreate(item_name='Fuel', category='fuel', weight_kg=100,
                                  origin_station='Bharati', destination_station='Maitri')
        assert shipment.origin_station == 'Bharati'

    def test_eta_hours_may_be_negative_to_backdate_a_drill(self):
        assert ShipmentCreate(item_name='X', category='fuel', weight_kg=1,
                              destination_station='Maitri', eta_hours=-6.5).eta_hours == -6.5

    def test_eta_hours_is_still_bounded(self):
        rejects(ShipmentCreate, item_name='X', category='fuel', weight_kg=1,
                destination_station='Maitri', eta_hours=99_999)


class TestIncidentUpdate:
    def test_every_field_is_optional_so_one_can_be_changed_alone(self):
        assert IncidentUpdateRequest(severity='critical').status is None
        assert IncidentUpdateRequest(affected_radius_m=8000).severity is None

    def test_an_unknown_severity_is_refused(self):
        rejects(IncidentUpdateRequest, severity='apocalyptic')

    def test_an_unknown_status_is_refused(self):
        rejects(IncidentUpdateRequest, status='maybe')


class TestResetGuard:
    def test_the_confirmation_word_is_mandatory(self):
        """An accidental POST must not be able to wipe a station's record."""
        rejects(ResetRequest, confirm='yes')
        assert ResetRequest(confirm='RESET').scope == 'operational'


class TestStockCommandRequest:
    def test_a_station_is_required(self):
        """An unscoped write matched the same item name at all three bases."""
        rejects(StockCommandRequest, transcript='Removed 10 litres of fuel')

    def test_an_empty_transcript_is_refused(self):
        rejects(StockCommandRequest, transcript='', station='Maitri')
