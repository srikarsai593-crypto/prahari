'use client';
import { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import { isStationBroadcast, type StationBroadcast } from '@/lib/broadcasts';
import { offlineQueue } from '@/lib/offlineQueue';

export type { StationBroadcast, StationMessageType, PayloadOf } from '@/lib/broadcasts';
export { isType, isAnyOf } from '@/lib/broadcasts';

/**
 * The shapes live in `lib/broadcasts.ts` as a discriminated union, so a
 * handler narrows on `type` and gets a known payload instead of `any`.
 */
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
  /**
   * Set while the operator is running a SATCOM blackout drill. The socket's
   * own job is to get back up, so without a flag it would reconnect within a
   * second of being cut and the drill would prove nothing.
   */
  const blackout = useRef(false);
  /** The live socket, including one still opening — `socket` state is only
   *  set on open, so a blackout declared mid-handshake needs this to close. */
  const wsRef = useRef<WebSocket | null>(null);

  const connect = useCallback(() => {
    if (unmounted.current || blackout.current) return;

    const ws = new WebSocket(getWsUrl());
    wsRef.current = ws;

    ws.onopen = () => {
      if (unmounted.current || blackout.current) { ws.close(); return; }
      console.log('[WS] Connected');
      setConnected(true);
      retryDelay.current = RECONNECT_BASE_MS; // reset backoff on successful connect
      setSocket(ws);
    };

    ws.onmessage = (event) => {
      try {
        const message: unknown = JSON.parse(event.data);
        // A frame is data from the network, so the type is checked rather than
        // asserted: a backend one version ahead can send something this build
        // has never heard of, and the console should ignore it rather than
        // hand an unknown shape to every module's handler.
        if (isStationBroadcast(message)) setLastMessage(message);
        else console.warn('[WS] Ignoring unrecognised broadcast', message);
      } catch (e) {
        console.error('[WS] Failed to parse message', e);
      }
    };

    ws.onclose = () => {
      if (wsRef.current === ws) wsRef.current = null;
      if (unmounted.current) return;
      setConnected(false);
      setSocket(null);
      // A severed link the operator is holding open stays severed until they
      // close the drill; scheduling a retry here would fight them.
      if (blackout.current) { console.log('[WS] Down — SATCOM blackout held'); return; }
      console.log(`[WS] Disconnected — retrying in ${retryDelay.current}ms`);
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
      wsRef.current = null;
      setSocket(prev => { prev?.close(); return null; });
    };
  }, [connect]);

  // Follow the blackout switch: cut the link when it goes on, and reconnect
  // immediately — not on the backoff the outage had built up — when it lifts.
  useEffect(() => {
    const sync = () => {
      if (offlineQueue.isBlackout === blackout.current) return;
      blackout.current = offlineQueue.isBlackout;
      if (blackout.current) {
        if (retryTimer.current) clearTimeout(retryTimer.current);
        wsRef.current?.close();
        wsRef.current = null;
        setConnected(false);
        setSocket(null);
      } else {
        retryDelay.current = RECONNECT_BASE_MS;
        connect();
      }
    };
    sync();
    return offlineQueue.subscribe(sync);
  }, [connect]);

  return (
    <WebSocketContext.Provider value={{ socket, lastMessage, connected }}>
      {children}
    </WebSocketContext.Provider>
  );
};
