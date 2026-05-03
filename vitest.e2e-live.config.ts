/**
 * Live e2e test configuration — opt-in via `npm run test:e2e-live`.
 *
 * IMPORTANT: These tests are NOT runnable in trader-service standalone.
 * They depend on the Host Manager Agent (HMA) — `createHostManager`,
 * `hm.spawn` over HMCP-0, the Dockerode adapter, and the agentic-hosting
 * tenant template registry — none of which live in this repo.
 *
 * The tests are preserved here at the same shape they had in the
 * agentic-hosting `pre-trader-cut-v1` tag so that they can be ported to
 * (or run from) the agentic-hosting repository's nightly integration CI
 * once the host-manager half of the stack is decoupled too. See
 * `test/e2e-live/README.md` for the full rationale and the runbook for
 * the manual scenarios these tests describe.
 *
 * Running this config in trader-service today will fail at module
 * resolution — the missing host-manager source files are the signal.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/e2e-live/**/*.test.ts'],
    // Run @unicitylabs/infra-probe before any test file. Aborts the run
    // up-front if the testnet Nostr relay / aggregator / IPFS / Fulcrum /
    // market is unreachable, instead of consuming a 10-15-minute container
    // spawn cycle to discover the same failure as an opaque timeout.
    // Bypass: TRADER_E2E_SKIP_PREFLIGHT=1.
    globalSetup: ['./test/e2e-live/global-setup.ts'],
    testTimeout: 180_000,
    hookTimeout: 300_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    sequence: { concurrent: false },
    retry: 0,
    bail: 1,
  },
});
