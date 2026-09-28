"""Replay protection for the offline queue.

The case this exists for is not a client bug: it is a write the station
received and acted on whose response never made it back. The console sees a
network error, keeps the entry, and replays it — and without a key the station
issues the stock twice.
"""

import time

from app import idempotency


def _key(name: str) -> dict:
    return {'Idempotency-Key': name}


class TestReplayIsSafe:
    def test_the_same_key_twice_declares_one_incident(self, station):
        first = station.post('/incidents', headers=_key('k-1'), json={
            'type': 'fire', 'location_lat': -70.767, 'location_lng': 11.731})
        second = station.post('/incidents', headers=_key('k-1'), json={
            'type': 'fire', 'location_lat': -70.767, 'location_lng': 11.731})

        assert first.status_code == second.status_code == 200
        assert station.scalar('SELECT COUNT(*) FROM incidents') == 1

    def test_the_replay_returns_the_original_answer(self, station):
        """The console needs the id the station assigned, not a second one —
        it is still holding a queue entry that refers to this write."""
        first = station.post('/incidents', headers=_key('k-2'), json={
            'type': 'medical', 'location_lat': -70.767, 'location_lng': 11.731}).json()
        second = station.post('/incidents', headers=_key('k-2'), json={
            'type': 'medical', 'location_lat': -70.767, 'location_lng': 11.731}).json()
        assert first['id'] == second['id']

    def test_a_replay_says_that_it_is_one(self, station):
        station.post('/incidents', headers=_key('k-3'), json={
            'type': 'fire', 'location_lat': -70.767, 'location_lng': 11.731})
        again = station.post('/incidents', headers=_key('k-3'), json={
            'type': 'fire', 'location_lat': -70.767, 'location_lng': 11.731})
        assert again.headers.get('Idempotent-Replay') == 'true'

    def test_a_replayed_stock_command_does_not_issue_twice(self, station):
        """The consequence that matters: an operator's 200 litres leaving the
        store once, not once per reconnect."""
        body = {'transcript': 'Removed 200 litres of diesel fuel',
                'station': 'Maitri', 'dry_run': False}
        station.post('/inventory/command', headers=_key('k-stock'), json=body)
        station.post('/inventory/command', headers=_key('k-stock'), json=body)
        assert station.item('Diesel Fuel')['quantity'] == 6300

    def test_the_audit_log_records_the_action_once(self, station):
        body = {'transcript': 'Removed 50 litres of diesel fuel',
                'station': 'Maitri', 'dry_run': False}
        station.post('/inventory/command', headers=_key('k-log'), json=body)
        station.post('/inventory/command', headers=_key('k-log'), json=body)
        commands = [a for a in station.event_actions(module='inventory', limit=50)
                    if 'Stock command' in a]
        assert len(commands) == 1


class TestItStaysOutOfTheWay:
    def test_two_identical_writes_without_keys_both_land(self, station):
        """Issuing 10 litres twice is a real thing an operator does. Nothing
        is inferred from the body."""
        body = {'transcript': 'Removed 10 litres of diesel fuel',
                'station': 'Maitri', 'dry_run': False}
        station.json('post', '/inventory/command', json=body)
        station.json('post', '/inventory/command', json=body)
        assert station.item('Diesel Fuel')['quantity'] == 6480

    def test_different_keys_are_different_intents(self, station):
        for key in ('a', 'b'):
            station.post('/inventory/command', headers=_key(key), json={
                'transcript': 'Removed 10 litres of diesel fuel',
                'station': 'Maitri', 'dry_run': False})
        assert station.item('Diesel Fuel')['quantity'] == 6480

    def test_reads_are_untouched(self, station):
        for _ in range(2):
            assert station.get('/inventory?station=Maitri',
                               headers=_key('read')).status_code == 200

    def test_a_key_reused_on_a_different_endpoint_is_refused(self, station):
        """Answering with another endpoint's stored body would be worse than
        saying the client has a bug."""
        station.post('/incidents', headers=_key('shared'), json={
            'type': 'fire', 'location_lat': -70.767, 'location_lng': 11.731})
        clash = station.post('/shipments', headers=_key('shared'), json={
            'item_name': 'X', 'category': 'fuel', 'weight_kg': 10,
            'destination_station': 'Maitri'})
        assert clash.status_code == 409
        assert 'already used' in clash.json()['detail']

    def test_an_absurdly_long_key_is_refused(self, station):
        """Otherwise the table is writable storage for anyone who can POST."""
        response = station.post('/incidents', headers=_key('x' * 5000), json={
            'type': 'fire', 'location_lat': -70.767, 'location_lng': 11.731})
        assert response.status_code == 400


class TestSignInIsExcluded:
    def test_a_replayed_login_still_issues_a_session(self, station):
        """Only the status and body are recorded, not the headers. A replayed
        login would otherwise answer `authenticated: true` with no Set-Cookie
        and leave the console convinced it had signed in holding no session.
        """
        from app.auth import get_expected_key
        body = {'key': get_expected_key()}

        first = station.client.post('/auth/login', headers=_key('login'), json=body)
        station.client.cookies.clear()
        second = station.client.post('/auth/login', headers=_key('login'), json=body)

        assert first.status_code == second.status_code == 200
        assert 'set-cookie' in {h.lower() for h in second.headers}
        assert second.headers.get('Idempotent-Replay') is None


class TestFailuresAreNotRemembered:
    def test_a_rejected_write_can_be_retried_with_the_same_key(self, station):
        """Replaying a refusal back at the client would make a transient
        failure permanent for that queue entry."""
        bad = {'transcript': '', 'station': 'Maitri', 'dry_run': False}
        assert station.post('/inventory/command', headers=_key('retry'),
                            json=bad).status_code == 422

        good = {'transcript': 'Removed 20 litres of diesel fuel',
                'station': 'Maitri', 'dry_run': False}
        assert station.post('/inventory/command', headers=_key('retry'),
                            json=good).status_code == 200
        assert station.item('Diesel Fuel')['quantity'] == 6480


class TestHousekeeping:
    def test_keys_past_their_retention_are_pruned(self, station):
        station.post('/incidents', headers=_key('old'), json={
            'type': 'fire', 'location_lat': -70.767, 'location_lng': 11.731})
        station.db.execute('UPDATE idempotency_keys SET created_at = ?',
                           (time.time() - idempotency.RETENTION_SECONDS - 10,))
        station.db.commit()

        assert idempotency.prune(station.db) >= 1
        assert station.scalar('SELECT COUNT(*) FROM idempotency_keys') == 0

    def test_a_recent_key_survives_a_prune(self, station):
        station.post('/incidents', headers=_key('fresh'), json={
            'type': 'fire', 'location_lat': -70.767, 'location_lng': 11.731})
        idempotency.prune(station.db)
        assert station.scalar('SELECT COUNT(*) FROM idempotency_keys') == 1

    def test_the_retention_outlasts_a_long_outage(self):
        """A station offline for a week must still be protected when it
        finally reconnects and replays."""
        assert idempotency.RETENTION_SECONDS >= 7 * 24 * 3600


class TestSecurityHeadersSurviveAReplay:
    def test_a_replayed_response_still_carries_them(self, station):
        """The replay guard sits outside the header middleware; if that
        ordering were reversed a replay would answer bare."""
        station.post('/incidents', headers=_key('hdr'), json={
            'type': 'fire', 'location_lat': -70.767, 'location_lng': 11.731})
        again = station.post('/incidents', headers=_key('hdr'), json={
            'type': 'fire', 'location_lat': -70.767, 'location_lng': 11.731})
        assert again.headers.get('X-Content-Type-Options') == 'nosniff'
