import { describe, expect, it } from 'vitest';
import { getStation, polarDaylight, seasonalNormal, STATIONS } from './stations';

/**
 * The header tells an operator whether the sun is going to rise today, and
 * that badge sits inline with live telemetry. If it is wrong it is worse than
 * absent, so the astronomy is pinned against dates whose answer is a matter of
 * fact rather than of this implementation.
 */

const MAITRI = getStation('Maitri');     // 70.8°S — inside the Antarctic circle
const BHARATI = getStation('Bharati');   // 69.4°S — just inside it
const HIMADRI = getStation('Himadri');   // 78.9°N — well inside the Arctic circle

const on = (iso: string) => new Date(`${iso}T12:00:00Z`);

describe('polarDaylight', () => {
  it('puts the Antarctic stations under midnight sun at the December solstice', () => {
    expect(polarDaylight(MAITRI, on('2026-12-21'))).toBe('midnight_sun');
    expect(polarDaylight(BHARATI, on('2026-12-21'))).toBe('midnight_sun');
  });

  it('puts them in polar night at the June solstice', () => {
    expect(polarDaylight(MAITRI, on('2026-06-21'))).toBe('polar_night');
    expect(polarDaylight(BHARATI, on('2026-06-21'))).toBe('polar_night');
  });

  // Himadri is the reason the rule is written against the sign of the
  // latitude rather than against the calendar: it is in the Arctic, so its
  // seasons are the mirror image of the other two stations'.
  it('mirrors the hemispheres — Himadri is opposite Maitri on both solstices', () => {
    expect(polarDaylight(HIMADRI, on('2026-06-21'))).toBe('midnight_sun');
    expect(polarDaylight(HIMADRI, on('2026-12-21'))).toBe('polar_night');
  });

  it('gives every station an ordinary day at the equinoxes', () => {
    for (const station of STATIONS) {
      expect(polarDaylight(station, on('2026-03-20'))).toBe('diurnal');
      expect(polarDaylight(station, on('2026-09-22'))).toBe('diurnal');
    }
  });

  /**
   * Bharati sits at 69.4°S, half a degree inside the Antarctic circle, so its
   * midnight-sun window is only a few weeks wide where Maitri's is months.
   * A rule that hard-coded "inside the circle means midnight sun in summer"
   * would pass every assertion above and still be wrong here.
   */
  it('gives the station nearest the circle a narrower midnight-sun window', () => {
    const days = (station: typeof MAITRI) => {
      let count = 0;
      for (let d = 0; d < 365; d++) {
        const date = new Date(Date.UTC(2026, 0, 1 + d, 12));
        if (polarDaylight(station, date) === 'midnight_sun') count++;
      }
      return count;
    };
    expect(days(BHARATI)).toBeGreaterThan(0);
    expect(days(BHARATI)).toBeLessThan(days(MAITRI));
  });
});

describe('seasonalNormal', () => {
  it('reads the summer normal when the sun leans towards the station', () => {
    expect(seasonalNormal(MAITRI, on('2026-12-21'))).toBe(MAITRI.normals.summer);
    expect(seasonalNormal(HIMADRI, on('2026-06-21'))).toBe(HIMADRI.normals.summer);
  });

  it('reads the winter normal when it leans away', () => {
    expect(seasonalNormal(MAITRI, on('2026-06-21'))).toBe(MAITRI.normals.winter);
    expect(seasonalNormal(HIMADRI, on('2026-12-21'))).toBe(HIMADRI.normals.winter);
  });

  it('reads the shoulder normal at the equinoxes', () => {
    expect(seasonalNormal(MAITRI, on('2026-03-20'))).toBe(MAITRI.normals.shoulder);
  });

  it('never reports summer as colder than winter at any station', () => {
    for (const station of STATIONS) {
      expect(station.normals.summer).toBeGreaterThan(station.normals.winter);
      expect(station.normals.shoulder).toBeGreaterThan(station.normals.winter);
      expect(station.normals.shoulder).toBeLessThan(station.normals.summer);
    }
  });
});
