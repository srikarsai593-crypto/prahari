import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['node_modules/**', '.next/**'],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      reporter: ['text-summary', 'html'],

      /**
       * Scoped to the modules that carry decisions.
       *
       * A percentage measured across presentational components is a number
       * about how much markup happens to be mounted, and chasing it produces
       * tests that assert the existence of a `<div>`. The files below are the
       * ones where being wrong changes what an operator is told: the geodesy
       * behind the "safe corridor" verdict, the queue holding work done in a
       * blizzard, the session gate, and the components that turn station data
       * into a reading.
       *
       * Adding a module with real logic means adding it here.
       */
      include: [
        'src/lib/geo.ts',
        'src/lib/offlineQueue.ts',
        'src/components/SessionProvider.tsx',
        'src/components/TraverseTelemetry.tsx',
        'src/components/InventoryControls.tsx',
      ],

      // A floor that ratchets, not a target to chase. It exists to stop new
      // logic landing in these files with no test at all.
      thresholds: {
        lines: 80,
        functions: 70,
        branches: 80,
        statements: 80,
        // The two with the worst failure modes — a wrong hazard verdict and
        // silently discarded offline work — are held higher individually.
        'src/lib/geo.ts': { lines: 100, functions: 100, branches: 95, statements: 100 },
        'src/lib/offlineQueue.ts': { lines: 90, functions: 75, branches: 65, statements: 90 },
      },
    },
  },
});
