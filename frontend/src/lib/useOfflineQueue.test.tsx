import { afterEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { useOfflineQueue } from './useOfflineQueue';
import { offlineQueue } from './offlineQueue';

/**
 * Three components read the queue, and they used to each keep their own copy
 * of this subscription — which is how the desktop band ended up showing a
 * pending count the handset drawer did not have.
 */

function Readout() {
  const { offline, blackout, pending, flushing } = useOfflineQueue();
  return (
    <span data-testid="state">
      {`${offline}/${blackout}/${pending}/${flushing}`}
    </span>
  );
}

const state = () => screen.getByTestId('state').textContent;

afterEach(async () => {
  await act(async () => {
    await offlineQueue.setBlackout(false);
    offlineQueue.clear();
  });
});

describe('useOfflineQueue', () => {
  it('reports a console with a live link and nothing held', () => {
    render(<Readout />);
    expect(state()).toBe('false/false/0/false');
  });

  it('follows the queue without the caller subscribing to anything', async () => {
    render(<Readout />);

    await act(async () => { await offlineQueue.setBlackout(true); });
    expect(state()).toBe('true/true/0/false');

    act(() => { offlineQueue.enqueue('/api/a', { method: 'POST' }, 'a'); });
    expect(state()).toBe('true/true/1/false');
  });

  it('separates a real outage from a drill', async () => {
    render(<Readout />);
    await act(async () => { await offlineQueue.setOffline(true); });
    expect(state()).toBe('true/false/0/false');
    await act(async () => { await offlineQueue.setOffline(false); });
  });

  /**
   * The queue is a module singleton that outlives any component. A reader
   * that does not detach keeps a dead component's setState alive for the rest
   * of the session.
   */
  it('detaches on unmount', async () => {
    const { unmount } = render(<Readout />);
    unmount();

    // Would warn about updating an unmounted component if it were still
    // subscribed; the assertion is that nothing throws and the queue is free.
    await act(async () => { await offlineQueue.setBlackout(true); });
    expect(offlineQueue.isBlackout).toBe(true);
  });
});
