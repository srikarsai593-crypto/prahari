/**
 * The one coordinate rendering in the console.
 *
 * Before this, the same position was printed three different ways — degrees-
 * minutes in the portal chrome, signed decimals in the movement dialog, and
 * unsigned decimals with a hemisphere letter on the personnel cards — so two
 * screens showing the same field position did not look like the same number.
 *
 * Format is degrees-minutes with a hemisphere letter, on the telemetry face
 * with tabular numerals so a column of positions aligns digit for digit. Pass
 * `decimals` where the exact figure matters (personnel cards, movement
 * authorisation) to print the decimal degrees underneath.
 *
 * Sizing is inherited: `.coordinate` floors at the 12px telemetry minimum but
 * follows a larger parent, so callers set the size on the surrounding block.
 */

export interface CoordinateProps {
  lat: number | null | undefined;
  lng: number | null | undefined;
  /** Also print decimal degrees underneath, for precision contexts. */
  decimals?: boolean;
  /** Decimal places for the `decimals` line. */
  precision?: number;
  /** Shown when either value is missing. */
  fallback?: string;
  className?: string;
}

/** Degrees-minutes with a hemisphere letter, e.g. "70°46' S". */
export function formatDegreesMinutes(value: number, axis: 'lat' | 'lng'): string {
  const hemisphere = axis === 'lat' ? (value < 0 ? 'S' : 'N') : (value < 0 ? 'W' : 'E');
  const abs = Math.abs(value);
  const degrees = Math.floor(abs);
  const minutes = Math.round((abs - degrees) * 60);
  // 59.6' rounds to 60' — carry into the degree rather than printing 60'.
  const [d, m] = minutes === 60 ? [degrees + 1, 0] : [degrees, minutes];
  return `${d}°${String(m).padStart(2, '0')}' ${hemisphere}`;
}

/** Decimal degrees with a hemisphere letter, e.g. "70.7670° S". */
export function formatDecimalDegrees(value: number, axis: 'lat' | 'lng', precision = 4): string {
  const hemisphere = axis === 'lat' ? (value < 0 ? 'S' : 'N') : (value < 0 ? 'W' : 'E');
  return `${Math.abs(value).toFixed(precision)}° ${hemisphere}`;
}

export function Coordinate({
  lat, lng, decimals = false, precision = 4, fallback = '—', className = '',
}: CoordinateProps) {
  if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) {
    return <span className={`coordinate ${className}`}>{fallback}</span>;
  }

  const dm = `${formatDegreesMinutes(lat, 'lat')}, ${formatDegreesMinutes(lng, 'lng')}`;
  const dd = `${formatDecimalDegrees(lat, 'lat', precision)}, ${formatDecimalDegrees(lng, 'lng', precision)}`;

  if (!decimals) {
    // The machine-readable value stays on the element for copy/paste and for
    // anything reading the DOM, without cluttering the rendered line.
    return <span className={`coordinate ${className}`} title={dd}>{dm}</span>;
  }

  return (
    <span className={`inline-flex flex-col leading-tight ${className}`}>
      <span className="coordinate">{dm}</span>
      <span className="coordinate-decimals">{dd}</span>
    </span>
  );
}
