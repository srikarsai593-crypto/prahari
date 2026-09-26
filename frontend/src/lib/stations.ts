/**
 * The three Indian polar research stations Prahari covers.
 *
 * Coordinates are the real station positions and match the geofence seed in
 * backend/app/seed.py — the map, the compass and the geofence checks must all
 * agree on where a station actually is.
 */
export interface StationInfo {
  id: string;
  name: string;
  label: string;
  region: string;
  lat: number;
  lng: number;
  /** Berths — mirrors STATION_CAPACITY in backend/app/routes/expeditions.py. */
  capacity: number;
}

export const STATIONS: StationInfo[] = [
  { id: 'Maitri',   name: 'Maitri',   label: 'Maitri Base',     region: 'Schirmacher Oasis, Antarctica', lat: -70.767, lng: 11.731, capacity: 40 },
  { id: 'Bharati',  name: 'Bharati',  label: 'Bharati Station', region: 'Larsemann Hills, Antarctica',   lat: -69.407, lng: 76.187, capacity: 47 },
  { id: 'Himadri',  name: 'Himadri',  label: 'Himadri Station', region: 'Ny-Ålesund, Svalbard (Arctic)', lat:  78.923, lng: 11.923, capacity: 25 },
];

export const DEFAULT_STATION = STATIONS[0];

export const getStation = (id: string | null | undefined): StationInfo =>
  STATIONS.find((s) => s.id === id) ?? DEFAULT_STATION;

// Coordinate formatting lives in components/Coordinate.tsx — one component
// renders every lat/lng pair in the console, so the format cannot drift.

const STORAGE_KEY = 'prahari_active_station';

export function loadActiveStation(): string {
  if (typeof window === 'undefined') return DEFAULT_STATION.id;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && STATIONS.some((s) => s.id === saved)) return saved;
  } catch { /* private mode or blocked storage — fall through to the default */ }
  return DEFAULT_STATION.id;
}

export function saveActiveStation(id: string) {
  if (typeof window === 'undefined') return;
  try { localStorage.setItem(STORAGE_KEY, id); } catch { /* non-fatal */ }
}
