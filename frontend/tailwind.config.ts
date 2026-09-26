import type { Config } from 'tailwindcss';

/**
 * PRAHARI design system — "Antarctic Operations Intelligence System".
 *
 * Institutional government-portal structure (GIGW 3.0 conventions: full-width
 * utility rail, emblem header, flat navigation band, dark statutory footer)
 * fused with an aerospace telemetry kit: crisp 1px slate borders, tight radii
 * and high-saturation functional accents instead of soft decorative shadows.
 *
 * `arctic` and `frost` are kept as the project-wide scale names — they are used
 * across every page — but their values now resolve to the portal palette, so a
 * single change here re-skins the whole console.
 */
const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // Primary scale: Ocean/Sky Polar Blue for action, Deep Navy Command for
        // authority. 600 is the interactive colour, 900 the body text colour.
        arctic: {
          50: '#f0f9ff',
          100: '#e0f2fe',  // active navigation pill
          200: '#bae6fd',  // focus ring
          300: '#7dd3fc',
          400: '#38bdf8',
          500: '#0ea5e9',
          600: '#0284c7',  // primary command action
          700: '#0369a1',  // action hover
          800: '#075985',
          900: '#0f172a',  // Deep Navy Command — headings and body text
          950: '#091c33',  // utility rail / footer
        },
        frost: {
          card: '#ffffff',
          border: '#e2e8f0',  // 1px structural card border
          subtle: '#f8fafc',  // recessed inset panels
          accent: '#0284c7',
          muted: '#64748b',
        },
        // Command surfaces — the dark planes: utility rail, hero, footer.
        navy: {
          DEFAULT: '#0f172a',
          deep: '#061324',
          panel: '#0b2545',
          command: '#091c33',
        },
        ice: {
          surface: '#f4f7fb',  // page canvas
          border: '#d2e0ee',
          subtle: '#e1eaf3',
        },
        // Status & telemetry spectrum. Each has base (text), fill (dot/border)
        // and tint (container) so a badge is built from one family.
        nominal: { DEFAULT: '#059669', fill: '#10b981', tint: '#ecfdf5', edge: '#a7f3d0' },
        alert: { DEFAULT: '#d97706', fill: '#f59e0b', tint: '#fffbeb', edge: '#fde68a' },
        emergency: { DEFAULT: '#dc2626', fill: '#ef4444', tint: '#fef2f2', edge: '#fca5a5' },

        // Legacy semantic aliases still referenced by map markers.
        safe: '#10b981',
        warning: '#f59e0b',
        danger: '#ef4444',
        info: '#0284c7',
      },
      fontFamily: {
        // Industrial sans for prose, monospace for every coordinate, ID code,
        // timestamp and telemetry figure (tabular alignment under field glare).
        sans: ['var(--font-inter)', 'Inter', 'Segoe UI', 'system-ui', 'sans-serif'],
        display: ['var(--font-inter)', 'Inter', 'Segoe UI', 'system-ui', 'sans-serif'],
        mono: ['var(--font-jetbrains)', 'JetBrains Mono', 'Consolas', 'monospace'],
        // Figures an operator reads off the console — coordinates, ΔT, counts.
        telemetry: ['var(--font-telemetry)', 'IBM Plex Mono', 'Consolas', 'monospace'],
      },
      // Every size is rem so the GovRail A- / A / A+ control, which scales the
      // root font size, actually moves the whole console. The px equivalents
      // assume the default 16px root.
      //
      // 2xs (11px) is the floor for labels and overlines; nothing that carries
      // a coordinate, a timestamp or a telemetry value goes below xs (12px).
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],       // 11px — labels only
        '13': ['0.8125rem', { lineHeight: '1.15rem' }],     // 13px
        '15': ['0.9375rem', { lineHeight: '1.45rem' }],     // 15px
        '17': ['1.0625rem', { lineHeight: '1.55rem' }],     // 17px
        '28': ['1.75rem', { lineHeight: '2.1rem' }],        // 28px
      },
      // Controlled, institutional corner language — the previous 16–24px radii
      // read as consumer-app. Existing `rounded-xl`/`rounded-2xl` usages across
      // the pages resolve to these tighter values automatically.
      borderRadius: {
        none: '0',
        sm: '2px',
        DEFAULT: '4px',
        md: '6px',
        lg: '8px',
        xl: '8px',
        '2xl': '10px',
        '3xl': '12px',
        full: '9999px',
      },
      boxShadow: {
        // Structural clarity over fuzzy depth: readable in bright command
        // rooms and in outdoor glare.
        card: '0 1px 3px 0 rgba(15,23,42,0.05), 0 1px 2px -1px rgba(15,23,42,0.03)',
        raised: '0 4px 6px -1px rgba(15,23,42,0.08)',
        hover: '0 4px 6px -1px rgba(15,23,42,0.08)',
        xs: '0 1px 2px 0 rgba(15,23,42,0.04)',
        rail: '0 1px 0 0 rgba(15,23,42,0.06)',
      },
      letterSpacing: {
        caps: '0.08em',
      },
      maxWidth: {
        portal: '1440px',
      },
    },
  },
  plugins: [],
};
export default config;
