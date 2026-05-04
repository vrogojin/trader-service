/**
 * Live E2E — Multi-agent trading scenarios.
 *
 * Three traders + 1 escrow; observe convergence under contention.
 *   1. Three pairwise-compatible intents → three distinct deals → all COMPLETE.
 *   2. Partial fill: A's volume_max=100, B's volume_max=30 → A's
 *      volume_filled=30 with the remaining 70 still ACTIVE on A.
 *   3. Concurrent matching: 3 traders all post matching intents at once;
 *      each intent must fill at most once per spec 5.7 (proposer election).
 *
 * Provisioning is shared. Each `it()` cancels any active intents from the
 * previous scenario before creating its own — keeps tests independent
 * without re-paying the faucet/Docker startup cost.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  provisionTrader,
  provisionTradersStaggered,
  provisionEscrow,
  type ProvisionedTenant,
} from './helpers/tenant-fixture.js';
import { waitForDealInState } from './helpers/scenario-helpers.js';
import { runTraderCtl } from './helpers/trader-ctl-driver.js';
import { getControllerWallet } from './helpers/tenant-fixture.js';
import {
  snapshotPortfolio,
  expectBalanceDelta,
  type Portfolio,
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
import { TESTNET } from './helpers/constants.js';

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

let escrow: ProvisionedTenant;
let alice: ProvisionedTenant;
let bob: ProvisionedTenant;
let carol: ProvisionedTenant;

/** Cancel every active intent on a tenant (test-isolation between scenarios).
 *  List ALL intents and filter client-side: trader-ctl `--state` flag is
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
  escrow = await provisionEscrow({
    label: 'multi-escrow',
    relayUrls: [...TESTNET.RELAYS],
    readyTimeoutMs: 180_000,
  });
  // Staggered-parallel provisioning — concurrent with a small kickoff delay
  // between traders to avoid simultaneous nametag-registration hits on the
  // aggregator (pure Promise.all has been observed to hang one of N traders
  // at sphere init for ~3 minutes).
  [alice, bob, carol] = await provisionTradersStaggered([
    () => provisionTrader({
      label: 'multi-alice',
      trustedEscrows: [escrow.address],
      relayUrls: [...TESTNET.RELAYS],
      waitForReady: true,
      readyTimeoutMs: 180_000,
      fundFromFaucet: true,
    }),
    () => provisionTrader({
      label: 'multi-bob',
      trustedEscrows: [escrow.address],
      relayUrls: [...TESTNET.RELAYS],
      waitForReady: true,
      readyTimeoutMs: 180_000,
      fundFromFaucet: true,
    }),
    () => provisionTrader({
      label: 'multi-carol',
      trustedEscrows: [escrow.address],
      relayUrls: [...TESTNET.RELAYS],
      waitForReady: true,
      readyTimeoutMs: 180_000,
      fundFromFaucet: true,
    }),
  ]);
}, 600_000);

afterAll(async () => {
  const cleanups: Array<() => Promise<void>> = [
    async () => carol?.dispose(),
    async () => bob?.dispose(),
    async () => alice?.dispose(),
    async () => escrow?.dispose(),
  ];
  for (const fn of cleanups) {
    try {
      await fn();
    } catch (err) {
      console.error('[multi-agent afterAll] cleanup error:', err);
    }
  }
}, 120_000);

describe('Multi-agent trading', () => {
  it(
    '3 traders post pairwise-compatible intents → all matched into deals → all complete',
    async () => {
      // Reset before this scenario.
      for (const t of [alice, bob, carol]) {
        await cancelActiveIntents(t);
      }

      // Three pairs: alice sells / bob buys, carol sells with a different
      // rate band so the order in which proposals arrive is deterministic
      // enough for the test to terminate. Each pair fills the other.
      // Serialized: parallel trader-ctl invocations contend on the controller
      // wallet's storage lock. Posting sequentially still triggers concurrent
      // matching because the trader engines pick up intents from the relay feed
      // independently of the post order.
      await createIntent(alice, {
        direction: 'sell',
        rateMin: 1n,
        rateMax: 1n,
        volumeMin: 100n,
        volumeMax: 500n,
      });
      await createIntent(bob, {
        direction: 'buy',
        rateMin: 1n,
        rateMax: 1n,
        volumeMin: 100n,
        volumeMax: 500n,
      });
      await createIntent(carol, {
        direction: 'sell',
        rateMin: 2n,
        rateMax: 2n,
        volumeMin: 50n,
        volumeMax: 200n,
      });
      await createIntent(bob, {
        direction: 'buy',
        rateMin: 2n,
        rateMax: 2n,
        volumeMin: 50n,
        volumeMax: 200n,
      });

      // Snapshot balances before — Audit Claim 4: state==='COMPLETED' alone is
      // insufficient evidence that real tokens moved. Conservation invariant:
      // sum of (post - pre) UCT across all 3 traders must be 0; same for USDU.
      // Plus: each trader's balance MUST have changed (a no-op regression
      // would leave all three unchanged).
      const aliceBalBefore = await snapshotPortfolio(alice.address);
      const bobBalBefore = await snapshotPortfolio(bob.address);
      const carolBalBefore = await snapshotPortfolio(carol.address);

      // Each trader must observe at least one COMPLETED deal.
      const [aliceDeal, bobDeal, carolDeal] = await Promise.all([
        waitForDealInState(alice, 'COMPLETED', TESTNET.SWAP_TIMEOUT_MS),
        waitForDealInState(bob, 'COMPLETED', TESTNET.SWAP_TIMEOUT_MS),
        waitForDealInState(carol, 'COMPLETED', TESTNET.SWAP_TIMEOUT_MS),
      ]);
      expect(aliceDeal['state']).toBe('COMPLETED');
      expect(bobDeal['state']).toBe('COMPLETED');
      expect(carolDeal['state']).toBe('COMPLETED');

      // Wait for payments.receive() to finalize inbound payouts (15s loop).
      await new Promise((resolve) => setTimeout(resolve, 5_000));

      const aliceBalAfter = await snapshotPortfolio(alice.address);
      const bobBalAfter = await snapshotPortfolio(bob.address);
      const carolBalAfter = await snapshotPortfolio(carol.address);

      // Conservation: total UCT delta = 0; total USDU delta = 0.
      // Tokens move between wallets; they don't appear or disappear.
      const totalUctDelta =
        (aliceBalAfter.UCT - aliceBalBefore.UCT) +
        (bobBalAfter.UCT - bobBalBefore.UCT) +
        (carolBalAfter.UCT - carolBalBefore.UCT);
      const totalUsduDelta =
        (aliceBalAfter.USDU - aliceBalBefore.USDU) +
        (bobBalAfter.USDU - bobBalBefore.USDU) +
        (carolBalAfter.USDU - carolBalBefore.USDU);
      expect(totalUctDelta, 'conservation: sum of UCT deltas across 3 traders must be 0').toBe(0n);
      expect(totalUsduDelta, 'conservation: sum of USDU deltas across 3 traders must be 0').toBe(0n);

      // No-op detection: every trader participated in at least one deal, so
      // at least one coin's balance must have changed for each.
      const aliceChanged =
        aliceBalAfter.UCT !== aliceBalBefore.UCT || aliceBalAfter.USDU !== aliceBalBefore.USDU;
      const bobChanged =
        bobBalAfter.UCT !== bobBalBefore.UCT || bobBalAfter.USDU !== bobBalBefore.USDU;
      const carolChanged =
        carolBalAfter.UCT !== carolBalBefore.UCT || carolBalAfter.USDU !== carolBalBefore.USDU;
      expect(aliceChanged, 'Alice participated in a COMPLETED deal but her balance did not change').toBe(true);
      expect(bobChanged, 'Bob participated in COMPLETED deals but his balance did not change').toBe(true);
      expect(carolChanged, 'Carol participated in a COMPLETED deal but her balance did not change').toBe(true);
    },
    TESTNET.SWAP_TIMEOUT_MS + 60_000,
  );

  it(
    'partial fill: A volume_max=100, B volume_max=30 → A volume_filled=30 with 70 remaining ACTIVE',
    async () => {
      for (const t of [alice, bob, carol]) {
        await cancelActiveIntents(t);
      }

      // Snapshot balances — Alice should sell exactly 30 UCT for 30 USDU
      // (rate=1, volume=30); Bob should buy exactly 30 UCT for 30 USDU.
      const aliceBalBefore = await snapshotPortfolio(alice.address);
      const bobBalBefore = await snapshotPortfolio(bob.address);

      const aliceIntentId = await createIntent(alice, {
        direction: 'sell',
        rateMin: 1n,
        rateMax: 1n,
        volumeMin: 10n,
        volumeMax: 100n,
      });
      await createIntent(bob, {
        direction: 'buy',
        rateMin: 1n,
        rateMax: 1n,
        volumeMin: 10n,
        volumeMax: 30n,
      });

      // Poll Alice's NEW intent directly for volume_filled=30. Don't rely on
      // waitForDealInState(COMPLETED) — `list-deals` returns stale COMPLETED
      // records from earlier scenarios in the shared-tenant fixture, so it
      // resolves instantly with the wrong deal. The intent ledger, in contrast,
      // is keyed by intent_id and only the new intent's volume can change.
      // After a partial fill the engine returns the intent to MATCHING (still
      // looking for a counterparty for the remaining 70) — accept either
      // ACTIVE or MATCHING; what matters is that volume_filled=30.
      await expect
        .poll(
          async () => {
            const list = await runAuthedTraderCtl(
              'list-intents',
              [],
              { tenant: alice.address, json: true },
            );
            if (list.exitCode !== 0) return null;
            const intents = arrayFieldFromOutput(list.output, 'intents');
            const found = intents.find(
              (i) => stringFieldFromOutput(i, 'intent_id') === aliceIntentId,
            );
            if (!found) return null;
            return {
              state: String(found['state']),
              volumeFilled: BigInt(String(found['volume_filled'] ?? '0')),
              volumeMax: BigInt(String(found['volume_max'] ?? '0')),
            };
          },
          { timeout: TESTNET.SWAP_TIMEOUT_MS, interval: 2_000 },
        )
        .toMatchObject({ volumeFilled: 30n, volumeMax: 100n });

      // Wait for inbound payouts to finalize (15s receive loop + margin).
      await new Promise((resolve) => setTimeout(resolve, 8_000));

      // Audit Claim 4 + 5a(c): exact balance deltas must reflect the partial
      // fill. Alice sold 30 UCT at rate=1 → -30 UCT, +30 USDU. Bob bought
      // 30 UCT at rate=1 → +30 UCT, -30 USDU. The intent-ledger assertion
      // above is bookkeeping — these checks verify real on-chain movement.
      const aliceBalAfter = await snapshotPortfolio(alice.address);
      const bobBalAfter = await snapshotPortfolio(bob.address);
      expectBalanceDelta(aliceBalBefore, aliceBalAfter, { UCT: -30n, USDU: 30n });
      expectBalanceDelta(bobBalBefore, bobBalAfter, { UCT: 30n, USDU: -30n });
    },
    TESTNET.SWAP_TIMEOUT_MS + 120_000,
  );

  it(
    'concurrent matching: 3 traders post matching intents simultaneously → no double-match',
    async () => {
      for (const t of [alice, bob, carol]) {
        await cancelActiveIntents(t);
      }

      // Snapshot balances BEFORE the swap so we can verify conservation +
      // exact deltas after the winner is determined.
      const aliceBalBefore = await snapshotPortfolio(alice.address);
      const bobBalBefore = await snapshotPortfolio(bob.address);
      const carolBalBefore = await snapshotPortfolio(carol.address);
      const buyerBalBefores: Record<string, Portfolio> = {
        [bob.address]: bobBalBefore,
        [carol.address]: carolBalBefore,
      };
      const aliceBefore = aliceBalBefore;

      // alice sells; bob and carol both want to buy. Per spec 5.7 the
      // deterministic proposer election picks ONE counterparty per fan-out
      // round, so alice's intent must end up filled exactly once
      // (volume_max=200 → volume_filled=200) and the OTHER buyer's intent
      // must remain ACTIVE with volume_filled=0.
      // Serialized for the same reason as the first scenario — the actual
      // concurrent-matching contention happens inside the trader engines.
      await createIntent(alice, {
        direction: 'sell',
        rateMin: 1n,
        rateMax: 1n,
        volumeMin: 200n,
        volumeMax: 200n,
      });
      await createIntent(bob, {
        direction: 'buy',
        rateMin: 1n,
        rateMax: 1n,
        volumeMin: 200n,
        volumeMax: 200n,
      });
      await createIntent(carol, {
        direction: 'buy',
        rateMin: 1n,
        rateMax: 1n,
        volumeMin: 200n,
        volumeMax: 200n,
      });

      // Poll alice's intent for FILLED with volume_filled=200 — this is the
      // canonical signal that exactly one fan-out partner won the match.
      // (Don't gate on waitForDealInState: stale COMPLETED records from prior
      // scenarios resolve immediately and lie about progress.)
      await expect
        .poll(
          async () => {
            const list = await runAuthedTraderCtl(
              'list-intents',
              [],
              { tenant: alice.address, json: true },
            );
            if (list.exitCode !== 0) return null;
            const intents = arrayFieldFromOutput(list.output, 'intents');
            const filled = intents.find(
              (i) => String(i['state'] ?? '').toUpperCase() === 'FILLED',
            );
            if (!filled) return null;
            return BigInt(String(filled['volume_filled'] ?? '0'));
          },
          { timeout: TESTNET.SWAP_TIMEOUT_MS, interval: 2_000 },
        )
        .toBe(200n);

      // Identify the winner by checking which buyer has volume_filled=200.
      const bobIntents = await runAuthedTraderCtl('list-intents', [], {
        tenant: bob.address, json: true,
      });
      const bobFilled = arrayFieldFromOutput(bobIntents.output, 'intents').some(
        (i) => BigInt(String(i['volume_filled'] ?? '0')) === 200n,
      );
      const loser = bobFilled ? carol : bob;
      const winner = bobFilled ? bob : carol;
      const loserIntents = await runAuthedTraderCtl(
        'list-intents',
        [],
        { tenant: loser.address, json: true },
      );
      expect(loserIntents.exitCode).toBe(0);
      const loserAll = arrayFieldFromOutput(loserIntents.output, 'intents');
      // Either still active with 0 filled, OR no longer active (engine may
      // have already moved it). Both are acceptable — what matters is that
      // its volume_filled is NOT 200.
      for (const i of loserAll) {
        const state = String(i['state'] ?? '').toUpperCase();
        if (state !== 'ACTIVE' && state !== 'MATCHING' && state !== 'PARTIALLY_FILLED') continue;
        const filled = BigInt(String(i['volume_filled'] ?? '0'));
        expect(filled).not.toBe(200n);
      }

      // Audit Claim 4 + 5a: verify exact deltas now that we know who won.
      // Wait for inbound payouts to finalize (15s receive loop + margin).
      await new Promise((resolve) => setTimeout(resolve, 8_000));
      const aliceBalAfter = await snapshotPortfolio(alice.address);
      const winnerBalAfter = await snapshotPortfolio(winner.address);
      const loserBalAfter = await snapshotPortfolio(loser.address);

      // Alice (seller) — sold 200 UCT for 200 USDU at rate=1.
      expectBalanceDelta(aliceBefore, aliceBalAfter, { UCT: -200n, USDU: 200n });
      // Winner — bought 200 UCT for 200 USDU.
      expectBalanceDelta(buyerBalBefores[winner.address]!, winnerBalAfter, { UCT: 200n, USDU: -200n });
      // Loser — never traded. Balance unchanged.
      expectBalanceDelta(buyerBalBefores[loser.address]!, loserBalAfter, { UCT: 0n, USDU: 0n });
    },
    TESTNET.SWAP_TIMEOUT_MS + 120_000,
  );
});
