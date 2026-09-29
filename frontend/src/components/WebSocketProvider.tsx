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

/**
 * Whether the socket is leaving this page's origin.
 *
 * It is, on any hosted deployment: a platform rewrite will not carry a
 * WebSocket upgrade, so `NEXT_PUBLIC_WS_URL` points the socket straight at
 * the backend instead. That is also the reason the handshake needs a ticket
 * — see below.
 */
const isCrossOrigin = (url: string) => {
  if (typeof window === 'undefined') return false;
  try {
    return new URL(url).host !== window.location.host;
  } catch {
    return false;
  }
};

/**
 * Exchange the session for a credential the handshake can actually carry.
 *
 * The console reaches the backend through its own origin, so the session
 * cookie belongs to *this* host. When the socket is opened against the
 * backend directly — which it has to be, because the rewrite cannot proxy an
 * upgrade — that cookie is never sent, the handshake is refused, and the
 * console reports a link that is, from where it stands, down. That was the
 * state of every hosted deployment: both link indicators red, forever,
 * while every other part of the console worked.
 *
 * This request goes over the proxied path like any other read, so the cookie
 * does arrive. A browser cannot put a header on a WebSocket handshake, so
 * what comes back rides in the query string — which is why the backend keeps
 * it alive for a minute and refuses to accept it anywhere else.
 *
 * Fetched fresh per attempt rather than cached: a reconnect can be half an
 * hour after the last one, by which time any held ticket is long dead.
 *
 * Returning null is not a failure to handle — it is the same-origin case
 * (local development, where the cookie works and no ticket is wanted) and
 * the case where the station has no session to exchange. The caller
 * connects anyway and lets the backend decide, which is what it did before
 * tickets existed.
 */
const fetchTicket = async (): Promise<string | null> => {
  try {
    const response = await fetch('/api/auth/ws-ticket', {
      method: 'POST',
      credentials: 'include',
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const ticket = (body as { ticket?: unknown })?.ticket;
    return typeof ticket === 'string' && ticket ? ticket : null;
  } catch {
    return null;
  }
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

/**
 * Link-state chatter, development only.
 *
 * Connect/disconnect/retry lines are useful while building the offline
 * behaviour and are noise in a deployed console — an operator who opens
 * devtools during an outage should see faults, not a running commentary on
 * the backoff timer. `warn` and `error` below stay unconditional, because
 * those report something actually wrong.
 */
const trace = (...args: unknown[]) => {
  if (process.env.NODE_ENV !== 'production') console.log(...args);
};

  const connect = useCallback(async () => {
    if (unmounted.current || blackout.current) return;

    const url = getWsUrl();
    /*
     * Only where the socket leaves this origin. Same-origin — local
     * development — the cookie already rides the handshake, and minting a
     * credential that is then put in a URL for no reason is strictly worse
     * than not doing it.
     */
    const ticket = isCrossOrigin(url) ? await fetchTicket() : null;

    // The await above is a round trip to the station, and the operator may
    // have declared a blackout or left the page during it.
    if (unmounted.current || blackout.current) return;

    const ws = new WebSocket(ticket ? `${url}?ticket=${encodeURIComponent(ticket)}` : url);
    wsRef.current = ws;

    ws.onopen = () => {
      if (unmounted.current || blackout.current) { ws.close(); return; }
      trace('[WS] Connected');
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
      if (blackout.current) { trace('[WS] Down — SATCOM blackout held'); return; }
      trace(`[WS] Disconnected — retrying in ${retryDelay.current}ms`);
      // Exponential backoff reconnect
      retryTimer.current = setTimeout(() => {
        retryDelay.current = Math.min(retryDelay.current * 2, RECONNECT_MAX_MS);
        void connect();
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
    void connect();
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
        void connect();
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
