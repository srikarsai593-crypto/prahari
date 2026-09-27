"""Timestamp normalisation.

Every timestamp the console shows and every event ordering depends on these
three functions agreeing on one format.
"""

from datetime import datetime, timedelta, timezone

import pytest

from app.timeutil import to_utc_iso, utc_now, utc_now_iso

ISO_LENGTH = len('2026-01-02T03:04:05.678Z')


class TestUtcNowIso:
    def test_shape_is_exactly_the_canonical_form(self):
        stamp = utc_now_iso()
        assert len(stamp) == ISO_LENGTH
        assert stamp[10] == 'T' and stamp.endswith('Z')
        datetime.fromisoformat(stamp.replace('Z', '+00:00'))

    def test_never_goes_backwards(self):
        stamps = [utc_now_iso() for _ in range(20_000)]
        assert stamps == sorted(stamps)

    def test_the_clock_is_read_exactly_once(self, monkeypatch):
        """Regression: the clock used to be read twice, once for the seconds
        and once for the milliseconds.

        Racing this for real is hopeless — it needs the two reads to straddle a
        second boundary — so the boundary is staged instead. Under the old
        code the result took 03:04:05 from the first reading and .001 from the
        second, yielding 03:04:05.001: a timestamp a whole second before the
        event, which can order two events backwards.
        """
        import app.timeutil as timeutil

        first = datetime(2026, 1, 2, 3, 4, 5, 999_000, tzinfo=timezone.utc)
        second = datetime(2026, 1, 2, 3, 4, 6, 1_000, tzinfo=timezone.utc)
        readings = iter([first, second])
        monkeypatch.setattr(timeutil, 'utc_now', lambda: next(readings))

        assert timeutil.utc_now_iso() == '2026-01-02T03:04:05.999Z'

    def test_milliseconds_belong_to_their_own_second(self):
        for _ in range(20_000):
            stamp = utc_now_iso()
            parsed = datetime.fromisoformat(stamp.replace('Z', '+00:00'))
            assert parsed.strftime('%Y-%m-%dT%H:%M:%S.') + f'{parsed.microsecond // 1000:03d}Z' \
                == stamp

    def test_is_close_to_the_real_clock(self):
        drift = abs(datetime.fromisoformat(utc_now_iso().replace('Z', '+00:00')) - utc_now())
        assert drift < timedelta(seconds=1)


class TestToUtcIso:
    def test_round_trips_its_own_output(self):
        stamp = utc_now_iso()
        assert to_utc_iso(stamp) == stamp

    def test_is_idempotent(self):
        once = to_utc_iso('2026-01-02T03:04:05Z')
        assert to_utc_iso(once) == once

    def test_a_naive_legacy_value_is_read_as_utc(self):
        """SQLite's CURRENT_TIMESTAMP has no zone. Browsers parse a naive
        string as *local* time, which silently shifts the whole timeline by the
        host's offset."""
        assert to_utc_iso('2026-01-02 03:04:05') == '2026-01-02T03:04:05.000Z'

    def test_an_offset_is_converted_rather_than_truncated(self):
        assert to_utc_iso('2026-01-02T08:34:05+05:30') == '2026-01-02T03:04:05.000Z'

    def test_accepts_a_datetime_object(self):
        moment = datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc)
        assert to_utc_iso(moment) == '2026-01-02T03:04:05.000Z'

    def test_a_naive_datetime_is_also_read_as_utc(self):
        assert to_utc_iso(datetime(2026, 1, 2, 3, 4, 5)) == '2026-01-02T03:04:05.000Z'

    @pytest.mark.parametrize('value', [None, '', '   '])
    def test_missing_values_stay_missing(self, value):
        assert to_utc_iso(value) is None

    def test_an_unparseable_value_is_returned_untouched(self):
        """Better to show an operator something odd than to guess a time and
        present the guess as a reading."""
        assert to_utc_iso('sometime tuesday') == 'sometime tuesday'
