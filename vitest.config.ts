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
      // Live e2e tests require agentic-hosting Host Manager + real Docker +
      // testnet relays. They are not runnable in trader-service standalone.
      // See test/e2e-live/README.md.
      'test/e2e-live/**',
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/index.ts', 'src/**/main.ts'],
    },
  },
});
