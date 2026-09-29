import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { WebSocketProvider } from './WebSocketProvider';
import { offlineQueue } from '@/lib/offlineQueue';

/**
 * How the telemetry socket proves who is opening it.
 *
 * The defect these exist for: a hosted console reaches the backend through
 * its own origin, so the session cookie belongs to that host. The socket
 * cannot take the same route — a platform rewrite will not carry a WebSocket
 * upgrade — so it is opened against the backend directly, where the cookie
 * is never sent. Every handshake was refused, the console retried forever,
 * and both link indicators sat red while everything else worked.
 *
 * A browser cannot put a header on a handshake, so the credential goes in
 * the query string. What matters below is that it is fetched only when it is
 * needed, fetched again on every attempt, and that failing to get one never
 * leaves the console worse off than it was before tickets existed.
 */

const opened: string[] = [];
let live: FakeSocket[] = [];

class FakeSocket {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;

  constructor(readonly url: string) {
    opened.push(url);
    live.push(this);
  }

  close() { this.onclose?.(); }
}

const ticketBody = (ticket: string) => ({
  ok: true, status: 200, json: async () => ({ ticket, expires_in: 60 }),
});

/** Let the provider's awaited ticket fetch settle before asserting. */
const settle = async () => { await act(async () => { await Promise.resolve(); }); };

beforeEach(() => {
  opened.length = 0;
  live = [];
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await act(async () => { await offlineQueue.setBlackout(false); });
});

describe('a socket that leaves this page origin', () => {
  beforeEach(() => { vi.stubEnv('NEXT_PUBLIC_WS_URL', 'wss://backend.example.com/ws'); });

  it('carries a ticket, because the session cookie cannot reach it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ticketBody('TICKET-1')));
    render(<WebSocketProvider>{null}</WebSocketProvider>);

    await waitFor(() => expect(opened).toHaveLength(1));
    expect(opened[0]).toBe('wss://backend.example.com/ws?ticket=TICKET-1');
  });

  it('asks the console origin for it, where the cookie does arrive', async () => {
    const f = vi.fn().mockResolvedValue(ticketBody('TICKET-1'));
    vi.stubGlobal('fetch', f);
    render(<WebSocketProvider>{null}</WebSocketProvider>);

    await waitFor(() => expect(f).toHaveBeenCalled());
    expect(f).toHaveBeenCalledWith('/api/auth/ws-ticket',
      expect.objectContaining({ method: 'POST', credentials: 'include' }));
  });

  it('escapes it, rather than trusting it to be URL-safe', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ticketBody('a+b/c=d&e')));
    render(<WebSocketProvider>{null}</WebSocketProvider>);

    await waitFor(() => expect(opened).toHaveLength(1));
    expect(opened[0]).toContain(`ticket=${encodeURIComponent('a+b/c=d&e')}`);
  });

  /**
   * A ticket lives about a minute and a reconnect can be half an hour after
   * the last one. Caching one would mean the console came back from a long
   * outage holding a credential that had expired while it waited.
   */
  it('gets a fresh one for every attempt', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(ticketBody('FIRST'))
      .mockResolvedValue(ticketBody('SECOND'));
    vi.stubGlobal('fetch', f);
    render(<WebSocketProvider>{null}</WebSocketProvider>);
    await waitFor(() => expect(opened).toHaveLength(1));

    // Drop the link the way the drill does, then restore it: the provider
    // reconnects immediately rather than on the outage's backoff.
    await act(async () => { await offlineQueue.setBlackout(true); });
    await act(async () => { await offlineQueue.setBlackout(false); });

    await waitFor(() => expect(opened).toHaveLength(2));
    expect(opened[1]).toBe('wss://backend.example.com/ws?ticket=SECOND');
  });

  // ── Nothing here may leave the console worse off than before ──────────

  it('still attempts the socket when the ticket cannot be minted', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    render(<WebSocketProvider>{null}</WebSocketProvider>);

    await waitFor(() => expect(opened).toHaveLength(1));
    expect(opened[0]).toBe('wss://backend.example.com/ws');
  });

  it('still attempts the socket when the station cannot be reached at all', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    render(<WebSocketProvider>{null}</WebSocketProvider>);

    await waitFor(() => expect(opened).toHaveLength(1));
    expect(opened[0]).toBe('wss://backend.example.com/ws');
  });

  it('survives a station that answers with something that is not a ticket', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      { ok: true, status: 200, json: async () => ({ unexpected: true }) }));
    render(<WebSocketProvider>{null}</WebSocketProvider>);

    await waitFor(() => expect(opened).toHaveLength(1));
    expect(opened[0]).toBe('wss://backend.example.com/ws');
  });

  it('does not open a socket for a blackout declared during the exchange', async () => {
    let release: (v: unknown) => void = () => {};
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(
      new Promise((resolve) => { release = resolve; })));
    render(<WebSocketProvider>{null}</WebSocketProvider>);

    await act(async () => { await offlineQueue.setBlackout(true); });
    await act(async () => { release(ticketBody('TOO-LATE')); await Promise.resolve(); });
    await settle();

    expect(opened).toHaveLength(0);
  });
});

describe('a socket on this page own origin', () => {
  /**
   * Local development. The cookie already rides the handshake, so minting a
   * credential and then putting it in a URL is strictly worse than not.
   */
  it('does not mint a ticket it has no use for', async () => {
    vi.stubEnv('NEXT_PUBLIC_WS_URL', `ws://${window.location.host}/ws`);
    const f = vi.fn().mockResolvedValue(ticketBody('UNUSED'));
    vi.stubGlobal('fetch', f);

    render(<WebSocketProvider>{null}</WebSocketProvider>);

    await waitFor(() => expect(opened).toHaveLength(1));
    expect(opened[0]).toBe(`ws://${window.location.host}/ws`);
    expect(f).not.toHaveBeenCalled();
  });

  it('does not mint one for the proxied default either', async () => {
    const f = vi.fn().mockResolvedValue(ticketBody('UNUSED'));
    vi.stubGlobal('fetch', f);

    render(<WebSocketProvider>{null}</WebSocketProvider>);

    await waitFor(() => expect(opened).toHaveLength(1));
    expect(opened[0]).toContain(`//${window.location.host}/ws`);
    expect(f).not.toHaveBeenCalled();
  });
});
