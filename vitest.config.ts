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
      // Live e2e test FILES (the scenarios) require agentic-hosting Host
      // Manager + real Docker + testnet relays. They are not runnable in
      // trader-service standalone. See test/e2e-live/README.md.
      //
      // Helper UNIT tests under test/e2e-live/helpers/ are mock-only and
      // safe to run in the default suite — we explicitly do NOT exclude
      // them here so they participate in `npm test`.
      'test/e2e-live/*.test.ts',
      'test/e2e-live/**/*.e2e.test.ts',
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/index.ts', 'src/**/main.ts'],
    },
  },
});
