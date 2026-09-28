import { beforeEach, describe, expect, it, vi } from 'vitest';
import { offlineQueue } from './offlineQueue';

/**
 * The queue holds work an operator did while the station link was down. Its
 * failure mode is not an error message — it is losing what somebody recorded
 * in a blizzard and never telling them.
 */

const STORAGE_KEY = 'prahari_offline_queue_v2';

function stubFetch(handler: (url: string, init: RequestInit) => Partial<Response>) {
  const spy = vi.fn(async (url: string, init: RequestInit = {}) => {
    const result = handler(url, init);
    return { ok: result.status === undefined || result.status < 400,
             status: result.status ?? 200,
             text: async () => '',
             ...result } as Response;
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

function enqueue(description = 'update inventory', url = '/api/inventory/inv-fuel') {
  offlineQueue.enqueue(url, { method: 'PATCH', body: JSON.stringify({ quantity: 10 }) },
                       description);
}

beforeEach(() => {
  offlineQueue.setOffline(false);
  offlineQueue.clear();
  window.localStorage.clear();
});

describe('capturing work while the link is down', () => {
  it('holds a mutation instead of losing it', () => {
    enqueue();
    expect(offlineQueue.pendingCount).toBe(1);
  });

  it('survives the console being closed and reopened', () => {
    enqueue();
    const persisted = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]');
    expect(persisted).toHaveLength(1);
    expect(persisted[0].url).toBe('/api/inventory/inv-fuel');
  });

  it('never persists a credential', () => {
    /**
     * The queue rebuilds headers at flush time and rides the session cookie.
     * A key written into localStorage would outlive the session that issued
     * it and sit there for anything on the page to read.
     */
    enqueue();
    const raw = window.localStorage.getItem(STORAGE_KEY) ?? '';
    expect(raw.toLowerCase()).not.toContain('commander');
    expect(raw.toLowerCase()).not.toContain('authorization');
    expect(JSON.parse(raw)[0]).not.toHaveProperty('headers');
  });

  it('caps the queue so a long outage cannot fill localStorage', () => {
    for (let i = 0; i < 260; i += 1) enqueue(`change ${i}`);
    expect(offlineQueue.pendingCount).toBeLessThanOrEqual(200);
  });
});

describe('replaying when the link returns', () => {
  it('sends each queued mutation and empties the queue', async () => {
    enqueue('first');
    enqueue('second');
    const fetchSpy = stubFetch(() => ({ status: 200 }));

    const result = await offlineQueue.flush();

    expect(result.flushed).toBe(2);
    expect(offlineQueue.pendingCount).toBe(0);
    // Two replays plus the sync report the backend composes the audit line from.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('replays in the order the operator made the changes', async () => {
    enqueue('first', '/api/a');
    enqueue('second', '/api/b');
    const fetchSpy = stubFetch(() => ({ status: 200 }));

    await offlineQueue.flush();

    const urls = fetchSpy.mock.calls.map((call) => call[0]);
    expect(urls.slice(0, 2)).toEqual(['/api/a', '/api/b']);
  });

  it('carries credentials, or every replay is anonymous', async () => {
    enqueue();
    const fetchSpy = stubFetch(() => ({ status: 200 }));

    await offlineQueue.flush();

    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ credentials: 'include' });
  });

  it('keeps work when the session lapsed rather than discarding it', async () => {
    /**
     * A 401 is not a verdict on the request — it says the console is signed
     * out right now. Treating it as permanent, which the 4xx branch used to,
     * threw away everything an operator recorded offline the moment their
     * session expired.
     */
    enqueue('a blizzard stock count');
    stubFetch(() => ({ status: 401 }));

    const result = await offlineQueue.flush();

    expect(result.dropped).toBe(0);
    expect(offlineQueue.pendingCount).toBe(1);
  });

  it('keeps work when the station is throttling', async () => {
    enqueue();
    stubFetch(() => ({ status: 429 }));

    expect((await offlineQueue.flush()).dropped).toBe(0);
    expect(offlineQueue.pendingCount).toBe(1);
  });

  it('replays successfully once the operator signs back in', async () => {
    enqueue('a blizzard stock count');
    stubFetch(() => ({ status: 401 }));
    await offlineQueue.flush();
    expect(offlineQueue.pendingCount).toBe(1);

    stubFetch(() => ({ status: 200 }));
    expect((await offlineQueue.flush()).flushed).toBe(1);
    expect(offlineQueue.pendingCount).toBe(0);
  });

  it('drops a request the station genuinely refuses, and says so', async () => {
    // 422: the payload is invalid and will be invalid for ever. Retrying it
    // blocks every later change behind it.
    enqueue('a malformed change');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch(() => ({ status: 422 }));

    const result = await offlineQueue.flush();

    expect(result.dropped).toBe(1);
    expect(offlineQueue.pendingCount).toBe(0);
  });

  it('stops at the first failure so later changes do not overtake earlier ones', async () => {
    enqueue('first', '/api/a');
    enqueue('second', '/api/b');
    const fetchSpy = stubFetch((url) => ({ status: url === '/api/a' ? 503 : 200 }));

    await offlineQueue.flush();

    expect(fetchSpy.mock.calls.map((c) => c[0])).not.toContain('/api/b');
    expect(offlineQueue.pendingCount).toBe(2);
  });

  it('keeps the queue when the link is still down', async () => {
    enqueue();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));

    const result = await offlineQueue.flush();

    expect(result.flushed).toBe(0);
    expect(offlineQueue.pendingCount).toBe(1);
  });

  it('gives up on a request the station keeps failing on', async () => {
    enqueue('a doomed change');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch(() => ({ status: 500 }));

    for (let i = 0; i < 6; i += 1) await offlineQueue.flush();

    expect(offlineQueue.pendingCount).toBe(0);
  });

  it('reports counts to the station, never prose', async () => {
    /**
     * The audit line is composed server-side. A browser that can write
     * arbitrary text into the station's record can forge it.
     */
    enqueue();
    const fetchSpy = stubFetch(() => ({ status: 200 }));

    await offlineQueue.flush();

    const report = fetchSpy.mock.calls.find((c) => String(c[0]).includes('sync-report'));
    expect(report).toBeDefined();
    const body = JSON.parse(String((report![1] as RequestInit).body));
    expect(body).toMatchObject({ flushed: 1, dropped: 0, pending: 0 });
    expect(Object.keys(body)).not.toContain('action');
  });

  it('does not report a sync when nothing was replayed', async () => {
    const fetchSpy = stubFetch(() => ({ status: 200 }));
    await offlineQueue.flush();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('concurrent callers share one replay instead of double-sending', async () => {
    /**
     * Several things ask the queue to drain at once — the reconnect handler,
     * the scenario page, an operator pressing sync. Each has to get an answer,
     * but the station must see the mutation exactly once: replaying a stock
     * deduction twice takes the fuel twice.
     */
    enqueue();
    const fetchSpy = stubFetch(() => ({ status: 200 }));

    const [a, b] = await Promise.all([offlineQueue.flush(), offlineQueue.flush()]);

    expect(fetchSpy.mock.calls.filter((c) => c[0] === '/api/inventory/inv-fuel'))
      .toHaveLength(1);
    // Both callers observe the same outcome rather than one being told nothing
    // happened, which would read as "my change was lost".
    expect(a).toEqual(b);
    expect(a.flushed).toBe(1);
    expect(offlineQueue.pendingCount).toBe(0);
  });
});

describe('replay protection', () => {
  it('sends the entry id as an idempotency key', async () => {
    /**
     * The case this covers is a write the station received and acted on
     * whose response never came back. Without a key, replaying it issues the
     * stock a second time.
     */
    enqueue();
    const key = offlineQueue.getPending()[0].id;
    const fetchSpy = stubFetch(() => ({ status: 200 }));

    await offlineQueue.flush();

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe(key);
  });

  it('keeps the same key across a failed attempt and its retry', async () => {
    /** A new key on each attempt would defeat the whole mechanism. */
    enqueue();
    const key = offlineQueue.getPending()[0].id;

    stubFetch(() => { throw new Error('network down'); });
    await offlineQueue.flush();
    expect(offlineQueue.getPending()[0].id).toBe(key);

    const retry = stubFetch(() => ({ status: 200 }));
    await offlineQueue.flush();
    const init = retry.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe(key);
  });

  it('gives every entry a distinct key', () => {
    for (let i = 0; i < 25; i += 1) enqueue(`change ${i}`);
    const ids = offlineQueue.getPending().map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('following the browser link state', () => {
  it('arms the queue the moment the browser reports no network', () => {
    /**
     * Until now the first write after an outage was always spent discovering
     * it: the queue only armed on a fetch that had already failed.
     */
    const stop = offlineQueue.watchBrowserConnectivity();
    window.dispatchEvent(new Event('offline'));
    expect(offlineQueue.isOffline).toBe(true);
    stop();
  });

  it('drains when the browser comes back', async () => {
    const stop = offlineQueue.watchBrowserConnectivity();
    window.dispatchEvent(new Event('offline'));
    enqueue();
    const fetchSpy = stubFetch(() => ({ status: 200 }));

    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(offlineQueue.pendingCount).toBe(0));
    expect(fetchSpy).toHaveBeenCalled();
    stop();
  });

  it('does not overrule an operator holding the link down', async () => {
    /**
     * A blackout is a demonstration. The browser noticing that wifi is fine
     * must not end it half way through.
     */
    const stop = offlineQueue.watchBrowserConnectivity();
    await offlineQueue.setBlackout(true);

    window.dispatchEvent(new Event('online'));

    expect(offlineQueue.isBlackout).toBe(true);
    expect(offlineQueue.isOffline).toBe(true);
    await offlineQueue.setBlackout(false);
    stop();
  });

  it('stops listening when the console unmounts it', () => {
    const stop = offlineQueue.watchBrowserConnectivity();
    stop();
    window.dispatchEvent(new Event('offline'));
    expect(offlineQueue.isOffline).toBe(false);
  });
});

describe('subscribers', () => {
  it('are told when the queue changes so the console can show the count', () => {
    const listener = vi.fn();
    const unsubscribe = offlineQueue.subscribe(listener);

    enqueue();
    expect(listener).toHaveBeenCalled();

    unsubscribe();
    listener.mockClear();
    enqueue();
    expect(listener).not.toHaveBeenCalled();
  });
});
