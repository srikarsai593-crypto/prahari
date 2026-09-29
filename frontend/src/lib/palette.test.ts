import { describe, expect, it } from 'vitest';
import config from '../../tailwind.config';

/**
 * Every colour that carries text must clear WCAG AA.
 *
 * This existed as a one-off sweep of the running console, which found that
 * `frost.muted` sat at 4.43:1 on a white card, `nominal` at 3.51, `alert` at
 * 2.96 and white-on-`arctic-600` at 4.10 — all under the 4.5 small text
 * needs, on a console that ships a high-contrast theme and claims GIGW
 * conventions. A sweep catches that once. This catches it forever, and it
 * fails at the moment someone lightens a token rather than months later.
 */

type Rgb = { r: number; g: number; b: number };

const parse = (hex: string): Rgb => {
  const h = hex.replace('#', '');
  return { r: parseInt(h.slice(0, 2), 16),
           g: parseInt(h.slice(2, 4), 16),
           b: parseInt(h.slice(4, 6), 16) };
};

/** Relative luminance, per WCAG 2.x. */
const luminance = ({ r, g, b }: Rgb): number => {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

export const contrastRatio = (a: string, b: string): number => {
  const [hi, lo] = [luminance(parse(a)), luminance(parse(b))].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** Small text. Anything below this is a fail for body copy. */
const AA = 4.5;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const colors = (config.theme as any).extend.colors;

/** The three light surfaces text is set on. White is the harshest. */
const LIGHT_SURFACES = {
  card: '#ffffff',
  page: colors.ice.surface as string,
  inset: colors.frost.subtle as string,
  get marked() { return MARKED_SURFACE; },
};

/**
 * The pale wash a marked row sits on — the accessibility statement scrolls to
 * one line and tints it. Added because it is a fourth light surface, and text
 * that clears AA on white does not automatically clear it here.
 */
const MARKED_SURFACE = colors.arctic[50] as string;

/** The dark bands: the utility rail, the command header, the footer. */
const DARK_SURFACES = {
  navy: colors.navy.DEFAULT as string,
  command: colors.navy.command as string,
  deep: colors.navy.deep as string,
};

describe('the sanity of the reference implementation', () => {
  it('computes known ratios correctly', () => {
    // Black on white is exactly 21:1; a colour against itself is exactly 1.
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    // A published reference pair, so a broken formula cannot pass silently.
    expect(contrastRatio('#64748b', '#ffffff')).toBeCloseTo(4.76, 1);
  });
});

describe('text colours on light surfaces', () => {
  const onLight: Record<string, string> = {
    'body text (arctic.900)': colors.arctic[900],
    'muted body copy (frost.muted)': colors.frost.muted,
    'links and actions (arctic.600)': colors.arctic[600],
    'action hover (arctic.700)': colors.arctic[700],
    'nominal status': colors.nominal.DEFAULT,
    'alert status': colors.alert.DEFAULT,
    'emergency status': colors.emergency.DEFAULT,
  };

  for (const [name, hex] of Object.entries(onLight)) {
    it(`${name} clears AA on every light surface`, () => {
      for (const [surface, bg] of Object.entries(LIGHT_SURFACES)) {
        const ratio = contrastRatio(hex, bg);
        expect(ratio, `${name} ${hex} on ${surface} ${bg} is ${ratio.toFixed(2)}:1`)
          .toBeGreaterThanOrEqual(AA);
      }
    });
  }
});

describe('white text on solid fills', () => {
  /** Each of these is used as a button or badge background with white on it. */
  const fills: Record<string, string> = {
    'primary action (arctic.600)': colors.arctic[600],
    'action hover (arctic.700)': colors.arctic[700],
    'emergency': colors.emergency.DEFAULT,
    'alert': colors.alert.DEFAULT,
    'nominal': colors.nominal.DEFAULT,
  };

  for (const [name, hex] of Object.entries(fills)) {
    it(`white clears AA on ${name}`, () => {
      const ratio = contrastRatio('#ffffff', hex);
      expect(ratio, `white on ${name} ${hex} is ${ratio.toFixed(2)}:1`)
        .toBeGreaterThanOrEqual(AA);
    });
  }
});

describe('muted text on the dark bands', () => {
  /**
   * The opposite constraint, and the reason a single "muted" value cannot
   * serve both: darkening `frost.muted` until it passed on a white card took
   * it to 2.69:1 over the navy footer. The dark chrome uses slate-400.
   */
  it('slate-400 clears AA on every dark surface', () => {
    const slate400 = '#94a3b8';
    for (const [surface, bg] of Object.entries(DARK_SURFACES)) {
      const ratio = contrastRatio(slate400, bg);
      expect(ratio, `slate-400 on ${surface} ${bg} is ${ratio.toFixed(2)}:1`)
        .toBeGreaterThanOrEqual(AA);
    }
  });

  it('the light muted token would NOT pass there, which is why it is not used', () => {
    // Guards the reasoning, not just the outcome: if someone "simplifies"
    // the footer back to frost.muted, this says why that is wrong.
    expect(contrastRatio(colors.frost.muted, DARK_SURFACES.command)).toBeLessThan(AA);
  });
});

/** Hue angle in degrees. */
const hue = (hex: string): number => {
  const { r, g, b } = parse(hex);
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn), d = max - min;
  if (d === 0) return 0;
  const h = max === rn ? ((gn - bn) / d) % 6
    : max === gn ? (bn - rn) / d + 2
    : (rn - gn) / d + 4;
  return (h * 60 + 360) % 360;
};

const hueSeparation = (a: string, b: string): number => {
  const d = Math.abs(hue(a) - hue(b)) % 360;
  return Math.min(d, 360 - d);
};

describe('the status triad stays distinguishable', () => {
  /**
   * Contrast ratio is the wrong instrument here: all three were darkened
   * until they clear AA, which by construction puts their luminances close
   * together, so the ratio *between* them is near 1 and says nothing. What
   * separates them is hue.
   *
   * Amber and red are the close pair at 26° and always will be — that is
   * the nature of a warning/danger scale, and it is why status in this
   * console is never carried by colour alone: every chip has a word in it,
   * and the critical ones also have an icon.
   */
  it('keeps green well away from the warning end of the scale', () => {
    expect(hueSeparation(colors.nominal.DEFAULT, colors.alert.DEFAULT))
      .toBeGreaterThan(90);
    expect(hueSeparation(colors.nominal.DEFAULT, colors.emergency.DEFAULT))
      .toBeGreaterThan(90);
  });

  it('keeps amber and red apart enough to read as different', () => {
    expect(hueSeparation(colors.alert.DEFAULT, colors.emergency.DEFAULT))
      .toBeGreaterThan(15);
  });

  it('does not let darkening turn the triad into three browns', () => {
    // Saturation is what would go first if someone reached for a darker
    // shade by mixing in grey rather than moving down the ramp.
    for (const hex of [colors.nominal.DEFAULT, colors.alert.DEFAULT,
                       colors.emergency.DEFAULT]) {
      const { r, g, b } = parse(hex);
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      expect((max - min) / max, `${hex} is too desaturated to read as a status`)
        .toBeGreaterThan(0.5);
    }
  });
});


/**
 * A marked row in the accessibility statement, which the language control
 * scrolls to.
 *
 * The left accent bar is the only thing distinguishing it at a glance, so it
 * has to be *seen* — WCAG 1.4.11 asks 3:1 of a non-text element that carries
 * meaning. An earlier attempt used a hairline `arctic-200` ring, which came
 * out at 1.33:1 on a white card and was invisible.
 */
describe('the marked row in the accessibility statement', () => {
  it('has an accent bar that can be seen against its own wash', () => {
    const ratio = contrastRatio(colors.arctic[600], MARKED_SURFACE);
    expect(ratio, `accent bar on the marked wash is ${ratio.toFixed(2)}:1`)
      .toBeGreaterThanOrEqual(3);
  });

  it('has a wash that does not swallow the text it sits behind', () => {
    for (const [name, hex] of Object.entries({
      title: colors.arctic[900] as string,
      detail: colors.frost.muted as string,
    })) {
      const ratio = contrastRatio(hex, MARKED_SURFACE);
      expect(ratio, `${name} on the marked wash is ${ratio.toFixed(2)}:1`)
        .toBeGreaterThanOrEqual(AA);
    }
  });
});
