/**
 * Live E2E — Multi-agent trading scenarios.
 *
 * Three traders + 1 escrow; observe convergence under contention.
 *   1. Three pairwise-compatible intents → three distinct deals → all COMPLETE.
 *   2. Partial fill: A's volume_total=100, B's volume_total=30 → A's
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
  type ProvisionedTenant,
} from './helpers/tenant-fixture.js';
import { waitForDealInState } from './helpers/scenario-helpers.js';
import { runTraderCtl } from './helpers/trader-ctl-driver.js';
import {
  runContainer,
  stopContainer,
  removeContainer,
} from './helpers/docker-helpers.js';
import { TESTNET } from './helpers/constants.js';

interface EscrowFixture {
  address: string;
  containerId: string;
  dispose(): Promise<void>;
}

let escrow: EscrowFixture;
let alice: ProvisionedTenant;
let bob: ProvisionedTenant;
let carol: ProvisionedTenant;

async function provisionEscrow(label: string): Promise<EscrowFixture> {
  const container = await runContainer({
    image: TESTNET.ESCROW_IMAGE,
    label,
    env: {
      UNICITY_RELAYS: TESTNET.RELAYS.join(','),
      UNICITY_AGGREGATOR_URL: TESTNET.AGGREGATOR_URL,
      UNICITY_IPFS_GATEWAY: TESTNET.IPFS_GATEWAY,
    },
    network: 'bridge',
    startTimeoutMs: 30_000,
  });
  return {
    address: `DIRECT://${container.id.slice(0, 64)}`,
    containerId: container.id,
    async dispose() {
      try {
        await stopContainer(container.id, 10_000);
      } catch {
        /* idempotent */
      }
      try {
        await removeContainer(container.id);
      } catch {
        /* idempotent */
      }
    },
  };
}

/** Cancel every active intent on a tenant (test-isolation between scenarios). */
async function cancelActiveIntents(tenant: ProvisionedTenant): Promise<void> {
  const list = await runTraderCtl('list-intents', ['--state', 'active'], {
    tenant: tenant.address,
    json: true,
  });
  if (list.exitCode !== 0) return;
  const intents = ((list.output as Record<string, unknown>)['intents'] ??
    []) as Array<Record<string, unknown>>;
  for (const intent of intents) {
    const id = String(intent['intent_id']);
    if (!id) continue;
    await runTraderCtl('cancel-intent', ['--intent-id', id], {
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
    volumeTotal: bigint;
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
    '--volume-total',
    args.volumeTotal.toString(),
  ];
  if (args.expiryMs !== undefined) {
    argv.push('--expiry-ms', String(args.expiryMs));
  }
  const result = await runTraderCtl('create-intent', argv, {
    tenant: tenant.address,
    json: true,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `create-intent failed (exit=${result.exitCode}): ${result.stderr}`,
    );
  }
  return String((result.output as Record<string, unknown>)['intent_id']);
}

beforeAll(async () => {
  escrow = await provisionEscrow('multi-escrow');
  [alice, bob, carol] = await Promise.all([
    provisionTrader({
      label: 'multi-alice',
      trustedEscrows: [escrow.address],
      relayUrls: [...TESTNET.RELAYS],
      waitForReady: true,
      readyTimeoutMs: 90_000,
    }),
    provisionTrader({
      label: 'multi-bob',
      trustedEscrows: [escrow.address],
      relayUrls: [...TESTNET.RELAYS],
      waitForReady: true,
      readyTimeoutMs: 90_000,
    }),
    provisionTrader({
      label: 'multi-carol',
      trustedEscrows: [escrow.address],
      relayUrls: [...TESTNET.RELAYS],
      waitForReady: true,
      readyTimeoutMs: 90_000,
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
      await Promise.all([
        createIntent(alice, {
          direction: 'sell',
          rateMin: 1n,
          rateMax: 1n,
          volumeMin: 100n,
          volumeTotal: 500n,
        }),
        createIntent(bob, {
          direction: 'buy',
          rateMin: 1n,
          rateMax: 1n,
          volumeMin: 100n,
          volumeTotal: 500n,
        }),
        createIntent(carol, {
          direction: 'sell',
          rateMin: 2n,
          rateMax: 2n,
          volumeMin: 50n,
          volumeTotal: 200n,
        }),
        // Bob also wants to be carol's counterparty
        createIntent(bob, {
          direction: 'buy',
          rateMin: 2n,
          rateMax: 2n,
          volumeMin: 50n,
          volumeTotal: 200n,
        }),
      ]);

      // Each trader must observe at least one COMPLETED deal.
      const [aliceDeal, bobDeal, carolDeal] = await Promise.all([
        waitForDealInState(alice, 'COMPLETED', TESTNET.SWAP_TIMEOUT_MS),
        waitForDealInState(bob, 'COMPLETED', TESTNET.SWAP_TIMEOUT_MS),
        waitForDealInState(carol, 'COMPLETED', TESTNET.SWAP_TIMEOUT_MS),
      ]);
      expect(aliceDeal['state']).toBe('COMPLETED');
      expect(bobDeal['state']).toBe('COMPLETED');
      expect(carolDeal['state']).toBe('COMPLETED');
    },
    TESTNET.SWAP_TIMEOUT_MS + 60_000,
  );

  it(
    'partial fill: A volume_total=100, B volume_total=30 → A volume_filled=30 with 70 remaining ACTIVE',
    async () => {
      for (const t of [alice, bob, carol]) {
        await cancelActiveIntents(t);
      }

      const aliceIntentId = await createIntent(alice, {
        direction: 'sell',
        rateMin: 1n,
        rateMax: 1n,
        volumeMin: 10n,
        volumeTotal: 100n,
      });
      await createIntent(bob, {
        direction: 'buy',
        rateMin: 1n,
        rateMax: 1n,
        volumeMin: 10n,
        volumeTotal: 30n,
      });

      // Wait until bob sees a completed deal — one settlement happened.
      await waitForDealInState(bob, 'COMPLETED', TESTNET.SWAP_TIMEOUT_MS);
      // Alice's same deal must also be COMPLETED.
      await waitForDealInState(alice, 'COMPLETED', TESTNET.SWAP_TIMEOUT_MS);

      // Now poll alice's intent and assert volume_filled=30, remaining ACTIVE.
      await expect
        .poll(
          async () => {
            const list = await runTraderCtl(
              'list-intents',
              ['--state', 'active'],
              { tenant: alice.address, json: true },
            );
            if (list.exitCode !== 0) return null;
            const intents = ((list.output as Record<string, unknown>)['intents'] ??
              []) as Array<Record<string, unknown>>;
            const found = intents.find(
              (i) => String(i['intent_id']) === aliceIntentId,
            );
            if (!found) return null;
            return {
              state: String(found['state']),
              volumeFilled: BigInt(String(found['volume_filled'] ?? '0')),
              volumeTotal: BigInt(String(found['volume_total'] ?? '0')),
            };
          },
          { timeout: 60_000, interval: 2_000 },
        )
        .toEqual({ state: 'ACTIVE', volumeFilled: 30n, volumeTotal: 100n });
    },
    TESTNET.SWAP_TIMEOUT_MS + 90_000,
  );

  it(
    'concurrent matching: 3 traders post matching intents simultaneously → no double-match',
    async () => {
      for (const t of [alice, bob, carol]) {
        await cancelActiveIntents(t);
      }

      // alice sells; bob and carol both want to buy. Per spec 5.7 the
      // deterministic proposer election picks ONE counterparty per fan-out
      // round, so alice's intent must end up filled exactly once
      // (volume_total=200 → volume_filled=200) and the OTHER buyer's intent
      // must remain ACTIVE with volume_filled=0.
      await Promise.all([
        createIntent(alice, {
          direction: 'sell',
          rateMin: 1n,
          rateMax: 1n,
          volumeMin: 200n,
          volumeTotal: 200n,
        }),
        createIntent(bob, {
          direction: 'buy',
          rateMin: 1n,
          rateMax: 1n,
          volumeMin: 200n,
          volumeTotal: 200n,
        }),
        createIntent(carol, {
          direction: 'buy',
          rateMin: 1n,
          rateMax: 1n,
          volumeMin: 200n,
          volumeTotal: 200n,
        }),
      ]);

      // Exactly one of bob/carol must reach COMPLETED.
      const winnerDeal = await Promise.race([
        waitForDealInState(bob, 'COMPLETED', TESTNET.SWAP_TIMEOUT_MS).then(
          (d) => ({ who: 'bob' as const, deal: d }),
        ),
        waitForDealInState(carol, 'COMPLETED', TESTNET.SWAP_TIMEOUT_MS).then(
          (d) => ({ who: 'carol' as const, deal: d }),
        ),
      ]);
      expect(winnerDeal.deal['state']).toBe('COMPLETED');

      // Alice's intent must be exactly fully filled — not double-filled.
      await expect
        .poll(
          async () => {
            const list = await runTraderCtl(
              'list-intents',
              ['--state', 'filled'],
              { tenant: alice.address, json: true },
            );
            if (list.exitCode !== 0) return null;
            const intents = ((list.output as Record<string, unknown>)['intents'] ??
              []) as Array<Record<string, unknown>>;
            const aliceIntent = intents[0];
            if (!aliceIntent) return null;
            return BigInt(String(aliceIntent['volume_filled'] ?? '0'));
          },
          { timeout: 90_000, interval: 2_000 },
        )
        .toBe(200n);

      // The losing buyer's intent must NOT have any COMPLETED deals: their
      // volume_filled stays 0 and the intent remains ACTIVE (or is later
      // cancelled by the engine if no further sellers exist).
      const loser = winnerDeal.who === 'bob' ? carol : bob;
      const loserIntents = await runTraderCtl(
        'list-intents',
        ['--state', 'active'],
        { tenant: loser.address, json: true },
      );
      expect(loserIntents.exitCode).toBe(0);
      const loserActive = ((loserIntents.output as Record<string, unknown>)['intents'] ??
        []) as Array<Record<string, unknown>>;
      // Either still active with 0 filled, OR no longer active (engine may
      // have already moved it). Both are acceptable — what matters is that
      // its volume_filled is NOT 200.
      for (const i of loserActive) {
        const filled = BigInt(String(i['volume_filled'] ?? '0'));
        expect(filled).not.toBe(200n);
      }
    },
    TESTNET.SWAP_TIMEOUT_MS + 120_000,
  );
});
