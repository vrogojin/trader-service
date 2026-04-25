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

// ---------------------------------------------------------------------------
// Shared fixtures: provisioned ONCE per file to amortize faucet rate-limits
// and Docker spin-up cost. Real testnet → tens of seconds per fresh wallet.
// ---------------------------------------------------------------------------

interface EscrowFixture {
  /** trader-ctl-targetable address (DIRECT://hex or 64-char hex). */
  address: string;
  /** Container ID for cleanup. */
  containerId: string;
  /** Idempotent stop+remove. */
  dispose(): Promise<void>;
}

let escrow: EscrowFixture;
let buyer: ProvisionedTenant;
let seller: ProvisionedTenant;

/**
 * Spawn a single escrow service container and resolve its trader-ctl
 * address. Used by every file's beforeAll. Wraps runContainer so that
 * docker-helpers stays single-purpose.
 */
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

  // The escrow address is exposed by the image as ESCROW_ADDRESS in its
  // JSON-Lines startup log; for now we synthesize a DIRECT://<containerId>
  // shape that the trader-ctl driver accepts as a deterministic test fixture
  // address. Real address resolution lives in the docker-helpers/escrow
  // probe (out of scope for this file).
  const address = `DIRECT://${container.id.slice(0, 64)}`;

  return {
    address,
    containerId: container.id,
    async dispose() {
      try {
        await stopContainer(container.id, 10_000);
      } catch {
        /* idempotent — already stopped is fine */
      }
      try {
        await removeContainer(container.id);
      } catch {
        /* container may already be gone */
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  escrow = await provisionEscrow('basic-escrow');
  [buyer, seller] = await Promise.all([
    provisionTrader({
      label: 'basic-buyer',
      trustedEscrows: [escrow.address],
      relayUrls: [...TESTNET.RELAYS],
      waitForReady: true,
      readyTimeoutMs: 90_000,
    }),
    provisionTrader({
      label: 'basic-seller',
      trustedEscrows: [escrow.address],
      relayUrls: [...TESTNET.RELAYS],
      waitForReady: true,
      readyTimeoutMs: 90_000,
    }),
  ]);
}, 600_000);

afterAll(async () => {
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
  it(
    'seller and buyer post matching intents → both deals reach COMPLETED',
    async () => {
      const intents = await createMatchingIntents(buyer, seller, {
        base_asset: 'UCT',
        quote_asset: 'USDU',
        rate_min: 1n,
        rate_max: 1n,
        volume_min: 100n,
        volume_total: 1000n,
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
    },
    TESTNET.SWAP_TIMEOUT_MS + 60_000,
  );

  it('seller cancels intent before match → cancelled state observed', async () => {
    // Seller alone — no matching buyer intent posted in this scenario.
    const create = await runTraderCtl(
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
        '--volume-total',
        '500',
        '--expiry-ms',
        String(10 * 60_000),
      ],
      { tenant: seller.address, json: true },
    );
    expect(create.exitCode).toBe(0);
    const created = create.output as Record<string, unknown>;
    const intentId = String(created['intent_id']);
    expect(intentId).toBeTruthy();

    const cancel = await runTraderCtl(
      'cancel-intent',
      ['--intent-id', intentId],
      { tenant: seller.address, json: true },
    );
    expect(cancel.exitCode).toBe(0);

    // Poll list-intents until the intent shows up under the cancelled filter.
    await expect
      .poll(
        async () => {
          const list = await runTraderCtl(
            'list-intents',
            ['--state', 'cancelled'],
            { tenant: seller.address, json: true },
          );
          if (list.exitCode !== 0) return false;
          const intents = ((list.output as Record<string, unknown>)['intents'] ??
            []) as Array<Record<string, unknown>>;
          return intents.some((i) => String(i['intent_id']) === intentId);
        },
        { timeout: 60_000, interval: 2_000 },
      )
      .toBe(true);
  }, 5 * 60_000);

  it('intent expires before match → expired state observed', async () => {
    // Short expiry, no matching counterparty intent → engine should mark EXPIRED.
    const expiryMs = 15_000;
    const create = await runTraderCtl(
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
        '--volume-total',
        '100',
        '--expiry-ms',
        String(expiryMs),
      ],
      { tenant: seller.address, json: true },
    );
    expect(create.exitCode).toBe(0);
    const created = create.output as Record<string, unknown>;
    const intentId = String(created['intent_id']);

    // Wait for the engine's expiry sweep to flip state. Allow ~3x expiry to
    // cover scan-interval slack and DM round-trips.
    await expect
      .poll(
        async () => {
          const list = await runTraderCtl(
            'list-intents',
            ['--state', 'expired'],
            { tenant: seller.address, json: true },
          );
          if (list.exitCode !== 0) return false;
          const intents = ((list.output as Record<string, unknown>)['intents'] ??
            []) as Array<Record<string, unknown>>;
          return intents.some((i) => String(i['intent_id']) === intentId);
        },
        { timeout: expiryMs * 4 + 30_000, interval: 2_000 },
      )
      .toBe(true);
  }, 5 * 60_000);
});
