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
    include: ['test/e2e-live/**/*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 300_000,
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
