'use client';
import { createContext, useContext, useEffect, useRef, useState } from 'react';

type WebSocketContextType = {
  socket: WebSocket | null;
  lastMessage: any | null;
  isConnected: boolean;
};

const WebSocketContext = createContext<WebSocketContextType>({
  socket: null,
  lastMessage: null,
  isConnected: false,
});

export const useWebSocket = () => useContext(WebSocketContext);

const WS_URL = typeof window !== 'undefined'
  ? `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`
  : 'ws://localhost:3000/ws';
const MAX_BACKOFF_MS = 30_000;

export const WebSocketProvider = ({ children }: { children: React.ReactNode }) => {
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const [lastMessage, setLastMessage] = useState<any | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  // Refs so callbacks always capture the latest values without re-creating effects
  const retryCount = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmounted = useRef(false);

  const connect = () => {
    if (unmounted.current) return;

    const ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      if (unmounted.current) { ws.close(); return; }
      console.log('[WS] Connected');
      retryCount.current = 0;
      setIsConnected(true);
      setSocket(ws);
    };

    ws.onmessage = (event) => {
      try {
        setLastMessage(JSON.parse(event.data));
      } catch (e) {
        console.error('[WS] Failed to parse message', e);
      }
    };

    ws.onerror = (err) => {
      console.warn('[WS] Error', err);
    };

    ws.onclose = () => {
      if (unmounted.current) return;
      console.warn('[WS] Disconnected — scheduling reconnect');
      setIsConnected(false);
      setSocket(null);

      // Exponential backoff: 1s, 2s, 4s … capped at MAX_BACKOFF_MS
      const delay = Math.min(1_000 * 2 ** retryCount.current, MAX_BACKOFF_MS);
      retryCount.current += 1;
      retryTimer.current = setTimeout(connect, delay);
    };
  };

  useEffect(() => {
    unmounted.current = false;
    connect();

    return () => {
      unmounted.current = true;
      if (retryTimer.current) clearTimeout(retryTimer.current);
      // Close the current socket (access via ref trick via state setter)
      setSocket((ws) => {
        ws?.close();
        return null;
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <WebSocketContext.Provider value={{ socket, lastMessage, isConnected }}>
      {children}
    </WebSocketContext.Provider>
  );
};
