"""WebSocket fan-out.

Broadcasts are serialised through a lock and sent concurrently. The previous
implementation iterated a copy of the list with a bare `except:` per send, which
swallowed CancelledError, mutated the list from inside the loop, and blocked the
whole fan-out behind the slowest client.
"""

import asyncio
import logging

from fastapi import WebSocket

logger = logging.getLogger(__name__)

# A client that cannot accept a frame within this window is treated as dead.
# Without it, one stalled tablet stalls every other operator's live feed.
SEND_TIMEOUT_S = 5.0


class ConnectionManager:
    def __init__(self) -> None:
        self.active_connections: list[WebSocket] = []
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self.active_connections.append(websocket)
        logger.info('WS client connected (%d active)', len(self.active_connections))

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            if websocket in self.active_connections:
                self.active_connections.remove(websocket)
        logger.info('WS client disconnected (%d active)', len(self.active_connections))

    async def _send(self, connection: WebSocket, message: dict) -> WebSocket | None:
        """Return the connection if it failed, so the caller can evict it."""
        try:
            await asyncio.wait_for(connection.send_json(message), timeout=SEND_TIMEOUT_S)
            return None
        except asyncio.CancelledError:
            raise                       # never swallow cancellation
        except Exception as exc:
            logger.debug('WS send failed, evicting client: %s', exc)
            return connection

    async def broadcast(self, message: dict) -> None:
        async with self._lock:
            targets = list(self.active_connections)
        if not targets:
            return

        results = await asyncio.gather(*(self._send(c, message) for c in targets),
                                       return_exceptions=True)
        dead = {r for r in results if isinstance(r, WebSocket)}
        if dead:
            async with self._lock:
                self.active_connections = [c for c in self.active_connections if c not in dead]

    @property
    def connection_count(self) -> int:
        return len(self.active_connections)


manager = ConnectionManager()
