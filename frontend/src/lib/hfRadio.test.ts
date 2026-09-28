import { describe, expect, it } from 'vitest';
import {
  ITA2_PRINTABLE, checkGroup, dateTimeGroup, encodeResupply, encodeSitrep, encodeSos,
  formatPosition, groupCount, isIta2Safe, renderRadiogram, toIta2Safe,
} from './hfRadio';

/**
 * These messages are read aloud over a noisy link by someone writing them
 * down. Two properties carry all the weight: every character must be one the
 * mode can actually carry, and a miscopy must be detectable.
 */

const AT = new Date('2026-09-28T14:32:00Z');

describe('the ITA2 character set', () => {
  it('upper-cases, because the alphabet has no lower case at all', () => {
    expect(toIta2Safe('Maitri Base')).toBe('MAITRI BASE');
  });

  it('spells out the symbols the console actually prints', () => {
    // These are not hypothetical: a cold-chain reading is -18°C and a
    // blizzard load is written ΔT throughout the console.
    expect(toIta2Safe('-18°C')).toBe('-18 DEG C');
    expect(toIta2Safe('ΔT +12')).toBe('DELTA T +12');
    expect(toIta2Safe('₹40000')).toBe('INR 40000');
    expect(toIta2Safe('fuel & food')).toBe('FUEL AND FOOD');
    expect(toIta2Safe('90% cover')).toBe('90 PCT COVER');
  });

  it('strips accents to the base letter rather than losing the word', () => {
    expect(toIta2Safe('Nuñez')).toBe('NUNEZ');
    expect(toIta2Safe('Ny-Ålesund')).toBe('NY-ALESUND');
  });

  it('flattens the dashes the console sets in prose', () => {
    expect(toIta2Safe('Maitri — Bharati')).toBe('MAITRI - BHARATI');
  });

  it('leaves a space where a character could not be carried, never a join', () => {
    /** A visible gap can be queried by the operator reading it back; two
     *  words silently fused into one cannot. */
    expect(toIta2Safe('a☃b')).toBe('A B');
  });

  it('collapses the whitespace it creates', () => {
    expect(toIta2Safe('  fuel \n\n  drum  ')).toBe('FUEL DRUM');
  });

  it('passes its own output', () => {
    const messy = 'Dr. Priya Sharma — 40°C, ΔT +12 (Maitri) #3 @ 90%';
    expect(ITA2_PRINTABLE.test(toIta2Safe(messy))).toBe(true);
  });

  it('is idempotent', () => {
    const once = toIta2Safe('Ny-Ålesund −18°C');
    expect(toIta2Safe(once)).toBe(once);
  });
});

describe('the check group', () => {
  it('counts words for the operator to recount', () => {
    expect(groupCount('SOS DISTRESS OP R KUMAR')).toBe(5);
    expect(groupCount('')).toBe(0);
  });

  it('changes when a single character is miscopied', () => {
    // The failure this exists for: one wrong digit in a position.
    expect(checkGroup('POS 7046.0S 01143.8E'))
      .not.toBe(checkGroup('POS 7046.0S 01143.9E'));
  });

  it('changes when two characters are transposed', () => {
    /** A plain sum would not catch this, which is why the sum is
     *  positionally weighted. */
    expect(checkGroup('QTY 4030 L')).not.toBe(checkGroup('QTY 4003 L'));
  });

  it('is always two characters, so it fits a fixed column', () => {
    for (const body of ['', 'A', 'SOS DISTRESS', 'X'.repeat(500)]) {
      expect(checkGroup(body)).toHaveLength(2);
    }
  });

  it('is itself carriable over the link', () => {
    for (const body of ['A', 'SOS', 'X'.repeat(97), 'POS 7046.0S 01143.8E']) {
      expect(ITA2_PRINTABLE.test(checkGroup(body))).toBe(true);
    }
  });
});

describe('position format', () => {
  it('renders degrees and decimal minutes with a hemisphere', () => {
    // Maitri, on the Schirmacher Oasis.
    expect(formatPosition(-70.767, 11.731)).toBe('7046.0S 01143.9E');
  });

  it('pads longitude to three degree digits so the columns hold', () => {
    /** Without the pad, a single-digit longitude shifts every following
     *  character on the transcription form. */
    expect(formatPosition(-70.5, 5.25)).toBe('7030.0S 00515.0E');
  });

  it('carries both hemispheres', () => {
    expect(formatPosition(78.923, -11.923)).toBe('7855.4N 01155.4W');
  });

  it('handles the equator and prime meridian as positive', () => {
    expect(formatPosition(0, 0)).toBe('0000.0N 00000.0E');
  });
});

describe('the date-time group', () => {
  it('is UTC, zero-padded, with a Z', () => {
    expect(dateTimeGroup(AT)).toBe('28SEP26 1432Z');
  });

  it('pads a single-digit day and a midnight hour', () => {
    expect(dateTimeGroup(new Date('2026-01-05T00:07:00Z'))).toBe('05JAN26 0007Z');
  });
});

describe('message assembly', () => {
  const sample = () => renderRadiogram({
    kind: 'SITREP', from: 'Maitri', precedence: 'ROUTINE', when: AT,
    lines: [['PAX', '40 TOTAL'], ['NOTE', 'all quiet']],
  });

  it('opens and closes with the teleprinter prosigns', () => {
    const message = sample();
    expect(message.split('\n')[0]).toBe('ZCZC PRAHARI SITREP');
    expect(message.endsWith('\nNNNN')).toBe(true);
  });

  it('names the originating station after DE', () => {
    expect(sample()).toContain('DE MAITRI');
  });

  it('keeps the fields in the order given', () => {
    const message = sample();
    expect(message.indexOf('PAX')).toBeLessThan(message.indexOf('NOTE'));
  });

  it('drops an empty field rather than sending a bare label', () => {
    const message = renderRadiogram({
      kind: 'SITREP', from: 'Maitri', precedence: 'ROUTINE', when: AT,
      lines: [['', ''], ['PAX', '40']],
    });
    expect(message).not.toMatch(/^\s*$/m);
    expect(message).toContain('PAX 40');
  });

  it('computes the check over the body, not the header', () => {
    /**
     * Re-sending the same content an hour later must produce the same
     * check, or an operator comparing two copies cannot tell whether the
     * content matched or only the clock moved.
     */
    const later = new Date('2026-09-28T15:32:00Z');
    const line = (when: Date) => renderRadiogram({
      kind: 'SITREP', from: 'Maitri', precedence: 'ROUTINE', when,
      lines: [['PAX', '40 TOTAL']],
    }).split('\n').find((l) => l.startsWith('CK '));
    expect(line(AT)).toBe(line(later));
  });

  it('is entirely carriable, whatever went in', () => {
    const message = renderRadiogram({
      kind: 'SITREP', from: 'Maitri — Schirmacher', precedence: 'ROUTINE', when: AT,
      lines: [['ΔT', '+12°C'], ['OP', 'Dr. Nuñez']],
    });
    expect(isIta2Safe(message)).toBe(true);
  });
});

describe('SOS', () => {
  const sos = (over = {}) => encodeSos({
    station: 'Maitri', operatorName: 'Dr. Priya Sharma',
    lat: -70.767, lng: 11.731, when: AT, ...over,
  });

  it('goes out at FLASH precedence', () => {
    expect(sos()).toContain('FLASH 28SEP26 1432Z');
  });

  it('carries who is in trouble and where', () => {
    const message = sos();
    expect(message).toContain('OP DR. PRIYA SHARMA');
    expect(message).toContain('POS 7046.0S 01143.9E');
  });

  it('says the position is unknown rather than inventing one', () => {
    /** A fabricated position is worse than no position: it sends a search
     *  to the wrong place. */
    const message = sos({ lat: null, lng: null });
    expect(message).toContain('POS UNKNOWN');
    expect(message).not.toMatch(/POS \d/);
  });

  it('asks for acknowledgement, because nothing else here can', () => {
    expect(sos()).toContain('ACK REQUIRED');
  });

  it('carries a note when there is one and omits the label when there is not', () => {
    expect(sos({ note: 'crevasse fall, leg injury' }))
      .toContain('INFO CREVASSE FALL, LEG INJURY');
    expect(sos({ note: '   ' })).not.toContain('INFO');
  });

  it('survives a name the alphabet cannot carry', () => {
    expect(isIta2Safe(sos({ operatorName: 'Ángel Nuñez-Söderberg' }))).toBe(true);
  });
});

describe('stores demand', () => {
  it('goes PRIORITY normally and IMMEDIATE when urgent', () => {
    const base = { station: 'Bharati', itemName: 'Diesel', quantity: 4000,
                   unit: 'L', when: AT };
    expect(encodeResupply(base)).toContain('PRIORITY');
    expect(encodeResupply({ ...base, urgent: true })).toContain('IMMEDIATE');
  });

  it('states the item, the quantity and the cover left', () => {
    const message = encodeResupply({ station: 'Bharati', itemName: 'Aviation Turbine Fuel',
                                     quantity: 4000, unit: 'L', daysCover: 6.4, when: AT });
    expect(message).toContain('ITEM AVIATION TURBINE FUEL');
    expect(message).toContain('QTY 4000 L');
    expect(message).toContain('COVER 6 DAYS');
  });

  it('omits cover entirely when the console does not know it', () => {
    const message = encodeResupply({ station: 'Bharati', itemName: 'Diesel',
                                     quantity: 100, unit: 'L', daysCover: null, when: AT });
    expect(message).not.toContain('COVER');
  });

  it('reports exhausted cover as zero rather than a negative', () => {
    const message = encodeResupply({ station: 'Bharati', itemName: 'Diesel', quantity: 100,
                                     unit: 'L', daysCover: -3, when: AT });
    expect(message).toContain('COVER 0 DAYS');
  });

  it('falls back to UNITS for an item with no unit', () => {
    expect(encodeResupply({ station: 'Bharati', itemName: 'Rations', quantity: 12,
                            unit: null, when: AT })).toContain('QTY 12 UNITS');
  });
});

describe('SITREP', () => {
  const base = { station: 'Maitri', personnelTotal: 40, personnelOut: 6,
                 unaccounted: 0, activeIncidents: 0, criticalStockItems: 2, when: AT };

  it('is ROUTINE when the station is quiet', () => {
    expect(encodeSitrep(base)).toContain('ROUTINE');
  });

  it('is raised to IMMEDIATE by an unaccounted person', () => {
    expect(encodeSitrep({ ...base, unaccounted: 1 })).toContain('IMMEDIATE');
  });

  it('is raised to IMMEDIATE by a live incident', () => {
    expect(encodeSitrep({ ...base, activeIncidents: 1 })).toContain('IMMEDIATE');
  });

  it('reports the head-count as totals, not as a roster', () => {
    const message = encodeSitrep(base);
    expect(message).toContain('PAX 40 TOTAL 6 FIELD');
    expect(message).toContain('UNACCOUNTED 0');
  });
});
