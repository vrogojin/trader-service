/**
 * portfolio-assertions — pre/post balance snapshots and delta assertions.
 *
 * Originally inlined in `basic-roundtrip.e2e-live.test.ts:127-170` and asserted
 * only there. Audit (May 2026) flagged that every other test file checked
 * `state === 'COMPLETED'` or `state === 'FAILED'` only — a regression that
 * left state machines green but skipped token transfer (or stranded tokens
 * after a failure) would silently pass. Extracted here so every scenario can
 * verify actual on-chain balance changes.
 *
 * Public surface:
 *   - `getPortfolio(tenant)` — raw portfolio JSON via trader-ctl
 *   - `balanceOf(portfolio, symbol)` — smallest-units bigint per coin
 *   - `snapshotPortfolio(tenant)` — compact { UCT: bigint, USDU: bigint } map
 *   - `expectBalanceDelta(before, after, expected)` — assert per-coin deltas
 *   - `expectBalanceUnchanged(before, after, tolerance?)` — no swap occurred
 *   - `pollUntilBalanceRestored(tenant, baseline, opts?)` — wait for refund
 *     after an unhappy-path failure (testnet refunds take time to propagate)
 */

import { expect } from 'vitest';

import { runTraderCtl } from './trader-ctl-driver.js';
import { getControllerWallet } from './tenant-fixture.js';
import { TESTNET } from './constants.js';

// =============================================================================
// Raw portfolio access
// =============================================================================

/** Symbols we exercise in the e2e suite. Extend as new coins are added. */
export type TrackedCoin = 'UCT' | 'USDU';
const TRACKED_COINS: ReadonlyArray<TrackedCoin> = ['UCT', 'USDU'];

/** Compact balance snapshot keyed by coin symbol. Values in smallest units. */
export type Portfolio = Record<TrackedCoin, bigint>;

/**
 * Extract a coin's confirmed balance (in smallest units) from the trader-ctl
 * portfolio JSON. Returns 0n if the coin isn't present.
 *
 * GET_PORTFOLIO emits each balance as
 *   { asset: <symbol-or-coinId>, available, total, confirmed, unconfirmed }
 * with `asset` set to the SDK-known symbol when available (e.g. 'UCT',
 * 'USDU'), falling back to the raw coinId hash. We match by symbol.
 */
export function balanceOf(portfolio: unknown, coinSymbol: string): bigint {
  if (typeof portfolio !== 'object' || portfolio === null) return 0n;
  const obj = portfolio as Record<string, unknown>;
  const balances =
    (obj['balances'] ?? (obj['result'] as Record<string, unknown> | undefined)?.['balances']) as
      | Array<Record<string, unknown>>
      | undefined;
  if (!Array.isArray(balances)) return 0n;
  for (const b of balances) {
    const asset = b['asset'] as string | undefined;
    if (asset === coinSymbol) {
      return BigInt(String(b['confirmed'] ?? '0'));
    }
  }
  return 0n;
}

/** Run trader-ctl `portfolio` and return the raw JSON. Throws on non-zero exit. */
export async function getPortfolio(tenantAddress: string): Promise<unknown> {
  const controller = await getControllerWallet();
  const result = await runTraderCtl('portfolio', [], {
    tenant: tenantAddress,
    timeoutMs: 10_000,
    json: true,
    dataDir: controller.dataDir,
    tokensDir: controller.tokensDir,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `portfolio query failed for ${tenantAddress}: exit ${result.exitCode} | ` +
        `stderr: ${result.stderr || '<empty>'} | ` +
        `output: ${JSON.stringify(result.output)?.slice(0, 200)}`,
    );
  }
  return result.output;
}

// =============================================================================
// Compact snapshots
// =============================================================================

/**
 * Snapshot a tenant's confirmed balances for the tracked coins.
 *
 * Use when you need to compare pre/post balances. The compact `Portfolio`
 * shape lets you write `before.UCT - after.UCT === expected` directly without
 * navigating the trader-ctl JSON envelope.
 */
export async function snapshotPortfolio(tenantAddress: string): Promise<Portfolio> {
  const raw = await getPortfolio(tenantAddress);
  const snap: Partial<Portfolio> = {};
  for (const coin of TRACKED_COINS) {
    snap[coin] = balanceOf(raw, coin);
  }
  return snap as Portfolio;
}

// =============================================================================
// Delta assertions (happy path)
// =============================================================================

/**
 * Assert that each coin's balance changed by exactly `expected[coin]`.
 *
 * `expected` values are signed bigints — positive = received, negative = paid.
 * Coins not in `expected` are NOT checked (use `expectBalanceUnchanged` if you
 * need a stronger "nothing else moved" assertion).
 *
 * Common pattern:
 * ```ts
 * const before = await snapshotPortfolio(buyer.address);
 * // ... swap happens ...
 * const after = await snapshotPortfolio(buyer.address);
 * expectBalanceDelta(before, after, { UCT: +volume, USDU: -(rate * volume) });
 * ```
 */
export function expectBalanceDelta(
  before: Portfolio,
  after: Portfolio,
  expected: Partial<Record<TrackedCoin, bigint>>,
): void {
  for (const [coin, expectedDelta] of Object.entries(expected) as Array<[TrackedCoin, bigint]>) {
    const actual = after[coin] - before[coin];
    expect(
      actual,
      `${coin}: expected delta ${expectedDelta.toString()}, got ${actual.toString()} ` +
        `(before=${before[coin].toString()}, after=${after[coin].toString()})`,
    ).toBe(expectedDelta);
  }
}

// =============================================================================
// "Nothing moved" assertions (rejected scenarios)
// =============================================================================

/**
 * Assert that no tracked-coin balance changed. Used when a scenario should
 * NOT cause any token movement — incompatible rates, blocked counterparty,
 * cancelled-before-match, expired intent. A regression that accidentally
 * moved tokens here would otherwise pass silently.
 *
 * `tolerance` allows for testnet noise (e.g., dust from a parallel test on
 * the shared aggregator). Default is 0 — strictly unchanged.
 */
export function expectBalanceUnchanged(
  before: Portfolio,
  after: Portfolio,
  tolerance: bigint = 0n,
): void {
  for (const coin of TRACKED_COINS) {
    const delta = after[coin] - before[coin];
    const absDelta = delta < 0n ? -delta : delta;
    expect(
      absDelta <= tolerance,
      `${coin}: expected no change (tolerance=${tolerance.toString()}), ` +
        `got delta=${delta.toString()} ` +
        `(before=${before[coin].toString()}, after=${after[coin].toString()})`,
    ).toBe(true);
  }
}

// =============================================================================
// Refund-propagation poll (unhappy-path balance restoration)
// =============================================================================

export interface PollBalanceRestoredOpts {
  /** Polling interval. Default: 5s. */
  intervalMs?: number;
  /** Total timeout. Default: SWAP_TIMEOUT_MS (25 min) — testnet refunds via
   *  escrow auto-return + L3 finality can take many minutes. */
  timeoutMs?: number;
  /** Per-coin tolerance for "restored". Default: 0n (strict). */
  tolerance?: bigint;
}

/**
 * After an unhappy-path failure, poll the tenant's portfolio until balances
 * return to the supplied baseline (within tolerance) or the timeout elapses.
 *
 * Use when a scenario deposited tokens but should fail and refund. The escrow's
 * `closeInvoice({autoReturn: true})` and the trader's own `setAutoReturn` need
 * time on testnet — verifying balance restoration is the only way to confirm
 * "all assets returned to original owners" (Claim 5b in the e2e audit). The
 * weaker `state === 'FAILED'` check is necessary but not sufficient.
 *
 * @returns The final snapshot.
 * @throws  If timeout elapses without restoration. The error message includes
 *          per-coin deltas so the operator can see which coin is stuck.
 */
export async function pollUntilBalanceRestored(
  tenantAddress: string,
  baseline: Portfolio,
  opts: PollBalanceRestoredOpts = {},
): Promise<Portfolio> {
  const intervalMs = opts.intervalMs ?? 5_000;
  const timeoutMs = opts.timeoutMs ?? TESTNET.SWAP_TIMEOUT_MS;
  const tolerance = opts.tolerance ?? 0n;
  const deadline = Date.now() + timeoutMs;

  let last: Portfolio | null = null;
  while (Date.now() < deadline) {
    last = await snapshotPortfolio(tenantAddress);
    let restored = true;
    for (const coin of TRACKED_COINS) {
      const delta = last[coin] - baseline[coin];
      const absDelta = delta < 0n ? -delta : delta;
      if (absDelta > tolerance) {
        restored = false;
        break;
      }
    }
    if (restored) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  // Timed out — produce a useful error message
  const final = last ?? (await snapshotPortfolio(tenantAddress));
  const deltas = TRACKED_COINS.map(
    (coin) =>
      `${coin}: baseline=${baseline[coin].toString()} ` +
      `final=${final[coin].toString()} ` +
      `delta=${(final[coin] - baseline[coin]).toString()}`,
  ).join(', ');
  throw new Error(
    `pollUntilBalanceRestored timed out after ${timeoutMs}ms for ${tenantAddress}: ` +
      `balance NOT restored to baseline. Deltas: ${deltas}. ` +
      `(This indicates assets were not returned to the original owner — see Claim 5b.)`,
  );
}
