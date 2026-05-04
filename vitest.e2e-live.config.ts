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

/**
 * VITEST_MAX_FORKS — opt-in knob for parallelizing e2e-live test FILES
 * across vitest worker forks. Default is 1 (sequential, one file at a
 * time) which preserves the historical behavior of `singleFork: true`.
 *
 * Two forks would run two test files concurrently. Each fork spawns its
 * own set of Docker containers (the test/e2e-live helpers session-prefix
 * everything) so cross-fork resource collisions are designed-out, but the
 * shared testnet Nostr relay is the bottleneck. Don't raise this above
 * what the relay can handle (empirically 2-3 today).
 *
 * Note: each fork spawns its own controller wallet via `Sphere.init`,
 * which performs a relay handshake. With N forks you do N concurrent
 * Sphere.init calls against the same relay during startup. If the relay
 * sustains 2-3 concurrent inits today, plan accordingly.
 *
 * The session-isolation work in test/e2e-live/helpers/session.ts is what
 * makes cross-fork (and cross-process) parallelism safe — see that file
 * for the per-resource analysis.
 *
 * Per PR-10 review W5: validate explicitly rather than silently floor on
 * NaN/0/negative — typos used to be hidden by `|| 1`, now they fail loudly.
 */
function readMaxForks(): number {
  const raw = process.env['VITEST_MAX_FORKS'];
  if (raw === undefined || raw === '') return 1;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || Number.isNaN(n)) {
    throw new Error(
      `Invalid VITEST_MAX_FORKS="${raw}": must be a positive integer.`,
    );
  }
  if (n < 1) {
    throw new Error(
      `Invalid VITEST_MAX_FORKS="${raw}" (parsed as ${n}): must be >= 1.`,
    );
  }
  return n;
}
const MAX_FORKS = readMaxForks();

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
    poolOptions: {
      forks: {
        // singleFork preserved as default for backward compatibility.
        // Setting VITEST_MAX_FORKS>1 flips to a multi-fork pool.
        singleFork: MAX_FORKS === 1,
        maxForks: MAX_FORKS,
        minForks: 1,
      },
    },
    sequence: { concurrent: false },
    retry: 0,
    bail: 1,
  },
});
