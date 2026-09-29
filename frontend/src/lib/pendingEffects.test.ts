import { afterEach, describe, expect, it, vi } from 'vitest';
import { pendingDeltaT, pendingEffects, pendingQuantity } from './pendingEffects';
import { offlineQueue } from './offlineQueue';
import { api } from './api';

/**
 * What a console shows an operator working through an outage.
 *
 * The queue kept their work and showed them a counter, and that was all: a
 * blizzard load applied during a blackout left the header on the old figure,
 * and a stock count left the row unchanged. The console said "held" and then
 * carried on describing a station where nothing had happened.
 */

const held = async (fn: () => Promise<unknown>) => {
  await offlineQueue.setOffline(true);
  await fn().catch(() => {});
};

afterEach(async () => {
  await offlineQueue.setOffline(false);
  offlineQueue.clear();
});

describe('nothing is held', () => {
  it('reports no pending figure', () => {
    expect(pendingEffects()).toEqual([]);
    expect(pendingDeltaT('Maitri')).toBeNull();
    expect(pendingQuantity('diesel')).toBeNull();
  });
});

describe('a blizzard load applied while the link is down', () => {
  it('is readable back as the operator set it', async () => {
    await held(() => api.applyStationWeather('Maitri', 18));
    expect(pendingDeltaT('Maitri')).toBe(18);
  });

  it('does not leak onto another station', async () => {
    await held(() => api.applyStationWeather('Maitri', 18));
    expect(pendingDeltaT('Bharati')).toBeNull();
  });

  /** An operator who moved the slider twice meant the second figure. */
  it('reports the most recent of several', async () => {
    await held(() => api.applyStationWeather('Maitri', 9));
    await held(() => api.applyStationWeather('Maitri', 21));
    expect(pendingDeltaT('Maitri')).toBe(21);
  });

  it('stops being pending once the station has it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      { ok: true, status: 200, text: async () => '{}' }));
    await held(() => api.applyStationWeather('Maitri', 18));
    expect(pendingDeltaT('Maitri')).toBe(18);

    await offlineQueue.setOffline(false);
    expect(pendingDeltaT('Maitri')).toBeNull();
  });

  /**
   * Survives a reload, because the effect is stored on the queue entry and
   * the queue is persisted. A console restarted mid-outage that forgot what
   * it was holding would be the original defect with extra steps.
   */
  it('is persisted with the entry it belongs to', async () => {
    await held(() => api.applyStationWeather('Maitri', 18));
    const [entry] = offlineQueue.getPending();
    expect(entry.effect).toEqual({ kind: 'stationDeltaT', station: 'Maitri', deltaT: 18 });
    expect(JSON.parse(JSON.stringify(entry)).effect).toEqual(entry.effect);
  });
});

describe('a stock correction made while the link is down', () => {
  it('is readable back against its own row', async () => {
    await held(() => api.updateInventory('diesel-01', 5000, 'Maitri'));
    expect(pendingQuantity('diesel-01')).toBe(5000);
  });

  it('does not leak onto another row', async () => {
    await held(() => api.updateInventory('diesel-01', 5000, 'Maitri'));
    expect(pendingQuantity('rations-01')).toBeNull();
  });

  /**
   * A row whose station is unknown cannot be shown against the right base,
   * so it is queued without an effect rather than shown against the wrong one.
   */
  it('is not claimed for a station it cannot name', async () => {
    await held(() => api.updateInventory('diesel-01', 5000));
    expect(pendingQuantity('diesel-01')).toBeNull();
    expect(offlineQueue.pendingCount).toBe(1);
  });
});

describe('what is deliberately not derived', () => {
  /**
   * days_of_cover is quantity over a burn rate scaled by crew and weather,
   * and that arithmetic lives on the backend. A second copy here would be a
   * model to drift from the first — the trade this codebase refuses
   * everywhere else it comes up.
   */
  it('carries only figures the operator supplied, never a computed one', async () => {
    await held(() => api.applyStationWeather('Maitri', 18));
    await held(() => api.updateInventory('diesel-01', 5000, 'Maitri'));

    for (const effect of pendingEffects()) {
      const keys = Object.keys(effect).sort();
      expect(keys).not.toContain('daysOfCover');
      expect(keys).not.toContain('coverDays');
      expect(keys).not.toContain('status');
    }
  });
});

describe('coming back from an outage', () => {
  /**
   * The bug this closes. A write replayed on reconnect changes figures the
   * console is displaying, and the broadcast that would normally refresh
   * them is exactly what a console coming out of an outage missed — the
   * socket was down while the write landed. Measured against the running
   * console: the station held ΔT +21 and the page went on showing +18.
   */
  it('tells readers to re-read once a replay has delivered', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      { ok: true, status: 200, text: async () => '{}', json: async () => ({}) }));

    let drained = 0;
    const stop = offlineQueue.subscribeDrained(() => { drained += 1; });

    await held(() => api.applyStationWeather('Maitri', 18));
    expect(drained).toBe(0);

    await offlineQueue.setOffline(false);
    expect(drained).toBe(1);
    stop();
  });

  it('does not tell them to re-read when there was nothing to deliver', async () => {
    let drained = 0;
    const stop = offlineQueue.subscribeDrained(() => { drained += 1; });

    await offlineQueue.setOffline(true);
    await offlineQueue.setOffline(false);

    expect(drained).toBe(0);
    stop();
  });

  it('stops notifying a reader that has gone away', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      { ok: true, status: 200, text: async () => '{}', json: async () => ({}) }));

    let drained = 0;
    offlineQueue.subscribeDrained(() => { drained += 1; })();   // subscribe, then unsubscribe

    await held(() => api.applyStationWeather('Maitri', 18));
    await offlineQueue.setOffline(false);

    expect(drained).toBe(0);
  });
});
