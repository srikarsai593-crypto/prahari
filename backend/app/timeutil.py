"""Single source of truth for timestamps.

Every timestamp Prahari stores or broadcasts is an ISO-8601 UTC string with an
explicit 'Z'. Naive strings (SQLite's CURRENT_TIMESTAMP) are parsed as *local*
time by browsers, which silently shifts the whole event timeline by the host's
UTC offset.
"""

from datetime import datetime, timezone


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def utc_now_iso() -> str:
    """e.g. '2026-09-26T08:54:23.417Z' — matches the SQLite column defaults."""
    return utc_now().strftime('%Y-%m-%dT%H:%M:%S.') + f'{utc_now().microsecond // 1000:03d}Z'


def to_utc_iso(value) -> str | None:
    """Normalise any stored timestamp to the canonical Z-suffixed UTC form."""
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    else:
        text = str(value).strip()
        if not text:
            return None
        try:
            dt = datetime.fromisoformat(text.replace('Z', '+00:00'))
        except ValueError:
            return text  # leave unparseable values untouched rather than guessing
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)  # legacy naive rows were UTC
    dt = dt.astimezone(timezone.utc)
    return dt.strftime('%Y-%m-%dT%H:%M:%S.') + f'{dt.microsecond // 1000:03d}Z'
