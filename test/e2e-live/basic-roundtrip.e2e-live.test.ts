/**
 * Live E2E — Basic round-trip trading.
 *
 * Minimum viable trade: 1 escrow + 2 traders. Real Docker, real Sphere DMs,
 * real testnet aggregator/IPFS. The trader-ctl driver talks directly to each
 * tenant — there is NO host-manager in this architecture; lifecycle is
 * orchestrated by docker-helpers and trading is orchestrated by trader-ctl.
 *
 * Three scenarios in one describe block:
 *   1. Matching buy + sell intents reach COMPLETED on both sides.
 *   2. Cancelling an intent before it matches → CANCELLED state observed.
 *   3. An intent without a counterparty expires → EXPIRED state observed.
 *
 * Provisioning is shared across all `it()` to keep faucet hits low; each
 * test cleans up only the intents/deals it created so leftover state from
 * one scenario does not contaminate the next.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  provisionTrader,
  provisionEscrow,
  type ProvisionedTenant,
  type InternalProvisionOptions,
} from './helpers/tenant-fixture.js';
import {
  createMatchingIntents,
  waitForDealInState,
} from './helpers/scenario-helpers.js';
import { runTraderCtl } from './helpers/trader-ctl-driver.js';
import { getControllerWallet } from './helpers/tenant-fixture.js';
import { getContainerLogs } from './helpers/docker-helpers.js';
import { TESTNET, UCT_COIN_ID, USDU_COIN_ID } from './helpers/constants.js';

// ---------------------------------------------------------------------------
// Shared fixtures: provisioned ONCE per file to amortize faucet rate-limits
// and Docker spin-up cost. Real testnet → tens of seconds per fresh wallet.
// ---------------------------------------------------------------------------

let escrow: ProvisionedTenant;
let buyer: ProvisionedTenant;
let seller: ProvisionedTenant;

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  escrow = await provisionEscrow({
    label: 'basic-escrow',
    relayUrls: [...TESTNET.RELAYS],
    readyTimeoutMs: 180_000,
  });
  // Sequential provisioning + 180s ready timeout: parallel nametag
  // registrations against the testnet aggregator can trip a rate-limit
  // (one of two concurrent provisions sometimes fails to log
  // sphere_initialized within 90s while the other completes in ~5s).
  // Sequential adds ~10–15s; well within the 600s beforeAll budget.
  // Self-mint funding instead of faucet HTTP. The faucet has been a
  // recurring source of test flakiness (sustained 30s+ HTTP timeouts on
  // /api/v1/faucet/request while the host TCP layer is healthy). Genesis
  // mints via state-transition-sdk hit the L3 aggregator directly, the
  // same dependency the swap-execution path already requires.
  // 5000 of each is the same amount the faucet path provided.
  const SELF_MINT = [
    { coinIdHex: UCT_COIN_ID, amount: 5000n },
    { coinIdHex: USDU_COIN_ID, amount: 5000n },
  ];
  buyer = await provisionTrader({
    label: 'basic-buyer',
    trustedEscrows: [escrow.address],
    relayUrls: [...TESTNET.RELAYS],
    waitForReady: true,
    readyTimeoutMs: 180_000,
    selfMintFund: SELF_MINT,
  } satisfies InternalProvisionOptions);
  seller = await provisionTrader({
    label: 'basic-seller',
    trustedEscrows: [escrow.address],
    relayUrls: [...TESTNET.RELAYS],
    waitForReady: true,
    readyTimeoutMs: 180_000,
    selfMintFund: SELF_MINT,
  } satisfies InternalProvisionOptions);
}, 600_000);

afterAll(async () => {
  // Dump container logs BEFORE cleanup — captured on every run for diagnostics.
  const tenants = [
    { label: 'buyer', t: buyer },
    { label: 'seller', t: seller },
    { label: 'escrow', t: escrow },
  ];
  for (const { label, t } of tenants) {
    if (!t?.container) continue;
    try {
      const logs = await getContainerLogs(t.container.id, 500);
      console.error(`\n=== CONTAINER LOGS [${label}] (last 500 lines) ===\n${logs}\n=== END ${label} ===\n`);
    } catch (err) {
      console.error(`[basic-roundtrip afterAll] failed to get logs for ${label}:`, err);
    }
  }

  // Best-effort cleanup; never let one failure mask another.
  const cleanups = [
    async () => seller?.dispose(),
    async () => buyer?.dispose(),
    async () => escrow?.dispose(),
  ];
  for (const fn of cleanups) {
    try {
      await fn();
    } catch (err) {
      console.error('[basic-roundtrip afterAll] cleanup error:', err);
    }
  }
}, 120_000);

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe('Basic round-trip trading', () => {
  /**
   * Helper: extract a coin's confirmed balance (in smallest units) from the
   * portfolio response. Returns 0n if the coin isn't present.
   *
   * GET_PORTFOLIO emits each balance as
   *   { asset: <symbol-or-coinId>, available, total, confirmed, unconfirmed }
   * with `asset` set to the SDK-known symbol when available (e.g. 'UCT',
   * 'USDU'), falling back to the raw coinId hash. We match by symbol.
   */
  function balanceOf(portfolio: unknown, coinSymbol: string): bigint {
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

  async function getPortfolio(
    tenantAddress: string,
  ): Promise<unknown> {
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
        `portfolio query failed for ${tenantAddress}: exit ${result.exitCode} | stderr: ${result.stderr || '<empty>'} | output: ${JSON.stringify(result.output)?.slice(0, 200)}`,
      );
    }
    return result.output;
  }

  it(
    'seller and buyer post matching intents → both deals reach COMPLETED',
    async () => {
      // ---- Pre-swap balance snapshot (regression coverage) ---------------
      // After the swap completes, the buyer (direction=buy UCT for USDU)
      // must have +volume UCT and -(rate*volume) USDU; seller is the inverse.
      // Asserting these post-swap deltas catches the canonical-sort party-
      // currency-vs-asset-position bug (sphere-sdk SwapModule.deposit) — a
      // bug where buyer would deposit UCT instead of USDU because the SDK
      // selected `assetIndex` positionally after canonicalSerialize sorted
      // the invoice's assets by coinId hash. See sphere-sdk
      // tests/unit/modules/SwapModule.deposit.test.ts UT-SWAP-DEP-009.
      const buyerBefore = await getPortfolio(buyer.address);
      const sellerBefore = await getPortfolio(seller.address);
      const buyerUctBefore = balanceOf(buyerBefore, 'UCT');
      const buyerUsduBefore = balanceOf(buyerBefore, 'USDU');
      const sellerUctBefore = balanceOf(sellerBefore, 'UCT');
      const sellerUsduBefore = balanceOf(sellerBefore, 'USDU');

      const intents = await createMatchingIntents(buyer, seller, {
        base_asset: 'UCT',
        quote_asset: 'USDU',
        rate_min: 1n,
        rate_max: 1n,
        volume_min: 1n,
        volume_max: 10n,
        escrow_address: escrow.address,
      });

      expect(intents.buyerIntentId).toBeTruthy();
      expect(intents.sellerIntentId).toBeTruthy();

      const buyerDeal = await waitForDealInState(
        buyer,
        'COMPLETED',
        TESTNET.SWAP_TIMEOUT_MS,
      );
      const sellerDeal = await waitForDealInState(
        seller,
        'COMPLETED',
        TESTNET.SWAP_TIMEOUT_MS,
      );

      expect(buyerDeal['state']).toBe('COMPLETED');
      expect(sellerDeal['state']).toBe('COMPLETED');
      // Both sides observe the same deal_id (one negotiation, two ledgers)
      expect(buyerDeal['deal_id']).toBe(sellerDeal['deal_id']);

      // ---- Post-swap balance assertions ----------------------------------
      // Wait briefly for payments.receive() to finalize the inbound payouts
      // before reading balances — the trader's loop is on a 15s cycle.
      await new Promise((resolve) => setTimeout(resolve, 5_000));

      const volume = 10n; // matches volume_max above (single-fill swap)
      const rate = 1n;
      const expectedUsduAmount = rate * volume;

      const buyerAfter = await getPortfolio(buyer.address);
      const sellerAfter = await getPortfolio(seller.address);
      const buyerUctAfter = balanceOf(buyerAfter, 'UCT');
      const buyerUsduAfter = balanceOf(buyerAfter, 'USDU');
      const sellerUctAfter = balanceOf(sellerAfter, 'UCT');
      const sellerUsduAfter = balanceOf(sellerAfter, 'USDU');

      // Buyer (direction='buy' UCT for USDU): +UCT, -USDU
      expect(
        buyerUctAfter - buyerUctBefore,
        `buyer UCT delta should be +${volume}; observed: ${buyerUctAfter - buyerUctBefore}`,
      ).toBe(volume);
      expect(
        buyerUsduBefore - buyerUsduAfter,
        `buyer USDU delta should be -${expectedUsduAmount}; observed: -${buyerUsduBefore - buyerUsduAfter}`,
      ).toBe(expectedUsduAmount);

      // Seller (direction='sell' UCT for USDU): -UCT, +USDU
      expect(
        sellerUctBefore - sellerUctAfter,
        `seller UCT delta should be -${volume}; observed: -${sellerUctBefore - sellerUctAfter}`,
      ).toBe(volume);
      expect(
        sellerUsduAfter - sellerUsduBefore,
        `seller USDU delta should be +${expectedUsduAmount}; observed: ${sellerUsduAfter - sellerUsduBefore}`,
      ).toBe(expectedUsduAmount);
    },
    TESTNET.SWAP_TIMEOUT_MS + 60_000, // outer vitest timeout
  );

  /**
   * Wrapper for runTraderCtl that automatically attaches controller-wallet
   * credentials. Without these, ACP commands sent to the trader are rejected
   * because the trader can't verify the sender against its allow-list.
   */
  async function authedTraderCtl(
    cmd: string,
    args: ReadonlyArray<string>,
    tenantAddress: string,
  ): ReturnType<typeof runTraderCtl> {
    const controller = await getControllerWallet();
    return runTraderCtl(cmd, args, {
      tenant: tenantAddress,
      timeoutMs: 30_000,
      json: true,
      dataDir: controller.dataDir,
      tokensDir: controller.tokensDir,
    });
  }

  /**
   * Pull a string field from a trader-ctl JSON response. The CLI output may
   * be either the bare result object or the AcpResultPayload envelope with
   * the result nested under `result`. Tolerate both.
   */
  function fieldFromOutput(output: unknown, field: string): string | null {
    if (typeof output !== 'object' || output === null) return null;
    const obj = output as Record<string, unknown>;
    if (typeof obj[field] === 'string') return obj[field] as string;
    const inner = obj['result'];
    if (typeof inner === 'object' && inner !== null) {
      const innerObj = inner as Record<string, unknown>;
      if (typeof innerObj[field] === 'string') return innerObj[field] as string;
    }
    return null;
  }

  /**
   * Pull an array field from a trader-ctl JSON response, tolerating both
   * top-level and `result`-nested envelope shapes.
   */
  function arrayFieldFromOutput(
    output: unknown,
    field: string,
  ): Array<Record<string, unknown>> {
    if (typeof output !== 'object' || output === null) return [];
    const obj = output as Record<string, unknown>;
    if (Array.isArray(obj[field])) {
      return obj[field] as Array<Record<string, unknown>>;
    }
    const inner = obj['result'];
    if (typeof inner === 'object' && inner !== null) {
      const innerObj = inner as Record<string, unknown>;
      if (Array.isArray(innerObj[field])) {
        return innerObj[field] as Array<Record<string, unknown>>;
      }
    }
    return [];
  }

  it('seller cancels intent before match → cancelled state observed', async () => {
    // Seller alone — no matching buyer intent posted in this scenario.
    const create = await authedTraderCtl(
      'create-intent',
      [
        '--direction',
        'sell',
        '--base',
        'UCT',
        '--quote',
        'USDU',
        '--rate-min',
        '5',
        '--rate-max',
        '5',
        '--volume-min',
        '50',
        '--volume-max',
        '500',
        '--expiry-ms',
        String(10 * 60_000),
      ],
      seller.address,
    );
    expect(create.exitCode).toBe(0);
    const intentId = fieldFromOutput(create.output, 'intent_id');
    if (!intentId) {
      throw new Error(
        `create-intent did not return an intent_id: ${JSON.stringify(create.output)?.slice(0, 500)}`,
      );
    }

    const cancel = await authedTraderCtl(
      'cancel-intent',
      ['--intent-id', intentId],
      seller.address,
    );
    if (cancel.exitCode !== 0) {
      throw new Error(
        `cancel-intent failed with exit ${cancel.exitCode}; stderr=${cancel.stderr || '<empty>'}; output=${JSON.stringify(cancel.output)?.slice(0, 500)}`,
      );
    }

    // Poll list-intents until the intent appears with state=CANCELLED.
    // Don't rely on the --state filter here (the trader-ctl CLI sends
    // {state: ...} but the trader's LIST_INTENTS handler reads
    // params.filter — until that's reconciled, we list all intents and
    // check the per-record state ourselves).
    await expect
      .poll(
        async () => {
          const list = await authedTraderCtl('list-intents', [], seller.address);
          if (list.exitCode !== 0) return false;
          const intents = arrayFieldFromOutput(list.output, 'intents');
          return intents.some(
            (i) =>
              String(i['intent_id']) === intentId &&
              String(i['state']).toUpperCase() === 'CANCELLED',
          );
        },
        { timeout: 60_000, interval: 2_000 },
      )
      .toBe(true);
  }, 5 * 60_000);

  it('intent expires before match → expired state observed', async () => {
    // Short expiry, no matching counterparty intent → engine should mark EXPIRED.
    const expiryMs = 15_000;
    const create = await authedTraderCtl(
      'create-intent',
      [
        '--direction',
        'sell',
        '--base',
        'UCT',
        '--quote',
        'USDU',
        '--rate-min',
        '7',
        '--rate-max',
        '7',
        '--volume-min',
        '10',
        '--volume-max',
        '100',
        '--expiry-ms',
        String(expiryMs),
      ],
      seller.address,
    );
    expect(create.exitCode).toBe(0);
    const intentId = fieldFromOutput(create.output, 'intent_id');
    if (!intentId) {
      throw new Error(
        `create-intent did not return an intent_id: ${JSON.stringify(create.output)?.slice(0, 500)}`,
      );
    }

    // Wait for the engine's expiry sweep to flip state. Allow ~3x expiry to
    // cover scan-interval slack and DM round-trips. List all intents and
    // check the per-record state ourselves (see cancel test for rationale).
    await expect
      .poll(
        async () => {
          const list = await authedTraderCtl('list-intents', [], seller.address);
          if (list.exitCode !== 0) return false;
          const intents = arrayFieldFromOutput(list.output, 'intents');
          return intents.some(
            (i) =>
              String(i['intent_id']) === intentId &&
              String(i['state']).toUpperCase() === 'EXPIRED',
          );
        },
        { timeout: expiryMs * 4 + 30_000, interval: 2_000 },
      )
      .toBe(true);
  }, 5 * 60_000);
});
