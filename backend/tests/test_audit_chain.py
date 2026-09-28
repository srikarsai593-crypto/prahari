"""The tamper-evident audit chain.

The console's claim is that every action is on the record. A log that can be
edited in place makes that an assurance rather than a fact, so each row commits
to the one before it. These pin the properties that make the claim checkable —
and the honesty of what it does *not* promise.
"""

import json

from app import events as events_mod
from app.events import GENESIS_HASH, compute_entry_hash, verify_chain


class TestTheChainIsBuilt:
    def test_the_first_entry_links_to_genesis(self, station):
        station.declare_incident()
        first = station.db.execute(
            'SELECT * FROM events ORDER BY seq ASC LIMIT 1').fetchone()
        assert first['prev_hash'] == GENESIS_HASH

    def test_every_entry_carries_a_digest(self, station):
        station.declare_incident()
        station.ship()
        rows = station.db.execute('SELECT entry_hash FROM events').fetchall()
        assert rows and all(r['entry_hash'] for r in rows)

    def test_each_entry_links_to_the_one_before_it(self, station):
        station.declare_incident()
        station.ship()
        rows = station.db.execute(
            'SELECT prev_hash, entry_hash FROM events ORDER BY seq ASC').fetchall()
        for earlier, later in zip(rows, rows[1:]):
            assert later['prev_hash'] == earlier['entry_hash']

    def test_two_entries_with_the_same_content_still_differ(self, station):
        """Otherwise a duplicated action is indistinguishable from a replayed
        one, and the chain could be reordered without detection."""
        station.set_weather(10)
        station.set_weather(10)
        hashes = [r['entry_hash'] for r in
                  station.db.execute('SELECT entry_hash FROM events').fetchall()]
        assert len(hashes) == len(set(hashes))


class TestVerification:
    def test_an_untouched_log_verifies(self, station):
        station.declare_incident()
        station.ship()
        assert station.json('get', '/events/verify')['ok'] is True

    def test_it_reports_the_head_so_it_can_be_recorded_elsewhere(self, station):
        station.declare_incident()
        result = station.json('get', '/events/verify')
        assert result['head'] == station.db.execute(
            'SELECT entry_hash FROM events ORDER BY seq DESC LIMIT 1').fetchone()[0]

    def test_an_empty_log_verifies_rather_than_erroring(self, station):
        station.json('post', '/admin/reset', json={'confirm': 'RESET', 'scope': 'all'})
        station.db.execute('DELETE FROM events')
        station.db.commit()
        result = station.json('get', '/events/verify')
        assert result['ok'] is True and result['checked'] == 0

    def test_an_edited_entry_is_caught(self, station):
        """The case the chain exists for: a row rewritten in place to say
        something other than what happened."""
        station.declare_incident()
        station.ship()
        target = station.db.execute(
            'SELECT seq FROM events ORDER BY seq ASC LIMIT 1').fetchone()['seq']
        station.db.execute("UPDATE events SET action = 'Nothing happened' WHERE seq = ?",
                           (target,))
        station.db.commit()

        result = station.json('get', '/events/verify')
        assert result['ok'] is False
        assert result['broken_at_seq'] == target
        assert 'altered' in result['reason']

    def test_a_deleted_entry_is_caught(self, station):
        """Removing an inconvenient row leaves a gap the next link exposes."""
        station.declare_incident()
        station.ship()
        station.set_weather(5)
        middle = station.db.execute(
            'SELECT seq FROM events ORDER BY seq ASC LIMIT 1 OFFSET 1').fetchone()['seq']
        station.db.execute('DELETE FROM events WHERE seq = ?', (middle,))
        station.db.commit()

        result = station.json('get', '/events/verify')
        assert result['ok'] is False
        assert 'removed or inserted' in result['reason']

    def test_an_entry_inserted_after_the_fact_is_caught(self, station):
        station.declare_incident()
        station.db.execute(
            'INSERT INTO events (id, module, action, actor, station, created_at, '
            'prev_hash, entry_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            ('forged', 'system', 'Authorised by the commander', 'commander', 'Maitri',
             '2026-01-01T00:00:00.000Z', GENESIS_HASH, 'a' * 64))
        station.db.commit()
        assert station.json('get', '/events/verify')['ok'] is False

    def test_an_unhashed_entry_is_reported_rather_than_skipped(self, station):
        """Rows written before the chain existed keep NULL hashes. Passing
        over them would let anyone append unanchored rows at will."""
        station.declare_incident()
        station.db.execute('UPDATE events SET entry_hash = NULL WHERE seq = '
                           '(SELECT MIN(seq) FROM events)')
        station.db.commit()
        result = station.json('get', '/events/verify')
        assert result['ok'] is False and 'no hash' in result['reason']

    def test_it_says_what_it_does_not_promise(self, station):
        """A claim of tamper-proofing would be false: whoever can write the
        database file can recompute the chain."""
        assert 'tamper-proof' in station.json('get', '/events/verify')['guarantee'].lower()


class TestTheDigest:
    def test_it_covers_the_metadata_not_only_the_message(self, station):
        """Half the record lives in metadata — severity, quantities, the
        parsed command. A digest over the prose alone would leave it free."""
        station.declare_incident()
        row = station.db.execute(
            "SELECT * FROM events WHERE metadata IS NOT NULL ORDER BY seq DESC LIMIT 1"
        ).fetchone()
        assert row, 'expected at least one event carrying metadata'
        station.db.execute("UPDATE events SET metadata = ? WHERE seq = ?",
                           (json.dumps({'severity': 'low'}), row['seq']))
        station.db.commit()
        assert station.json('get', '/events/verify')['ok'] is False

    def test_key_order_does_not_change_the_digest(self, station):
        """Otherwise verification depends on how a dict happened to be built."""
        a = compute_entry_hash(GENESIS_HASH, event_id='e', module='m', action='a',
                               actor='x', related_id=None,
                               metadata={'one': 1, 'two': 2}, station='Maitri',
                               created_at='2026-01-01T00:00:00.000Z')
        b = compute_entry_hash(GENESIS_HASH, event_id='e', module='m', action='a',
                               actor='x', related_id=None,
                               metadata={'two': 2, 'one': 1}, station='Maitri',
                               created_at='2026-01-01T00:00:00.000Z')
        assert a == b


class TestItSurvivesHousekeeping:
    def test_a_full_reset_starts_a_fresh_chain_that_verifies(self, station):
        station.declare_incident()
        station.json('post', '/admin/reset', json={'confirm': 'RESET', 'scope': 'all'})
        result = station.json('get', '/events/verify')
        assert result['ok'] is True
        first = station.db.execute(
            'SELECT prev_hash FROM events ORDER BY seq ASC LIMIT 1').fetchone()
        assert first['prev_hash'] == GENESIS_HASH

    def test_the_demo_season_leaves_a_verifiable_chain(self, station):
        station.json('post', '/admin/demo-season', json={})
        assert station.json('get', '/events/verify')['ok'] is True
