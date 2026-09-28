"""Choosing the right asset for a callout.

Ranking by distance alone sent the nearest snowcat to a casualty while a
helicopter with a medic aboard sat eight minutes further out, and it put a
vehicle on a quarter tank above one that was fuelled and ten metres behind it.
"""

from app.routes.incidents import (ASSET_WEIGHTS, COMFORTABLE_FUEL, FAR_M,
                                  score_asset)

MAITRI = (-70.767, 11.731)


def _asset(**over):
    base = {'name': 'Snowcat', 'type': 'vehicle', 'fuel_pct': 100, 'range_km': 180,
            'speed_kmh': 20, 'seats': 6, 'medic_aboard': 0}
    return {**base, **over}


class TestWhatItWeighs:
    def test_the_nearer_of_two_identical_assets_wins(self, station):
        """Distance is still the largest single factor, and should be."""
        near = score_asset(_asset(), 1_000, needs_medic=False)
        far = score_asset(_asset(), 30_000, needs_medic=False)
        assert near['suitability'] > far['suitability']

    def test_a_fuelled_asset_beats_a_nearer_one_running_dry(self, station):
        """The failure this exists for: a vehicle on a quarter tank ranked
        above one that was fuelled and ten metres behind it."""
        thirsty = score_asset(_asset(fuel_pct=15), 1_000, needs_medic=False)
        fuelled = score_asset(_asset(fuel_pct=100), 1_400, needs_medic=False)
        assert fuelled['suitability'] > thirsty['suitability']

    def test_a_comfortably_fuelled_asset_is_not_penalised_for_being_under_full(self):
        """There is nothing to choose between 82% and 100% for a two-km
        callout. Scoring them apart ranked a full sled 1.3 km away above the
        snowcat parked outside the door."""
        near = score_asset(_asset(fuel_pct=82), 469, needs_medic=False)
        further = score_asset(_asset(fuel_pct=100), 1_794, needs_medic=False)
        assert near['suitability'] > further['suitability']

    def test_fuel_still_decides_it_once_the_tank_is_genuinely_low(self):
        """The distinction that was worth making in the first place."""
        low = score_asset(_asset(fuel_pct=int(COMFORTABLE_FUEL * 100) - 30),
                          469, needs_medic=False)
        full = score_asset(_asset(fuel_pct=100), 1_794, needs_medic=False)
        assert full['suitability'] > low['suitability']

    def test_a_medic_aboard_decides_a_medical_callout(self, station):
        plain = score_asset(_asset(), 2_000, needs_medic=True)
        with_medic = score_asset(_asset(medic_aboard=1), 4_000, needs_medic=True)
        assert with_medic['suitability'] > plain['suitability']

    def test_a_medic_is_not_the_deciding_factor_on_a_fire(self, station):
        """On a fuel fire it is beside the point, and weighting it anyway
        would rank a medical cache above the vehicle that can get there."""
        plain = score_asset(_asset(), 2_000, needs_medic=False)
        with_medic = score_asset(_asset(medic_aboard=1), 4_000, needs_medic=False)
        assert plain['suitability'] > with_medic['suitability']

    def test_scores_stay_comparable_across_incident_types(self, station):
        """The medic weight is redistributed rather than dropped, so a fire
        response is not capped below a medical one for no reason."""
        best_medical = score_asset(_asset(medic_aboard=1), 0, needs_medic=True)
        best_fire = score_asset(_asset(), 0, needs_medic=False)
        assert best_medical['suitability'] == best_fire['suitability'] == 1.0

    def test_the_weights_are_declared_rather_than_buried(self):
        assert abs(sum(ASSET_WEIGHTS.values()) - 1.0) < 1e-9


class TestReach:
    def test_range_is_judged_on_the_round_trip(self, station):
        """A range figure is one way. The asset has to come back, which is
        the half that gets people stranded."""
        # 100 km out, 90 km of range left: it can reach the scene and not return.
        verdict = score_asset(_asset(range_km=90, fuel_pct=100), 100_000, needs_medic=False)
        assert verdict['out_of_range'] is True

    def test_range_is_scaled_by_what_is_actually_in_the_tank(self, station):
        full = score_asset(_asset(range_km=200, fuel_pct=100), 40_000, needs_medic=False)
        low = score_asset(_asset(range_km=200, fuel_pct=20), 40_000, needs_medic=False)
        assert full['out_of_range'] is False and low['out_of_range'] is True

    def test_static_kit_is_ranked_but_flagged(self, station):
        """A medical cache at the station does not travel. It is still worth
        listing — somebody may go and fetch it — but not as a responder."""
        cache = score_asset(_asset(type='medical', range_km=0, speed_kmh=0,
                                   medic_aboard=1), 8_000, needs_medic=True)
        assert 'static kit' in ' '.join(cache['notes'])

    def test_an_asset_beyond_its_range_says_so_in_words(self, station):
        verdict = score_asset(_asset(range_km=20, fuel_pct=50), 40_000, needs_medic=False)
        assert any('round-trip range' in note for note in verdict['notes'])

    def test_low_fuel_is_called_out_even_when_the_trip_is_short(self, station):
        verdict = score_asset(_asset(fuel_pct=12), 500, needs_medic=False)
        assert any('low fuel' in note for note in verdict['notes'])


class TestItShowsItsWorking:
    def test_every_component_of_the_score_is_returned(self, station):
        """A commander overruling a ranking needs to see what it weighed. A
        number with no workings is one nobody should act on mid-emergency."""
        verdict = score_asset(_asset(), 5_000, needs_medic=True)
        assert set(verdict['factors']) == {'proximity', 'fuel', 'reach', 'medic'}

    def test_it_estimates_an_arrival_time_where_it_can(self, station):
        verdict = score_asset(_asset(speed_kmh=20), 10_000, needs_medic=False)
        assert verdict['eta_minutes'] == 30

    def test_kit_that_cannot_move_has_no_arrival_time(self, station):
        assert score_asset(_asset(speed_kmh=0), 10_000,
                           needs_medic=False)['eta_minutes'] is None

    def test_distance_past_the_horizon_stops_changing_the_ranking(self, station):
        """Beyond a point the difference between 60 km and 70 km stops
        mattering, and letting it dominate buries the other factors."""
        a = score_asset(_asset(), FAR_M + 10_000, needs_medic=False)
        b = score_asset(_asset(), FAR_M + 200_000, needs_medic=False)
        assert a['factors']['proximity'] == b['factors']['proximity'] == 0.0


class TestThroughTheApi:
    def test_the_search_returns_a_ranked_list(self, station):
        assets = station.json(
            'get', f'/incidents/nearby-assets/search?lat={MAITRI[0]}&lng={MAITRI[1]}')
        scores = [a['suitability'] for a in assets]
        assert scores == sorted(scores, reverse=True)

    def test_every_row_still_reports_its_distance(self, station):
        assets = station.json(
            'get', f'/incidents/nearby-assets/search?lat={MAITRI[0]}&lng={MAITRI[1]}')
        assert all('distance_m' in a for a in assets)

    def test_the_ranking_follows_the_incident_type(self, station):
        """The same position, two kinds of emergency, two right answers."""
        medical = station.json(
            'get', f'/incidents/nearby-assets/search?lat={MAITRI[0]}&lng={MAITRI[1]}'
                   '&incident_type=medical')
        fire = station.json(
            'get', f'/incidents/nearby-assets/search?lat={MAITRI[0]}&lng={MAITRI[1]}'
                   '&incident_type=fire')
        assert [a['id'] for a in medical] != [a['id'] for a in fire]

    def test_an_incident_ranks_its_assets_for_its_own_type(self, station):
        incident = station.declare_incident(type='medical')
        detail = station.json('get', f'/incidents/{incident["id"]}')
        assert detail['nearby_assets'][0]['suitability'] is not None
        assert 'factors' in detail['nearby_assets'][0]

    def test_a_medical_callout_puts_a_medic_carrying_asset_first(self, station):
        assets = station.json(
            'get', f'/incidents/nearby-assets/search?lat={MAITRI[0]}&lng={MAITRI[1]}'
                   '&incident_type=medical')
        assert assets[0]['medic_aboard'] == 1

    def test_unavailable_assets_are_never_offered(self, station):
        asset = next(a for a in station.json('get', '/incidents/assets?station=Maitri')
                     if a['name'] == 'Snowcat Alpha')
        station.patch(f'/incidents/assets/{asset["id"]}',
                      json={'status': 'unavailable'})
        offered = station.json(
            'get', f'/incidents/nearby-assets/search?lat={MAITRI[0]}&lng={MAITRI[1]}')
        assert asset['id'] not in {a['id'] for a in offered}
