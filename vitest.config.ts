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
      // Live e2e tests require real Docker + testnet relays. They are not
      // runnable in default `npm test`. See test/e2e-live/README.md.
      //
      // Helpers under test/e2e-live/helpers/ ARE included here — those modules
      // mock external deps and are safe to run in CI without infra.
      'test/e2e-live/*.test.ts',
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/index.ts', 'src/**/main.ts'],
    },
  },
});
