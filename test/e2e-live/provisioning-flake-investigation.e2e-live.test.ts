/**
 * FOCUSED INVESTIGATION: provisioning hang base rate.
 *
 * Question: when `provisionTrader` fails with "did not log
 * sphere_initialized within 180000ms", is it testnet-side (Nostr relay /
 * AWS ALB / aggregator) or our-side (race in Sphere.init)?
 *
 * Methodology: provision N traders sequentially with fresh wallets,
 * record per-attempt {start, end, status, container_logs_on_fail}.
 * Print a histogram + hang rate at end. Each container is disposed
 * immediately after init — we're NOT exercising the swap path.
 *
 * Expected output:
 *   - Most attempts: ~4 seconds (matches the working case)
 *   - Some attempts: 180s timeout (the hang)
 *   - Hang rate gives us infrastructure flakiness magnitude
 *
 * If a hang fires, the container's logs are dumped to stderr (via the
 * provisionTrader catch path's diagnostic added 2026-04-30) so we can
 * see WHERE in init the trader hung — distinguishing:
 *   - registering_nametag without sphere_initialized = Nostr stuck
 *   - downloading_trustbase without registering_nametag = HTTP stuck
 *   - nothing logged at all = our code crashed somehow
 *
 * Run with:
 *   npm run test:e2e-live -- test/e2e-live/provisioning-flake-investigation.e2e-live.test.ts
 *
 * Skip in CI by default — this is a manual diagnostic.
 */

import { describe, it, expect } from 'vitest';
import { provisionTrader } from './helpers/tenant-fixture.js';
import { TESTNET } from './helpers/constants.js';

interface AttemptResult {
  attempt: number;
  startMs: number;
  endMs: number;
  durationMs: number;
  status: 'success' | 'hang' | 'error';
  errorMessage?: string;
}

const ATTEMPTS = 20;
const PER_ATTEMPT_BUDGET_MS = 200_000; // hang budget = 180s + 20s grace

describe.skipIf(process.env['INVESTIGATE_PROVISIONING_FLAKE'] !== '1')(
  'Provisioning flake investigation (manual diagnostic)',
  () => {
    it(
      `provisions ${ATTEMPTS} traders sequentially and reports hang rate`,
      async () => {
        const results: AttemptResult[] = [];

        for (let i = 1; i <= ATTEMPTS; i++) {
          const startMs = Date.now();
          const label = `flake-probe-${i}`;
          try {
            // Provision but do NOT fund — we want to isolate the init path.
            const tenant = await provisionTrader({
              label,
              relayUrls: [...TESTNET.RELAYS],
              waitForReady: true,
              readyTimeoutMs: 180_000,
            });
            const endMs = Date.now();
            results.push({
              attempt: i,
              startMs,
              endMs,
              durationMs: endMs - startMs,
              status: 'success',
            });
            // Dispose immediately — we just want the init signal.
            await tenant.dispose().catch(() => {});
          } catch (err) {
            const endMs = Date.now();
            const msg = err instanceof Error ? err.message : String(err);
            const isHang = msg.includes('did not log sphere_initialized');
            results.push({
              attempt: i,
              startMs,
              endMs,
              durationMs: endMs - startMs,
              status: isHang ? 'hang' : 'error',
              errorMessage: msg.slice(0, 500),
            });
          }
          // Brief pause between attempts so the testnet relay can drain.
          await new Promise((r) => setTimeout(r, 2_000));
          // Periodic progress dump to stderr — this is a long-running test.
          process.stderr.write(
            `\n[flake-probe ${i}/${ATTEMPTS}] status=${results[i - 1]!.status} durationMs=${results[i - 1]!.durationMs}\n`,
          );
        }

        // ---- Report ----
        const successes = results.filter((r) => r.status === 'success');
        const hangs = results.filter((r) => r.status === 'hang');
        const errors = results.filter((r) => r.status === 'error');

        const successDurations = successes.map((r) => r.durationMs).sort((a, b) => a - b);
        const successP50 = successDurations[Math.floor(successDurations.length / 2)] ?? 0;
        const successP95 =
          successDurations[Math.floor(successDurations.length * 0.95)] ?? 0;
        const successMax = successDurations[successDurations.length - 1] ?? 0;

        process.stderr.write(`
=== PROVISIONING FLAKE REPORT ===
Total attempts:    ${results.length}
Successes:         ${successes.length} (${Math.round((100 * successes.length) / results.length)}%)
Hangs (180s+):     ${hangs.length} (${Math.round((100 * hangs.length) / results.length)}%)
Other errors:      ${errors.length}

Success duration:
  p50: ${successP50}ms
  p95: ${successP95}ms
  max: ${successMax}ms

Hang attempts: ${hangs.map((h) => h.attempt).join(', ')}
Error attempts: ${errors.map((e) => `${e.attempt}: ${e.errorMessage?.slice(0, 80)}`).join('; ')}
`);

        // Always pass — this is a measurement, not a pass/fail check.
        // We just want the report. The user reads stderr and decides.
        expect(results.length).toBe(ATTEMPTS);
      },
      ATTEMPTS * PER_ATTEMPT_BUDGET_MS + 60_000,
    );
  },
);
