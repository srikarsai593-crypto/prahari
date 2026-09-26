'use client';

import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState,
} from 'react';
import {
  DEFAULT_STATION, getStation, loadActiveStation, saveActiveStation, type StationInfo,
} from '@/lib/stations';

interface StationContextValue {
  /** Station id, e.g. "Maitri". */
  stationId: string;
  /** Full record for the active station — coordinates, region, berths. */
  station: StationInfo;
  setStationId: (id: string) => void;
  /** False until the persisted choice has been read on the client. */
  ready: boolean;
}

/**
 * Layout effects run before the browser paints; plain effects run after. Reading
 * the persisted station in a plain effect meant the first painted frame said
 * "Maitri" and the second said the saved station — a visible flash on every
 * load. useLayoutEffect does not exist on the server, so fall back there.
 */
const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' ? useLayoutEffect : useEffect;

const StationContext = createContext<StationContextValue>({
  stationId: DEFAULT_STATION.id,
  station: DEFAULT_STATION,
  setStationId: () => {},
  ready: false,
});

/**
 * One active station for the whole console.
 *
 * Every module previously kept its own copy — the dashboard had a switcher, the
 * other pages hard-coded "Maitri" — so changing station on the dashboard left
 * Cargo, Inventory and Emergency reporting on a different base than the header
 * claimed. Hoisting it here means the header switcher drives every query.
 */
export function StationProvider({ children }: { children: React.ReactNode }) {
  // Start from the default so server and first client render agree; the
  // persisted choice is applied in an effect to avoid a hydration mismatch.
  const [stationId, setStation] = useState(DEFAULT_STATION.id);
  const [ready, setReady] = useState(false);

  useIsomorphicLayoutEffect(() => {
    setStation(loadActiveStation());
    setReady(true);
  }, []);

  const setStationId = useCallback((id: string) => {
    setStation(getStation(id).id);
    saveActiveStation(id);
  }, []);

  const value = useMemo<StationContextValue>(
    () => ({ stationId, station: getStation(stationId), setStationId, ready }),
    [stationId, setStationId, ready],
  );

  return <StationContext.Provider value={value}>{children}</StationContext.Provider>;
}

export const useStation = () => useContext(StationContext);
