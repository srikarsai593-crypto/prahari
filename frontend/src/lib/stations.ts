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
  /**
   * Published climatological air-temperature normals for the site, in °C.
   *
   * These are reference figures for the location, not a sensor reading, and
   * the header says so where it uses them. Prahari has no meteorological feed
   * — the alternative to a normal is an invented number, which on an
   * operations console is indistinguishable from a measured one.
   */
  normals: { summer: number; shoulder: number; winter: number };
}

export const STATIONS: StationInfo[] = [
  { id: 'Maitri',   name: 'Maitri',   label: 'Maitri Base',     region: 'Schirmacher Oasis, Antarctica', lat: -70.767, lng: 11.731, capacity: 40, normals: { summer:   0, shoulder: -12, winter: -28 } },
  { id: 'Bharati',  name: 'Bharati',  label: 'Bharati Station', region: 'Larsemann Hills, Antarctica',   lat: -69.407, lng: 76.187, capacity: 47, normals: { summer:   1, shoulder: -10, winter: -22 } },
  { id: 'Himadri',  name: 'Himadri',  label: 'Himadri Station', region: 'Ny-Ålesund, Svalbard (Arctic)', lat:  78.923, lng: 11.923, capacity: 25, normals: { summer:   5, shoulder:  -6, winter: -14 } },
];

export const DEFAULT_STATION = STATIONS[0];

export const getStation = (id: string | null | undefined): StationInfo =>
  STATIONS.find((s) => s.id === id) ?? DEFAULT_STATION;

// Coordinate formatting lives in components/Coordinate.tsx — one component
// renders every lat/lng pair in the console, so the format cannot drift.

// ── Polar environment ───────────────────────────────────────────────────────

export type PolarDaylight = 'midnight_sun' | 'polar_night' | 'diurnal';

/**
 * Solar declination for a date, in degrees.
 *
 * Cooper's equation — the standard first-order approximation, good to about a
 * third of a degree. That is far inside the margin that matters here: the
 * question is only whether the sun clears the horizon at all, and at these
 * latitudes the answer changes over days, not hours.
 */
function solarDeclination(date: Date): number {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const dayOfYear = Math.floor((date.getTime() - start) / 86_400_000);
  return -23.44 * Math.cos(((2 * Math.PI) / 365) * (dayOfYear + 10));
}

/**
 * Whether the station is under 24-hour sun, 24-hour night, or an ordinary
 * day/night cycle right now.
 *
 * This is real astronomy from the station's own latitude, not a stored figure
 * — which is why it is safe to show next to live telemetry. Inside the polar
 * circle the sun stays up when the declination leans far enough towards the
 * station's own hemisphere, and stays down when it leans as far away.
 */
export function polarDaylight(station: StationInfo, now: Date = new Date()): PolarDaylight {
  const declination = solarDeclination(now);
  // The sun is circumpolar above this latitude for today's declination.
  const circumpolarFrom = 90 - Math.abs(declination);
  if (Math.abs(station.lat) < circumpolarFrom) return 'diurnal';
  // Same hemisphere as the sun's tilt means it never sets; opposite means it
  // never rises.
  return Math.sign(station.lat) === Math.sign(declination) ? 'midnight_sun' : 'polar_night';
}

/**
 * The station's climatological air temperature for the time of year, in °C.
 *
 * Banded by the sun's position rather than by calendar month, so it works for
 * Himadri in the Arctic and Maitri in the Antarctic off the same rule: the
 * summer band is when the sun leans towards the station, winter when it leans
 * away, and shoulder either side of that.
 */
export function seasonalNormal(station: StationInfo, now: Date = new Date()): number {
  const declination = solarDeclination(now);
  // Positive when the sun favours this station's hemisphere, scaled −1…1.
  const lean = (Math.sign(station.lat) * declination) / 23.44;
  if (lean > 0.45) return station.normals.summer;
  if (lean < -0.45) return station.normals.winter;
  return station.normals.shoulder;
}

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
