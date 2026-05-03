/**
 * Live e2e test configuration — opt-in via `npm run test:e2e-live`.
 *
 * Tests run against REAL Unicity testnet infrastructure (Nostr relay at
 * `wss://nostr-relay.testnet.unicity.network`, L3 aggregator at
 * `goggregator-test.unicity.network`, IPFS gateway, Market API). The
 * @unicitylabs/infra-probe globalSetup aborts the run if any of those
 * services are unreachable so a multi-minute container-spawn cycle isn't
 * wasted on a known-down service.
 *
 * Two flavors of test live in this directory:
 *
 *   1. Direct-docker tests (the existing files: basic-roundtrip,
 *      multi-agent, surplus-refund, etc.) — provision tenants via
 *      docker run with a synthesized fake manager pubkey, drive
 *      trading via trader-ctl over Sphere DM. NO host-manager
 *      involvement; matches the architecture as it stood before
 *      agentic-hosting Phase 5 shipped DM transport.
 *
 *   2. HMA-orchestrated tests (hma-orchestrated.e2e-live.test.ts and
 *      siblings added in PR-B/PR-C of the migration plan) — boot the
 *      compiled `dist/host-manager.js` from agentic-hosting, spawn
 *      tenants via `sphere host spawn`, drive trading via
 *      `sphere trader …`. This is the production architecture: the
 *      HMA owns lifecycle; controllers reach tenants directly for
 *      trade ops.
 *
 * Both flavors share the infra-probe preflight; the HMA-orchestrated
 * tests additionally `describe.skipIf` themselves when sphere-cli or
 * the agentic-hosting binary isn't available locally so an upstream
 * regression doesn't fail this branch's CI.
 *
 * Bypass the preflight (e.g. iterating offline against a single test):
 *   TRADER_E2E_SKIP_PREFLIGHT=1 npm run test:e2e-live
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/e2e-live/**/*.e2e-live.test.ts'],
    // Run @unicitylabs/infra-probe before any test file. Aborts the run
    // up-front if testnet services are unreachable, instead of consuming
    // a 10-15-minute container spawn cycle to discover the same failure
    // as an opaque timeout. Bypass: TRADER_E2E_SKIP_PREFLIGHT=1.
    globalSetup: ['./test/e2e-live/global-setup.ts'],
    testTimeout: 180_000,
    hookTimeout: 600_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    sequence: { concurrent: false },
    retry: 0,
    bail: 1,
  },
});
