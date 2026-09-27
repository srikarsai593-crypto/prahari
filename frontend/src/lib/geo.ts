/**
 * Geodesy helpers for the browser, mirroring backend/app/geo.py.
 *
 * The route planner needs to answer "does this path clip that circle?" while
 * the operator is still dragging a waypoint — a round trip per drag would make
 * the editor unusable, and the backend's pre-flight check remains the
 * authority at submit time either way.
 */

const EARTH_RADIUS_M = 6371000;

export interface Point { lat: number; lng: number }

export function haversineDistance(a: Point, b: Point): number {
  const phi1 = (a.lat * Math.PI) / 180;
  const phi2 = (b.lat * Math.PI) / 180;
  const dPhi = ((b.lat - a.lat) * Math.PI) / 180;
  const dLambda = ((b.lng - a.lng) * Math.PI) / 180;
  const h = Math.sin(dPhi / 2) ** 2
    + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  const clamped = Math.min(1, Math.max(0, h));
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(clamped), Math.sqrt(1 - clamped));
}

/** Equirectangular projection to local metres — valid over a traverse leg, and
 *  it keeps the segment maths in ordinary Euclidean space. */
function localXY(p: Point, latRef: number): [number, number] {
  return [
    (p.lng * Math.PI / 180) * Math.cos((latRef * Math.PI) / 180) * EARTH_RADIUS_M,
    (p.lat * Math.PI / 180) * EARTH_RADIUS_M,
  ];
}

/** Perpendicular distance from a point to the segment a–b, in metres. */
export function distanceToSegment(point: Point, a: Point, b: Point): number {
  const latRef = (a.lat + b.lat) / 2;
  const [px, py] = localXY(point, latRef);
  const [ax, ay] = localXY(a, latRef);
  const [bx, by] = localXY(b, latRef);

  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return haversineDistance(point, a);

  // Clamped so the foot of the perpendicular stays on the segment rather than
  // running off its extension.
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export interface Zone { id: string; name: string; center_lat: number; center_lng: number;
                        radius_m: number; type: string }

/**
 * Restricted zones the path actually enters.
 *
 * Measured against the path's *segments*, not sampled points along it. Point
 * sampling misses a chord that cuts a corner of the circle between two
 * samples; segment distance cannot. That makes this strictly stricter than the
 * backend's sampled pre-flight check, so a path this reports as clear will
 * also clear there — never the other way round.
 */
export function restrictedZonesOnPath(path: Point[], zones: Zone[]): Zone[] {
  if (path.length < 2) return [];
  return zones.filter((zone) => {
    if (zone.type !== 'restricted') return false;
    const centre = { lat: zone.center_lat, lng: zone.center_lng };
    for (let i = 0; i < path.length - 1; i += 1) {
      if (distanceToSegment(centre, path[i], path[i + 1]) <= zone.radius_m) return true;
    }
    return false;
  });
}

/** Total path length in kilometres. */
export function pathLengthKm(path: Point[]): number {
  let total = 0;
  for (let i = 0; i < path.length - 1; i += 1) total += haversineDistance(path[i], path[i + 1]);
  return total / 1000;
}
