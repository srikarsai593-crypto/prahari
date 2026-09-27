"""
Simple API-key authentication for Prahari write endpoints.

Set PRAHARI_API_KEY for all non-demo deployments.
For explicit local/demo mode, set PRAHARI_ALLOW_DEMO_KEY=true to allow
the public demo key "prahari-demo-2024".
"""

import os
from fastapi import Depends, HTTPException, status, Security
from fastapi.security import APIKeyHeader

_API_KEY_HEADER = APIKeyHeader(name='X-Commander-Key', auto_error=False)
DEMO_KEY = 'prahari-demo-2024'

# PRAHARI_API_KEY is the documented name. PRAHARI_COMMANDER_KEY is accepted
# because the Render blueprint set that one, and a key that is configured but
# read under a different name is worse than no key at all: the deployment looks
# secured while every write is in fact still accepting the public demo key.
_KEY_ENV_NAMES = ('PRAHARI_API_KEY', 'PRAHARI_COMMANDER_KEY')


def get_expected_key() -> str | None:
    for name in _KEY_ENV_NAMES:
        configured = (os.getenv(name) or '').strip()
        if configured:
            return configured
    allow_demo = os.getenv('PRAHARI_ALLOW_DEMO_KEY', 'true').lower() in {'1', 'true', 'yes'}
    return DEMO_KEY if allow_demo else None


async def require_key(key: str | None = Security(_API_KEY_HEADER)) -> str:
    """FastAPI dependency — raises 401 if the commander key is wrong or missing."""
    expected_key = get_expected_key()

    if expected_key is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail='This station backend has no commander key configured, so it is '
                   'refusing every write. Set PRAHARI_API_KEY in backend/.env (or '
                   'PRAHARI_ALLOW_DEMO_KEY=true for a local demo) and restart it.',
        )

    if key != expected_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail='Station write rejected: the commander key this console sent does not '
                   'match the one the backend expects. The console sends it automatically, so '
                   'this normally means the station key was rotated - set '
                   'NEXT_PUBLIC_COMMANDER_KEY in the frontend to the backend PRAHARI_API_KEY '
                   'and reload. Reads are unaffected.',
            headers={'WWW-Authenticate': 'ApiKey'},
        )
    return key
