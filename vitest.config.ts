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
      // Live e2e tests are at test/e2e-live/*.test.ts (top-level) and any
      // future scenario directories. They require agentic-hosting Host
      // Manager + real Docker + testnet relays and are NOT runnable in
      // trader-service standalone. See test/e2e-live/README.md.
      //
      // Helper unit tests live under test/e2e-live/helpers/*.test.ts and
      // ARE runnable here — they mock execFile and never touch Docker.
      // They run in `npm test` so PRs that change the helpers get signal
      // without spinning up the live harness.
      'test/e2e-live/*.test.ts',
      'test/e2e-live/scenarios/**/*.test.ts',
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/index.ts', 'src/**/main.ts'],
    },
  },
});
