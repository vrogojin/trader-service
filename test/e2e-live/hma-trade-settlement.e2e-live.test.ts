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
 * Trader image:
 *   This test requires `ghcr.io/vrogojin/agentic-hosting/trader:local`
 *   built from this repo's Dockerfile (which embeds the current
 *   sphere-sdk including mintFungibleToken). Build before running:
 *     cd /home/vrogojin && docker build -f trader-service/Dockerfile \
 *       -t ghcr.io/vrogojin/agentic-hosting/trader:local .
 *   The published `:v0.1` tag at ghcr.io is too old (tested in rounds
 *   3-5: lacks mintFungibleToken AND the faucet path silently
 *   doesn't deliver). The test materializes a temp templates.json
 *   that swaps the image tag from v0.1 to local without modifying
 *   agentic-hosting's shared config.
 *
 * Funding:
 *   Self-mint via TRADER_TEST_FUND env var (5000 each of UCT/USDU
 *   per trader at startup). HMA forwards the env to docker via its
 *   payload.env passthrough (validatePayloadEnv at
 *   agentic-hosting/src/host-manager/manager.ts:97 — TRADER_TEST_FUND
 *   isn't in FORBIDDEN_ENV_KEYS and doesn't start with UNICITY_, so
 *   it passes through unchanged). The trader's startup self-mint
 *   gate also requires TRADER_FAULT_INJECTION_ALLOWED=1.
 *
 * Out of scope:
 *   - Faucet HTTP — verified silently broken on testnet (round 5/6:
 *     POST returns 200 OK + tx_id but the deposit never surfaces in
 *     the trader's portfolio after 2+ minutes of polling).
 *   - Negotiation-failure paths — covered by negotiation-failures.
 *   - Partial fills — covered by edge-cases.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync, existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
const SELF_MINT_AMOUNT = 5000n; // matches basic-roundtrip's selfMintFund amount

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

    // The published trader image at ghcr.io/.../trader:v0.1 lacks both
    // mintFungibleToken (so TRADER_TEST_FUND fails) AND a working
    // payments.receive() loop (so faucet deposits never surface in
    // portfolio). To get end-to-end settlement working we use a
    // locally-built `trader:local` image with the current sphere-sdk +
    // trader code. Build via:
    //   cd /home/vrogojin && docker build -f trader-service/Dockerfile \
    //     -t ghcr.io/vrogojin/agentic-hosting/trader:local .
    // Then we materialize a temp templates.json that swaps the image
    // tag from v0.1 to local. agentic-hosting/config/templates.json is
    // not modified.
    const baseTemplatesPath = join(agenticProbe.ok ? agenticProbe.path : '', 'config', 'templates.json');
    const baseTemplates = JSON.parse(readFileSync(baseTemplatesPath, 'utf8')) as {
      templates: Array<{ template_id: string; image: string;[k: string]: unknown }>;
    };
    for (const t of baseTemplates.templates) {
      if (t.template_id === 'trader-agent') {
        t.image = 'ghcr.io/vrogojin/agentic-hosting/trader:local';
      }
    }
    const tplDir = mkdtempSync(join(tmpdir(), 'hma-trade-settlement-tpl-'));
    cliHomes.push(tplDir);
    const customTemplatesPath = join(tplDir, 'templates.json');
    writeFileSync(customTemplatesPath, JSON.stringify(baseTemplates, null, 2));

    // HMA accepts AUTHORIZED_CONTROLLERS as a comma-separated list of
    // pubkeys (see agentic-hosting/src/shared/config.ts:52). Authorize
    // every scenario's controller in one HMA — production has one HMA
    // per host serving multiple operators, so this matches the real
    // multi-tenant topology.
    console.log('[hma-trade-settlement] booting host-manager…');
    const manager = await spawnHostManager({
      controllerPubkey: controllers.map((c) => c.pubkey).join(','),
      templatesPath: customTemplatesPath,
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
    // The locally-rebuilt trader image (ghcr.io/.../trader:local) ships
    // with the current sphere-sdk which includes mintFungibleToken,
    // so we use TRADER_TEST_FUND for funding (self-mint at startup).
    // Reasons we don't use the testnet faucet:
    //   - The faucet returns 200 OK with a tx_id but the deposit
    //     never lands in the trader's portfolio (verified with
    //     5+ minute polling in round 5/6). basic-roundtrip's commit
    //     history documents the same flakiness.
    //   - Self-mint avoids any external HTTP dependency for funding,
    //     which is a more reliable test contract.
    // Both flags are required by the trader's production guard:
    //   TRADER_FAULT_INJECTION_ALLOWED=1 — opt-in to fault injection
    //   TRADER_TEST_FUND=<coinIdHex>:<amount>,...
    const traderEnv = {
      TRADER_TEST_FUND:
        `${UCT_COIN_ID}:${(SELF_MINT_AMOUNT).toString()},` +
        `${USDU_COIN_ID}:${(SELF_MINT_AMOUNT).toString()}`,
      TRADER_FAULT_INJECTION_ALLOWED: '1',
    };
    // Within a scenario, sphere-cli calls share one wallet.json and
    // race on its atomic temp+rename writes — see header. Sequential
    // within-scenario; cross-scenario runs in true parallel via
    // vitest it.concurrent.
    console.log(`[${scenarioId}] spawning escrow + alice + bob (sequential within-scenario)…`);
    const escrow = await hostSpawnAsync({
      cliPath: s.cliPath,
      cliHome: controller.cliHome,
      managerAddress: s.managerAddr,
      templateId: 'escrow-service',
      instanceName: `escrow-${scenarioId}`,
      timeoutMs: 180_000,
    });
    const alice = await hostSpawnAsync({
      cliPath: s.cliPath,
      cliHome: controller.cliHome,
      managerAddress: s.managerAddr,
      templateId: 'trader-agent',
      instanceName: `alice-${scenarioId}`,
      timeoutMs: 180_000,
      env: traderEnv,
    });
    const bob = await hostSpawnAsync({
      cliPath: s.cliPath,
      cliHome: controller.cliHome,
      managerAddress: s.managerAddr,
      templateId: 'trader-agent',
      instanceName: `bob-${scenarioId}`,
      timeoutMs: 180_000,
      env: traderEnv,
    });
    s.spawned.push(escrow, alice, bob);
    console.log(
      `[${scenarioId}] up: escrow=${escrow.instanceName} ` +
      `alice=${alice.instanceName} bob=${bob.instanceName}`,
    );
    return { escrow, alice, bob };
  }

  /**
   * Pull a coin's confirmed balance (smallest units) from a portfolio
   * response. The trader's GET_PORTFOLIO emits each balance as
   *   { asset, available, total, confirmed, unconfirmed }
   * where `confirmed` is the amount we should use for assertions.
   * Older versions used `amount`; tolerate both. Round-7 hit a bug
   * where the early return on `b.amount ?? '0'` short-circuited to
   * 0n WITHOUT falling through to `confirmed` when the field was
   * absent, so the self-mint balance assertion failed despite the
   * mint succeeding.
   */
  function balanceOf(p: readonly PortfolioBalance[], symbol: string): bigint {
    for (const b of p as Array<Record<string, unknown>>) {
      if (b['asset'] !== symbol) continue;
      // Prefer `confirmed` (canonical); fall back to `amount` (legacy).
      if (b['confirmed'] !== undefined) return BigInt(String(b['confirmed']));
      if (b['amount'] !== undefined) return BigInt(String(b['amount']));
      // `available` is also a reasonable fallback for "what can be spent now".
      if (b['available'] !== undefined) return BigInt(String(b['available']));
      return 0n;
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
  async function runSettlementScenario(
    scenarioId: string,
    controller: ScenarioController,
  ): Promise<void> {
    if (!state) throw new Error('beforeAll did not initialize state');
    const s = state;
    const { escrow, alice, bob } = await provisionTriple(scenarioId, controller);

    // Funding happened via TRADER_TEST_FUND at trader startup (5000 each
    // of UCT and USDU on both traders). The trader's main.ts logs
    // "test_fund_mint_succeeded" once per coin if the mint worked,
    // and the intent engine reads the resulting balance on its first
    // scan cycle. Wait briefly so the first portfolio query reflects
    // the post-mint balance.
    await new Promise((r) => setTimeout(r, 5_000));

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
