'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { useWebSocket } from '@/components/WebSocketProvider';

/**
 * Live blizzard ΔT for one station.
 *
 * Read by the portal header and the dashboard, so both always quote the same
 * figure. It refreshes on the broadcast that changes it rather than on a timer:
 * Cargo writes ΔT, the backend fans out `blizzard_update`, and every subscriber
 * re-reads — no polling loop on an offline-first console.
 */
export function useStationConditions(stationId: string) {
  const { lastMessage } = useWebSocket();
  const [stations, setStations] = useState<Record<string, number> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await api.getStationConditions();
      setStations(res?.stations ?? {});
    } catch {
      // Leave the last known reading in place; the header renders "No reading"
      // only when nothing has ever been fetched.
      setStations((prev) => prev);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (lastMessage?.type === 'blizzard_update' || lastMessage?.type === 'shipment_update') {
      void refresh();
    }
  }, [lastMessage, refresh]);

  return {
    /** null until the first successful fetch, then 0 for "calm". */
    deltaT: stations ? (stations[stationId] ?? 0) : null,
    allStations: stations,
    refresh,
  };
}
