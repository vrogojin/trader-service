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
 *   - 2 scenarios run concurrently (vitest `it.concurrent`).
 *   - Within each scenario, every step that can fan out does so via
 *     Promise.all using the *Async helpers (which use spawn, not
 *     spawnSync — sync helpers would serialize even inside Promise.all
 *     because spawnSync blocks the event loop).
 *   - Total live infra load at peak: ~6 spawn DMs, 4 set-strategy DMs,
 *     4 create-intent DMs, ~4 list-deals DMs every 3s during settlement
 *     wait. The infra-probe preflight runs first to fail-fast on a
 *     degraded testnet.
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
import { UCT_COIN_ID, USDU_COIN_ID } from './helpers/constants.js';

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

interface SuiteState {
  cliPath: string;
  cliHome: string;
  manager: HostManagerProcess;
  managerAddr: string;
  controllerDirectAddress: string;
  spawned: SpawnedTenant[];
}

// Both scenarios share the HMA and controller wallet (no point booting
// two HMAs to test parallelism — production has one HMA per host). The
// `spawned` list is mutated by each scenario as it provisions tenants
// so afterAll can stop them all in parallel.
let state: SuiteState | null = null;

const SELF_MINT_AMOUNT = 5000n; // matches basic-roundtrip
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
    const { home: cliHome } = createSphereCliEnv('hma-trade-settlement');

    console.log('[hma-trade-settlement] bootstrapping controller wallet…');
    const controller = bootstrapControllerWallet(cliPath, cliHome);
    console.log(`[hma-trade-settlement] controller pubkey ${controller.pubkey.slice(0, 16)}…`);

    console.log('[hma-trade-settlement] booting host-manager…');
    const manager = await spawnHostManager({ controllerPubkey: controller.pubkey });
    await manager.ready;
    const managerAddr = manager.nametag ? `@${manager.nametag}` : manager.pubkey;
    console.log(`[hma-trade-settlement] manager ready @ ${managerAddr}`);

    state = {
      cliPath,
      cliHome,
      manager,
      managerAddr,
      controllerDirectAddress: controller.directAddress,
      spawned: [],
    };
  }, 240_000);

  afterAll(async () => {
    if (!state) return;
    // Best-effort parallel cleanup — never let one stop block the rest.
    await Promise.allSettled(
      state.spawned.map((t) =>
        hostStop({
          cliPath: state!.cliPath,
          cliHome: state!.cliHome,
          managerAddress: state!.manager.pubkey,
          target: t.instanceName,
          timeoutMs: 60_000,
        }),
      ),
    );
    await state.manager.stop();
    try { rmSync(state.cliHome, { recursive: true, force: true }); }
    catch { /* best effort */ }
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
  async function provisionTriple(scenarioId: string): Promise<{
    escrow: SpawnedTenant;
    alice: SpawnedTenant;
    bob: SpawnedTenant;
  }> {
    if (!state) throw new Error('beforeAll did not initialize state');
    const s = state;
    const traderEnv = {
      TRADER_TEST_FUND: `${UCT_COIN_ID}:${SELF_MINT_AMOUNT.toString()},${USDU_COIN_ID}:${SELF_MINT_AMOUNT.toString()}`,
      TRADER_FAULT_INJECTION_ALLOWED: '1',
    };
    console.log(`[${scenarioId}] spawning escrow + alice + bob (parallel)…`);
    const [escrow, alice, bob] = await Promise.all([
      hostSpawnAsync({
        cliPath: s.cliPath,
        cliHome: s.cliHome,
        managerAddress: s.managerAddr,
        templateId: 'escrow-service',
        instanceName: `escrow-${scenarioId}`,
        timeoutMs: 180_000,
      }),
      hostSpawnAsync({
        cliPath: s.cliPath,
        cliHome: s.cliHome,
        managerAddress: s.managerAddr,
        templateId: 'trader-agent',
        instanceName: `alice-${scenarioId}`,
        timeoutMs: 180_000,
        env: traderEnv,
      }),
      hostSpawnAsync({
        cliPath: s.cliPath,
        cliHome: s.cliHome,
        managerAddress: s.managerAddr,
        templateId: 'trader-agent',
        instanceName: `bob-${scenarioId}`,
        timeoutMs: 180_000,
        env: traderEnv,
      }),
    ]);
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
  async function runSettlementScenario(scenarioId: string): Promise<void> {
    if (!state) throw new Error('beforeAll did not initialize state');
    const s = state;
    const { escrow, alice, bob } = await provisionTriple(scenarioId);

    // ---- 2. Configure trusted escrows on both traders --------------
    console.log(`[${scenarioId}] set-strategy on alice + bob (parallel)…`);
    await Promise.all([
      setStrategyAsync({
        cliPath: s.cliPath, cliHome: s.cliHome, tenant: alice.tenantPubkey,
        trustedEscrows: [escrow.tenantPubkey],
        maxConcurrent: 5,
      }),
      setStrategyAsync({
        cliPath: s.cliPath, cliHome: s.cliHome, tenant: bob.tenantPubkey,
        trustedEscrows: [escrow.tenantPubkey],
        maxConcurrent: 5,
      }),
    ]);

    // ---- 3. Pre-trade portfolio snapshot ---------------------------
    const [aliceBefore, bobBefore] = await Promise.all([
      portfolioAsync({ cliPath: s.cliPath, cliHome: s.cliHome, tenant: alice.tenantPubkey }),
      portfolioAsync({ cliPath: s.cliPath, cliHome: s.cliHome, tenant: bob.tenantPubkey }),
    ]);
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

    // ---- 4. Post matching intents in parallel ----------------------
    // Alice buys UCT (pays USDU). Bob sells UCT (receives USDU).
    console.log(`[${scenarioId}] posting matching intents (parallel)…`);
    const [aliceIntent, bobIntent] = await Promise.all([
      createIntentAsync({
        cliPath: s.cliPath, cliHome: s.cliHome, tenant: alice.tenantPubkey,
        direction: 'buy',
        baseAsset: 'UCT', quoteAsset: 'USDU',
        rateMin: TRADE_RATE, rateMax: TRADE_RATE,
        volumeMin: TRADE_VOLUME, volumeMax: TRADE_VOLUME,
        expiryMs: SWAP_TIMEOUT_MS,
      }),
      createIntentAsync({
        cliPath: s.cliPath, cliHome: s.cliHome, tenant: bob.tenantPubkey,
        direction: 'sell',
        baseAsset: 'UCT', quoteAsset: 'USDU',
        rateMin: TRADE_RATE, rateMax: TRADE_RATE,
        volumeMin: TRADE_VOLUME, volumeMax: TRADE_VOLUME,
        expiryMs: SWAP_TIMEOUT_MS,
      }),
    ]);
    console.log(
      `[${scenarioId}] intents posted: alice=${aliceIntent.intentId.slice(0, 12)}… ` +
      `bob=${bobIntent.intentId.slice(0, 12)}…`,
    );

    // ---- 5. Wait for both deals to reach COMPLETED in parallel -----
    console.log(`[${scenarioId}] waiting for COMPLETED on both sides…`);
    const [aliceDeal, bobDeal] = await Promise.all([
      waitForDealInStateAsync({
        cliPath: s.cliPath, cliHome: s.cliHome, tenant: alice.tenantPubkey,
        targetState: 'COMPLETED',
        timeoutMs: SWAP_TIMEOUT_MS,
      }),
      waitForDealInStateAsync({
        cliPath: s.cliPath, cliHome: s.cliHome, tenant: bob.tenantPubkey,
        targetState: 'COMPLETED',
        timeoutMs: SWAP_TIMEOUT_MS,
      }),
    ]);
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

    const [aliceAfter, bobAfter] = await Promise.all([
      portfolioAsync({ cliPath: s.cliPath, cliHome: s.cliHome, tenant: alice.tenantPubkey }),
      portfolioAsync({ cliPath: s.cliPath, cliHome: s.cliHome, tenant: bob.tenantPubkey }),
    ]);
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
      cliPath: s.cliPath, cliHome: s.cliHome, tenant: alice.tenantPubkey,
      asset: 'UCT',
      amount: WITHDRAW_AMOUNT,
      toAddress: s.controllerDirectAddress,
    });
    expect(wr.transferId).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(wr.transferId.length).toBeGreaterThan(8);
    console.log(`[${scenarioId}] withdraw transfer_id=${wr.transferId.slice(0, 16)}…`);

    // Verify alice's UCT balance is now reduced by the withdrawn amount.
    // Allow a small settle delay for the transfer to land in the
    // confirmed bucket (testnet aggregator round-trip).
    await new Promise((r) => setTimeout(r, 5_000));
    const aliceFinal = await portfolioAsync({
      cliPath: s.cliPath, cliHome: s.cliHome, tenant: alice.tenantPubkey,
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
    await runSettlementScenario(`p1-${randomUUID().slice(0, 6)}`);
  }, SWAP_TIMEOUT_MS + 4 * 60_000); // 12 min total budget per scenario

  it('Pair-2: parallel scenario settles on the same HMA without interference', async () => {
    await runSettlementScenario(`p2-${randomUUID().slice(0, 6)}`);
  }, SWAP_TIMEOUT_MS + 4 * 60_000);
});
