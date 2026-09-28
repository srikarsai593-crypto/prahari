"""The stages an incident response passes through.

`open` and `resolved` could not tell an incident nobody had seen apart from
one with a snowcat already on the ice, which during a callout is the only
difference that matters.
"""

from app import incident_lifecycle as lifecycle


class TestStages:
    def test_an_incident_starts_declared(self, station):
        assert station.declare_incident()['status'] == lifecycle.DECLARED

    def test_each_stage_says_what_it_means(self, station):
        """"Contained" is not "closed", and no console should have to keep
        its own copy of that distinction."""
        incident = station.declare_incident()
        detail = station.json('get', f'/incidents/{incident["id"]}')
        assert detail['stage_description'] == lifecycle.DESCRIPTIONS[lifecycle.DECLARED]

    def test_it_offers_the_stages_that_may_follow(self, station):
        incident = station.declare_incident()
        detail = station.json('get', f'/incidents/{incident["id"]}')
        assert lifecycle.ACKNOWLEDGED in detail['next_stages']
        assert lifecycle.DECLARED not in detail['next_stages']

    def test_a_response_can_be_walked_through_its_stages(self, station):
        incident = station.declare_incident()
        for stage in (lifecycle.ACKNOWLEDGED, lifecycle.RESPONDING,
                      lifecycle.CONTAINED, lifecycle.RESOLVED):
            result = station.json('patch', f'/incidents/{incident["id"]}',
                                  json={'status': stage})
            assert result['status'] == stage

    def test_a_stage_may_be_skipped_forward(self, station):
        """An incident contained the moment it is declared should not need
        three clicks to say so, and a callout is the worst place to make
        someone satisfy a state machine."""
        incident = station.declare_incident()
        result = station.json('patch', f'/incidents/{incident["id"]}',
                              json={'status': lifecycle.CONTAINED})
        assert result['status'] == lifecycle.CONTAINED

    def test_it_cannot_go_backwards(self, station):
        """Rolling contained back to declared erases a timestamp the debrief
        needs and describes nothing that happens in a real response."""
        incident = station.declare_incident()
        station.json('patch', f'/incidents/{incident["id"]}',
                     json={'status': lifecycle.CONTAINED})
        refused = station.patch(f'/incidents/{incident["id"]}',
                                json={'status': lifecycle.DECLARED})
        assert refused.status_code == 409
        assert 'cannot go from' in refused.json()['detail']

    def test_a_resolved_incident_reopens_into_responding(self, station):
        """Somebody is dealing with it again, which is what responding means."""
        incident = station.declare_incident()
        station.json('patch', f'/incidents/{incident["id"]}', json={'status': 'resolved'})
        result = station.json('patch', f'/incidents/{incident["id"]}',
                              json={'status': lifecycle.RESPONDING})
        assert result['status'] == lifecycle.RESPONDING

    def test_a_resolved_incident_cannot_jump_to_another_stage(self, station):
        incident = station.declare_incident()
        station.json('patch', f'/incidents/{incident["id"]}', json={'status': 'resolved'})
        refused = station.patch(f'/incidents/{incident["id"]}',
                                json={'status': lifecycle.CONTAINED})
        assert refused.status_code == 409
        assert 'only be reopened' in refused.json()['detail']


class TestTheSafetyPropertyIsUnchanged:
    def test_it_still_cannot_be_resolved_over_a_missing_person(self, station):
        """The one rule the module exists to enforce, now that there are five
        stages to move between rather than two."""
        researcher = station.personnel()[0]
        station.patch(f'/personnel/{researcher["id"]}/status', json={'status': 'in_transit'})
        incident = station.declare_incident(affected_radius_m=50_000)
        assert (incident['unaccounted_count'] or 0) > 0, 'setup did not strand anyone'

        refused = station.patch(f'/incidents/{incident["id"]}', json={'status': 'resolved'})
        assert refused.status_code == 409
        assert 'unaccounted' in refused.json()['detail']

    def test_reaching_contained_does_not_bypass_the_check(self, station):
        """Skipping forward must not become a way around the head-count."""
        researcher = station.personnel()[0]
        station.patch(f'/personnel/{researcher["id"]}/status', json={'status': 'in_transit'})
        incident = station.declare_incident(affected_radius_m=50_000)
        assert (incident['unaccounted_count'] or 0) > 0, 'setup did not strand anyone'
        station.json('patch', f'/incidents/{incident["id"]}',
                     json={'status': lifecycle.CONTAINED})
        assert station.patch(f'/incidents/{incident["id"]}',
                             json={'status': 'resolved'}).status_code == 409


class TestTimestamps:
    def test_each_stage_records_when_it_was_entered(self, station):
        """The two figures a debrief is built on: how long to acknowledge,
        and how long to get moving."""
        incident = station.declare_incident()
        station.json('patch', f'/incidents/{incident["id"]}',
                     json={'status': lifecycle.ACKNOWLEDGED})
        station.json('patch', f'/incidents/{incident["id"]}',
                     json={'status': lifecycle.RESPONDING})
        detail = station.json('get', f'/incidents/{incident["id"]}')
        assert detail['acknowledged_at'] and detail['acknowledged_at'].endswith('Z')
        assert detail['responding_at'] and detail['responding_at'].endswith('Z')
        assert detail['contained_at'] is None

    def test_a_skipped_stage_leaves_its_timestamp_empty(self, station):
        """Stamping a stage nobody passed through would invent a response."""
        incident = station.declare_incident()
        station.json('patch', f'/incidents/{incident["id"]}',
                     json={'status': lifecycle.CONTAINED})
        detail = station.json('get', f'/incidents/{incident["id"]}')
        assert detail['contained_at'] is not None
        assert detail['acknowledged_at'] is None


class TestDispatchMovesTheStage:
    def test_committing_an_asset_puts_the_incident_into_responding(self, station):
        """Otherwise the lifecycle is a dropdown nobody remembers to update
        while a snowcat is already on the ice."""
        incident = station.declare_incident()
        asset = next(a for a in station.json('get', '/incidents/assets?station=Maitri')
                     if a['name'] == 'Snowcat Alpha')
        station.patch(f'/incidents/assets/{asset["id"]}/dispatch',
                      json={'incident_id': incident['id']})

        detail = station.json('get', f'/incidents/{incident["id"]}')
        assert detail['status'] == lifecycle.RESPONDING
        assert detail['responding_at'] is not None

    def test_it_does_not_drag_a_contained_incident_backwards(self, station):
        incident = station.declare_incident()
        station.json('patch', f'/incidents/{incident["id"]}',
                     json={'status': lifecycle.CONTAINED})
        asset = next(a for a in station.json('get', '/incidents/assets?station=Maitri')
                     if a['name'] == 'Snowcat Alpha')
        station.patch(f'/incidents/assets/{asset["id"]}/dispatch',
                      json={'incident_id': incident['id']})
        assert station.json('get', f'/incidents/{incident["id"]}')['status'] \
            == lifecycle.CONTAINED

    def test_an_asset_can_be_tasked_at_any_live_stage(self, station):
        """A contained incident still needs its assets; refusing would make
        advancing the stage a way to lock yourself out of the response."""
        incident = station.declare_incident()
        station.json('patch', f'/incidents/{incident["id"]}',
                     json={'status': lifecycle.CONTAINED})
        asset = next(a for a in station.json('get', '/incidents/assets?station=Maitri')
                     if a['name'] == 'Snowcat Alpha')
        assert station.patch(f'/incidents/assets/{asset["id"]}/dispatch',
                             json={'incident_id': incident['id']}).status_code == 200


class TestTheLegacyWordStillWorks:
    def test_open_is_accepted_and_means_declared(self):
        assert lifecycle.normalise('open') == lifecycle.DECLARED

    def test_filtering_on_open_returns_every_live_stage(self, station):
        """Older consoles and scripts know one word. Breaking them to rename
        a constant would be a poor trade."""
        first = station.declare_incident(type='fire')
        second = station.declare_incident(type='medical')
        station.json('patch', f'/incidents/{second["id"]}',
                     json={'status': lifecycle.CONTAINED})
        station.json('patch', f'/incidents/{first["id"]}',
                     json={'status': lifecycle.ACKNOWLEDGED})

        live = station.json('get', '/incidents?status=open')
        assert {i['id'] for i in live} == {first['id'], second['id']}

    def test_a_resolved_incident_is_not_in_the_open_list(self, station):
        incident = station.declare_incident()
        station.json('patch', f'/incidents/{incident["id"]}', json={'status': 'resolved'})
        assert incident['id'] not in {i['id'] for i in
                                      station.json('get', '/incidents?status=open')}

    def test_a_row_still_holding_the_legacy_word_counts_as_live(self, station):
        """`normalise` runs on the way out, so the database can still hold
        'open' — a backup predating the migration, or an older build against
        the same file. A query that listed only the five stage names would
        count such a row as closed and drop a live incident off the reset
        preview and the roster's hazard check."""
        incident = station.declare_incident()
        station.db.execute("UPDATE incidents SET status = 'open' WHERE id = ?",
                           (incident['id'],))
        station.db.commit()

        assert station.json('get', '/admin/counts')['open_incidents'] == 1
        live = station.json('get', '/incidents?status=open')
        assert incident['id'] in {i['id'] for i in live}
        # And it is reported as a stage, never as the legacy word.
        assert next(i for i in live if i['id'] == incident['id'])['status'] == 'declared'

    def test_the_reset_preview_counts_every_live_stage(self, station):
        incident = station.declare_incident()
        station.json('patch', f'/incidents/{incident["id"]}',
                     json={'status': lifecycle.CONTAINED})
        assert station.json('get', '/admin/counts')['open_incidents'] == 1
