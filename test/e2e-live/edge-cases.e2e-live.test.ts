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
import { getControllerWallet } from './helpers/tenant-fixture.js';

/**
 * Wrapper that auto-attaches controller-wallet credentials so the trader
 * accepts the ACP command. Without these, `runTraderCtl` falls back to
 * `~/.trader-ctl/wallet/wallet.json` (the default user wallet), which can
 * race + corrupt across parallel tests and is not in the trader's allow-list.
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
  // List ALL intents and filter client-side: the trader-ctl CLI accepts
  // `--state` but the trader's LIST_INTENTS handler reads `params.filter`
  // (mismatched flag name — listed as a follow-up product fix), so the
  // server-side filter is currently a no-op.
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

/**
 * Resolve true if neither tenant completed a deal WITH THE OTHER tenant for
 * the named intents. We can't constrain global state because the testnet
 * aggregator is shared — alice's sell-rate-100-200 intent might match
 * unrelated stale buy intents from prior runs that happen to be live, and
 * bob's buy-rate-1-50 intent is even more likely to find unrelated sellers.
 * What we CAN guarantee is "no deal between alice and bob themselves" —
 * verified by checking each tenant's deals for a COMPLETED record where the
 * counterparty pubkey matches the OTHER test tenant's address/pubkey.
 *
 * volume_filled on the named intent is also asserted to be 0 — even if some
 * unrelated peer matched, our intent shouldn't have actually completed a swap
 * with them within the quiet window for the test to be meaningful.
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

  for (const [tenant, intentId, otherAddr] of [
    [tenantA, intentIdA, tenantB.address] as const,
    [tenantB, intentIdB, tenantA.address] as const,
  ]) {
    const deals = await runAuthedTraderCtl('list-deals', [], {
      tenant: tenant.address,
      json: true,
    });
    if (deals.exitCode !== 0) return false;
    const dealRecs = arrayFieldFromOutput(deals.output, 'deals');
    // No deal between THIS tenant and the OTHER test tenant should have completed.
    // The deal record's counterparty fields may be `proposer_address` /
    // `acceptor_address` (DIRECT://hex) or `proposer_pubkey` / `acceptor_pubkey`.
    // Match any of these against the other tenant's address.
    const otherKey = otherAddr.startsWith('@')
      ? otherAddr.slice(1)
      : otherAddr.replace(/^DIRECT:\/\//, '');
    const involvesOther = (d: Record<string, unknown>): boolean => {
      const fields = ['proposer_address', 'acceptor_address', 'proposer_pubkey', 'acceptor_pubkey'];
      for (const f of fields) {
        const v = String(d[f] ?? '');
        if (v.includes(otherKey) || v.includes(otherAddr)) return true;
      }
      return false;
    };
    if (
      dealRecs.some(
        (d) => String(d['state']) === 'COMPLETED' && involvesOther(d),
      )
    ) {
      return false;
    }
  }

  // Also verify the named intents have volume_filled=0 (they may have moved
  // to MATCHING/PROPOSED with unrelated peers, but they shouldn't have
  // actually swapped with the OTHER named tenant — and a 0 fill is the most
  // direct evidence of "no swap occurred for THIS specific intent").
  for (const [tenant, intentId] of [
    [tenantA, intentIdA] as const,
    [tenantB, intentIdB] as const,
  ]) {
    const list = await runAuthedTraderCtl('list-intents', [], {
      tenant: tenant.address,
      json: true,
    });
    if (list.exitCode !== 0) return false;
    const intents = arrayFieldFromOutput(list.output, 'intents');
    const found = intents.find((i) => String(i['intent_id']) === intentId);
    if (!found) return false;
    if (BigInt(String(found['volume_filled'] ?? '0')) !== 0n) return false;
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
      readyTimeoutMs: 180_000,
    }),
    provisionTrader({
      label: 'edge-bob',
      trustedEscrows: [escrow.address],
      relayUrls: [...TESTNET.RELAYS],
      waitForReady: true,
      readyTimeoutMs: 180_000,
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
        volumeMax: 100n,
      });
      const bobId = await createIntent(bob, {
        direction: 'buy',
        rateMin: 1n,
        rateMax: 50n,
        volumeMin: 10n,
        volumeMax: 100n,
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
        volumeMax: 100n,
      });
      const buyId = await createIntent(alice, {
        direction: 'buy',
        rateMin: 1n,
        rateMax: 1n,
        volumeMin: 50n,
        volumeMax: 100n,
      });

      // Wait long enough for >1 scan cycle and assert no SELF-MATCH deal.
      // Note: alice may match unrelated stale intents on the shared testnet
      // aggregator; what we MUST guarantee is that alice doesn't trade with
      // HERSELF. We verify by scanning for any deal where proposer_pubkey ===
      // acceptor_pubkey (the self-match anti-invariant).
      await new Promise((r) => setTimeout(r, 45_000));

      const dealsRes = await runAuthedTraderCtl('list-deals', [], {
        tenant: alice.address,
        json: true,
      });
      expect(dealsRes.exitCode).toBe(0);
      const deals = arrayFieldFromOutput(dealsRes.output, 'deals');
      // No deal where proposer == acceptor (== alice's own pubkey).
      const selfMatchDeals = deals.filter((d) => {
        const p = String(d['proposer_pubkey'] ?? '');
        const a = String(d['acceptor_pubkey'] ?? '');
        return p !== '' && p === a;
      });
      expect(
        selfMatchDeals,
        'self-match guard must prevent any deal with proposer===acceptor',
      ).toEqual([]);

      // Each named intent must have volume_filled === 0 (we don't constrain
      // state — alice may legitimately be MATCHING with unrelated peers).
      const list = await runAuthedTraderCtl('list-intents', [], {
        tenant: alice.address,
        json: true,
      });
      expect(list.exitCode).toBe(0);
      const intents = arrayFieldFromOutput(list.output, 'intents');
      for (const id of [sellId, buyId]) {
        const intent = intents.find((i) => String(i['intent_id']) === id);
        expect(intent, `${id} should still be present in list`).toBeTruthy();
        expect(BigInt(String(intent!['volume_filled'] ?? '0'))).toBe(0n);
      }
    },
    5 * 60_000,
  );

  it(
    'blocked counterparty: A.blocked_counterparties=[B] → no deal A↔B',
    async () => {
      await cancelActiveIntents(alice);
      await cancelActiveIntents(bob);

      // 1. Alice blocks bob via the new CLI flag. The matcher's filter
      //    (intent-engine.ts:matchesCriteria) reads strategy.blocked_counterparties
      //    every scan cycle, so the next scan (within scan_interval_ms) will
      //    skip bob's intent — but bob's matcher is still free to find alice
      //    and propose to her. Alice's negotiation handler will then reject
      //    the proposal because alice's own filter excludes bob.
      const setStrategy = await runAuthedTraderCtl(
        'set-strategy',
        ['--blocked-counterparties', bob.address],
        { tenant: alice.address, json: true },
      );
      expect(setStrategy.exitCode).toBe(0);

      // 2. Post matching intents from both sides. Alice sells, bob buys, same
      //    rate band — under normal conditions this would complete a deal.
      const aliceId = await createIntent(alice, {
        direction: 'sell',
        rateMin: 1n,
        rateMax: 1n,
        volumeMin: 10n,
        volumeMax: 100n,
      });
      const bobId = await createIntent(bob, {
        direction: 'buy',
        rateMin: 1n,
        rateMax: 1n,
        volumeMin: 10n,
        volumeMax: 100n,
      });

      // 3. Wait for >= one full scan cycle on both sides + DM round-trips, then
      //    assert no completed deal exists between the two of them. We use the
      //    "no completed deal involving the other tenant" check (same as the
      //    incompatible-rate-ranges scenario) so that unrelated stale intents
      //    on the testnet aggregator can't false-positive the test.
      const stillUnmatched = await intentsRemainUnmatched(
        alice,
        aliceId,
        bob,
        bobId,
        45_000,
      );
      expect(stillUnmatched).toBe(true);

      // 4. Restore alice's strategy so the next test starts clean.
      await runAuthedTraderCtl(
        'set-strategy',
        ['--blocked-counterparties', ''],
        { tenant: alice.address, json: true },
      ).catch(() => undefined);
    },
    5 * 60_000,
  );

  it(
    'volume_min greater than counterparty volume_max → no match',
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
        volumeMax: 5000n,
      });
      const bobId = await createIntent(bob, {
        direction: 'buy',
        rateMin: 1n,
        rateMax: 1n,
        volumeMin: 10n,
        volumeMax: 100n,
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
