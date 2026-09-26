/**
 * The PRAHARI mark — a six-armed snowflake that turns slowly inside a
 * breathing halo.
 *
 * The spin and the halo live in globals.css (`snowSpin`, `haloBreath`) so they
 * can be switched off wholesale under `prefers-reduced-motion`. Both are
 * decorative, so the whole thing is hidden from assistive technology and the
 * surrounding link carries the accessible name.
 */

export interface PrahariLogoProps {
  /** Rendered size of the snowflake in px. The halo scales with it. */
  size?: number;
  /** Colour of the snowflake — inherits `currentColor` by default. */
  className?: string;
  /** Drop the halo ring (tight spaces, e.g. inside the header's navy square). */
  halo?: boolean;
}

export function PrahariLogo({ size = 56, className = '', halo = true }: PrahariLogoProps) {
  return (
    <span
      className="snowflake-hero-wrapper"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {halo && <span className="snowflake-halo" />}
      <svg
        className={`snowflake-svg-element ${className}`}
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        viewBox="0 0 24 24"
        role="presentation"
        focusable="false"
      >
        <line x1="12" x2="12" y1="2" y2="22" />
        <line x1="2" x2="22" y1="12" y2="12" />
        <line x1="4.93" x2="19.07" y1="4.93" y2="19.07" />
        <line x1="19.07" x2="4.93" y1="4.93" y2="19.07" />
        <path d="M12 4.5l-2.5-2.5m5 0L12 4.5M12 19.5l-2.5 2.5m5 0L12 19.5M4.5 12L2 9.5m0 5L4.5 12M19.5 12L22 9.5m0 5L19.5 12" />
        <circle cx="12" cy="12" r="2" fill="currentColor" />
      </svg>
    </span>
  );
}
