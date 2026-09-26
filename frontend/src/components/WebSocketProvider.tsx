'use client';
import { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';

/**
 * Every broadcast the backend fans out on `/ws`.
 *
 * `data` stays loose on purpose — each type carries a different shape and the
 * consumers narrow it themselves — but `type` is a closed set, so a listener
 * that checks for a message the backend never sends is a compile error rather
 * than a handler that silently never runs.
 */
export type StationMessageType =
  | 'event'
  | 'alert'
  | 'gps_update'
  | 'inventory_update'
  | 'shipment_update'
  | 'blizzard_update'
  | 'personnel_update'
  | 'accountability_update'
  | 'incident_update'
  | 'expedition_update'
  | 'station_reset';

export interface StationMessage {
  type: StationMessageType;
  data?: Record<string, never> | Record<string, unknown> | undefined;
}

/** What consumers actually read off a message, without asserting a shape. */
export interface StationBroadcast {
  type: StationMessageType | string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
}

type WebSocketContextType = {
  socket: WebSocket | null;
  lastMessage: StationBroadcast | null;
  connected: boolean;
};

const WebSocketContext = createContext<WebSocketContextType>({ socket: null, lastMessage: null, connected: false });

export const useWebSocket = () => useContext(WebSocketContext);

/**
 * Same-origin `/ws`, proxied to the backend by next.config.ts.
 *
 * Pointing straight at `hostname:8000` worked only when the browser sat on the
 * same machine as the backend on that exact port — it broke the moment the
 * console was served to a field tablet over the station LAN or behind TLS,
 * because the page's own origin was not the backend's. Going through the proxy
 * means the socket follows the page: right host, right port, wss:// under TLS.
 */
const getWsUrl = () => {
  if (process.env.NEXT_PUBLIC_WS_URL) return process.env.NEXT_PUBLIC_WS_URL;
  if (typeof window !== 'undefined') {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/ws`;
  }
  return 'ws://localhost:3000/ws';
};
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

export const WebSocketProvider = ({ children }: { children: React.ReactNode }) => {
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const [lastMessage, setLastMessage] = useState<StationBroadcast | null>(null);
  const [connected, setConnected] = useState(false);
  const retryDelay = useRef(RECONNECT_BASE_MS);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmounted = useRef(false);

  const connect = useCallback(() => {
    if (unmounted.current) return;

    const ws = new WebSocket(getWsUrl());

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
