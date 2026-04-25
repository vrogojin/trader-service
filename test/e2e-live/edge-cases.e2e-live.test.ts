/**
 * Live E2E — Edge cases / boundary + adversarial.
 *
 * Scenarios verify the trader's negative paths: incompatible rate ranges,
 * self-match guard, blocked counterparties, and volume-floor mismatch.
 *
 * `blocked counterparties` is currently UNREACHABLE through trader-ctl
 * because `set-strategy` does not expose a `--blocked-counterparties`
 * flag. The strategy engine itself supports the field (see
 * src/trader/intent-engine.ts criterion 7), so we mark the scenario
 * `it.skip` with a clear reason — the test stays as documentation of the
 * intended invariant and lights up automatically once the CLI flag lands.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  provisionTrader,
  type ProvisionedTenant,
} from './helpers/tenant-fixture.js';
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

/**
 * Resolve true if both intent IDs are still ACTIVE on their respective
 * tenants AND no COMPLETED deals exist on either side. We check at a
 * single instant after waiting `quietWindowMs` for any settlement DMs to
 * have arrived — false positives from "match in flight" are mitigated by
 * the wait.
 */
async function intentsRemainUnmatched(
  tenantA: ProvisionedTenant,
  intentIdA: string,
  tenantB: ProvisionedTenant,
  intentIdB: string,
  quietWindowMs: number,
): Promise<boolean> {
  // Hold the bus quiet — give scan loops + DM round-trips time to either
  // produce a deal or not.
  await new Promise((r) => setTimeout(r, quietWindowMs));

  for (const [tenant, intentId] of [
    [tenantA, intentIdA] as const,
    [tenantB, intentIdB] as const,
  ]) {
    const list = await runTraderCtl('list-intents', ['--state', 'active'], {
      tenant: tenant.address,
      json: true,
    });
    if (list.exitCode !== 0) return false;
    const intents = ((list.output as Record<string, unknown>)['intents'] ??
      []) as Array<Record<string, unknown>>;
    const found = intents.find((i) => String(i['intent_id']) === intentId);
    if (!found) return false;
    if (String(found['state']) !== 'ACTIVE') return false;
    if (BigInt(String(found['volume_filled'] ?? '0')) !== 0n) return false;

    const deals = await runTraderCtl('list-deals', [], {
      tenant: tenant.address,
      json: true,
    });
    if (deals.exitCode !== 0) return false;
    const dealRecs = ((deals.output as Record<string, unknown>)['deals'] ??
      []) as Array<Record<string, unknown>>;
    if (dealRecs.some((d) => String(d['state']) === 'COMPLETED')) return false;
  }
  return true;
}

beforeAll(async () => {
  escrow = await provisionEscrow('edge-escrow');
  [alice, bob] = await Promise.all([
    provisionTrader({
      label: 'edge-alice',
      trustedEscrows: [escrow.address],
      relayUrls: [...TESTNET.RELAYS],
      waitForReady: true,
      readyTimeoutMs: 90_000,
    }),
    provisionTrader({
      label: 'edge-bob',
      trustedEscrows: [escrow.address],
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
    async () => escrow?.dispose(),
  ];
  for (const fn of cleanups) {
    try {
      await fn();
    } catch (err) {
      console.error('[edge-cases afterAll] cleanup error:', err);
    }
  }
}, 120_000);

describe('Edge cases', () => {
  it(
    'incompatible rate ranges → no match, both intents remain active',
    async () => {
      await cancelActiveIntents(alice);
      await cancelActiveIntents(bob);

      // Alice will sell at >= 100; Bob will buy only at <= 50. Disjoint bands.
      const aliceId = await createIntent(alice, {
        direction: 'sell',
        rateMin: 100n,
        rateMax: 200n,
        volumeMin: 10n,
        volumeTotal: 100n,
      });
      const bobId = await createIntent(bob, {
        direction: 'buy',
        rateMin: 1n,
        rateMax: 50n,
        volumeMin: 10n,
        volumeTotal: 100n,
      });

      const stillUnmatched = await intentsRemainUnmatched(
        alice,
        aliceId,
        bob,
        bobId,
        45_000, // quiet window — at least one full scan_interval cycle
      );
      expect(stillUnmatched).toBe(true);
    },
    5 * 60_000,
  );

  it(
    'self-match guard: trader posts both buy and sell on its own → no self-match deal',
    async () => {
      await cancelActiveIntents(alice);
      await cancelActiveIntents(bob);

      // Alice posts both sides. The intent-engine self-match guard
      // (criterion 8 / pubkeysEqual check) must prevent her from matching
      // her own counterparty discovery result.
      const sellId = await createIntent(alice, {
        direction: 'sell',
        rateMin: 1n,
        rateMax: 1n,
        volumeMin: 50n,
        volumeTotal: 100n,
      });
      const buyId = await createIntent(alice, {
        direction: 'buy',
        rateMin: 1n,
        rateMax: 1n,
        volumeMin: 50n,
        volumeTotal: 100n,
      });

      // Wait long enough for >1 scan cycle and assert nothing settled.
      await new Promise((r) => setTimeout(r, 45_000));

      const dealsRes = await runTraderCtl('list-deals', [], {
        tenant: alice.address,
        json: true,
      });
      expect(dealsRes.exitCode).toBe(0);
      const deals = ((dealsRes.output as Record<string, unknown>)['deals'] ??
        []) as Array<Record<string, unknown>>;
      // No COMPLETED deal — the self-match guard has held.
      expect(deals.some((d) => String(d['state']) === 'COMPLETED')).toBe(false);

      // Both intents remain ACTIVE with 0 filled.
      const list = await runTraderCtl('list-intents', ['--state', 'active'], {
        tenant: alice.address,
        json: true,
      });
      expect(list.exitCode).toBe(0);
      const intents = ((list.output as Record<string, unknown>)['intents'] ??
        []) as Array<Record<string, unknown>>;
      for (const id of [sellId, buyId]) {
        const intent = intents.find((i) => String(i['intent_id']) === id);
        expect(intent, `${id} must still be ACTIVE`).toBeTruthy();
        expect(String(intent!['state'])).toBe('ACTIVE');
        expect(BigInt(String(intent!['volume_filled'] ?? '0'))).toBe(0n);
      }
    },
    5 * 60_000,
  );

  it.skip(
    'blocked counterparty: A.blocked_counterparties=[B] → B intents never proposed to A',
    async () => {
      // SKIPPED: trader-ctl set-strategy does not yet expose a
      // --blocked-counterparties flag. The runtime strategy engine
      // (src/trader/intent-engine.ts) supports the criterion. Once the CLI
      // surfaces it, replace this skip with the real assertion:
      //   1. set-strategy --blocked-counterparties <bob.address> on alice
      //   2. post matching intents on alice and bob
      //   3. assert no deal reaches COMPLETED on either side after a
      //      conservative quiet window
    },
  );

  it(
    'volume_min greater than counterparty volume_total → no match',
    async () => {
      await cancelActiveIntents(alice);
      await cancelActiveIntents(bob);

      // Alice will only accept fills of 1000+ but Bob can only commit 100.
      // The matcher must reject the pairing on volume floor mismatch.
      const aliceId = await createIntent(alice, {
        direction: 'sell',
        rateMin: 1n,
        rateMax: 1n,
        volumeMin: 1000n,
        volumeTotal: 5000n,
      });
      const bobId = await createIntent(bob, {
        direction: 'buy',
        rateMin: 1n,
        rateMax: 1n,
        volumeMin: 10n,
        volumeTotal: 100n,
      });

      const stillUnmatched = await intentsRemainUnmatched(
        alice,
        aliceId,
        bob,
        bobId,
        45_000,
      );
      expect(stillUnmatched).toBe(true);
    },
    5 * 60_000,
  );
});
