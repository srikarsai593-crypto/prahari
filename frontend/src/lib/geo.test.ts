import { describe, expect, it } from 'vitest';
import {
  distanceToSegment, haversineDistance, pathLengthKm, restrictedZonesOnPath, type Zone,
} from './geo';

/**
 * The route planner tells an operator "Safe corridor — 0 restricted hazard
 * zones crossed" and they authorise a traverse on that sentence. This is the
 * code behind it.
 */

const MAITRI = { lat: -70.767, lng: 11.731 };
const CAMP_ALPHA = { lat: -70.850, lng: 11.950 };

const CREVASSE: Zone = {
  id: 'gf-crevasse', name: 'Crevasse Zone', type: 'restricted',
  center_lat: -70.820, center_lng: 11.880, radius_m: 800,
};
const CAMP_FENCE: Zone = {
  id: 'gf-campa', name: 'Camp Alpha', type: 'field_camp',
  center_lat: -70.850, center_lng: 11.950, radius_m: 1500,
};

describe('haversineDistance', () => {
  it('is zero for a point against itself', () => {
    expect(haversineDistance(MAITRI, MAITRI)).toBeCloseTo(0, 6);
  });

  it('is symmetric', () => {
    expect(haversineDistance(MAITRI, CAMP_ALPHA))
      .toBeCloseTo(haversineDistance(CAMP_ALPHA, MAITRI), 6);
  });

  it('agrees with the known length of a degree of latitude', () => {
    expect(haversineDistance({ lat: 0, lng: 0 }, { lat: 1, lng: 0 }))
      .toBeCloseTo(111_195, -2);
  });

  it('matches the backend to the metre on the seeded corridor', () => {
    /**
     * Pinned against `backend/app/geo.py`, which returns 12.2171 km for this
     * leg. The two implementations are separate code in separate languages and
     * they have to agree: the console draws the route and quotes its length,
     * the station decides whether it crosses a hazard, and an operator reading
     * one while the other decides is how a traverse gets authorised on a
     * figure nobody checked.
     */
    expect(haversineDistance(MAITRI, CAMP_ALPHA) / 1000).toBeCloseTo(12.2171, 3);
  });

  it('matches the backend on a short east-west chord at polar latitude', () => {
    // Where a flat approximation diverges most: 0.1 degrees of longitude is
    // 3.65 km here and 11.1 km at the equator.
    expect(haversineDistance({ lat: -70.820, lng: 11.830 },
                             { lat: -70.820, lng: 11.930 }) / 1000)
      .toBeCloseTo(3.6532, 3);
  });
});

describe('distanceToSegment', () => {
  it('is zero for a point on the segment', () => {
    const midpoint = { lat: -70.8085, lng: 11.8405 };
    expect(distanceToSegment(midpoint, MAITRI, CAMP_ALPHA)).toBeLessThan(20);
  });

  it('clamps to the endpoint rather than the infinite line', () => {
    const a = { lat: -70.80, lng: 11.80 };
    const b = { lat: -70.81, lng: 11.81 };
    const beyond = { lat: -70.90, lng: 11.90 };
    expect(distanceToSegment(beyond, a, b))
      .toBeCloseTo(haversineDistance(beyond, b), -1);
  });

  it('does not divide by zero on a degenerate segment', () => {
    const point = { lat: -70.9, lng: 11.9 };
    expect(distanceToSegment(point, MAITRI, MAITRI))
      .toBeCloseTo(haversineDistance(point, MAITRI), -1);
  });
});

describe('restrictedZonesOnPath', () => {
  it('flags the straight Maitri corridor, which runs through the crevasse', () => {
    const crossed = restrictedZonesOnPath([MAITRI, CAMP_ALPHA], [CREVASSE, CAMP_FENCE]);
    expect(crossed.map((z) => z.name)).toEqual(['Crevasse Zone']);
  });

  it('clears a corridor routed around it', () => {
    const detour = [MAITRI, { lat: -70.8319, lng: 11.7550 }, CAMP_ALPHA];
    expect(restrictedZonesOnPath(detour, [CREVASSE, CAMP_FENCE])).toEqual([]);
  });

  it('ignores zones that are not restricted', () => {
    // The route ends inside Camp Alpha's own fence. A camp is a destination,
    // not a hazard; reporting it would train operators to ignore the warning.
    expect(restrictedZonesOnPath([MAITRI, CAMP_ALPHA], [CAMP_FENCE])).toEqual([]);
  });

  it('catches a chord that cuts a corner between two waypoints', () => {
    /**
     * The reason this measures segments rather than sampling points along the
     * path. Both endpoints sit outside the disc; the line between them passes
     * straight through it. A sampling check with coarse steps reports "safe".
     */
    const west = { lat: -70.820, lng: 11.830 };
    const east = { lat: -70.820, lng: 11.930 };
    expect(haversineDistance(west, { lat: CREVASSE.center_lat, lng: CREVASSE.center_lng }))
      .toBeGreaterThan(CREVASSE.radius_m);
    expect(haversineDistance(east, { lat: CREVASSE.center_lat, lng: CREVASSE.center_lng }))
      .toBeGreaterThan(CREVASSE.radius_m);
    expect(restrictedZonesOnPath([west, east], [CREVASSE])).toHaveLength(1);
  });

  it('is stricter than the backend sampling check, never looser', () => {
    /**
     * The console's verdict is advisory and the backend's pre-flight is
     * authoritative. They are allowed to disagree in exactly one direction: if
     * the console says clear, the backend must agree. Otherwise an operator is
     * told "safe corridor" and then authorised into a hazard.
     */
    const densify = (from: typeof MAITRI, to: typeof MAITRI, fixes = 8) =>
      Array.from({ length: fixes + 1 }, (_, i) => ({
        lat: from.lat + ((to.lat - from.lat) * i) / fixes,
        lng: from.lng + ((to.lng - from.lng) * i) / fixes,
      }));

    for (let offset = 0; offset <= 0.06; offset += 0.004) {
      const path = [MAITRI, { lat: -70.82 - offset, lng: 11.76 }, CAMP_ALPHA];
      const clientSaysClear = restrictedZonesOnPath(path, [CREVASSE]).length === 0;
      if (!clientSaysClear) continue;

      const sampled = [
        ...densify(path[0], path[1]),
        ...densify(path[1], path[2]).slice(1),
      ];
      const backendWouldFlag = sampled.some((fix) =>
        haversineDistance(fix, { lat: CREVASSE.center_lat, lng: CREVASSE.center_lng })
          <= CREVASSE.radius_m);
      expect(backendWouldFlag).toBe(false);
    }
  });

  it('treats a path with fewer than two points as nothing to check', () => {
    expect(restrictedZonesOnPath([], [CREVASSE])).toEqual([]);
    expect(restrictedZonesOnPath([MAITRI], [CREVASSE])).toEqual([]);
  });
});

describe('pathLengthKm', () => {
  it('is zero for a path that goes nowhere', () => {
    expect(pathLengthKm([])).toBe(0);
    expect(pathLengthKm([MAITRI])).toBe(0);
  });

  it('charges the operator for the detour', () => {
    // The dialog shows this figure, and a detour that reads as free is a
    // detour an operator has no reason to weigh.
    const direct = pathLengthKm([MAITRI, CAMP_ALPHA]);
    const detoured = pathLengthKm([MAITRI, { lat: -70.8319, lng: 11.7550 }, CAMP_ALPHA]);
    expect(detoured).toBeGreaterThan(direct);
  });
});
