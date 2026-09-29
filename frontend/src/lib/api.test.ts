import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, isQueued, setWriteGuard } from './api';
import { offlineQueue } from './offlineQueue';

/**
 * What the console does with a write it cannot send.
 *
 * Parking it is the right answer for a commander in a blizzard and the wrong
 * answer for an observer, and the console used to give both the same one —
 * telling a read-only session its change was safe, then never being able to
 * deliver it.
 */

const ok = () => ({ ok: true, status: 200, text: async () => '{}' });

beforeEach(async () => {
  await offlineQueue.setOffline(false);
  offlineQueue.clear();
  setWriteGuard(() => null);
});

afterEach(async () => {
  await offlineQueue.setOffline(false);
  offlineQueue.clear();
  setWriteGuard(() => null);
});

describe('a write made while the station is unreachable', () => {
  it('is parked for a caller who may write', async () => {
    await offlineQueue.setOffline(true);

    const result = await api.loadDemoSeason();
    expect(isQueued(result)).toBe(true);
    expect(offlineQueue.pendingCount).toBe(1);
  });

  /**
   * The bug this closes. Every replay of an observer's write hits the 403
   * from `require_commander`, which the queue treats as retryable — the
   * session might yet be upgraded — so the entry never drains. The operator
   * was told the work was safe, the counter climbed, and the reconnect
   * reported "0 queued changes synced".
   */
  it('is refused outright for an observer, rather than promised and never sent',
    async () => {
      setWriteGuard(() => 'You are viewing this station as an observer, which is read-only.');
      await offlineQueue.setOffline(true);

      await expect(api.loadDemoSeason()).rejects.toThrow(/observer, which is read-only/i);
      expect(offlineQueue.pendingCount).toBe(0);
    });

  it('refuses with the status the station itself would have returned', async () => {
    setWriteGuard(() => 'You are viewing this station as an observer, which is read-only.');
    await offlineQueue.setOffline(true);

    await expect(api.loadDemoSeason()).rejects.toMatchObject({
      name: 'ApiError',
      status: 403,
    });
  });

  /**
   * A console reloaded while the link is already down cannot reach
   * /auth/session, so it does not know who it is holding. Refusing a
   * commander's work over that is the worse of the two failures.
   */
  it('is parked when the console has not been able to ask who is signed in', async () => {
    setWriteGuard(() => null);   // SessionProvider's reading of `state === null`
    await offlineQueue.setOffline(true);

    expect(isQueued(await api.loadDemoSeason())).toBe(true);
    expect(offlineQueue.pendingCount).toBe(1);
  });
});

describe('a write lost to a network failure rather than a declared outage', () => {
  it('is parked for a caller who may write', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection reset')));

    expect(isQueued(await api.loadDemoSeason())).toBe(true);
    expect(offlineQueue.pendingCount).toBe(1);
  });

  it('is refused for an observer on that path too', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection reset')));
    setWriteGuard(() => 'You are viewing this station as an observer, which is read-only.');

    await expect(api.loadDemoSeason()).rejects.toThrow(/observer, which is read-only/i);
    expect(offlineQueue.pendingCount).toBe(0);
  });
});

describe('a write the console can actually deliver', () => {
  /**
   * The guard exists to stop the console making a promise it cannot keep
   * offline. Online there is a station to ask, and its answer — including
   * its refusal — is the authoritative one.
   */
  it('is sent to the station even for an observer, so the station decides', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal('fetch', fetchMock);
    setWriteGuard(() => 'You are viewing this station as an observer, which is read-only.');

    await api.loadDemoSeason();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('is not queued', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok()));

    await api.loadDemoSeason();
    expect(offlineQueue.pendingCount).toBe(0);
  });
});

describe('a read', () => {
  it('is never blocked by the write guard', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200, text: async () => '[]',
    });
    vi.stubGlobal('fetch', fetchMock);
    setWriteGuard(() => 'You are viewing this station as an observer, which is read-only.');

    await expect(api.listPersonnel('Maitri')).resolves.toEqual([]);
  });

  it('still fails loudly when the station cannot be reached, rather than queueing',
    async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection reset')));

      await expect(api.listPersonnel('Maitri')).rejects.toBeInstanceOf(ApiError);
      expect(offlineQueue.pendingCount).toBe(0);
    });
});
