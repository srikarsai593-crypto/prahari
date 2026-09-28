/**
 * HF radio traffic — the rung below the offline queue.
 *
 * Prahari's offline story stops at one assumption: that the link comes back.
 * The queue holds work on the handset and drains when it does. If the
 * satellite terminal itself is down — a failed modem, a collapsed dish, a
 * winter storm on the antenna — the queue holds forever and the station is
 * left with what Antarctic stations have always fallen back on, which is HF
 * radio to the next station or to the ship.
 *
 * You cannot put JSON over that. What you can do is hand the radio operator
 * a short, unambiguous block of text to key or to read aloud, and that is
 * all this module produces.
 *
 * ## On "compression"
 *
 * This does not compress anything, and it is worth being plain about that,
 * because it would be easy to claim otherwise. ITA2 — the five-bit
 * Baudot-Murray alphabet a teleprinter actually carries — is a *character
 * set*, not a compressor: it is narrower than ASCII, not denser. The useful
 * work here is the opposite of compression:
 *
 *   * **Restrict** the text to characters the mode can carry at all. ITA2
 *     has no lower case, no `°`, no `Δ`, no em dash, and the console's own
 *     copy is full of all three.
 *   * **Fix the field order**, so a receiving operator can transcribe onto a
 *     form without having to parse prose.
 *   * **Attach a check**, so a message that arrives corrupted is *known* to
 *     have arrived corrupted. Over HF that is the difference that matters:
 *     a miscopied digit in a position report is worse than no position.
 *
 * The prosigns are the real ones. `ZCZC` and `NNNN` start and end a
 * teleprinter message on the aeronautical fixed service; `DE` means "from";
 * `NR` is the message number; `CK` is the check. A radio operator at a polar
 * station will recognise the shape of this without being taught it.
 */

/**
 * The printable ITA2 repertoire, in both shifts.
 *
 * Letters shift gives A–Z and space. Figures shift gives the digits and this
 * punctuation. Anything outside the union cannot be sent, so anything
 * outside it has to be transliterated before it gets here.
 */
export const ITA2_PRINTABLE = /^[A-Z0-9 \-?:().,'=/+]*$/;

/**
 * Characters the console actually emits that ITA2 cannot carry.
 *
 * Every entry is here because it appears in real Prahari copy — `°C` on a
 * cold-chain reading, `ΔT` on a blizzard load, the em dashes in station
 * labels, `₹` on a purchase order. Mapping them explicitly beats dropping
 * them: `MINUS 40 DEG C` survives a radio link, `MINUS 40 C` reads like a
 * typo, and `-40°C` arrives as `-40C` or as garbage depending on the
 * equipment.
 */
const TRANSLITERATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[‘’‛]/g, "'"],      // curly single quotes
  [/[“”]/g, "'"],            // curly double quotes -> ITA2 has no "
  [/["]/g, "'"],
  [/[–—−_]/g, '-'],     // en/em dash, minus sign, underscore
  [/[…]/g, '.'],                  // ellipsis
  [/°/g, ' DEG '],
  [/Δ/g, ' DELTA '],              // the blizzard load is written as ΔT
  [/₹/g, ' INR '],
  [/[$]/g, ' USD '],
  [/&/g, ' AND '],
  [/%/g, ' PCT '],
  [/@/g, ' AT '],
  [/#/g, ' NR '],
  [/[;]/g, ','],
  [/[!]/g, '.'],
  [/[*~^`|\\]/g, ' '],
  [/[<[{]/g, '('],
  [/[>\]}]/g, ')'],
];

/**
 * Force arbitrary console text into something a teleprinter can carry.
 *
 * Accents are stripped by decomposing and dropping the combining marks, so a
 * name like "Nuñez" goes out as NUNEZ rather than as a hole in the message.
 * Whatever is still unrepresentable after that becomes a space rather than
 * being deleted: a gap is visible to the operator reading it back, a silent
 * deletion is not.
 */
export function toIta2Safe(input: string): string {
  let out = input.normalize('NFD').replace(/[̀-ͯ]/g, '');
  for (const [pattern, replacement] of TRANSLITERATIONS) out = out.replace(pattern, replacement);
  return out
    .toUpperCase()
    .replace(/[^A-Z0-9 \-?:().,'=/+]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Words in the body — the classic radiogram "check", counted by the sender
 *  and recounted by the receiver. */
export const groupCount = (body: string): number =>
  body.split(/\s+/).filter(Boolean).length;

/**
 * A two-character check group over the body.
 *
 * The word count catches a dropped or invented word; it does not catch a
 * miscopied character inside one, which over HF is the common failure and
 * the dangerous one in a position report. This is a positional sum, so
 * transposing two characters changes it — a plain sum would not.
 *
 * Base 36 and two characters wide, because the operator has to read it
 * aloud and write it down. It is a transcription check, not a cryptographic
 * one: it detects accident, and is not meant to resist anyone.
 */
export function checkGroup(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i += 1) sum += body.charCodeAt(i) * (i + 1);
  return (sum % 1296).toString(36).toUpperCase().padStart(2, '0');
}

// ── Position ───────────────────────────────────────────────────────────────

/**
 * Degrees and decimal minutes with a hemisphere suffix — `7046.0S 01143.9E` is Maitri.
 *
 * The standard maritime and aeronautical position format, and the one a
 * polar radio operator will already be writing on a form. Latitude is padded
 * to two degree digits and longitude to three, so the fields stay in fixed
 * columns even at single-digit longitudes; without that, a copied position
 * loses its column alignment and becomes ambiguous.
 */
export function formatPosition(lat: number, lng: number): string {
  const part = (value: number, degreeDigits: number, positive: string, negative: string) => {
    const hemisphere = value >= 0 ? positive : negative;
    const absolute = Math.abs(value);
    const degrees = Math.floor(absolute);
    const minutes = (absolute - degrees) * 60;
    return `${String(degrees).padStart(degreeDigits, '0')}`
      + `${minutes.toFixed(1).padStart(4, '0')}${hemisphere}`;
  };
  return `${part(lat, 2, 'N', 'S')} ${part(lng, 3, 'E', 'W')}`;
}

/** `28SEP26 1432Z` — the date-time group, always UTC. */
export function dateTimeGroup(when: Date): string {
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
                  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const dd = String(when.getUTCDate()).padStart(2, '0');
  const mon = months[when.getUTCMonth()];
  const yy = String(when.getUTCFullYear()).slice(-2);
  const hh = String(when.getUTCHours()).padStart(2, '0');
  const mm = String(when.getUTCMinutes()).padStart(2, '0');
  return `${dd}${mon}${yy} ${hh}${mm}Z`;
}

// ── Message assembly ───────────────────────────────────────────────────────

export interface RadiogramFields {
  /** SOS, SITREP, LOGREQ — what the receiving station is being handed. */
  kind: string;
  /** Originating station. */
  from: string;
  /** Precedence, in the usual order: ROUTINE, PRIORITY, IMMEDIATE, FLASH. */
  precedence: 'ROUTINE' | 'PRIORITY' | 'IMMEDIATE' | 'FLASH';
  when: Date;
  /** Ordered `LABEL: value` lines. Order is the format; do not sort them. */
  lines: ReadonlyArray<readonly [string, string]>;
}

/**
 * Assemble the block the radio operator is handed.
 *
 * The check is computed over the body only — the lines between the header
 * and `CK` — so that re-sending the same content at a different time does
 * not change it. An operator comparing two copies of a message is asking
 * whether the *content* matched, not whether the clock did.
 */
export function renderRadiogram(fields: RadiogramFields): string {
  const body = fields.lines
    .map(([label, value]) => `${toIta2Safe(label)} ${toIta2Safe(value)}`.trim())
    .filter((line) => line.length > 0);

  const bodyText = body.join(' ');
  const header = [
    `ZCZC PRAHARI ${toIta2Safe(fields.kind)}`,
    `DE ${toIta2Safe(fields.from)}`,
    `${fields.precedence} ${dateTimeGroup(fields.when)}`,
  ];
  const footer = [`CK ${groupCount(bodyText)} ${checkGroup(bodyText)}`, 'NNNN'];

  return [...header, ...body, ...footer].join('\n');
}

/** Whether a rendered message is carriable as-is. Used by the tests, and
 *  worth asserting on anything new that grows a message. */
export const isIta2Safe = (message: string): boolean =>
  message.split('\n').every((line) => ITA2_PRINTABLE.test(line));

// ── The messages Prahari actually sends ────────────────────────────────────

export interface SosMessage {
  station: string;
  operatorName: string;
  lat: number | null;
  lng: number | null;
  /** What the operator can say about it, if anything. */
  note?: string | null;
  when?: Date;
}

/**
 * The one that matters.
 *
 * Field mode already tells an operator whose SOS could not be sent to raise
 * the alarm by radio. Before this, it told them that and handed them
 * nothing — leaving somebody in trouble to compose a position report from
 * memory. This is what they read out.
 */
export function encodeSos(message: SosMessage): string {
  const lines: Array<readonly [string, string]> = [
    ['SOS', 'DISTRESS'],
    ['OP', message.operatorName],
    ['POS', message.lat !== null && message.lng !== null
      ? formatPosition(message.lat, message.lng)
      : 'UNKNOWN LAST SEEN AT STN'],
  ];
  if (message.note?.trim()) lines.push(['INFO', message.note]);
  lines.push(['ACK', 'REQUIRED']);

  return renderRadiogram({
    kind: 'SOS',
    from: message.station,
    precedence: 'FLASH',
    when: message.when ?? new Date(),
    lines,
  });
}

export interface ResupplyMessage {
  station: string;
  itemName: string;
  quantity: number;
  unit: string | null;
  /** Days of cover remaining, if the console knows. */
  daysCover?: number | null;
  urgent?: boolean;
  when?: Date;
}

/** A stores demand, for when the console cannot raise the supplying station. */
export function encodeResupply(message: ResupplyMessage): string {
  const lines: Array<readonly [string, string]> = [
    ['REQ', 'STORES'],
    ['ITEM', message.itemName],
    ['QTY', `${message.quantity} ${message.unit ?? 'UNITS'}`],
  ];
  if (message.daysCover !== null && message.daysCover !== undefined) {
    lines.push(['COVER', `${Math.max(0, Math.round(message.daysCover))} DAYS`]);
  }
  lines.push(['ACK', 'REQUIRED']);

  return renderRadiogram({
    kind: 'LOGREQ',
    from: message.station,
    precedence: message.urgent ? 'IMMEDIATE' : 'PRIORITY',
    when: message.when ?? new Date(),
    lines,
  });
}

export interface SitrepMessage {
  station: string;
  personnelTotal: number;
  personnelOut: number;
  unaccounted: number;
  activeIncidents: number;
  criticalStockItems: number;
  note?: string | null;
  when?: Date;
}

/**
 * The periodic situation report a station owes while it is out of contact.
 *
 * Deliberately only counts. A SITREP is read over a noisy link by someone
 * writing it down, and every extra field is another chance to miscopy the
 * one that mattered.
 */
export function encodeSitrep(message: SitrepMessage): string {
  const lines: Array<readonly [string, string]> = [
    ['SITREP', 'STATION STATUS'],
    ['PAX', `${message.personnelTotal} TOTAL ${message.personnelOut} FIELD`],
    ['UNACCOUNTED', String(message.unaccounted)],
    ['INCIDENTS', String(message.activeIncidents)],
    ['STORES CRIT', String(message.criticalStockItems)],
  ];
  if (message.note?.trim()) lines.push(['INFO', message.note]);

  return renderRadiogram({
    kind: 'SITREP',
    from: message.station,
    // An unaccounted person makes a routine report an urgent one.
    precedence: message.unaccounted > 0 || message.activeIncidents > 0
      ? 'IMMEDIATE' : 'ROUTINE',
    when: message.when ?? new Date(),
    lines,
  });
}
