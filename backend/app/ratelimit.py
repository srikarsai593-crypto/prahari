"""In-process sliding-window rate limiting.

Deliberately not slowapi or redis. This is a single-uvicorn station backend, so
a shared store would be infrastructure for a problem that does not exist here,
and an extra dependency is an extra thing that has to install cleanly on a
machine at 70 degrees south.

Two windows, because the two abuses are different shapes:

* **Sign-in** is the one that matters. The commander key is a single shared
  secret, so without a limit it is brute-forceable at network speed. This
  window is tight and counts failures.
* **Writes** are limited mostly against a runaway client or a loop in a script
  hammering the station; the ceiling is well above anything an operator can
  produce by hand.

Reads are not limited. An operator refreshing a dashboard during an incident is
the behaviour this console exists to serve, and throttling it would make the
tool worse exactly when it matters most.
"""

import os
import threading
import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request, status


def _int_env(name: str, default: int) -> int:
    try:
        value = int(os.getenv(name, default))
        return value if value > 0 else default
    except (TypeError, ValueError):
        return default


LOGIN_MAX_ATTEMPTS = _int_env('PRAHARI_LOGIN_RATE_LIMIT', 5)
LOGIN_WINDOW_S = _int_env('PRAHARI_LOGIN_RATE_WINDOW_S', 60)
WRITE_MAX_REQUESTS = _int_env('PRAHARI_WRITE_RATE_LIMIT', 120)
WRITE_WINDOW_S = _int_env('PRAHARI_WRITE_RATE_WINDOW_S', 60)

# Stop the bucket map growing without bound on a long-lived process.
_IDLE_EVICTION_S = 900


class SlidingWindow:
    """Per-client hit times, trimmed to the window on every check."""

    def __init__(self, limit: int, window_s: int):
        self.limit = limit
        self.window_s = window_s
        self._hits: dict[str, deque] = defaultdict(deque)
        self._lock = threading.Lock()
        self._last_swept = 0.0

    def _sweep(self, now: float) -> None:
        if now - self._last_swept < _IDLE_EVICTION_S:
            return
        self._last_swept = now
        for key in [k for k, hits in self._hits.items()
                    if not hits or now - hits[-1] > _IDLE_EVICTION_S]:
            self._hits.pop(key, None)

    def check(self, key: str) -> tuple[bool, int]:
        """(allowed, seconds until a slot frees). Does not record a hit."""
        now = time.monotonic()
        with self._lock:
            self._sweep(now)
            hits = self._hits[key]
            while hits and now - hits[0] > self.window_s:
                hits.popleft()
            if len(hits) < self.limit:
                return True, 0
            return False, max(1, int(self.window_s - (now - hits[0])) + 1)

    def record(self, key: str) -> None:
        with self._lock:
            self._hits[key].append(time.monotonic())

    def forget(self, key: str) -> None:
        """Clear a client's history — used when a sign-in succeeds, so an
        operator who mistyped twice is not then locked out by their own
        successful attempt."""
        with self._lock:
            self._hits.pop(key, None)

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


login_attempts = SlidingWindow(LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_S)
write_requests = SlidingWindow(WRITE_MAX_REQUESTS, WRITE_WINDOW_S)


def client_key(request: Request) -> str:
    """Identify the caller for rate-limiting purposes.

    Behind Render/Vercel the socket address is the proxy, so the forwarded
    header is used when present — and only its first entry, because the rest is
    caller-supplied and trivially spoofed.
    """
    forwarded = request.headers.get('x-forwarded-for', '')
    if forwarded:
        return forwarded.split(',')[0].strip()
    return request.client.host if request.client else 'unknown'


def _refuse(retry_after: int, message: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail=message,
        headers={'Retry-After': str(retry_after)},
    )


def guard_login(request: Request) -> str:
    """Raise if this client has failed sign-in too often. Returns its key."""
    key = client_key(request)
    allowed, retry_after = login_attempts.check(key)
    if not allowed:
        raise _refuse(retry_after,
                      f'Too many sign-in attempts. Wait {retry_after}s and try again.')
    return key


async def guard_write(request: Request) -> None:
    """Dependency on every write route."""
    key = client_key(request)
    allowed, retry_after = write_requests.check(key)
    if not allowed:
        raise _refuse(retry_after,
                      'This console is sending writes faster than the station will accept '
                      f'them. Retry in {retry_after}s.')
    write_requests.record(key)
