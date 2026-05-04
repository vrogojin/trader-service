/**
 * Live E2E — Disjoint-pairs simultaneous swap.
 *
 * DIAGNOSTIC: isolates the question "can the escrow handle multiple
 * simultaneous swaps?" from the question "can a single trader handle
 * multiple simultaneous swaps?" by giving every trader exactly ONE deal.
 *
 * Setup:
 *   - 1 escrow (shared)
 *   - 4 traders: alice, bob, carol, dave (fresh keys)
 *
 * Scenario:
 *   - alice (sell rate=1, vol=200) ↔ bob (buy rate=1, vol=200)   — pair 1
 *   - carol (sell rate=2, vol=100) ↔ dave (buy rate=2, vol=100)  — pair 2
 *   - Both pairs post intents in close succession; the escrow ends up with
 *     two concurrent swaps.
 *   - All 4 traders must reach COMPLETED.
 *
 * Pass → escrow architecturally supports parallel swaps (per-swap state
 *   machine isolation works under load); any remaining failure in the
 *   3-trader scenario is specifically about one trader handling two
 *   simultaneous swaps (single-wallet contention on payouts/deposits).
 *
 * Fail → escrow has a parallel-swap bug; the on-failure log dump (escrow
 *   container logs are now captured by waitForDealInState) tells us where.
 *
 * Sister scenario to `multi-agent.e2e-live.test.ts > 3 traders ...`. Lives
 * in a separate file so it can be enabled/disabled independently while we
 * triage the underlying issue.
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
import { TESTNET } from './helpers/constants.js';
import {
  snapshotPortfolio,
  expectBalanceDelta,
} from './helpers/portfolio-assertions.js';

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
let dave: ProvisionedTenant;

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
  },
): Promise<string> {
  const argv: string[] = [
    '--direction', args.direction,
    '--base', 'UCT',
    '--quote', 'USDU',
    '--rate-min', args.rateMin.toString(),
    '--rate-max', args.rateMax.toString(),
    '--volume-min', args.volumeMin.toString(),
    '--volume-max', args.volumeMax.toString(),
  ];
  const result = await runAuthedTraderCtl('create-intent', argv, {
    tenant: tenant.address,
    json: true,
  });
  if (result.exitCode !== 0) {
    throw new Error(`create-intent failed (exit=${result.exitCode}): ${result.stderr}`);
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
    label: 'disjoint-escrow',
    relayUrls: [...TESTNET.RELAYS],
    readyTimeoutMs: 180_000,
  });
  // Staggered-parallel provisioning — concurrent with a small kickoff delay
  // between traders to avoid simultaneous nametag-registration hits on the
  // aggregator (pure Promise.all has been observed to hang one of N traders
  // at sphere init for ~3 minutes).
  [alice, bob, carol, dave] = await provisionTradersStaggered([
    () => provisionTrader({
      label: 'disjoint-alice',
      trustedEscrows: [escrow.address],
      relayUrls: [...TESTNET.RELAYS],
      waitForReady: true,
      readyTimeoutMs: 180_000,
      fundFromFaucet: true,
    }),
    () => provisionTrader({
      label: 'disjoint-bob',
      trustedEscrows: [escrow.address],
      relayUrls: [...TESTNET.RELAYS],
      waitForReady: true,
      readyTimeoutMs: 180_000,
      fundFromFaucet: true,
    }),
    () => provisionTrader({
      label: 'disjoint-carol',
      trustedEscrows: [escrow.address],
      relayUrls: [...TESTNET.RELAYS],
      waitForReady: true,
      readyTimeoutMs: 180_000,
      fundFromFaucet: true,
    }),
    () => provisionTrader({
      label: 'disjoint-dave',
      trustedEscrows: [escrow.address],
      relayUrls: [...TESTNET.RELAYS],
      waitForReady: true,
      readyTimeoutMs: 180_000,
      fundFromFaucet: true,
    }),
  ]);
}, 900_000);

afterAll(async () => {
  const cleanups: Array<() => Promise<void>> = [
    async () => dave?.dispose(),
    async () => carol?.dispose(),
    async () => bob?.dispose(),
    async () => alice?.dispose(),
    async () => escrow?.dispose(),
  ];
  for (const fn of cleanups) {
    try {
      await fn();
    } catch (err) {
      console.error('[multi-agent-disjoint afterAll] cleanup error:', err);
    }
  }
}, 120_000);

describe('Multi-agent disjoint pairs', () => {
  it(
    '2 disjoint pairs swap simultaneously through the same escrow → all 4 traders complete',
    async () => {
      for (const t of [alice, bob, carol, dave]) {
        await cancelActiveIntents(t);
      }

      // Snapshot balances — Audit Claim 4: with two pairs swapping through
      // the same escrow, exact deltas are computable:
      //   Pair 1 (rate=1, vol=200): alice -200 UCT +200 USDU; bob +200 UCT -200 USDU
      //   Pair 2 (rate=2, vol=100): carol -100 UCT +200 USDU; dave +100 UCT -200 USDU
      const aliceBalBefore = await snapshotPortfolio(alice.address);
      const bobBalBefore = await snapshotPortfolio(bob.address);
      const carolBalBefore = await snapshotPortfolio(carol.address);
      const daveBalBefore = await snapshotPortfolio(dave.address);

      // Pair 1 — alice (sell @ 1) ↔ bob (buy @ 1), 200 UCT
      // Pair 2 — carol (sell @ 2) ↔ dave (buy @ 2), 100 UCT
      // Posting sequentially (not Promise.all) — parallel trader-ctl invocations
      // race on the controller-wallet LevelDB lock; sequential keeps the wire
      // operations clean while the on-network arrival of intents still drives
      // both pairs into simultaneous matching/negotiation.
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
        direction: 'sell',
        rateMin: 2n,
        rateMax: 2n,
        volumeMin: 100n,
        volumeMax: 100n,
      });
      await createIntent(dave, {
        direction: 'buy',
        rateMin: 2n,
        rateMax: 2n,
        volumeMin: 100n,
        volumeMax: 100n,
      });

      // Each trader must observe its OWN deal reach COMPLETED. The escrow has
      // two simultaneous swaps in flight; if it can't process them in
      // parallel, at least one pair's COMPLETED never lands and we get the
      // EXECUTION_TIMEOUT on the laggard.
      const [aliceDeal, bobDeal, carolDeal, daveDeal] = await Promise.all([
        waitForDealInState(alice, 'COMPLETED', TESTNET.SWAP_TIMEOUT_MS),
        waitForDealInState(bob, 'COMPLETED', TESTNET.SWAP_TIMEOUT_MS),
        waitForDealInState(carol, 'COMPLETED', TESTNET.SWAP_TIMEOUT_MS),
        waitForDealInState(dave, 'COMPLETED', TESTNET.SWAP_TIMEOUT_MS),
      ]);

      expect(aliceDeal['state']).toBe('COMPLETED');
      expect(bobDeal['state']).toBe('COMPLETED');
      expect(carolDeal['state']).toBe('COMPLETED');
      expect(daveDeal['state']).toBe('COMPLETED');

      // Sanity: the two pairs negotiated DIFFERENT deals — alice/bob share one
      // deal_id, carol/dave share the other, and the two are not equal.
      expect(aliceDeal['deal_id']).toBe(bobDeal['deal_id']);
      expect(carolDeal['deal_id']).toBe(daveDeal['deal_id']);
      expect(aliceDeal['deal_id']).not.toBe(carolDeal['deal_id']);

      // Wait for inbound payouts to finalize (15s receive loop + margin).
      await new Promise((resolve) => setTimeout(resolve, 8_000));

      // Exact balance assertions — both pairs swapped through the same escrow
      // with no cross-contamination.
      const aliceBalAfter = await snapshotPortfolio(alice.address);
      const bobBalAfter = await snapshotPortfolio(bob.address);
      const carolBalAfter = await snapshotPortfolio(carol.address);
      const daveBalAfter = await snapshotPortfolio(dave.address);
      expectBalanceDelta(aliceBalBefore, aliceBalAfter, { UCT: -200n, USDU: 200n });
      expectBalanceDelta(bobBalBefore, bobBalAfter, { UCT: 200n, USDU: -200n });
      expectBalanceDelta(carolBalBefore, carolBalAfter, { UCT: -100n, USDU: 200n });
      expectBalanceDelta(daveBalBefore, daveBalAfter, { UCT: 100n, USDU: -200n });
    },
    TESTNET.SWAP_TIMEOUT_MS + 120_000,
  );
});
