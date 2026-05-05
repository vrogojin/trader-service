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
 *           ├── spawn escrow + 2 traders   ← sequential (sphere-cli wallet contention)
 *           ├── FAUCET_REQUEST → shared faucet-agent for each trader
 *           │     (5000 UCT + 5000 USDU per trader; faucet mints + sends DM)
 *           ├── poll each trader's portfolio until faucet delivery confirms
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
 *   Each trader is funded via a `FAUCET_REQUEST` ACP DM to a SHARED
 *   js-faucet agent spawned by the same HMA. The test bootstraps an
 *   in-process Sphere wallet (helpers/faucet-client.ts) to sign +
 *   encrypt the DM. The faucet mints UCT + USDU and sends them to
 *   each trader's address; the test polls portfolio until
 *   `confirmed >= INITIAL_FUND_AMOUNT` for both assets.
 *
 *   This replaces two earlier funding paths that didn't work:
 *     - TRADER_TEST_FUND self-mint: trader-issued tokens may
 *       interact poorly with the swap protocol (issuer == sender
 *       is unusual in production).
 *     - Public faucet HTTP: returns 200 OK + tx_id but the deposit
 *       never surfaces in portfolio (verified across rounds 5-6).
 *
 *   The js-faucet image must be built before running this test:
 *     cd /home/vrogojin && docker build \
 *       -f js-faucet/Dockerfile \
 *       -t ghcr.io/unicitynetwork/agentic-hosting/faucet:local .
 *
 * Out of scope:
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
import { createFaucetClient, type FaucetClient } from './helpers/faucet-client.js';

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
  /** Single shared faucet — anyone can request, so one per HMA suffices. */
  faucet: SpawnedTenant;
  /** In-process Sphere wallet that signs+encrypts FAUCET_REQUEST DMs. */
  faucetClient: FaucetClient;
}

// Number of concurrent settlement scenarios. Each gets its own controller
// wallet + own cliHome. Bumping this raises the parallel infra load
// (more concurrent spawn DMs, more concurrent listdeals polls during
// settlement). Two is the contract test for the parallelism claim;
// higher values stress-test the relay+aggregator+HMA further.
const SCENARIO_COUNT = 2;

let state: SuiteState | null = null;

const SWAP_TIMEOUT_MS = 8 * 60_000; // 8 minutes; testnet settlement is 3-5 min typical
/** Per-asset funding amount delivered to each trader by the faucet. */
const INITIAL_FUND_AMOUNT = 5000n;
/** How long we wait for faucet-delivered tokens to surface in `confirmed` balance. */
const FUNDING_BALANCE_TIMEOUT_MS = 180_000;

// `volume_max` for matching intents in each scenario. Both sides post
// identical volumes so a single fill clears both intents.
const TRADE_VOLUME = 10n;
// Per-scenario rates are distinct to prevent cross-scenario matching;
// see runSettlementScenario header for why.
const PAIR_1_RATE = 1n; // 1 USDU per UCT
const PAIR_2_RATE = 3n; // 3 USDU per UCT — non-adjacent to avoid any rate-fuzzing overlap

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
    // The published trader image at ghcr.io/.../trader:v0.1 lacks a working
    // payments.receive() loop (verified in earlier rounds). Use the locally-
    // built `trader:local` image with the current sphere-sdk + trader code.
    // Add a `faucet-agent` template entry pointing at the locally-built
    // js-faucet image so the test can spawn it through the same HMA.
    const baseTemplatesPath = join(agenticProbe.ok ? agenticProbe.path : '', 'config', 'templates.json');
    const baseTemplates = JSON.parse(readFileSync(baseTemplatesPath, 'utf8')) as {
      templates: Array<{ template_id: string; image: string; entrypoint?: string[]; env_defaults?: Record<string, string>; resources?: Record<string, unknown>;[k: string]: unknown }>;
    };
    for (const t of baseTemplates.templates) {
      if (t.template_id === 'trader-agent') {
        t.image = 'ghcr.io/vrogojin/agentic-hosting/trader:local';
      }
      // The published escrow:v0.1 has an asymmetric bug in
      // deliverDepositInvoice — the second recipient's invoice_delivery
      // DM is never put on the wire, so swaps stall at "ACCEPTED" with
      // the trader polling for an invoice that the escrow never sent
      // (diag agent traced this 2026-05-05; see HMA-SETTLEMENT-DIAGNOSTIC.md).
      // Build escrow:local from current source and use it here.
      if (t.template_id === 'escrow-service') {
        t.image = 'ghcr.io/vrogojin/agentic-hosting/escrow:local';
      }
    }
    if (!baseTemplates.templates.some((t) => t.template_id === 'faucet-agent')) {
      baseTemplates.templates.push({
        template_id: 'faucet-agent',
        image: 'ghcr.io/unicitynetwork/agentic-hosting/faucet:local',
        entrypoint: ['node', '/app/dist/acp-adapter/main.js'],
        env_defaults: { LOG_LEVEL: 'info', SPHERE_NETWORK: 'testnet' },
        resources: { memory_mb: 512, pids_limit: 256 },
      });
    } else {
      for (const t of baseTemplates.templates) {
        if (t.template_id === 'faucet-agent') {
          t.image = 'ghcr.io/unicitynetwork/agentic-hosting/faucet:local';
        }
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

    // Spawn ONE shared faucet (the faucet is open — anyone can request,
    // so we don't need one per scenario).
    console.log('[hma-trade-settlement] spawning shared faucet-agent…');
    const faucet = await hostSpawnAsync({
      cliPath,
      cliHome: controllers[0]!.cliHome,
      managerAddress: managerAddr,
      templateId: 'faucet-agent',
      instanceName: `faucet-${randomUUID().slice(0, 6)}`,
      timeoutMs: 180_000,
    });
    console.log(
      `[hma-trade-settlement] faucet ready: pubkey=${faucet.tenantPubkey.slice(0, 16)}… ` +
      `nametag=${faucet.tenantNametag ?? '<none>'}`,
    );

    // In-process Sphere wallet that the test uses to send FAUCET_REQUEST
    // DMs. The faucet doesn't authorize senders, so this wallet doesn't
    // need to be in HMA's AUTHORIZED_CONTROLLERS list.
    console.log('[hma-trade-settlement] bootstrapping in-process FaucetClient…');
    const faucetClient = await createFaucetClient();
    console.log(`[hma-trade-settlement] faucet client pubkey ${faucetClient.pubkey.slice(0, 16)}…`);

    state = {
      cliPath,
      cliHomes,
      manager,
      managerAddr,
      controllers,
      spawned: [faucet],
      faucet,
      faucetClient,
    };
  }, 900_000); // 15 min — adds ~30-60s for faucet spawn + client bootstrap on top of controller-wallet inits

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
    try { await state.faucetClient.destroy(); } catch { /* best effort */ }
    await state.manager.stop();
    for (const home of state.cliHomes) {
      try { rmSync(home, { recursive: true, force: true }); }
      catch { /* best effort */ }
    }
  }, 240_000);

  // ---- Per-scenario helpers -------------------------------------------------

  /**
   * Spawn one escrow + two traders (alice/bob) sequentially within a
   * scenario, then fund each trader with UCT + USDU via the SHARED
   * faucet-agent. Funding via FAUCET_REQUEST DM replaces the previous
   * TRADER_TEST_FUND self-mint pathway:
   *   - Self-mint produced trader-issued tokens, which may interact
   *     poorly with the swap protocol (the swap counterparty would see
   *     the issuer == sender, which is unusual in production).
   *   - Public faucet HTTP returned 200 OK + tx_id but never delivered
   *     (verified across multiple rounds — silent flake).
   *   - The js-faucet agent mints + sends with the FAUCET as issuer,
   *     matching production reality.
   * Each trader is funded with `INITIAL_FUND_AMOUNT` of both UCT and
   * USDU so either side has the inventory to fulfil any direction.
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

    // Fund both traders via FAUCET_REQUEST DMs. The faucet mints the
    // tokens and sends to each trader's DIRECT://. We then poll each
    // trader's portfolio until the balance arrives in `confirmed`.
    console.log(`[${scenarioId}] funding alice + bob via faucet DM…`);
    for (const t of [{ name: 'alice', tenant: alice }, { name: 'bob', tenant: bob }]) {
      const recipient = t.tenant.tenantNametag
        ? `@${t.tenant.tenantNametag}`
        : `DIRECT://${t.tenant.tenantPubkey}`;
      const deliveries = await s.faucetClient.request(s.faucet.tenantPubkey, {
        recipient,
        items: [
          { asset: 'UCT', amount: INITIAL_FUND_AMOUNT.toString() },
          { asset: 'USDU', amount: INITIAL_FUND_AMOUNT.toString() },
        ],
      }, 240_000);
      console.log(
        `[${scenarioId}] ${t.name}: faucet delivered ${deliveries.length} item(s) ` +
        `(transfer_ids: ${deliveries.map((d) => d.transfer_id.slice(0, 8)).join(', ')})`,
      );
    }
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
  /**
   * `tradeRate` differs per scenario so the two pairs CANNOT
   * cross-match on testnet. Round 8 saw both scenarios stuck at
   * waitForDealInState → COMPLETED with 29 deals in CANCELLED state
   * because pair-1's alice (rate=1) was matching pair-2's bob (also
   * rate=1) and trying to negotiate — but the trusted_escrows on
   * each side only allow that scenario's own escrow, so every
   * cross-scenario negotiation flipped to FAILED/CANCELLED in a
   * thrash loop. With distinct rates, rate-overlap filtering at
   * the matcher level prevents the cross-match before negotiation
   * even starts.
   */
  async function runSettlementScenario(
    scenarioId: string,
    controller: ScenarioController,
    tradeRate: bigint,
  ): Promise<void> {
    if (!state) throw new Error('beforeAll did not initialize state');
    const s = state;
    const { escrow, alice, bob } = await provisionTriple(scenarioId, controller);

    // The faucet returned `acp.result` for each FAUCET_REQUEST, but the
    // trader's payments.receive() loop runs on a 15s cycle — the
    // delivered tokens may be in `unconfirmed` for up to ~30s after
    // the send completes. Poll each trader's portfolio until both
    // assets reach the funded amount in `confirmed` so set-strategy /
    // create-intent operate on a fully-settled balance.
    console.log(`[${scenarioId}] waiting for faucet-funded balances to confirm…`);
    for (const t of [{ name: 'alice', tenant: alice }, { name: 'bob', tenant: bob }]) {
      const deadline = Date.now() + FUNDING_BALANCE_TIMEOUT_MS;
      let lastSnapshot: readonly PortfolioBalance[] = [];
      while (Date.now() < deadline) {
        try {
          lastSnapshot = await portfolioAsync({
            cliPath: s.cliPath, cliHome: controller.cliHome, tenant: t.tenant.tenantPubkey,
          });
          if (
            balanceOf(lastSnapshot, 'UCT') >= INITIAL_FUND_AMOUNT &&
            balanceOf(lastSnapshot, 'USDU') >= INITIAL_FUND_AMOUNT
          ) {
            break;
          }
        } catch { /* transient — keep polling */ }
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
      const uct = balanceOf(lastSnapshot, 'UCT');
      const usdu = balanceOf(lastSnapshot, 'USDU');
      if (uct < INITIAL_FUND_AMOUNT || usdu < INITIAL_FUND_AMOUNT) {
        throw new Error(
          `[${scenarioId}] ${t.name} did not see UCT>=${INITIAL_FUND_AMOUNT} && USDU>=${INITIAL_FUND_AMOUNT} ` +
          `within ${FUNDING_BALANCE_TIMEOUT_MS}ms. observed: UCT=${uct}, USDU=${usdu}`,
        );
      }
      console.log(`[${scenarioId}] ${t.name} balance confirmed: ${uct}UCT/${usdu}USDU`);
    }

    // ---- 2. Configure trusted escrows on both traders --------------
    // Sequential within-scenario (wallet.json contention; see provisionTriple).
    console.log(`[${scenarioId}] set-strategy on alice + bob…`);
    await setStrategyAsync({
      cliPath: s.cliPath, cliHome: controller.cliHome, tenant: alice.tenantPubkey,
      trustedEscrows: [escrow.tenantDirectAddress],
      maxConcurrent: 5,
    });
    await setStrategyAsync({
      cliPath: s.cliPath, cliHome: controller.cliHome, tenant: bob.tenantPubkey,
      trustedEscrows: [escrow.tenantDirectAddress],
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
    // Sanity: the faucet delivery must have landed (otherwise no
    // UCT/USDU is available to trade and the swap will hang). The
    // earlier polling loop already enforces this; this assertion is
    // the explicit test contract.
    expect(aliceUctBefore + aliceUsduBefore).toBeGreaterThan(0n);
    expect(bobUctBefore + bobUsduBefore).toBeGreaterThan(0n);

    // ---- 4. Post matching intents (sequential — wallet.json) ------
    // Alice buys UCT (pays USDU). Bob sells UCT (receives USDU).
    console.log(`[${scenarioId}] posting matching intents…`);
    // CRITICAL: pass escrow_address. Trader's intent-engine defaults
    // it to the literal string 'any' when omitted (intent-engine.ts:836)
    // — that's a wildcard that means "any escrow", but the swap-executor
    // uses terms.escrow_address as a routing target and tries to send
    // swap.announce to 'any', which doesn't resolve. The escrow then
    // never sees the announce and rejects subsequent status queries
    // with "Swap not found", which trips deal CANCELLED. Round 10
    // diagnosed this from escrow logs (zero announce_received events
    // despite ping/pong round-trips working). Fix: route via the
    // actual HMA-spawned escrow's pubkey (must match a value in
    // trustedEscrows from the earlier set-strategy call).
    const aliceIntent = await createIntentAsync({
      cliPath: s.cliPath, cliHome: controller.cliHome, tenant: alice.tenantPubkey,
      direction: 'buy',
      baseAsset: 'UCT', quoteAsset: 'USDU',
      rateMin: tradeRate, rateMax: tradeRate,
      volumeMin: TRADE_VOLUME, volumeMax: TRADE_VOLUME,
      expiryMs: SWAP_TIMEOUT_MS,
      escrowAddress: escrow.tenantDirectAddress,
    });
    const bobIntent = await createIntentAsync({
      cliPath: s.cliPath, cliHome: controller.cliHome, tenant: bob.tenantPubkey,
      direction: 'sell',
      baseAsset: 'UCT', quoteAsset: 'USDU',
      rateMin: tradeRate, rateMax: tradeRate,
      volumeMin: TRADE_VOLUME, volumeMax: TRADE_VOLUME,
      expiryMs: SWAP_TIMEOUT_MS,
      escrowAddress: escrow.tenantDirectAddress,
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

    const expectedUsduPaid = tradeRate * TRADE_VOLUME;
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

  it('Pair-1: full spawn → trade → settle → withdraw via HMA (rate=1)', async () => {
    if (!state) throw new Error('beforeAll did not initialize state');
    const c = state.controllers[0];
    if (!c) throw new Error('controller #0 missing');
    await runSettlementScenario(`p1-${randomUUID().slice(0, 6)}`, c, PAIR_1_RATE);
  }, SWAP_TIMEOUT_MS + 4 * 60_000); // 12 min total budget per scenario

  it('Pair-2: parallel scenario settles on the same HMA at distinct rate (rate=3)', async () => {
    if (!state) throw new Error('beforeAll did not initialize state');
    const c = state.controllers[1];
    if (!c) throw new Error('controller #1 missing');
    await runSettlementScenario(`p2-${randomUUID().slice(0, 6)}`, c, PAIR_2_RATE);
  }, SWAP_TIMEOUT_MS + 4 * 60_000);
});
