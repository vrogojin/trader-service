/**
 * FOCUSED INVESTIGATION (load): provisioning hang under concurrent load.
 *
 * Sequel to provisioning-flake-investigation.e2e-live.test.ts. The
 * isolation test (single trader, sequential, 20 attempts) showed 0/20
 * hangs but 3/20 attempts had elevated latency — suggesting the hang we
 * see in basic-roundtrip is tied to concurrent provisioning load.
 *
 * basic-roundtrip provisions ESCROW + BUYER + SELLER. The escrow runs
 * first (it's a different image), then the two traders run "sequential"
 * but with very small (sub-second) gap. From the relay's perspective,
 * 3 NostrClient inits all kick off within ~10 seconds.
 *
 * This test reproduces THAT pattern: 3 traders in parallel, repeated
 * 10 iterations. If the hang is load-correlated, we should see it.
 *
 * Expected outcomes:
 *   - hangs >= 1/30: confirmed load-induced hang. Capture the failed
 *     trader's logs to localize WHERE in init it hangs.
 *   - hangs == 0/30: hang is something more specific (e.g., escrow's
 *     existence interferes with traders' nametag publishing). Need
 *     yet another targeted test.
 *
 * Run with:
 *   INVESTIGATE_PROVISIONING_LOAD=1 npm run test:e2e-live -- \
 *     test/e2e-live/provisioning-load-investigation.e2e-live.test.ts
 */

import { describe, it, expect } from 'vitest';
import { provisionTrader, type ProvisionedTenant } from './helpers/tenant-fixture.js';
import { TESTNET } from './helpers/constants.js';

interface AttemptResult {
  iteration: number;
  parallel_idx: number;
  startMs: number;
  endMs: number;
  durationMs: number;
  status: 'success' | 'hang' | 'error';
  errorMessage?: string;
}

const ITERATIONS = 10;
const PARALLEL_PER_ITERATION = 3;
const PER_ATTEMPT_BUDGET_MS = 200_000;

describe.skipIf(process.env['INVESTIGATE_PROVISIONING_LOAD'] !== '1')(
  'Provisioning load investigation (manual diagnostic)',
  () => {
    it(
      `provisions ${PARALLEL_PER_ITERATION} traders concurrently, ${ITERATIONS} iterations`,
      async () => {
        const allResults: AttemptResult[] = [];

        for (let iter = 1; iter <= ITERATIONS; iter++) {
          const iterStartMs = Date.now();

          // Launch PARALLEL_PER_ITERATION provisionTrader calls in parallel.
          // Each gets a unique label so they get distinct nametags.
          const provisions = Array.from({ length: PARALLEL_PER_ITERATION }, (_, i) => i)
            .map((parallelIdx) => {
              const label = `load-${iter}-${parallelIdx}`;
              const startMs = Date.now();
              return provisionTrader({
                label,
                relayUrls: [...TESTNET.RELAYS],
                waitForReady: true,
                readyTimeoutMs: 180_000,
              })
                .then((tenant: ProvisionedTenant) => {
                  const endMs = Date.now();
                  const result: AttemptResult = {
                    iteration: iter,
                    parallel_idx: parallelIdx,
                    startMs,
                    endMs,
                    durationMs: endMs - startMs,
                    status: 'success',
                  };
                  // Dispose immediately — we just want the init signal.
                  void tenant.dispose().catch(() => {});
                  return result;
                })
                .catch((err: unknown) => {
                  const endMs = Date.now();
                  const msg = err instanceof Error ? err.message : String(err);
                  const isHang = msg.includes('did not log sphere_initialized');
                  const result: AttemptResult = {
                    iteration: iter,
                    parallel_idx: parallelIdx,
                    startMs,
                    endMs,
                    durationMs: endMs - startMs,
                    status: isHang ? 'hang' : 'error',
                    errorMessage: msg.slice(0, 500),
                  };
                  return result;
                });
            });

          // Wait for ALL provisions in this iteration to settle before next.
          // Promise.all is fine since we always settle (success/hang/error).
          const iterResults = await Promise.all(provisions);
          allResults.push(...iterResults);

          const iterEndMs = Date.now();
          const iterHangs = iterResults.filter((r) => r.status === 'hang').length;
          const iterErrors = iterResults.filter((r) => r.status === 'error').length;
          process.stderr.write(
            `\n[load-iter ${iter}/${ITERATIONS}] elapsed=${iterEndMs - iterStartMs}ms ` +
              `successes=${iterResults.filter((r) => r.status === 'success').length}/${PARALLEL_PER_ITERATION} ` +
              `hangs=${iterHangs} errors=${iterErrors}\n`,
          );
          if (iterHangs > 0 || iterErrors > 0) {
            for (const r of iterResults.filter((r) => r.status !== 'success')) {
              process.stderr.write(
                `  attempt ${r.iteration}-${r.parallel_idx}: ${r.status} (${r.durationMs}ms) ${r.errorMessage?.slice(0, 80) ?? ''}\n`,
              );
            }
          }

          // Brief pause between iterations.
          await new Promise((r) => setTimeout(r, 3_000));
        }

        // ---- Final report ----
        const successes = allResults.filter((r) => r.status === 'success');
        const hangs = allResults.filter((r) => r.status === 'hang');
        const errors = allResults.filter((r) => r.status === 'error');

        const successDurations = successes.map((r) => r.durationMs).sort((a, b) => a - b);
        const successP50 = successDurations[Math.floor(successDurations.length / 2)] ?? 0;
        const successP95 =
          successDurations[Math.floor(successDurations.length * 0.95)] ?? 0;
        const successMax = successDurations[successDurations.length - 1] ?? 0;

        process.stderr.write(`
=== PROVISIONING LOAD REPORT ===
Total attempts:    ${allResults.length} (${ITERATIONS} iterations × ${PARALLEL_PER_ITERATION} parallel)
Successes:         ${successes.length} (${Math.round((100 * successes.length) / allResults.length)}%)
Hangs (180s+):     ${hangs.length} (${Math.round((100 * hangs.length) / allResults.length)}%)
Other errors:      ${errors.length}

Success duration:
  p50: ${successP50}ms
  p95: ${successP95}ms
  max: ${successMax}ms

Hang attempts: ${hangs.map((h) => `iter${h.iteration}-${h.parallel_idx}`).join(', ')}
Error attempts: ${errors.map((e) => `iter${e.iteration}-${e.parallel_idx}: ${e.errorMessage?.slice(0, 80)}`).join('; ')}

Per-iteration:
${Array.from({ length: ITERATIONS }, (_, i) => i + 1)
  .map((iter) => {
    const iterAttempts = allResults.filter((r) => r.iteration === iter);
    const iterSucc = iterAttempts.filter((r) => r.status === 'success').length;
    const iterHang = iterAttempts.filter((r) => r.status === 'hang').length;
    const iterErr = iterAttempts.filter((r) => r.status === 'error').length;
    const maxDur = Math.max(...iterAttempts.map((r) => r.durationMs));
    return `  iter ${iter}: ${iterSucc} success / ${iterHang} hang / ${iterErr} error  (max ${maxDur}ms)`;
  })
  .join('\n')}
`);

        expect(allResults.length).toBe(ITERATIONS * PARALLEL_PER_ITERATION);
      },
      ITERATIONS * PER_ATTEMPT_BUDGET_MS + 60_000,
    );
  },
);
