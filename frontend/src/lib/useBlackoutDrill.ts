'use client';

import { useCallback, useState } from 'react';
import { offlineQueue } from './offlineQueue';
import { useOfflineQueue, type QueueState } from './useOfflineQueue';
import { useToast } from '@/components/Toast';

export interface BlackoutDrill extends QueueState {
  /** A toggle is in flight — the replay it may have started is awaited. */
  switching: boolean;
  /** Cut the link, or restore it and replay everything held. */
  toggle: () => Promise<void>;
}

/**
 * The SATCOM blackout drill, and what to say about it.
 *
 * Both navigation bands offer this control, and until now only the desktop
 * one reported anything: the handset's toggle severed the link in silence, so
 * on the surface where an outage is most likely the operator got the least
 * confirmation. The wording lived inline in one of the two components, which
 * is why the other never grew any.
 */
export function useBlackoutDrill(): BlackoutDrill {
  const queue = useOfflineQueue();
  const { addToast } = useToast();
  const [switching, setSwitching] = useState(false);

  const toggle = useCallback(async () => {
    setSwitching(true);
    try {
      if (offlineQueue.isBlackout) {
        const held = offlineQueue.pendingCount;
        const { flushed, dropped, failed } = await offlineQueue.setBlackout(false);

        /*
         * Lead with the count, because the count is the claim: the work an
         * operator did through the outage arrived. "SATCOM restored" first
         * buried it behind the thing that is merely the precondition.
         *
         * Still the real figures rather than a flattering round number — a
         * replay that dropped or stalled says so in the same breath, or the
         * console is congratulating itself over work it lost.
         */
        const remainder = [
          dropped ? `${dropped} rejected by the station` : null,
          failed ? `${failed} still queued` : null,
        ].filter(Boolean).join(', ');

        addToast(
          held === 0
            ? 'SATCOM restored — nothing was written while the link was down'
            : `${flushed} queued change${flushed === 1 ? '' : 's'} synced`
              + (remainder ? ` — ${remainder}` : ' — the station is back in step'),
          dropped || failed ? 'warning' : 'success');
      } else {
        await offlineQueue.setBlackout(true);
        addToast('SATCOM blackout — writes are being held on this console and will '
          + 'replay when the link returns', 'warning');
      }
    } finally { setSwitching(false); }
  }, [addToast]);

  return { ...queue, switching, toggle };
}
