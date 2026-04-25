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
  type ProvisionedTenant,
} from './helpers/tenant-fixture.js';
import {
  createMatchingIntents,
  waitForDealInState,
} from './helpers/scenario-helpers.js';
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

let trustedEscrow: EscrowFixture;
/** Provisioned but NEVER added to anyone's `trusted_escrows`. */
let untrustedEscrow: EscrowFixture;
let alice: ProvisionedTenant;
let bob: ProvisionedTenant;

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
  trustedEscrow = await provisionEscrow('failures-trusted-escrow');
  untrustedEscrow = await provisionEscrow('failures-untrusted-escrow');

  // Both traders trust ONLY trustedEscrow. The untrusted-escrow scenario
  // re-targets via SET_STRATEGY mid-test rather than re-provisioning a
  // trader, to keep faucet hits low.
  [alice, bob] = await Promise.all([
    provisionTrader({
      label: 'fail-alice',
      trustedEscrows: [trustedEscrow.address],
      relayUrls: [...TESTNET.RELAYS],
      waitForReady: true,
      readyTimeoutMs: 90_000,
    }),
    provisionTrader({
      label: 'fail-bob',
      trustedEscrows: [trustedEscrow.address],
      relayUrls: [...TESTNET.RELAYS],
      waitForReady: true,
      readyTimeoutMs: 90_000,
    }),
  ]);
}, 600_000);

afterAll(async () => {
  const cleanups: Array<() => Promise<void>> = [
    async () => bob?.dispose(),
    async () => alice?.dispose(),
    async () => trustedEscrow?.dispose(),
    async () => untrustedEscrow?.dispose(),
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

      // Repoint Bob at the untrusted escrow ONLY for this test. Alice still
      // only trusts the original. Bob will create his intent advertising
      // untrustedEscrow, which Alice's intent-engine must reject when it
      // sees the proposal.
      const setStrategy = await runTraderCtl(
        'set-strategy',
        ['--trusted-escrows', untrustedEscrow.address],
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
        volumeTotal: 500n,
      });
      const aliceIntent = await createIntent(alice, {
        direction: 'sell',
        rateMin: 1n,
        rateMax: 1n,
        volumeMin: 100n,
        volumeTotal: 500n,
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

      const aliceDeals = await runTraderCtl('list-deals', [], {
        tenant: alice.address,
        json: true,
      });
      expect(aliceDeals.exitCode).toBe(0);
      const aliceDealRecs = ((aliceDeals.output as Record<string, unknown>)['deals'] ??
        []) as Array<Record<string, unknown>>;
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
      await runTraderCtl(
        'set-strategy',
        ['--trusted-escrows', trustedEscrow.address],
        { tenant: bob.address, json: true },
      ).catch(() => undefined);
    },
    10 * 60_000,
  );

  it(
    'escrow unreachable mid-negotiation: stop the escrow container after PROPOSED → deal FAILED with ESCROW_UNREACHABLE',
    async () => {
      await cancelActiveIntents(alice);
      await cancelActiveIntents(bob);

      // Make sure Bob is back to trusting the original escrow.
      await runTraderCtl(
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
        volume_total: 500n,
      });
      expect(intents.buyerIntentId).toBeTruthy();
      expect(intents.sellerIntentId).toBeTruthy();

      // Wait until at least one side observes the deal in PROPOSED — this
      // confirms negotiation has begun and proves the escrow has been
      // engaged. THEN kill the escrow.
      await waitForDealInState(alice, 'PROPOSED', 120_000).catch(async () => {
        // Some implementations skip PROPOSED and go straight to ACCEPTED if
        // the second-leg DM is already in flight. Treat ACCEPTED as
        // equivalent for the kill-trigger.
        await waitForDealInState(alice, 'ACCEPTED', 120_000);
      });

      // Take the escrow OFFLINE — SIGTERM, then SIGKILL after grace period.
      await stopContainer(trustedEscrow.containerId, 5_000);

      // The deal must now land in FAILED. Allow up to SWAP_TIMEOUT_MS for
      // the trader's escrow-unreachable detection (heartbeat + retries).
      const failed = await waitForDealInState(
        alice,
        'FAILED',
        TESTNET.SWAP_TIMEOUT_MS,
      );
      expect(failed['state']).toBe('FAILED');
      const reason = String(failed['error_code'] ?? failed['reason'] ?? '');
      expect(reason).toContain('ESCROW_UNREACHABLE');
    },
    10 * 60_000,
  );

  it.skip(
    'deposit timeout: A deposits, B does not → both refunded, deal FAILED',
    async () => {
      // SKIPPED: requires the ability to start a swap and selectively block
      // ONE peer's deposit transaction. trader-ctl exposes no
      // hook to short-circuit a peer's deposit step. Implementing this
      // would require either:
      //   (1) a debug/fault-injection command on the trader (e.g.
      //       `trader-ctl fault inject deposit-skip`), OR
      //   (2) running one peer with a wallet that has zero funds so its
      //       deposit transaction reliably fails to confirm.
      //
      // (2) is feasible if `provisionTrader` exposes a `skipFaucetFunding`
      // option. As of the current contracts.ts that option is not
      // declared, so we leave this scenario as a TODO marker that lights
      // up automatically once the harness gains the capability.
    },
  );
});
