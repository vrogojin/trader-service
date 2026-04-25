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
      // Live e2e SCENARIO tests require real Docker, real testnet relays,
      // and a faucet. They are opt-in via `npm run test:e2e-live`.
      //
      // Helper UNIT tests (mocked subprocess, mocked Docker) DO run in the
      // default suite — they live in `test/e2e-live/helpers/` and are how
      // the harness keeps itself honest while the real-network scenarios
      // are gated behind the e2e-live config.
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
