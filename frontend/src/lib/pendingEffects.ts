'use client';

import { useEffect, useState } from 'react';
import { offlineQueue } from './offlineQueue';

/**
 * What a write held on this console would do, if the station had received it.
 *
 * The queue kept the operator's work and showed them a counter, and that was
 * the whole of it: a blizzard load applied during an outage left the header
 * reading the old figure, and stock removed from a shed left the shed's row
 * unchanged. The console said "held" and then carried on describing a station
 * where nothing had happened. An operator working through a blackout could
 * queue work but could not *work* — every reading they went back to check was
 * the one from before they started.
 *
 * So a mutation may declare what it means locally, and the console shows that
 * while the link is down.
 *
 * ## What this deliberately does not do
 *
 * It does not compute anything. An effect carries a value the operator
 * themselves supplied — the ΔT they set, the quantity the station last
 * confirmed plus the delta they entered — and nothing derived from it.
 * `days_of_cover` is quantity over a burn rate scaled by crew and weather,
 * and the one place that arithmetic lives is the backend. Reproducing it here
 * would put a second model in the console to drift from the first, which is
 * the trade this codebase refuses everywhere else it comes up.
 *
 * So a figure that depends on a held write is reported as waiting, not
 * recalculated. `days_of_cover` beside a pending quantity is the station's
 * last answer to a question that has since changed, and saying so is the
 * honest reading.
 *
 * ## And it never presents a held value as the station's
 *
 * Every consumer gets `pending: true` alongside the value and is expected to
 * mark it. A console that quietly showed the operator their own input back as
 * though the station had accepted it would be lying in exactly the direction
 * that matters — the operator would have no way to tell what the station
 * actually holds from what they merely asked for.
 */
export type PendingEffect =
  /** Blizzard load applied to a station, before the station has it. */
  | { kind: 'stationDeltaT'; station: string; deltaT: number }
  /** A stock row's new quantity, as the operator's own arithmetic. */
  | { kind: 'stockQuantity'; itemId: string; station: string; quantity: number };

/** The effects carried by everything currently waiting, oldest first. */
export function pendingEffects(): PendingEffect[] {
  return offlineQueue.getPending()
    .map((entry) => entry.effect)
    .filter((e): e is PendingEffect => e != null);
}

/**
 * The ΔT a station would be on once the queue drains, or null if no held
 * write touches it. The last one wins — an operator who moved the slider
 * twice meant the second figure.
 */
export function pendingDeltaT(station: string): number | null {
  let value: number | null = null;
  for (const effect of pendingEffects()) {
    if (effect.kind === 'stationDeltaT' && effect.station === station) {
      value = effect.deltaT;
    }
  }
  return value;
}

/** The quantity a stock row would hold once the queue drains, or null. */
export function pendingQuantity(itemId: string): number | null {
  let value: number | null = null;
  for (const effect of pendingEffects()) {
    if (effect.kind === 'stockQuantity' && effect.itemId === itemId) {
      value = effect.quantity;
    }
  }
  return value;
}

/**
 * Re-render when what is held changes.
 *
 * Returns a counter rather than the effects themselves: consumers call the
 * lookups above, which read the queue directly, and a changing number is
 * enough to bring them back. Returning an array would hand every caller a new
 * identity on every notification whether or not anything they care about moved.
 */
export function usePendingRevision(): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => offlineQueue.subscribe(() => setRevision((n) => n + 1)), []);
  return revision;
}
