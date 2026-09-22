"""
Simple API-key authentication for Prahari write endpoints.

The key is configured via the PRAHARI_API_KEY environment variable.
It defaults to "prahari-demo-2024" so the system works out of the box
without any configuration — judges and evaluators just use the default.

Usage in a route:
    from ..auth import require_key
    @router.post('/some-endpoint', dependencies=[Depends(require_key)])
    async def create_something(...): ...
"""

import os
from fastapi import Depends, HTTPException, status, Security
from fastapi.security import APIKeyHeader

_API_KEY_HEADER = APIKeyHeader(name='X-Commander-Key', auto_error=False)

# Fallback to demo key so it works without any .env setup
_EXPECTED_KEY: str = os.getenv('PRAHARI_API_KEY', 'prahari-demo-2024')


async def require_key(key: str | None = Security(_API_KEY_HEADER)) -> str:
    """FastAPI dependency — raises 401 if the commander key is wrong or missing."""
    if key != _EXPECTED_KEY:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail='Invalid or missing X-Commander-Key header. '
                   'Use the default demo key: prahari-demo-2024',
            headers={'WWW-Authenticate': 'ApiKey'},
        )
    return key
