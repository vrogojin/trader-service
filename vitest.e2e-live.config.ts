/**
 * Live e2e test configuration — opt-in via `npm run test:e2e-live`.
 *
 * Tests run against REAL Unicity testnet infrastructure (Nostr relay at
 * `wss://nostr-relay.testnet.unicity.network`, L3 aggregator at
 * `goggregator-test.unicity.network`, IPFS gateway, Market API). The
 * infra-probe preflight gate aborts the run if any of those services
 * are unreachable so a 10-15-minute container-spawn cycle isn't wasted
 * on a known-down service.
 *
 * Trader and escrow containers are spawned **directly via the local
 * Docker daemon** — NOT through the Host Manager Agent (HMA) / HMCP-0.
 * The trader-ctl driver talks to each tenant over Sphere DM. This
 * matches the production architecture where agentic-hosting only
 * orchestrates lifecycle; trading happens controller ↔ tenant directly.
 * See `test/e2e-live/helpers/contracts.ts` and
 * `test/e2e-live/helpers/tenant-fixture.ts` for the rationale.
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
