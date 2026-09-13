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
        polar: {
          50: '#F5FAFD',
          100: '#EBF5FC',
          200: '#D8EDF9',
          300: '#B0DAF5',
          400: '#7BC0ED',
          500: '#4A9FD9',
          600: '#2D7BB5',
          700: '#1F5C8B',
          800: '#0F3A5C',
          900: '#0A2540',
          950: '#061525',
        },
        safe: '#22C55E',
        warning: '#F59E0B',
        danger: '#EF4444',
        info: '#3B82F6',
        neutral: '#94A3B8',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
export default config;
