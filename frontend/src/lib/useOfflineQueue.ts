'use client';

import { useEffect, useState } from 'react';
import { offlineQueue } from './offlineQueue';

export interface QueueState {
  /** The console cannot reach the station, for any reason. */
  offline: boolean;
  /** True only while an operator is holding the link down deliberately. */
  blackout: boolean;
  /** Mutations written on this console and not yet replayed. */
  pending: number;
  /** A replay is in progress. */
  flushing: boolean;
}

const read = (): QueueState => ({
  offline: offlineQueue.isOffline,
  blackout: offlineQueue.isBlackout,
  pending: offlineQueue.pendingCount,
  flushing: offlineQueue.isFlushing,
});

/** What the server rendered: the queue is a browser object and has no state there. */
const IDLE: QueueState = { offline: false, blackout: false, pending: 0, flushing: false };

/**
 * Subscribe to the offline queue.
 *
 * Three components watched the queue with the same twelve lines of
 * `useState` + `subscribe` + `sync`, and each one chose its own subset of the
 * four values — so the desktop band could show a pending count the mobile
 * drawer did not have. One reader, one shape.
 *
 * The first render deliberately returns the idle state rather than reading the
 * queue, so the server's markup and the client's first pass agree. A console
 * that was already queueing corrects itself in the effect below, on the same
 * tick as hydration.
 */
export function useOfflineQueue(): QueueState {
  const [state, setState] = useState<QueueState>(IDLE);

  useEffect(() => {
    const sync = () => setState(read());
    const unsub = offlineQueue.subscribe(sync);
    sync();
    return unsub;
  }, []);

  return state;
}
