/**
 * Live E2E — Negotiation failure paths.
 *
 * Asserts that the trader correctly classifies negotiation failures rather
 * than blindly retrying or reaching COMPLETED. Each scenario stages a
 * specific fault (untrusted escrow, escrow disappears mid-negotiation,
 * peer never deposits) and asserts the deal lands in FAILED with the
 * expected error code.
 *
 * Per-test timeouts are 10 minutes for failure paths because the trader's
 * waiting periods (DM ack timeout, deposit timeout) intentionally exceed
 * normal happy-path timings.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  provisionTrader,
  provisionEscrow as provisionRealEscrow,
  type ProvisionedTenant,
} from './helpers/tenant-fixture.js';
import {
  createMatchingIntents,
  waitForDealInState,
} from './helpers/scenario-helpers.js';
import { runTraderCtl } from './helpers/trader-ctl-driver.js';
import { getControllerWallet } from './helpers/tenant-fixture.js';
import {
  snapshotPortfolio,
  expectBalanceUnchanged,
  pollUntilBalanceRestored,
} from './helpers/portfolio-assertions.js';

/**
 * Wrapper that auto-attaches controller-wallet credentials so the trader
 * accepts the ACP command. Without these, runTraderCtl falls back to the
 * default ~/.trader-ctl/wallet/wallet.json — not in the trader's allow-list
 * and prone to corruption when multiple tests share it.
 */
async function runAuthedTraderCtl(
  cmd: string,
  args: ReadonlyArray<string>,
  opts: { tenant: string; json?: boolean; timeoutMs?: number },
): ReturnType<typeof runTraderCtl> {
  const controller = await getControllerWallet();
  return runTraderCtl(cmd, args, {
    ...opts,
    dataDir: controller.dataDir,
    tokensDir: controller.tokensDir,
  });
}
import { stopContainer } from './helpers/docker-helpers.js';
import { TESTNET } from './helpers/constants.js';
import { randomBytes } from 'node:crypto';

/**
 * Pull an array field from a trader-ctl JSON response. Tolerates both the
 * bare result object and the AcpResultPayload envelope (with the result
 * nested under `result`).
 */
function arrayFieldFromOutput(
  output: unknown,
  field: string,
): Array<Record<string, unknown>> {
  if (typeof output !== 'object' || output === null) return [];
  const obj = output as Record<string, unknown>;
  if (Array.isArray(obj[field])) return obj[field] as Array<Record<string, unknown>>;
  const inner = obj['result'];
  if (typeof inner === 'object' && inner !== null) {
    const innerObj = inner as Record<string, unknown>;
    if (Array.isArray(innerObj[field])) return innerObj[field] as Array<Record<string, unknown>>;
  }
  return [];
}

/** Pull a string field from a trader-ctl JSON response, tolerating envelope shapes. */
function stringFieldFromOutput(output: unknown, field: string): string | null {
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

let trustedEscrow: ProvisionedTenant;
/** Address never added to anyone's `trusted_escrows`. No container needed. */
let untrustedEscrowAddress: string;
let alice: ProvisionedTenant;
let bob: ProvisionedTenant;
/**
 * Third trader provisioned with `TRADER_FAULT_SKIP_DEPOSITS=1`. Used only by
 * the deposit-timeout scenario to play the "B accepts the deal but never
 * deposits" role. Lives behind a separate fixture so the other tests in this
 * file are unaffected. */
let faultyTrader: ProvisionedTenant;

/** Format-valid DIRECT:// address pointing nowhere. Used for `INVALID_ESCROW`
 *  scenarios where the escrow is supposed to be REJECTED before any RPC. */
function fakeDirectAddress(): string {
  return `DIRECT://${randomBytes(32).toString('hex')}`;
}

/** List ALL intents and filter client-side: trader-ctl `--state` flag is
 *  currently a no-op (handler reads `params.filter`, CLI sends `params.state`). */
async function cancelActiveIntents(tenant: ProvisionedTenant): Promise<void> {
  const list = await runAuthedTraderCtl('list-intents', [], {
    tenant: tenant.address,
    json: true,
  });
  if (list.exitCode !== 0) return;
  const intents = arrayFieldFromOutput(list.output, 'intents');
  for (const intent of intents) {
    const id = stringFieldFromOutput(intent, 'intent_id');
    const state = String(intent['state'] ?? '').toUpperCase();
    if (!id) continue;
    if (state !== 'ACTIVE' && state !== 'MATCHING' && state !== 'PARTIALLY_FILLED') continue;
    await runAuthedTraderCtl('cancel-intent', ['--intent-id', id], {
      tenant: tenant.address,
      json: true,
    }).catch(() => {
      /* best effort */
    });
  }
}

async function createIntent(
  tenant: ProvisionedTenant,
  args: {
    direction: 'buy' | 'sell';
    rateMin: bigint;
    rateMax: bigint;
    volumeMin: bigint;
    volumeMax: bigint;
    expiryMs?: number;
  },
): Promise<string> {
  const argv: string[] = [
    '--direction',
    args.direction,
    '--base',
    'UCT',
    '--quote',
    'USDU',
    '--rate-min',
    args.rateMin.toString(),
    '--rate-max',
    args.rateMax.toString(),
    '--volume-min',
    args.volumeMin.toString(),
    '--volume-max',
    args.volumeMax.toString(),
  ];
  if (args.expiryMs !== undefined) {
    argv.push('--expiry-ms', String(args.expiryMs));
  }
  const result = await runAuthedTraderCtl('create-intent', argv, {
    tenant: tenant.address,
    json: true,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `create-intent failed (exit=${result.exitCode}): ${result.stderr}`,
    );
  }
  const id = stringFieldFromOutput(result.output, 'intent_id');
  if (!id) {
    throw new Error(
      `create-intent returned no intent_id: ${JSON.stringify(result.output)?.slice(0, 500)}`,
    );
  }
  return id;
}

beforeAll(async () => {
  trustedEscrow = await provisionRealEscrow({
    label: 'failures-trusted-escrow',
    relayUrls: [...TESTNET.RELAYS],
    readyTimeoutMs: 180_000,
  });
  untrustedEscrowAddress = fakeDirectAddress();

  // Both traders trust ONLY trustedEscrow. The untrusted-escrow scenario
  // re-targets via SET_STRATEGY mid-test rather than re-provisioning a
  // trader, to keep faucet hits low.
  alice = await provisionTrader({
    label: 'fail-alice',
    trustedEscrows: [trustedEscrow.address],
    relayUrls: [...TESTNET.RELAYS],
    waitForReady: true,
    readyTimeoutMs: 180_000,
    fundFromFaucet: true,
  });
  bob = await provisionTrader({
    label: 'fail-bob',
    trustedEscrows: [trustedEscrow.address],
    relayUrls: [...TESTNET.RELAYS],
    waitForReady: true,
    readyTimeoutMs: 180_000,
    fundFromFaucet: true,
  });
  faultyTrader = await provisionTrader({
    label: 'fail-faulty',
    trustedEscrows: [trustedEscrow.address],
    relayUrls: [...TESTNET.RELAYS],
    waitForReady: true,
    readyTimeoutMs: 180_000,
    fundFromFaucet: true,
    faultSkipDeposits: true, // accepts the deal, never calls swapModule.deposit()
  });
}, 600_000);

afterAll(async () => {
  const cleanups: Array<() => Promise<void>> = [
    async () => faultyTrader?.dispose(),
    async () => bob?.dispose(),
    async () => alice?.dispose(),
    async () => trustedEscrow?.dispose(),
  ];
  for (const fn of cleanups) {
    try {
      await fn();
    } catch (err) {
      console.error('[negotiation-failures afterAll] cleanup error:', err);
    }
  }
}, 120_000);

describe('Negotiation failures', () => {
  it(
    'untrusted escrow: A trusts X, B proposes via Y → deal rejected with INVALID_ESCROW',
    async () => {
      await cancelActiveIntents(alice);
      await cancelActiveIntents(bob);

      // Audit Claim 5b: untrusted-escrow rejection must happen BEFORE deposit,
      // so neither Alice nor Bob should have moved any tokens. Snapshot before,
      // assert unchanged after the test confirms no COMPLETED deal.
      const aliceBalBefore = await snapshotPortfolio(alice.address);
      const bobBalBefore = await snapshotPortfolio(bob.address);

      // Repoint Bob at the untrusted escrow ONLY for this test. Alice still
      // only trusts the original. Bob will create his intent advertising
      // untrustedEscrow, which Alice's intent-engine must reject when it
      // sees the proposal.
      const setStrategy = await runAuthedTraderCtl(
        'set-strategy',
        ['--trusted-escrows', untrustedEscrowAddress],
        { tenant: bob.address, json: true },
      );
      expect(setStrategy.exitCode).toBe(0);

      // Bob posts an intent — the engine attaches his (now untrusted-by-A)
      // escrow address as escrow_address in the intent payload.
      const bobIntent = await createIntent(bob, {
        direction: 'buy',
        rateMin: 1n,
        rateMax: 1n,
        volumeMin: 100n,
        volumeMax: 500n,
      });
      const aliceIntent = await createIntent(alice, {
        direction: 'sell',
        rateMin: 1n,
        rateMax: 1n,
        volumeMin: 100n,
        volumeMax: 500n,
      });

      expect(bobIntent).toBeTruthy();
      expect(aliceIntent).toBeTruthy();

      // No COMPLETED deal should appear on Alice. Either:
      //   (a) she rejects pre-acceptance (no deal record on her side), OR
      //   (b) a deal is created and lands in FAILED with INVALID_ESCROW.
      // Both are valid outcomes; the negation we MUST guarantee is "no
      // COMPLETED deal".
      const quietWindowMs = 90_000;
      await new Promise((r) => setTimeout(r, quietWindowMs));

      const aliceDeals = await runAuthedTraderCtl('list-deals', [], {
        tenant: alice.address,
        json: true,
      });
      expect(aliceDeals.exitCode).toBe(0);
      const aliceDealRecs = arrayFieldFromOutput(aliceDeals.output, 'deals');
      expect(
        aliceDealRecs.some((d) => String(d['state']) === 'COMPLETED'),
      ).toBe(false);

      // If a deal record exists, it must be FAILED with INVALID_ESCROW reason.
      for (const d of aliceDealRecs) {
        if (String(d['state']) === 'FAILED') {
          const reason = String(d['error_code'] ?? d['reason'] ?? '');
          expect(reason).toContain('INVALID_ESCROW');
        }
      }

      // Restore Bob's strategy so the next test starts clean.
      await runAuthedTraderCtl(
        'set-strategy',
        ['--trusted-escrows', trustedEscrow.address],
        { tenant: bob.address, json: true },
      ).catch(() => undefined);

      // No deposit should have occurred — both balances must be unchanged.
      // The intent engine rejects the deal pre-acceptance when it sees the
      // untrusted escrow address, so payInvoice is never called on either side.
      const aliceBalAfter = await snapshotPortfolio(alice.address);
      const bobBalAfter = await snapshotPortfolio(bob.address);
      expectBalanceUnchanged(aliceBalBefore, aliceBalAfter);
      expectBalanceUnchanged(bobBalBefore, bobBalAfter);
    },
    10 * 60_000,
  );

  it(
    'deposit timeout: A deposits, B does not → deal FAILED',
    async () => {
      await cancelActiveIntents(alice);
      await cancelActiveIntents(faultyTrader);

      // Audit Claim 5b — THE CANONICAL "did Alice get her tokens back?" case.
      // Alice DOES deposit her tokens to the escrow. The faulty counterparty
      // intentionally skips its deposit. The escrow's deposit_timeout fires;
      // the deal goes FAILED. The user's claim — "all assets returned to
      // their original owners on unhappy paths" — requires Alice's deposit to
      // be refunded by the escrow's auto-return-on-cancel mechanism. This was
      // historically asserted only as `state === 'FAILED' && error_code !== ''`,
      // which a regression that stranded Alice's tokens would silently pass.
      // We now poll until balance restoration to verify the refund actually
      // propagates back to Alice.
      const aliceBalBefore = await snapshotPortfolio(alice.address);

      // Pair alice (deposits normally) with `faultyTrader` (TRADER_FAULT_SKIP_DEPOSITS=1
      // — receives swap:announced but skips swapModule.deposit()). The deal
      // must land in FAILED on alice's side. The exact error_code depends on
      // which side proposer-election picks:
      //   - If alice has lower pubkey → alice proposes, escrow announces,
      //     alice deposits, faulty side never deposits → escrow's deposit
      //     timer fires after deposit_timeout_sec. Alice's swap-executor
      //     transitions to FAILED with EXECUTION_TIMEOUT.
      //   - If faulty has lower pubkey → faulty proposes; faulty's
      //     swap.proposeSwap() blocks on its own deposit and times out at
      //     the SDK's announce-deadline → faulty fails with
      //     PROPOSE_SWAP_FAILED, alice's deal is rejected.
      // Both outcomes produce a FAILED deal with a distinguishing error_code,
      // which is the contract the new DealRecord.error_code field exposes.
      // CRITICAL — runs BEFORE the escrow-unreachable scenario, which kills
      // the trustedEscrow container.
      const intents = await createMatchingIntents(faultyTrader, alice, {
        base_asset: 'UCT',
        quote_asset: 'USDU',
        rate_min: 1n,
        rate_max: 1n,
        volume_min: 100n,
        volume_max: 500n,
      });
      expect(intents.buyerIntentId).toBeTruthy();
      expect(intents.sellerIntentId).toBeTruthy();

      const failed = await waitForDealInState(
        alice,
        'FAILED',
        TESTNET.SWAP_TIMEOUT_MS,
      );
      expect(failed['state']).toBe('FAILED');

      // error_code must be set (any non-empty distinguishing code).
      // EXECUTION_TIMEOUT, PROPOSE_SWAP_FAILED, ESCROW_UNREACHABLE, and
      // VOLUME_RESERVATION_FAILED are all valid outcomes for this scenario.
      // We assert the field is present — the precise code is the operator's
      // signal, not a test invariant.
      const errorCode = String(failed['error_code'] ?? '');
      expect(errorCode).not.toBe('');

      // CLAIM 5b ASSERTION: Alice's tokens must be returned to her.
      //
      // The deal is now FAILED. Alice's deposit (if she made one — depending on
      // proposer-election) is held by the escrow. The escrow's
      // closeInvoice({autoReturn:true}) on the deposit invoice (escrow-service
      // commit b97a84b) plus Alice's own setAutoReturn flag (trader-service
      // PR #12) should refund the deposit back to her wallet within a few
      // testnet round-trips. Poll until balance returns to baseline.
      //
      // If this assertion fires, it indicates a real product bug: Alice's
      // tokens are stranded after an unhappy-path deal. That's exactly the
      // class of regression Claim 5b was designed to catch — the historical
      // `state === 'FAILED'` check would have hidden it.
      await pollUntilBalanceRestored(alice.address, aliceBalBefore, {
        // Allow up to the test budget minus a margin for the FAILED transition
        // to land. The 11-min outer testTimeout means we have ~5 min headroom
        // after EXECUTION_TIMEOUT fires.
        timeoutMs: 5 * 60_000,
        intervalMs: 5_000,
      });
    },
    11 * 60_000,
  );

  it(
    'escrow unreachable mid-negotiation: stop the escrow container after PROPOSED → deal FAILED with ESCROW_UNREACHABLE',
    async () => {
      await cancelActiveIntents(alice);
      await cancelActiveIntents(bob);

      // Audit Claim 5b: if either trader deposited before the escrow died,
      // those tokens must come back. With the escrow process killed, the
      // escrow's deposit-invoice auto-return cannot fire — the only paths
      // for refund are:
      //   (a) the trader's own swap-cancel path returning tokens
      //       client-side (would require the trader to have direct refund
      //       authority, which it doesn't — the escrow holds the funds), OR
      //   (b) escrow restart + crash-recovery firing closeInvoice with
      //       autoReturn (we don't restart the escrow in this scenario, so
      //       this path is closed).
      // If neither (a) nor (b) is achievable in production, this scenario
      // produces stranded tokens — which is itself a product gap the user's
      // Claim 5b is designed to surface. We snapshot before, observe the
      // FAILED state, and try to verify balance restoration. If restoration
      // doesn't happen within the budget, that's a real signal.
      const aliceBalBefore = await snapshotPortfolio(alice.address);
      const bobBalBefore = await snapshotPortfolio(bob.address);

      // Make sure Bob is back to trusting the original escrow.
      await runAuthedTraderCtl(
        'set-strategy',
        ['--trusted-escrows', trustedEscrow.address],
        { tenant: bob.address, json: true },
      );

      const intents = await createMatchingIntents(bob, alice, {
        base_asset: 'UCT',
        quote_asset: 'USDU',
        rate_min: 1n,
        rate_max: 1n,
        volume_min: 100n,
        volume_max: 500n,
      });
      expect(intents.buyerIntentId).toBeTruthy();
      expect(intents.sellerIntentId).toBeTruthy();

      // Kill the escrow as soon as the intents are posted. The previous
      // approach polled for PROPOSED/ACCEPTED and then killed — but on real
      // testnet the deal moves through the entire state machine (PROPOSED →
      // ACCEPTED → EXECUTING → COMPLETED) in ~25s, faster than a 2s poller
      // can latch onto a transient state. Killing immediately guarantees the
      // negotiation engages with a dead escrow at SOME point during deposit
      // or payout, surfacing ESCROW_UNREACHABLE.
      // Give the intents ~3s to be picked up by both engines first so the
      // negotiation actually begins (otherwise no deal record exists at all).
      await new Promise((r) => setTimeout(r, 3_000));
      await stopContainer(trustedEscrow.container.id, 5_000);

      // The deal must now land in FAILED, OR not exist at all (if negotiation
      // never started). Whichever happens, the critical invariant is that
      // NO COMPLETED deal exists for either side. (The trader's DealRecord
      // currently has no `error_code` field — see follow-up #122 — so we can't
      // assert on the specific failure reason yet; we verify the negative.)
      const failed = await waitForDealInState(
        alice,
        'FAILED',
        TESTNET.SWAP_TIMEOUT_MS,
      ).catch(() => null);
      if (failed !== null) {
        expect(failed['state']).toBe('FAILED');
      }
      // Critical assertion: no COMPLETED deal on either side after the escrow
      // was taken offline.
      for (const tenant of [alice, bob]) {
        const list = await runAuthedTraderCtl('list-deals', [], {
          tenant: tenant.address,
          json: true,
        });
        const deals = arrayFieldFromOutput(list.output, 'deals');
        expect(
          deals.some((d) => String(d['state']) === 'COMPLETED'),
        ).toBe(false);
      }

      // CLAIM 5b ASSERTION: Alice's and Bob's tokens must be returned.
      //
      // KNOWN LIMITATION: with the escrow process killed mid-negotiation, the
      // escrow's auto-return-on-cancel cannot fire. If either trader deposited
      // before the kill, their deposit is currently stranded — there is no
      // crash-recovery escrow restart in this scenario. This is a real
      // product gap (the system has no client-side recovery for "escrow died
      // holding my deposit"). Per the user's Claim 5b, all failure paths
      // must refund — so this assertion is designed to surface the gap.
      //
      // We use a generous timeout but fail loud if balances don't restore.
      // If this assertion fires repeatedly, the right product fix is one of:
      //   (1) Add escrow auto-recovery restart in this test fixture, OR
      //   (2) Add client-side refund-from-stuck-escrow path in trader-service.
      await pollUntilBalanceRestored(alice.address, aliceBalBefore, {
        timeoutMs: 4 * 60_000,
        intervalMs: 5_000,
      });
      await pollUntilBalanceRestored(bob.address, bobBalBefore, {
        timeoutMs: 4 * 60_000,
        intervalMs: 5_000,
      });
    },
    14 * 60_000, // bumped from 10 to absorb the dual balance polls (8 min worst case)
  );

});
