/**
 * Fixed-width formatting shared by the documents Prahari generates.
 *
 * The post-incident debrief and the shift handover brief are different
 * artefacts for different readers, but they are both plain text on purpose:
 * they print from any machine at any station, survive being pasted into a
 * ticket or read over a link, and need no font, viewer or dependency that a
 * console at the end of a satellite hop might not have.
 *
 * They share these primitives so the two documents stay recognisably the
 * same family — a commander who has read one can read the other without
 * relearning where the figures are.
 */

export const RULE = '='.repeat(78);
export const THIN = '-'.repeat(78);

/** UTC throughout. Station logs are UTC and a report must not re-zone them. */
export const stamp = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? String(iso)
    : `${d.toISOString().slice(0, 19).replace('T', ' ')}Z`;
};

/** `label ....... value`, so the columns line up in a fixed-width viewer. */
export const row = (label: string, value: string | number | null | undefined): string =>
  `  ${(label + ' ').padEnd(30, '.')} ${value ?? '—'}`;

export const heading = (title: string): string => `\n${title}\n${THIN}`;

/** The masthead every generated document carries. */
export function masthead(title: string, subtitle: string): string[] {
  return [
    RULE,
    '  MINISTRY OF EARTH SCIENCES · GOVERNMENT OF INDIA',
    '  NATIONAL CENTRE FOR POLAR AND OCEAN RESEARCH (NCPOR)',
    '',
    `  ${title}`,
    `  ${subtitle}`,
    RULE,
    '',
  ];
}
