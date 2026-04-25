import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: [
      'src/**/*.test.ts',
      'test/**/*.test.ts',
    ],
    exclude: [
      'node_modules',
      // Live e2e SCENARIO tests require real Docker + testnet relays + faucet.
      // They are opt-in via `npm run test:e2e-live` (uses vitest.e2e-live.config.ts).
      //
      // Helper UNIT tests (mocked subprocess, mocked Docker) DO run in the
      // default suite — they live in `test/e2e-live/helpers/*.test.ts` and
      // keep the harness honest while the real-network scenarios stay gated.
      'test/e2e-live/*.test.ts',
      'test/e2e-live/scenarios/**',
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/index.ts', 'src/**/main.ts'],
    },
  },
});
