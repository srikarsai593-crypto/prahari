'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, HardDriveDownload, SatelliteDish } from 'lucide-react';
import { useOfflineQueue } from '@/lib/useOfflineQueue';

/**
 * Station-wide banner for a severed satellite link.
 *
 * The console has always kept working through an outage — the queue, the
 * service worker and the replay were all there. What was missing was any way
 * to *see* it: the only sign the link was down was a small amber badge in the
 * navigation band, which is indistinguishable from the console simply being
 * quiet. An operator who did not already know the link had dropped had no
 * reason to look.
 *
 * So the outage takes over the page. The banner says what is happening in one
 * line, the counter beside it is the genuine queue depth and ticks as writes
 * land in it, and the whole interface goes amber via `data-blackout` on the
 * root element (see globals.css) — the same mechanism the high-contrast theme
 * uses, so no component has to know about any of this.
 *
 * The drill is labelled a drill. A console tinted amber with a satellite
 * warning across the top is exactly the sort of thing somebody walks past and
 * reports, and the difference between a demonstration and a real failure has
 * to be readable from the doorway.
 */
export function BlackoutBanner() {
  const { offline, blackout, pending, flushing } = useOfflineQueue();

  // Re-triggers the counter's bump animation on each increment. Tracking the
  // previous value rather than animating on every render, or the digit
  // twitches whenever anything else in the banner updates.
  const [bump, setBump] = useState(0);
  const previous = useRef(pending);

  useEffect(() => {
    if (pending > previous.current) setBump((n) => n + 1);
    previous.current = pending;
  }, [pending]);

  // `data-blackout` on <html> rather than a wrapper: the tint is applied by
  // redefining the design tokens at the root, which is what lets it reach the
  // header, the footer, every card and the toast rail without a single
  // component opting in.
  useEffect(() => {
    const root = document.documentElement;
    if (offline) root.dataset.blackout = 'on';
    else delete root.dataset.blackout;
    return () => { delete root.dataset.blackout; };
  }, [offline]);

  if (!offline) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      /* Sticky, because the drill is the operator clicking around the console
         and the counter is no use scrolled off the top. Under the critical
         banner's z-index on purpose: both pin to the same edge, and if an
         emergency is declared mid-drill it is the emergency that should own
         that line. */
      className="blackout-banner sticky top-0 z-[65] px-4 sm:px-6 py-2.5 flex items-center
                 justify-between gap-3 flex-wrap"
    >
      <div className="flex items-center gap-3 min-w-0">
        <SatelliteDish size={18} aria-hidden="true" className="shrink-0 blackout-dish" />
        <p className="text-sm font-bold tracking-wide min-w-0">
          <AlertTriangle size={14} aria-hidden="true" className="inline-block mb-0.5 mr-1.5" />
          SATCOM LINK LOST
          <span className="hidden sm:inline"> — Operating on local cache</span>
        </p>

        {/* Named for what it is. The tint and the warning are loud on purpose,
            and an operator walking past needs to be able to tell a drill from
            a satellite the station has actually lost. */}
        {blackout && (
          <span className="shrink-0 px-2 py-0.5 rounded font-mono text-2xs font-bold
                           tracking-caps uppercase bg-black/25 border border-white/30">
            Drill
          </span>
        )}
      </div>

      <div className="flex items-center gap-2.5 shrink-0">
        <HardDriveDownload size={15} aria-hidden="true" className="opacity-80" />
        {/*
          Only writes queue — reading a page needs nothing from the station,
          which is the point of the cache. So a counter sitting at zero while
          somebody clicks through the modules is correct and reads as broken.
          Until the first write lands, the banner asks for one.
        */}
        <span className="font-mono text-2xs font-bold tracking-caps uppercase opacity-90">
          {flushing ? 'Syncing'
            : pending === 0 ? 'Make a change — it will be held here'
              : 'Queued locally'}
        </span>
        {/* The genuine queue depth. `key` restarts the bump each time it
            climbs, which is the whole point of the counter — a judge clicking
            around during the drill should see the console catching the work. */}
        <span key={bump}
              className="queue-counter metric text-base font-bold tabular-nums px-2.5 py-0.5
                         rounded bg-black/25 border border-white/30">
          {pending}
        </span>
        <span className="sr-only">
          {pending === 1 ? '1 change is' : `${pending} changes are`} waiting on this console
          and will be sent when the link returns.
        </span>
      </div>
    </div>
  );
}
