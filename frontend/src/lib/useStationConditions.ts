'use client';

import { useEffect, useState } from 'react';
import { api } from './api';
import { useWebSocket } from '@/components/WebSocketProvider';

/**
 * Live blizzard ΔT for one station.
 *
 * Read by the portal header, the NOTAM strip, Cargo and Inventory, so they
 * always quote the same figure. It refreshes on the broadcast that changes
 * it rather than on a timer: Cargo writes ΔT, the backend fans out
 * `blizzard_update`, and every subscriber re-reads — no polling loop on an
 * offline-first console.
 *
 * ## One request, however many readers
 *
 * Each of those components used to hold its own copy of this hook and fetch
 * independently, so a page load made three identical round trips for one
 * small object, and every `blizzard_update` made three more at the same
 * instant. On a station link that is exactly the waste this console exists
 * to avoid.
 *
 * The state lives at module scope now. Callers that ask while a request is
 * already in flight join that request instead of starting another, and the
 * answer is pushed to every subscriber at once. The hook's signature is
 * unchanged — no call site knows.
 */

type Conditions = Record<string, number>;

/** Last successful read, shared by every instance of the hook. */
let cache: Conditions | null = null;
/** The request in flight, if any, so concurrent callers can join it. */
let inflight: Promise<Conditions | null> | null = null;
const subscribers = new Set<(next: Conditions | null) => void>();

async function fetchShared(): Promise<Conditions | null> {
  if (!inflight) {
    inflight = api.getStationConditions()
      .then((res) => { cache = res?.stations ?? {}; return cache; })
      // Leave the last known reading in place. A dropped link is not a
      // reason to tell the header there is no weather.
      .catch(() => cache)
      .finally(() => { inflight = null; });
  }
  const result = await inflight;
  subscribers.forEach((notify) => notify(cache));
  return result;
}

/** Test seam: drop the shared state so one test cannot leak into the next. */
export function __resetStationConditions(): void {
  cache = null;
  inflight = null;
  subscribers.clear();
}

export function useStationConditions(stationId: string) {
  const { lastMessage } = useWebSocket();
  // Seeded from the shared cache, so a component mounting later renders the
  // known figure immediately instead of flashing "no reading".
  const [stations, setStations] = useState<Conditions | null>(cache);

  useEffect(() => {
    subscribers.add(setStations);
    void fetchShared();
    return () => { subscribers.delete(setStations); };
  }, []);

  useEffect(() => {
    if (lastMessage?.type === 'blizzard_update' || lastMessage?.type === 'shipment_update') {
      void fetchShared();
    }
  }, [lastMessage]);

  return {
    /** null until the first successful fetch, then 0 for "calm". */
    deltaT: stations ? (stations[stationId] ?? 0) : null,
    allStations: stations,
    refresh: fetchShared,
  };
}
