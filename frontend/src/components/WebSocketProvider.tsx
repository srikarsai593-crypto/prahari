'use client';
import { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';

type WebSocketContextType = {
  socket: WebSocket | null;
  lastMessage: any | null;
  connected: boolean;
};

const WebSocketContext = createContext<WebSocketContextType>({ socket: null, lastMessage: null, connected: false });

export const useWebSocket = () => useContext(WebSocketContext);

const WS_URL = 'ws://localhost:8000/ws';
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

export const WebSocketProvider = ({ children }: { children: React.ReactNode }) => {
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const [lastMessage, setLastMessage] = useState<any | null>(null);
  const [connected, setConnected] = useState(false);
  const retryDelay = useRef(RECONNECT_BASE_MS);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmounted = useRef(false);

  const connect = useCallback(() => {
    if (unmounted.current) return;

    const ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      if (unmounted.current) { ws.close(); return; }
      console.log('[WS] Connected');
      setConnected(true);
      retryDelay.current = RECONNECT_BASE_MS; // reset backoff on successful connect
      setSocket(ws);
    };

    ws.onmessage = (event) => {
      try {
        setLastMessage(JSON.parse(event.data));
      } catch (e) {
        console.error('[WS] Failed to parse message', e);
      }
    };

    ws.onclose = () => {
      if (unmounted.current) return;
      console.log(`[WS] Disconnected — retrying in ${retryDelay.current}ms`);
      setConnected(false);
      setSocket(null);
      // Exponential backoff reconnect
      retryTimer.current = setTimeout(() => {
        retryDelay.current = Math.min(retryDelay.current * 2, RECONNECT_MAX_MS);
        connect();
      }, retryDelay.current);
    };

    ws.onerror = () => {
      // onclose fires after onerror; reconnect handled there
      ws.close();
    };
  }, []);

  useEffect(() => {
    unmounted.current = false;
    connect();
    return () => {
      unmounted.current = true;
      if (retryTimer.current) clearTimeout(retryTimer.current);
      setSocket(prev => { prev?.close(); return null; });
    };
  }, [connect]);

  return (
    <WebSocketContext.Provider value={{ socket, lastMessage, connected }}>
      {children}
    </WebSocketContext.Provider>
  );
};
