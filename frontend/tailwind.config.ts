import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        arctic: {
          50:  '#F5FAFE',
          100: '#E9F4FC',
          200: '#D5EBFB',
          300: '#B5DCF8',
          400: '#38BDF8',
          500: '#0284C7',
          600: '#0088CC',
          700: '#006B9F',
          800: '#1E3A5F',
          900: '#0F253E',
          950: '#081729',
        },
        frost: {
          card:   '#FFFFFF',
          border: '#E2EDF8',
          subtle: '#F4F8FC',
          accent: '#0088CC',
          muted:  '#64748B',
        },
        // Keep legacy semantic colors for functional badges
        safe:    '#22C55E',
        warning: '#F59E0B',
        danger:  '#EF4444',
        info:    '#3B82F6',
        neutral: '#94A3B8',
      },
      fontFamily: {
        sans:    ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        display: ['Outfit', 'Space Grotesk', 'sans-serif'],
        mono:    ['JetBrains Mono', 'monospace'],
      },
      boxShadow: {
        'card':   '0 8px 32px -4px rgba(0,136,204,0.08), 0 2px 8px -2px rgba(13,27,42,0.04)',
        'hover':  '0 16px 48px -6px rgba(0,136,204,0.14), 0 4px 12px -2px rgba(13,27,42,0.06)',
        'xs':     '0 1px 3px rgba(13,27,42,0.06)',
      },
    },
  },
  plugins: [],
};
export default config;
