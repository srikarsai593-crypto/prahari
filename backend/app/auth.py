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
_DEMO_KEY = 'prahari-demo-2024'
_ALLOW_DEMO_KEY = os.getenv('PRAHARI_ALLOW_DEMO_KEY', '').lower() in {'1', 'true', 'yes'}
_EXPECTED_KEY: str | None = os.getenv('PRAHARI_API_KEY')


async def require_key(key: str | None = Security(_API_KEY_HEADER)) -> str:
    """FastAPI dependency — raises 401 if the commander key is wrong or missing."""
    expected_key = _EXPECTED_KEY or (_DEMO_KEY if _ALLOW_DEMO_KEY else None)

    if expected_key is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail='Commander API key is not configured on the server.',
        )

    if key != expected_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail='Invalid or missing X-Commander-Key header.',
            headers={'WWW-Authenticate': 'ApiKey'},
        )
    return key
