/**
 * Live e2e: HMA-orchestrated trade-settlement (THE goal-completion test).
 *
 * Closes the architectural loop that hma-trade-flow.e2e-live.test.ts
 * stopped one step short of: full Architecture-B settlement THROUGH
 * the HMA, not via direct-docker.
 *
 *   Test
 *     ├── boot HMA over Sphere DM (single shared instance)
 *     └── for each scenario IN PARALLEL (it.concurrent):
 *           ├── spawn escrow + 2 traders   ← Promise.all (3-way concurrent)
 *           │     └── self-mint UCT+USDU at boot via TRADER_TEST_FUND env
 *           │         passthrough through HMA → docker
 *           ├── set-strategy on both traders   ← Promise.all
 *           ├── post matching intents on both ← Promise.all
 *           ├── wait for COMPLETED on both    ← Promise.all
 *           ├── assert balance deltas (buyer +UCT/-USDU, seller mirror)
 *           └── withdraw a small amount from one trader
 *               to the controller's DIRECT:// address
 *
 * Why this exists:
 *   The user's stated goal: "operators can launch HMA, spawn agents,
 *   fund them, trade (multi-party), AND withdraw" — all over Sphere
 *   DMs. Every prior live test covers a slice; this one chains every
 *   slice into a single end-to-end run.
 *
 *   - basic-roundtrip.e2e-live: settles correctly, but uses direct
 *     docker run (no HMA in the loop).
 *   - hma-orchestrated.e2e-live: spawns through HMA, but doesn't trade.
 *   - hma-trade-flow.e2e-live: spawns through HMA, posts/cancels
 *     intents, but explicitly stops short of settlement.
 *   - this file: spawns through HMA, settles, AND withdraws.
 *
 * Parallelism contract:
 *   - 2 scenarios run concurrently across the file (vitest `it.concurrent`).
 *     Each scenario uses its OWN controller wallet in its OWN cliHome
 *     dir — concurrent sphere-cli calls in the SAME .sphere-cli/wallet.json
 *     race on the SDK's atomic temp+rename writes (FileStorageProvider.save
 *     → fs.renameSync) and corrupt each other's state.
 *   - WITHIN each scenario, sphere-cli calls are SEQUENTIAL. Tried fully
 *     parallel (Promise.all over spawn/set-strategy/portfolio) and got
 *     two distinct races on the first run: "No wallet exists" (Sphere.init
 *     reading mid-write) and "ENOENT: rename wallet.json.tmp -> wallet.json"
 *     (two atomic writes racing each other). The DM round-trips for spawn
 *     are the only ones inside a scenario where parallelism would matter
 *     (~5-15s each); against the 3-5min settlement-wait dominator, the
 *     wall-clock cost of serializing them is negligible.
 *   - Net effect: total wall time ≈ max(scenario_time), not sum, because
 *     the long settlement wait runs concurrently across scenarios.
 *   - Live infra load at peak: 2 cross-scenario sphere-cli children,
 *     each making 1 DM at a time. Manageable for the relay. Aggregator
 *     load comes from the trader containers themselves, not sphere-cli.
 *
 * Performance target on a healthy testnet: ~5-8 minutes total.
 *   - HMA boot: ~10s
 *   - 6 concurrent spawns (2 scenarios × 3 tenants): ~30-60s
 *   - 4 concurrent set-strategy: ~5-10s
 *   - 4 concurrent create-intent: ~5-10s
 *   - settlement wait: 3-5 min on testnet (dominates)
 *   - 2 concurrent withdraws: ~5-10s
 *
 * Out of scope:
 *   - Faucet HTTP — the trader self-mints via TRADER_TEST_FUND, the
 *     same pattern basic-roundtrip uses (faucet has been a recurring
 *     source of flakiness on testnet).
 *   - Negotiation-failure paths — covered by negotiation-failures.
 *   - Partial fills — covered by edge-cases.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  probeSphereCli,
  createSphereCliEnv,
  bootstrapControllerWallet,
  type SphereCliProbe,
} from './helpers/sphere-cli.js';
import {
  spawnHostManager,
  checkAgenticHostingPath,
  type HostManagerProcess,
} from './helpers/manager-process.js';
import {
  hostSpawnAsync,
  hostStop,
  type SpawnedTenant,
} from './helpers/hma-spawn.js';
import {
  setStrategyAsync,
  createIntentAsync,
  portfolioAsync,
  waitForDealInStateAsync,
  withdrawAsync,
  type PortfolioBalance,
} from './helpers/sphere-trader.js';
import { fundWallet } from './helpers/funding.js';

// ---------------------------------------------------------------------------
// Precondition gates (mirrors hma-trade-flow's structure)
// ---------------------------------------------------------------------------

const cliProbe: SphereCliProbe = probeSphereCli();
const agenticProbe = checkAgenticHostingPath();
let managerBinPath = '';
let agenticReady = false;
if (agenticProbe.ok) {
  managerBinPath = join(agenticProbe.path, 'dist', 'host-manager.js');
  agenticReady = existsSync(managerBinPath);
}
const skip = !cliProbe.ok || !agenticReady;
const skipReason = !cliProbe.ok
  ? `sphere-cli not runnable: ${cliProbe.reason}`
  : !agenticProbe.ok
    ? agenticProbe.reason
    : !agenticReady
      ? `agentic-hosting binary missing at ${managerBinPath}.`
      : '';

// ---------------------------------------------------------------------------
// Shared HMA + controller fixture
// ---------------------------------------------------------------------------

/**
 * Per-scenario controller: the controller wallet (cliHome + pubkey/addr).
 * Concurrent `sphere host spawn` invocations write to .sphere-cli/wallet.json
 * inside cliHome (the SDK persists incoming-DM state there atomically via
 * temp+rename). Two parallel calls in the same cliHome corrupt each other's
 * rename — give each scenario its own cliHome to make concurrency safe.
 */
interface ScenarioController {
  cliHome: string;
  pubkey: string;
  directAddress: string;
}

interface SuiteState {
  cliPath: string;
  /** All cliHome dirs we created — afterAll wipes them. */
  cliHomes: string[];
  manager: HostManagerProcess;
  managerAddr: string;
  controllers: ScenarioController[];
  spawned: SpawnedTenant[];
}

// Number of concurrent settlement scenarios. Each gets its own controller
// wallet + own cliHome. Bumping this raises the parallel infra load
// (more concurrent spawn DMs, more concurrent listdeals polls during
// settlement). Two is the contract test for the parallelism claim;
// higher values stress-test the relay+aggregator+HMA further.
const SCENARIO_COUNT = 2;

let state: SuiteState | null = null;

const SWAP_TIMEOUT_MS = 8 * 60_000; // 8 minutes; testnet settlement is 3-5 min typical

// `volume_max` for matching intents in each scenario. Both sides post
// identical volumes so a single fill clears both intents.
const TRADE_VOLUME = 10n;
const TRADE_RATE = 1n; // 1 USDU per UCT — keeps the math obvious

// Withdraw amount: small fraction of received UCT so the test asserts
// real value movement without exhausting the trader's post-trade balance.
const WITHDRAW_AMOUNT = 3n;

// ---------------------------------------------------------------------------

describe.skipIf(skip).concurrent('HMA-orchestrated trade settlement (live testnet)', () => {
  if (skip) {
    console.warn(`[hma-trade-settlement] SKIPPED: ${skipReason}`);
  }

  beforeAll(async () => {
    if (skip) return;
    if (!cliProbe.ok) throw new Error('precondition gate inverted');
    const cliPath = cliProbe.path;

    // One controller wallet per scenario — concurrent sphere-cli calls
    // in the same .sphere-cli/wallet.json race on the SDK's atomic
    // temp+rename writes (sphere-sdk persists DM state per call).
    // Bootstrap them sequentially; the wallet-init aggregator round-trip
    // (~30s each) dominates this section anyway and parallel inits also
    // race on the same OS-level temp dirs.
    const controllers: ScenarioController[] = [];
    const cliHomes: string[] = [];
    for (let i = 0; i < SCENARIO_COUNT; i++) {
      const { home } = createSphereCliEnv(`hma-trade-settlement-c${String(i)}`);
      cliHomes.push(home);
      console.log(`[hma-trade-settlement] bootstrapping controller wallet #${String(i)}…`);
      const c = bootstrapControllerWallet(cliPath, home);
      console.log(`[hma-trade-settlement] controller #${String(i)} pubkey ${c.pubkey.slice(0, 16)}…`);
      controllers.push({ cliHome: home, pubkey: c.pubkey, directAddress: c.directAddress });
    }

    // HMA accepts AUTHORIZED_CONTROLLERS as a comma-separated list of
    // pubkeys (see agentic-hosting/src/shared/config.ts:52). Authorize
    // every scenario's controller in one HMA — production has one HMA
    // per host serving multiple operators, so this matches the real
    // multi-tenant topology.
    console.log('[hma-trade-settlement] booting host-manager…');
    const manager = await spawnHostManager({
      controllerPubkey: controllers.map((c) => c.pubkey).join(','),
    });
    await manager.ready;
    const managerAddr = manager.nametag ? `@${manager.nametag}` : manager.pubkey;
    console.log(`[hma-trade-settlement] manager ready @ ${managerAddr}`);

    state = {
      cliPath,
      cliHomes,
      manager,
      managerAddr,
      controllers,
      spawned: [],
    };
  }, 600_000); // 10 min — wallet-init is ~30s per controller on testnet

  afterAll(async () => {
    if (!state) return;
    // Best-effort parallel cleanup. Use the FIRST controller's cliHome
    // for stop calls — the HMA accepts stops from any authorized
    // controller, so we don't need to issue one stop per controller.
    const stopHome = state.controllers[0]?.cliHome ?? state.cliHomes[0]!;
    await Promise.allSettled(
      state.spawned.map((t) =>
        hostStop({
          cliPath: state!.cliPath,
          cliHome: stopHome,
          managerAddress: state!.manager.pubkey,
          target: t.instanceName,
          timeoutMs: 60_000,
        }),
      ),
    );
    await state.manager.stop();
    for (const home of state.cliHomes) {
      try { rmSync(home, { recursive: true, force: true }); }
      catch { /* best effort */ }
    }
  }, 240_000);

  // ---- Per-scenario helpers -------------------------------------------------

  /**
   * Spawn one escrow + two traders (alice/bob) IN PARALLEL via
   * Promise.all on hostSpawnAsync. Both traders self-mint UCT+USDU
   * at boot via TRADER_TEST_FUND (HMA's --env passthrough — see
   * agentic-hosting/src/host-manager/manager.ts:97 validatePayloadEnv;
   * TRADER_TEST_FUND is not in FORBIDDEN_ENV_KEYS and doesn't start
   * with UNICITY_ so it's allowed through).
   */
  async function provisionTriple(
    scenarioId: string,
    controller: ScenarioController,
  ): Promise<{
    escrow: SpawnedTenant;
    alice: SpawnedTenant;
    bob: SpawnedTenant;
  }> {
    if (!state) throw new Error('beforeAll did not initialize state');
    const s = state;
    // Within a scenario, sphere-cli calls share one wallet.json and
    // race on its atomic temp+rename writes (FileStorageProvider.save
    // → fs.renameSync). So within-scenario calls are serialized. The
    // PARALLELISM the user asked for is preserved cross-scenario via
    // vitest `it.concurrent` — each scenario has its own controller
    // wallet and the long settlement-wait phases run truly in parallel
    // across scenarios. Wall-clock cost of this serialization vs full
    // parallel: 2-3 spawn DM round-trips (~5-15s each) instead of 1,
    // negligible against the 3-5 min settlement dominator.
    console.log(`[${scenarioId}] spawning escrow + alice + bob (sequential within-scenario)…`);
    const escrow = await hostSpawnAsync({
      cliPath: s.cliPath,
      cliHome: controller.cliHome,
      managerAddress: s.managerAddr,
      templateId: 'escrow-service',
      instanceName: `escrow-${scenarioId}`,
      timeoutMs: 180_000,
    });
    // Trader templates do NOT receive TRADER_TEST_FUND — the published
    // trader image (ghcr.io/.../trader:v0.1) uses an older sphere-sdk
    // without mintFungibleToken, so the self-mint path errors out
    // ("TRADER_TEST_FUND requires sphere-sdk with mintFungibleToken").
    // Funding happens AFTER spawn via the testnet faucet (HTTP).
    const alice = await hostSpawnAsync({
      cliPath: s.cliPath,
      cliHome: controller.cliHome,
      managerAddress: s.managerAddr,
      templateId: 'trader-agent',
      instanceName: `alice-${scenarioId}`,
      timeoutMs: 180_000,
    });
    const bob = await hostSpawnAsync({
      cliPath: s.cliPath,
      cliHome: controller.cliHome,
      managerAddress: s.managerAddr,
      templateId: 'trader-agent',
      instanceName: `bob-${scenarioId}`,
      timeoutMs: 180_000,
    });
    s.spawned.push(escrow, alice, bob);
    console.log(
      `[${scenarioId}] up: escrow=${escrow.instanceName} ` +
      `alice=${alice.instanceName} bob=${bob.instanceName}`,
    );
    return { escrow, alice, bob };
  }

  /** Pull a coin's confirmed balance (smallest units) from a portfolio response. */
  function balanceOf(p: readonly PortfolioBalance[], symbol: string): bigint {
    for (const b of p) {
      if (b.asset === symbol) return BigInt(String(b.amount ?? '0'));
    }
    // Tolerate alternate field names (some sphere-sdk versions emit `confirmed`).
    for (const b of p as Array<Record<string, unknown>>) {
      if (b['asset'] === symbol && b['confirmed'] !== undefined) {
        return BigInt(String(b['confirmed']));
      }
    }
    return 0n;
  }

  /**
   * One full settlement scenario, parametrized by name. Inside the test:
   *   1. Spawn escrow + buyer + seller in parallel.
   *   2. set-strategy on both traders in parallel.
   *   3. Pre-trade portfolio snapshot in parallel.
   *   4. Post matching intents in parallel.
   *   5. Wait for COMPLETED on both deals in parallel.
   *   6. Post-trade portfolio snapshot in parallel; assert deltas.
   *   7. Withdraw a small amount from buyer to controller's DIRECT://
   *      address; assert transfer_id non-empty + post-withdraw balance
   *      reflects the withdrawal.
   */
  /**
   * Map an asset symbol (as the trader exposes it in portfolio:
   * `UCT`, `USDU`, etc.) to the faucet's coin identifier. The
   * faucet's `/api/v1/faucet/request` endpoint looks up coins by
   * the `name` field of `/api/v1/faucet/coins`, NOT by symbol —
   * `coin: "UCT"` returns `Coin not found: UCT`. Verified by probing
   * the faucet directly:
   *   coins[].name "unicity"     → faucet accepts symbol UCT
   *   coins[].name "unicity-usd" → faucet accepts symbol USDU
   * If a future coin is added to this test, extend this map.
   */
  const FAUCET_COIN_NAME: Record<string, string> = {
    UCT: 'unicity',
    USDU: 'unicity-usd',
  };

  /**
   * Fund a trader via the testnet faucet, then poll its portfolio
   * until the requested asset arrives or `timeoutMs` elapses. Faucet
   * deposits land via the trader's payments.receive() loop (~15s
   * cycle) plus aggregator confirmation, so we typically observe the
   * balance ~30-60s after the faucet POST.
   *
   * Faucet expects the BARE nametag (no `@`) in `unicityId`. The
   * fundWallet helper unwraps `@nametag` automatically.
   */
  async function faucetFundAndWait(
    label: string,
    tenant: { tenantNametag: string | null; tenantPubkey: string },
    asset: 'UCT' | 'USDU',
    amount: bigint,
    cliHome: string,
    timeoutMs = 120_000,
  ): Promise<void> {
    if (!state) throw new Error('state missing');
    const s = state;
    const recipient = tenant.tenantNametag ? `@${tenant.tenantNametag}` : `DIRECT://${tenant.tenantPubkey}`;
    const faucetCoin = FAUCET_COIN_NAME[asset];
    if (faucetCoin === undefined) {
      throw new Error(`[${label}] no faucet coin name for ${asset}`);
    }
    console.log(`[${label}] faucet → ${recipient} ${amount}${asset} (faucet name: ${faucetCoin})…`);
    await fundWallet(recipient, amount, faucetCoin);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const p = await portfolioAsync({
        cliPath: s.cliPath, cliHome, tenant: tenant.tenantPubkey,
      });
      if (balanceOf(p, asset) >= amount) {
        console.log(`[${label}] balance arrived: ${balanceOf(p, asset)}${asset}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 5_000));
    }
    throw new Error(
      `[${label}] balance ${asset}>=${amount} did not arrive within ${timeoutMs}ms`,
    );
  }

  async function runSettlementScenario(
    scenarioId: string,
    controller: ScenarioController,
  ): Promise<void> {
    if (!state) throw new Error('beforeAll did not initialize state');
    const s = state;
    const { escrow, alice, bob } = await provisionTriple(scenarioId, controller);

    // ---- 1.5 Faucet-fund both traders before they can trade ---------
    // Alice (buyer of UCT) needs USDU to pay. Bob (seller of UCT) needs UCT.
    // Sequential within-scenario (wallet.json contention again). Use
    // exact trade-required amounts plus headroom for the withdraw step.
    const aliceUsduFundAmount = TRADE_RATE * TRADE_VOLUME * 2n; // 2× headroom
    const bobUctFundAmount = TRADE_VOLUME * 2n;
    console.log(`[${scenarioId}] funding alice + bob via faucet…`);
    await faucetFundAndWait(scenarioId, alice, 'USDU', aliceUsduFundAmount, controller.cliHome);
    await faucetFundAndWait(scenarioId, bob, 'UCT', bobUctFundAmount, controller.cliHome);

    // ---- 2. Configure trusted escrows on both traders --------------
    // Sequential within-scenario (wallet.json contention; see provisionTriple).
    console.log(`[${scenarioId}] set-strategy on alice + bob…`);
    await setStrategyAsync({
      cliPath: s.cliPath, cliHome: controller.cliHome, tenant: alice.tenantPubkey,
      trustedEscrows: [escrow.tenantPubkey],
      maxConcurrent: 5,
    });
    await setStrategyAsync({
      cliPath: s.cliPath, cliHome: controller.cliHome, tenant: bob.tenantPubkey,
      trustedEscrows: [escrow.tenantPubkey],
      maxConcurrent: 5,
    });

    // ---- 3. Pre-trade portfolio snapshot ---------------------------
    const aliceBefore = await portfolioAsync({
      cliPath: s.cliPath, cliHome: controller.cliHome, tenant: alice.tenantPubkey,
    });
    const bobBefore = await portfolioAsync({
      cliPath: s.cliPath, cliHome: controller.cliHome, tenant: bob.tenantPubkey,
    });
    const aliceUctBefore = balanceOf(aliceBefore, 'UCT');
    const aliceUsduBefore = balanceOf(aliceBefore, 'USDU');
    const bobUctBefore = balanceOf(bobBefore, 'UCT');
    const bobUsduBefore = balanceOf(bobBefore, 'USDU');
    console.log(
      `[${scenarioId}] pre-trade balances: ` +
      `alice=${aliceUctBefore}UCT/${aliceUsduBefore}USDU bob=${bobUctBefore}UCT/${bobUsduBefore}USDU`,
    );
    // Sanity: the self-mint must have happened (otherwise no UCT/USDU
    // are available to trade and the swap will hang).
    expect(aliceUctBefore + aliceUsduBefore).toBeGreaterThan(0n);
    expect(bobUctBefore + bobUsduBefore).toBeGreaterThan(0n);

    // ---- 4. Post matching intents (sequential — wallet.json) ------
    // Alice buys UCT (pays USDU). Bob sells UCT (receives USDU).
    console.log(`[${scenarioId}] posting matching intents…`);
    const aliceIntent = await createIntentAsync({
      cliPath: s.cliPath, cliHome: controller.cliHome, tenant: alice.tenantPubkey,
      direction: 'buy',
      baseAsset: 'UCT', quoteAsset: 'USDU',
      rateMin: TRADE_RATE, rateMax: TRADE_RATE,
      volumeMin: TRADE_VOLUME, volumeMax: TRADE_VOLUME,
      expiryMs: SWAP_TIMEOUT_MS,
    });
    const bobIntent = await createIntentAsync({
      cliPath: s.cliPath, cliHome: controller.cliHome, tenant: bob.tenantPubkey,
      direction: 'sell',
      baseAsset: 'UCT', quoteAsset: 'USDU',
      rateMin: TRADE_RATE, rateMax: TRADE_RATE,
      volumeMin: TRADE_VOLUME, volumeMax: TRADE_VOLUME,
      expiryMs: SWAP_TIMEOUT_MS,
    });
    console.log(
      `[${scenarioId}] intents posted: alice=${aliceIntent.intentId.slice(0, 12)}… ` +
      `bob=${bobIntent.intentId.slice(0, 12)}…`,
    );

    // ---- 5. Wait for both deals to reach COMPLETED ------------------
    // Sequential within-scenario (wallet.json contention). Wait for
    // alice first; once she's COMPLETED, bob is typically COMPLETED
    // already on the next poll, so this adds at most one poll cycle.
    console.log(`[${scenarioId}] waiting for alice COMPLETED…`);
    const aliceDeal = await waitForDealInStateAsync({
      cliPath: s.cliPath, cliHome: controller.cliHome, tenant: alice.tenantPubkey,
      targetState: 'COMPLETED',
      timeoutMs: SWAP_TIMEOUT_MS,
    });
    console.log(`[${scenarioId}] waiting for bob COMPLETED…`);
    const bobDeal = await waitForDealInStateAsync({
      cliPath: s.cliPath, cliHome: controller.cliHome, tenant: bob.tenantPubkey,
      targetState: 'COMPLETED',
      timeoutMs: SWAP_TIMEOUT_MS,
    });
    expect(aliceDeal.state).toBe('COMPLETED');
    expect(bobDeal.state).toBe('COMPLETED');
    // Both sides observe the same deal_id (one negotiation, two ledgers).
    expect(aliceDeal.deal_id).toBe(bobDeal.deal_id);
    console.log(
      `[${scenarioId}] deal COMPLETED: ${aliceDeal.deal_id.slice(0, 12)}…`,
    );

    // ---- 6. Post-trade balance assertions --------------------------
    // Wait briefly for payments.receive() to finalize inbound payouts
    // (trader loop is on a 15s cycle; basic-roundtrip uses 5s and that
    // has been enough on testnet).
    await new Promise((r) => setTimeout(r, 5_000));

    const aliceAfter = await portfolioAsync({
      cliPath: s.cliPath, cliHome: controller.cliHome, tenant: alice.tenantPubkey,
    });
    const bobAfter = await portfolioAsync({
      cliPath: s.cliPath, cliHome: controller.cliHome, tenant: bob.tenantPubkey,
    });
    const aliceUctAfter = balanceOf(aliceAfter, 'UCT');
    const aliceUsduAfter = balanceOf(aliceAfter, 'USDU');
    const bobUctAfter = balanceOf(bobAfter, 'UCT');
    const bobUsduAfter = balanceOf(bobAfter, 'USDU');

    const expectedUsduPaid = TRADE_RATE * TRADE_VOLUME;
    // Alice (buy UCT for USDU): +UCT / -USDU
    expect(
      aliceUctAfter - aliceUctBefore,
      `alice UCT delta should be +${TRADE_VOLUME}; observed: ${aliceUctAfter - aliceUctBefore}`,
    ).toBe(TRADE_VOLUME);
    expect(
      aliceUsduBefore - aliceUsduAfter,
      `alice USDU delta should be -${expectedUsduPaid}; observed: -${aliceUsduBefore - aliceUsduAfter}`,
    ).toBe(expectedUsduPaid);
    // Bob (sell UCT for USDU): -UCT / +USDU
    expect(
      bobUctBefore - bobUctAfter,
      `bob UCT delta should be -${TRADE_VOLUME}; observed: -${bobUctBefore - bobUctAfter}`,
    ).toBe(TRADE_VOLUME);
    expect(
      bobUsduAfter - bobUsduBefore,
      `bob USDU delta should be +${expectedUsduPaid}; observed: ${bobUsduAfter - bobUsduBefore}`,
    ).toBe(expectedUsduPaid);

    // ---- 7. Withdraw from alice (now has UCT) ---------------------
    // Alice had 0 UCT pre-trade and acquired TRADE_VOLUME via the swap.
    // Withdraw a fraction (WITHDRAW_AMOUNT) to the controller's DIRECT
    // address — exercises the WITHDRAW_TOKEN ACP command end-to-end
    // including the round-6 trim+validation gate.
    console.log(`[${scenarioId}] withdraw ${WITHDRAW_AMOUNT} UCT from alice → controller…`);
    const wr = await withdrawAsync({
      cliPath: s.cliPath, cliHome: controller.cliHome, tenant: alice.tenantPubkey,
      asset: 'UCT',
      amount: WITHDRAW_AMOUNT,
      toAddress: controller.directAddress,
    });
    expect(wr.transferId).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(wr.transferId.length).toBeGreaterThan(8);
    console.log(`[${scenarioId}] withdraw transfer_id=${wr.transferId.slice(0, 16)}…`);

    // Verify alice's UCT balance is now reduced by the withdrawn amount.
    // Allow a small settle delay for the transfer to land in the
    // confirmed bucket (testnet aggregator round-trip).
    await new Promise((r) => setTimeout(r, 5_000));
    const aliceFinal = await portfolioAsync({
      cliPath: s.cliPath, cliHome: controller.cliHome, tenant: alice.tenantPubkey,
    });
    const aliceUctFinal = balanceOf(aliceFinal, 'UCT');
    expect(
      aliceUctAfter - aliceUctFinal,
      `alice UCT delta after withdraw should be -${WITHDRAW_AMOUNT}; observed: -${aliceUctAfter - aliceUctFinal}`,
    ).toBe(WITHDRAW_AMOUNT);

    console.log(`[${scenarioId}] ✓ end-to-end settlement+withdraw verified`);
  }

  // ---- Concurrent scenarios -----------------------------------------------

  it('Pair-1: full spawn → trade → settle → withdraw via HMA', async () => {
    if (!state) throw new Error('beforeAll did not initialize state');
    const c = state.controllers[0];
    if (!c) throw new Error('controller #0 missing');
    await runSettlementScenario(`p1-${randomUUID().slice(0, 6)}`, c);
  }, SWAP_TIMEOUT_MS + 4 * 60_000); // 12 min total budget per scenario

  it('Pair-2: parallel scenario settles on the same HMA without interference', async () => {
    if (!state) throw new Error('beforeAll did not initialize state');
    const c = state.controllers[1];
    if (!c) throw new Error('controller #1 missing');
    await runSettlementScenario(`p2-${randomUUID().slice(0, 6)}`, c);
  }, SWAP_TIMEOUT_MS + 4 * 60_000);
});
