/**
 * E2E Live Cross-Environment Trading Test: Agents from two separate hosting
 * environments discover each other, negotiate, and execute trades via escrow
 * services hosted in either environment.
 *
 * Proves that trading does NOT depend on hosting co-location. All agents
 * communicate over the same testnet Nostr relay — the hosting environment
 * is invisible to the trading protocol.
 *
 * Architecture:
 *   Environment A (Host Manager A):
 *     - Escrow A1, Escrow A2 (escrow-service)
 *     - alpha, bravo, charlie, delta, echo, foxtrot (trader-agent)
 *   Environment B (Host Manager B):
 *     - Escrow B1 (escrow-service)
 *     - golf, hotel, india, juliet, kilo (trader-agent)
 *
 * Cross-environment trading pairs (every trade crosses env boundary):
 *   1. alpha (A) SELL 400000 UCT <-> golf (B) BUY    via Escrow A1
 *   2. hotel (B) SELL 350000 UCT <-> bravo (A) BUY   via Escrow B1
 *   3. charlie (A) SELL 300000 UCT <-> india (B) BUY  via Escrow A2
 *   4. juliet (B) SELL 250000 UCT <-> delta (A) BUY   via Escrow A1
 *   5. echo (A) SELL 200000 UCT <-> kilo (B) BUY      via Escrow B1
 *
 * foxtrot (A) is funded but posts NO intent — spectator verifying its
 * balance remains unchanged after all trades complete.
 *
 * Escrow distribution:
 *   - Escrow A1: trades 1 + 4 (concurrent multi-swap on single escrow)
 *   - Escrow A2: trade 3
 *   - Escrow B1: trades 2 + 5 (concurrent multi-swap on single escrow)
 *
 * Expected final balances (rate=1, quoteAmount = volume):
 *   Sellers lose UCT, gain USDU. Buyers gain UCT, lose USDU.
 *   foxtrot: unchanged (10 UCT, 10 USDU).
 *
 * Conservation: total UCT = 110e18, total USDU = 110e6 (11 agents x 10 each)
 *
 * Run: npx vitest run --config vitest.e2e-live.config.ts test/e2e-live/cross-env-trading.e2e-live.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTestEnvironment,
  teardownEnvironment,
  checkDockerAvailability,
  type LiveTestEnvironment,
} from './helpers/environment.js';
import {
  spawnAgent,
  sendCommand,
  verifyInstanceState,
  type SpawnedAgent,
} from './helpers/agent-helpers.js';
import { fundWallet } from './helpers/funding.js';

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

const dockerCheck = checkDockerAvailability();
if (dockerCheck) throw new Error(`Docker required: ${dockerCheck}`);

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let envA: LiveTestEnvironment;
let envB: LiveTestEnvironment;

// Escrows
let escrowA1: SpawnedAgent;
let escrowA2: SpawnedAgent;
let escrowB1: SpawnedAgent;
let escrowA1Nametag: string;
let escrowA2Nametag: string;
let escrowB1Nametag: string;

// Env A traders
let alpha: SpawnedAgent;
let bravo: SpawnedAgent;
let charlie: SpawnedAgent;
let delta: SpawnedAgent;
let echo: SpawnedAgent;
let foxtrot: SpawnedAgent;

// Env B traders
let golf: SpawnedAgent;
let hotel: SpawnedAgent;
let india: SpawnedAgent;
let juliet: SpawnedAgent;
let kilo: SpawnedAgent;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Faucet gives 10 whole tokens per call. UCT has 18 decimals, USDU has 6.
const EXPECTED_UCT = 10_000_000_000_000_000_000n; // 10 x 10^18
const EXPECTED_USDU = 10_000_000n;                 // 10 x 10^6

// Trade definitions: every trade crosses environment boundary
interface TradeSpec {
  seller: string;
  sellerEnv: 'A' | 'B';
  buyer: string;
  buyerEnv: 'A' | 'B';
  volume: bigint;
  escrowKey: 'escrowA1' | 'escrowA2' | 'escrowB1';
}

const TRADES: TradeSpec[] = [
  { seller: 'alpha',   sellerEnv: 'A', buyer: 'golf',   buyerEnv: 'B', volume: 400_000n, escrowKey: 'escrowA1' },
  { seller: 'hotel',   sellerEnv: 'B', buyer: 'bravo',  buyerEnv: 'A', volume: 350_000n, escrowKey: 'escrowB1' },
  { seller: 'charlie', sellerEnv: 'A', buyer: 'india',  buyerEnv: 'B', volume: 300_000n, escrowKey: 'escrowA2' },
  { seller: 'juliet',  sellerEnv: 'B', buyer: 'delta',  buyerEnv: 'A', volume: 250_000n, escrowKey: 'escrowA1' },
  { seller: 'echo',    sellerEnv: 'A', buyer: 'kilo',   buyerEnv: 'B', volume: 200_000n, escrowKey: 'escrowB1' },
];

// 11 agents x 10 tokens each
const TOTAL_UCT = EXPECTED_UCT * 11n;
const TOTAL_USDU = EXPECTED_USDU * 11n;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string): void {
  console.log(`[cross-env-e2e ${new Date().toISOString()}] ${msg}`);
}

/** Extract confirmed balance for a given asset from a GET_PORTFOLIO response. */
function getBalance(portfolio: Record<string, unknown>, asset: string): bigint {
  const balances = portfolio['balances'] as Array<Record<string, unknown>>;
  const entry = balances.find((b) => b['asset'] === asset);
  if (!entry) return 0n;
  return BigInt(String(entry['confirmed'] ?? '0'));
}

/** Map agent name to its SpawnedAgent and hosting environment. */
function getAgent(name: string): { agent: SpawnedAgent; env: LiveTestEnvironment } {
  const map: Record<string, { agent: SpawnedAgent; env: LiveTestEnvironment }> = {
    alpha:   { agent: alpha,   env: envA },
    bravo:   { agent: bravo,   env: envA },
    charlie: { agent: charlie, env: envA },
    delta:   { agent: delta,   env: envA },
    echo:    { agent: echo,    env: envA },
    foxtrot: { agent: foxtrot, env: envA },
    golf:    { agent: golf,    env: envB },
    hotel:   { agent: hotel,   env: envB },
    india:   { agent: india,   env: envB },
    juliet:  { agent: juliet,  env: envB },
    kilo:    { agent: kilo,    env: envB },
  };
  return map[name]!;
}

/** All 11 agents with labels. */
function allAgents(): Array<{ name: string; agent: SpawnedAgent; env: LiveTestEnvironment }> {
  return [
    { name: 'alpha',   agent: alpha,   env: envA },
    { name: 'bravo',   agent: bravo,   env: envA },
    { name: 'charlie', agent: charlie, env: envA },
    { name: 'delta',   agent: delta,   env: envA },
    { name: 'echo',    agent: echo,    env: envA },
    { name: 'foxtrot', agent: foxtrot, env: envA },
    { name: 'golf',    agent: golf,    env: envB },
    { name: 'hotel',   agent: hotel,   env: envB },
    { name: 'india',   agent: india,   env: envB },
    { name: 'juliet',  agent: juliet,  env: envB },
    { name: 'kilo',    agent: kilo,    env: envB },
  ];
}

/** The 10 actively trading agents (excludes foxtrot). */
function tradingAgents(): Array<{ name: string; agent: SpawnedAgent; env: LiveTestEnvironment }> {
  return allAgents().filter((a) => a.name !== 'foxtrot');
}

/** Resolve escrow nametag from key. */
function escrowNametag(key: 'escrowA1' | 'escrowA2' | 'escrowB1'): string {
  const map: Record<string, string> = {
    escrowA1: escrowA1Nametag,
    escrowA2: escrowA2Nametag,
    escrowB1: escrowB1Nametag,
  };
  return map[key]!;
}

/** Build the set of escrow nametags an agent needs in trusted_escrows. */
function trustedEscrowsFor(agentName: string): string[] {
  const escrows = new Set<string>();
  for (const trade of TRADES) {
    if (trade.seller === agentName || trade.buyer === agentName) {
      escrows.add(`@${escrowNametag(trade.escrowKey)}`);
    }
  }
  // foxtrot has no trades — give it any escrow so SET_STRATEGY succeeds
  if (escrows.size === 0) {
    escrows.add(`@${escrowA1Nametag}`);
  }
  return [...escrows];
}

/** Compute expected post-trade balance for an agent. */
function expectedBalance(agentName: string): { uct: bigint; usdu: bigint } {
  let uctDelta = 0n;
  let usduDelta = 0n;

  for (const trade of TRADES) {
    if (trade.seller === agentName) {
      // Seller loses UCT, gains USDU (rate=1, so quoteAmount = volume)
      uctDelta -= trade.volume;
      usduDelta += trade.volume;
    } else if (trade.buyer === agentName) {
      // Buyer gains UCT, loses USDU
      uctDelta += trade.volume;
      usduDelta -= trade.volume;
    }
  }

  return {
    uct: EXPECTED_UCT + uctDelta,
    usdu: EXPECTED_USDU + usduDelta,
  };
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // 1. Create two independent hosting environments
  log('creating Environment A');
  envA = await createTestEnvironment();
  log(`Environment A ready: manager=@${envA.managerNametag}`);

  log('creating Environment B');
  envB = await createTestEnvironment();
  log(`Environment B ready: manager=@${envB.managerNametag}`);

  // 2. Spawn escrows — A1 and A2 in Env A, B1 in Env B
  log('spawning escrowA1 (escrow-service) in Env A');
  escrowA1 = await spawnAgent(envA, 'escrow-service', 'xenv-escrow-a1');
  await verifyInstanceState(envA, escrowA1.instanceName, 'RUNNING');
  escrowA1Nametag = escrowA1.tenantNametag ?? '';
  log(`escrowA1 RUNNING, nametag=${escrowA1Nametag}`);

  log('spawning escrowA2 (escrow-service) in Env A');
  escrowA2 = await spawnAgent(envA, 'escrow-service', 'xenv-escrow-a2');
  await verifyInstanceState(envA, escrowA2.instanceName, 'RUNNING');
  escrowA2Nametag = escrowA2.tenantNametag ?? '';
  log(`escrowA2 RUNNING, nametag=${escrowA2Nametag}`);

  log('spawning escrowB1 (escrow-service) in Env B');
  escrowB1 = await spawnAgent(envB, 'escrow-service', 'xenv-escrow-b1');
  await verifyInstanceState(envB, escrowB1.instanceName, 'RUNNING');
  escrowB1Nametag = escrowB1.tenantNametag ?? '';
  log(`escrowB1 RUNNING, nametag=${escrowB1Nametag}`);

  // 3. Spawn 6 traders in Env A
  const envATraders: Array<{ varName: string; instanceName: string }> = [
    { varName: 'alpha',   instanceName: 'xenv-alpha' },
    { varName: 'bravo',   instanceName: 'xenv-bravo' },
    { varName: 'charlie', instanceName: 'xenv-charlie' },
    { varName: 'delta',   instanceName: 'xenv-delta' },
    { varName: 'echo',    instanceName: 'xenv-echo' },
    { varName: 'foxtrot', instanceName: 'xenv-foxtrot' },
  ];

  for (const { varName, instanceName } of envATraders) {
    log(`spawning ${varName} (trader-agent) in Env A`);
    const agent = await spawnAgent(envA, 'trader-agent', instanceName);
    await verifyInstanceState(envA, agent.instanceName, 'RUNNING');
    log(`${varName} RUNNING, nametag=${agent.tenantNametag}`);

    // Assign to module-level variable
    switch (varName) {
      case 'alpha':   alpha = agent; break;
      case 'bravo':   bravo = agent; break;
      case 'charlie': charlie = agent; break;
      case 'delta':   delta = agent; break;
      case 'echo':    echo = agent; break;
      case 'foxtrot': foxtrot = agent; break;
    }
  }

  // 4. Spawn 5 traders in Env B
  const envBTraders: Array<{ varName: string; instanceName: string }> = [
    { varName: 'golf',   instanceName: 'xenv-golf' },
    { varName: 'hotel',  instanceName: 'xenv-hotel' },
    { varName: 'india',  instanceName: 'xenv-india' },
    { varName: 'juliet', instanceName: 'xenv-juliet' },
    { varName: 'kilo',   instanceName: 'xenv-kilo' },
  ];

  for (const { varName, instanceName } of envBTraders) {
    log(`spawning ${varName} (trader-agent) in Env B`);
    const agent = await spawnAgent(envB, 'trader-agent', instanceName);
    await verifyInstanceState(envB, agent.instanceName, 'RUNNING');
    log(`${varName} RUNNING, nametag=${agent.tenantNametag}`);

    switch (varName) {
      case 'golf':   golf = agent; break;
      case 'hotel':  hotel = agent; break;
      case 'india':  india = agent; break;
      case 'juliet': juliet = agent; break;
      case 'kilo':   kilo = agent; break;
    }
  }

  // 5. Fund all 11 traders (10 UCT + 10 USDU each)
  log('funding all 11 trader wallets via faucet');
  for (const { name, agent } of allAgents()) {
    log(`funding ${name} with 10 UCT`);
    await fundWallet(getAgent(name).env, agent, 'unicity', 10);
    log(`funding ${name} with 10 USDU`);
    await fundWallet(getAgent(name).env, agent, 'unicity-usd', 10);
  }

  log('waiting 20s for Nostr delivery of faucet transfers');
  await new Promise((r) => setTimeout(r, 20_000));

  log('setup complete — 3 escrows + 11 agents spawned and funded across 2 environments');
}, 600_000);

afterAll(async () => {
  if (envA) await teardownEnvironment(envA);
  if (envB) await teardownEnvironment(envB);
}, 120_000);

// ===========================================================================
// Test Suite
// ===========================================================================

describe('Live Trading: Cross-Environment 5-Pair Trading with 3 Escrows', () => {

  // --- Test 1: All 11 agents RUNNING and funded ----------------------------

  it('all 11 agents are RUNNING and funded', async () => {
    for (const { name, agent, env } of allAgents()) {
      const portfolio = await sendCommand(env, agent.instanceName, 'GET_PORTFOLIO');
      log(`${name} portfolio: ${JSON.stringify(portfolio)}`);

      const uct = getBalance(portfolio, 'UCT');
      const usdu = getBalance(portfolio, 'USDU');
      log(`${name}: UCT=${uct}, USDU=${usdu}`);
      expect(uct, `${name} UCT must be ${EXPECTED_UCT}`).toBe(EXPECTED_UCT);
      expect(usdu, `${name} USDU must be ${EXPECTED_USDU}`).toBe(EXPECTED_USDU);
    }
  }, 60_000);

  // --- Test 2: Configure strategy with per-agent escrow assignment ---------

  it('configure strategy with per-agent escrow assignment', async () => {
    log(`escrow nametags: A1=@${escrowA1Nametag}, A2=@${escrowA2Nametag}, B1=@${escrowB1Nametag}`);

    // Phase 1: auto_match=false so intents can be created without triggering
    // matching. All intents must be visible on MarketModule before scanning.
    for (const { name, agent, env } of allAgents()) {
      const escrows = trustedEscrowsFor(name);
      log(`${name} trusted_escrows: ${escrows.join(', ')}`);

      const result = await sendCommand(env, agent.instanceName, 'SET_STRATEGY', {
        auto_match: false,
        auto_negotiate: true,
        scan_interval_ms: 5000,
        max_concurrent_swaps: 3,
        trusted_escrows: escrows,
      });
      log(`${name} SET_STRATEGY (phase 1, no matching): ${JSON.stringify(result)}`);
    }
  }, 60_000);

  // --- Test 3: Create intents for all 10 trading agents --------------------

  it('create intents for all 10 trading agents', async () => {
    for (const trade of TRADES) {
      const sellerInfo = getAgent(trade.seller);
      const buyerInfo = getAgent(trade.buyer);
      const escrowAddr = `@${escrowNametag(trade.escrowKey)}`;

      // Seller intent
      const sellerIntent = await sendCommand(
        sellerInfo.env, sellerInfo.agent.instanceName, 'CREATE_INTENT', {
          direction: 'sell',
          base_asset: 'UCT',
          quote_asset: 'USDU',
          rate_min: '1',
          rate_max: '1',
          volume_min: String(trade.volume),
          volume_max: String(trade.volume),
          escrow_address: escrowAddr,
          expiry_sec: 600,
        },
      );
      log(`${trade.seller} CREATE_INTENT (SELL ${trade.volume}): ${JSON.stringify(sellerIntent)}`);
      expect(sellerIntent['state']).toBe('ACTIVE');
      expect(sellerIntent['intent_id']).toBeDefined();
      expect(sellerIntent['market_intent_id']).toBeDefined();
      expect(sellerIntent['direction'], `${trade.seller} direction must be sell`).toBe('sell');
      expect(sellerIntent['base_asset']).toBe('UCT');
      expect(sellerIntent['quote_asset']).toBe('USDU');

      // Buyer intent
      const buyerIntent = await sendCommand(
        buyerInfo.env, buyerInfo.agent.instanceName, 'CREATE_INTENT', {
          direction: 'buy',
          base_asset: 'UCT',
          quote_asset: 'USDU',
          rate_min: '1',
          rate_max: '1',
          volume_min: String(trade.volume),
          volume_max: String(trade.volume),
          escrow_address: escrowAddr,
          expiry_sec: 600,
        },
      );
      log(`${trade.buyer} CREATE_INTENT (BUY ${trade.volume}): ${JSON.stringify(buyerIntent)}`);
      expect(buyerIntent['state']).toBe('ACTIVE');
      expect(buyerIntent['intent_id']).toBeDefined();
      expect(buyerIntent['market_intent_id']).toBeDefined();
      expect(buyerIntent['direction'], `${trade.buyer} direction must be buy`).toBe('buy');
      expect(buyerIntent['base_asset']).toBe('UCT');
      expect(buyerIntent['quote_asset']).toBe('USDU');
    }
  }, 60_000);

  // --- Test 4: Verify all 10 intents ACTIVE, foxtrot has 0 ----------------

  it('all 10 intents ACTIVE, foxtrot has 0 intents', async () => {
    // Verify each trading agent has exactly 1 active intent
    for (const { name, agent, env } of tradingAgents()) {
      const result = await sendCommand(env, agent.instanceName, 'LIST_INTENTS', { filter: 'active' });
      const intents = (result['intents'] ?? []) as Array<Record<string, unknown>>;
      log(`${name} active intents: ${intents.length}`);
      expect(intents.length, `${name} must have 1 active intent`).toBe(1);
      expect(intents[0]!['state']).toBe('ACTIVE');
      expect(intents[0]!['base_asset']).toBe('UCT');
      expect(intents[0]!['quote_asset']).toBe('USDU');
      expect(Number(intents[0]!['rate_min']), `${name} rate_min`).toBe(1);
      expect(Number(intents[0]!['rate_max']), `${name} rate_max`).toBe(1);
    }

    // Verify specific volumes and directions per trade
    for (const trade of TRADES) {
      const sellerInfo = getAgent(trade.seller);
      const buyerInfo = getAgent(trade.buyer);

      const sellerResult = await sendCommand(
        sellerInfo.env, sellerInfo.agent.instanceName, 'LIST_INTENTS', { filter: 'active' },
      );
      const sellerIntents = (sellerResult['intents'] as Array<Record<string, unknown>>);
      expect(sellerIntents[0]!['direction']).toBe('sell');
      expect(Number(sellerIntents[0]!['volume_max'])).toBe(Number(trade.volume));

      const buyerResult = await sendCommand(
        buyerInfo.env, buyerInfo.agent.instanceName, 'LIST_INTENTS', { filter: 'active' },
      );
      const buyerIntents = (buyerResult['intents'] as Array<Record<string, unknown>>);
      expect(buyerIntents[0]!['direction']).toBe('buy');
      expect(Number(buyerIntents[0]!['volume_max'])).toBe(Number(trade.volume));
    }

    // foxtrot must have 0 intents
    const foxtrotResult = await sendCommand(envA, foxtrot.instanceName, 'LIST_INTENTS', { filter: 'active' });
    const foxtrotIntents = (foxtrotResult['intents'] ?? []) as Array<Record<string, unknown>>;
    log(`foxtrot active intents: ${foxtrotIntents.length}`);
    expect(foxtrotIntents.length, 'foxtrot must have 0 active intents').toBe(0);
  }, 60_000);

  // --- Test 5: Enable auto_match on all trading agents ---------------------

  it('enable auto_match on all trading agents', async () => {
    for (const { name, agent, env } of tradingAgents()) {
      await sendCommand(env, agent.instanceName, 'SET_STRATEGY', {
        auto_match: true,
        scan_interval_ms: 5000,
      });
      log(`${name} auto_match ENABLED`);
    }
  }, 60_000);

  // --- Test 6: Agents discover and negotiate -- 5 deals reach ACCEPTED -----

  it('agents discover and negotiate — at least 5 deals reach ACCEPTED', async () => {
    const MAX_ROUNDS = 12;
    const POLL_INTERVAL_MS = 15_000;
    let sufficientDeals = false;

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      log(`poll round ${round}/${MAX_ROUNDS} — waiting ${POLL_INTERVAL_MS / 1000}s...`);
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

      // Gather deal states from all 10 trading agents
      let acceptedEntries = 0;
      for (const { name, agent, env } of tradingAgents()) {
        const swaps = await sendCommand(env, agent.instanceName, 'LIST_SWAPS', { filter: 'all' });
        const deals = (swaps['deals'] ?? []) as Array<Record<string, unknown>>;

        const states: Record<string, number> = {};
        for (const d of deals) {
          const s = String(d['state']);
          states[s] = (states[s] ?? 0) + 1;
        }
        log(`  ${name} deals: ${JSON.stringify(states)}`);

        // Count deals at ACCEPTED or beyond
        const advanced = deals.filter(
          (d) => d['state'] === 'ACCEPTED' || d['state'] === 'EXECUTING' || d['state'] === 'COMPLETED',
        );
        acceptedEntries += advanced.length;
      }

      // 5 unique deals, each visible on 2 sides = 10 entries minimum
      if (acceptedEntries >= 10) {
        log(`sufficient deals found: ${acceptedEntries} entries across trading agents`);
        sufficientDeals = true;
        break;
      }
    }

    expect(
      sufficientDeals,
      'at least 5 deals must reach ACCEPTED/EXECUTING/COMPLETED (10 entries across 10 agents)',
    ).toBe(true);
  }, 210_000);

  // --- Test 7: All 5 deals reach COMPLETED via escrow ----------------------

  it('all 5 deals reach COMPLETED via escrow', async () => {
    const MAX_SWAP_ROUNDS = 16;
    const SWAP_POLL_MS = 15_000;
    let allCompleted = false;

    for (let round = 1; round <= MAX_SWAP_ROUNDS; round++) {
      log(`swap poll round ${round}/${MAX_SWAP_ROUNDS} — waiting ${SWAP_POLL_MS / 1000}s...`);
      await new Promise((r) => setTimeout(r, SWAP_POLL_MS));

      let completedAgents = 0;

      for (const { name, agent, env } of tradingAgents()) {
        const swaps = await sendCommand(env, agent.instanceName, 'LIST_SWAPS', { filter: 'all' });
        const deals = (swaps['deals'] ?? []) as Array<Record<string, unknown>>;

        const states: Record<string, number> = {};
        for (const d of deals) {
          const s = String(d['state']);
          states[s] = (states[s] ?? 0) + 1;
        }
        log(`  ${name} deals: ${JSON.stringify(states)}`);

        // Log non-trivial deal states for diagnostics
        for (const d of deals) {
          const state = String(d['state']);
          if (state !== 'CANCELLED' && state !== 'PROPOSED') {
            log(`    ${name} deal ${String(d['deal_id']).slice(0, 12)}... state=${state} role=${d['role']}`);
          }
        }

        // Query SwapExecutor state for detailed progress (first 8 rounds only)
        if (round <= 8) {
          try {
            const exec = await sendCommand(env, agent.instanceName, 'DEBUG_SWAP_EXEC');
            const active = (exec['active_deals'] as Array<Record<string, unknown>>) ?? [];
            if (active.length > 0) {
              log(`    ${name} SwapExecutor: ${active.map((a) => `${String(a['deal_id']).slice(0, 12)}=${a['state']}`).join(', ')}`);
            }
            const errors = (exec['last_errors'] as unknown[]) ?? [];
            if (errors.length > 0) log(`    ${name} errors: ${JSON.stringify(errors)}`);
          } catch { /* non-critical */ }
        }

        // Check for FAILED deals
        const failedDeals = deals.filter((d) => d['state'] === 'FAILED');
        if (failedDeals.length > 0) {
          log(`  WARNING: ${name} has ${failedDeals.length} FAILED deals`);
          for (const d of failedDeals) {
            log(`    FAILED: ${JSON.stringify(d)}`);
          }
        }

        // Agent has a COMPLETED deal
        const hasCompleted = deals.some((d) => String(d['state']) === 'COMPLETED');
        if (hasCompleted) completedAgents++;
      }

      log(`round ${round}: ${completedAgents}/10 trading agents have COMPLETED deals`);

      if (completedAgents >= 10) {
        allCompleted = true;

        // Log deal IDs for each trade pair
        for (const trade of TRADES) {
          const sellerInfo = getAgent(trade.seller);
          const buyerInfo = getAgent(trade.buyer);

          const sellerSwaps = await sendCommand(sellerInfo.env, sellerInfo.agent.instanceName, 'LIST_SWAPS', { filter: 'all' });
          const buyerSwaps = await sendCommand(buyerInfo.env, buyerInfo.agent.instanceName, 'LIST_SWAPS', { filter: 'all' });

          const sellerDeals = (sellerSwaps['deals'] ?? []) as Array<Record<string, unknown>>;
          const buyerDeals = (buyerSwaps['deals'] ?? []) as Array<Record<string, unknown>>;

          const sellerCompleted = sellerDeals.filter((d) => d['state'] === 'COMPLETED');
          const buyerCompleted = buyerDeals.filter((d) => d['state'] === 'COMPLETED');

          for (const sd of sellerCompleted) {
            const match = buyerCompleted.find((bd) => String(bd['deal_id']) === String(sd['deal_id']));
            if (match) {
              log(`${trade.seller}-${trade.buyer} deal: ${String(sd['deal_id']).slice(0, 16)}..., volume=${sd['volume']}, rate=${sd['rate']}`);
              break;
            }
          }
        }

        log('ALL 10 TRADING AGENTS COMPLETED');
        break;
      }

      // Early exit: if all deals are CANCELLED on all sides after round 8
      if (round > 8) {
        let allCancelled = true;
        for (const { agent, env } of tradingAgents()) {
          const swaps = await sendCommand(env, agent.instanceName, 'LIST_SWAPS', { filter: 'all' });
          const deals = (swaps['deals'] ?? []) as Array<Record<string, unknown>>;
          if (!deals.every((d) => d['state'] === 'CANCELLED')) {
            allCancelled = false;
            break;
          }
        }
        if (allCancelled) {
          log('all deals CANCELLED on all sides — aborting');
          break;
        }
      }
    }

    // Dump container logs for diagnostics
    const { execSync } = await import('node:child_process');
    const allContainers = [
      ...tradingAgents().map(({ name, agent }) => ({ name, agent })),
      { name: 'escrowA1', agent: escrowA1 },
      { name: 'escrowA2', agent: escrowA2 },
      { name: 'escrowB1', agent: escrowB1 },
    ];
    for (const { name, agent } of allContainers) {
      const containerName = `agentic-${agent.instanceName}-${agent.instanceId.slice(0, 8)}`;
      try {
        const logs = execSync(
          `docker logs ${containerName} 2>&1`,
          { encoding: 'utf-8', timeout: 10000 },
        );
        const lines = logs.split('\n').slice(-40);
        log(`=== ${name} container logs (${lines.length} lines) ===`);
        for (const line of lines) {
          if (line.trim()) log(`  ${name}: ${line}`);
        }
      } catch {
        log(`could not fetch logs for ${name}`);
      }
    }

    // Hard assertions
    expect(allCompleted, 'all 10 trading agents must have COMPLETED deals').toBe(true);
  }, 270_000);

  // --- Test 8: Exact balances on all 11 agents (foxtrot unchanged) ---------

  it('exact balances after all trades', async () => {
    // Wait for SDK swap to reach terminal state on all 10 trading agents
    const PAYOUT_POLL_MS = 3_000;
    const PAYOUT_TIMEOUT_MS = 120_000;
    const payoutStart = Date.now();
    let allSwapsDone = false;

    while (Date.now() - payoutStart < PAYOUT_TIMEOUT_MS) {
      let doneCount = 0;
      for (const { name, agent, env } of tradingAgents()) {
        const progress = await sendCommand(env, agent.instanceName, 'GET_SWAP_PROGRESS');
        const swaps = (progress['swaps'] ?? []) as Array<Record<string, unknown>>;
        const hasDone = swaps.some((s) => s['progress'] === 'completed');
        if (hasDone) doneCount++;
        const progressStates = swaps.map((s) => s['progress']).join(',') || 'none';
        log(`payout poll: ${name}=${progressStates}`);
      }
      if (doneCount >= 10) {
        log(`all SDK swaps completed after ${Math.round((Date.now() - payoutStart) / 1000)}s`);
        allSwapsDone = true;
        break;
      }
      await new Promise((r) => setTimeout(r, PAYOUT_POLL_MS));
    }
    expect(allSwapsDone, 'SDK swap must reach completed on all 10 trading agents').toBe(true);

    // Poll for balance convergence
    const balanceDeadline = Date.now() + PAYOUT_TIMEOUT_MS;
    let balancesMatch = false;

    while (Date.now() < balanceDeadline) {
      let matchCount = 0;

      for (const { name, agent, env } of allAgents()) {
        const portfolio = await sendCommand(env, agent.instanceName, 'GET_PORTFOLIO');
        const uct = getBalance(portfolio, 'UCT');
        const usdu = getBalance(portfolio, 'USDU');
        const expected = expectedBalance(name);
        log(`${name}: UCT=${uct} (expected ${expected.uct}), USDU=${usdu} (expected ${expected.usdu})`);
        if (uct === expected.uct && usdu === expected.usdu) matchCount++;
      }

      if (matchCount === 11) {
        balancesMatch = true;
        break;
      }

      await new Promise((r) => setTimeout(r, 2_000));
    }

    if (balancesMatch) {
      log('all balances converged within polling window');
    }

    // Final exact balance assertions for all 11 agents
    for (const { name, agent, env } of allAgents()) {
      const portfolio = await sendCommand(env, agent.instanceName, 'GET_PORTFOLIO');
      const uct = getBalance(portfolio, 'UCT');
      const usdu = getBalance(portfolio, 'USDU');
      const expected = expectedBalance(name);

      log(`final ${name}: UCT=${uct} (expected ${expected.uct}), USDU=${usdu} (expected ${expected.usdu})`);
      expect(uct, `${name} UCT must be exactly ${expected.uct}`).toBe(expected.uct);
      expect(usdu, `${name} USDU must be exactly ${expected.usdu}`).toBe(expected.usdu);
    }

    // Verify foxtrot balance is completely unchanged
    const foxtrotPortfolio = await sendCommand(envA, foxtrot.instanceName, 'GET_PORTFOLIO');
    expect(getBalance(foxtrotPortfolio, 'UCT'), 'foxtrot UCT must be unchanged').toBe(EXPECTED_UCT);
    expect(getBalance(foxtrotPortfolio, 'USDU'), 'foxtrot USDU must be unchanged').toBe(EXPECTED_USDU);

    // Verify directional deltas for each trade
    for (const trade of TRADES) {
      const sellerInfo = getAgent(trade.seller);
      const buyerInfo = getAgent(trade.buyer);

      const sellerPortfolio = await sendCommand(
        sellerInfo.env, sellerInfo.agent.instanceName, 'GET_PORTFOLIO',
      );
      const buyerPortfolio = await sendCommand(
        buyerInfo.env, buyerInfo.agent.instanceName, 'GET_PORTFOLIO',
      );

      // Per-pair conservation: UCT and USDU deltas must sum to zero
      const pairUctDelta =
        (getBalance(sellerPortfolio, 'UCT') - EXPECTED_UCT) +
        (getBalance(buyerPortfolio, 'UCT') - EXPECTED_UCT);
      const pairUsduDelta =
        (getBalance(sellerPortfolio, 'USDU') - EXPECTED_USDU) +
        (getBalance(buyerPortfolio, 'USDU') - EXPECTED_USDU);

      log(`${trade.seller}+${trade.buyer} pair: UCT delta sum=${pairUctDelta}, USDU delta sum=${pairUsduDelta}`);
      expect(pairUctDelta, `${trade.seller}+${trade.buyer} UCT deltas must sum to zero`).toBe(0n);
      expect(pairUsduDelta, `${trade.seller}+${trade.buyer} USDU deltas must sum to zero`).toBe(0n);
    }

    log('all 11 agents have exact post-trade balances, foxtrot unchanged');
  }, 300_000);

  // --- Test 9: Conservation -- total tokens unchanged ----------------------

  it('conservation: total tokens unchanged across 11 agents', async () => {
    let totalUct = 0n;
    let totalUsdu = 0n;

    for (const { name, agent, env } of allAgents()) {
      const portfolio = await sendCommand(env, agent.instanceName, 'GET_PORTFOLIO');
      const uct = getBalance(portfolio, 'UCT');
      const usdu = getBalance(portfolio, 'USDU');
      totalUct += uct;
      totalUsdu += usdu;
      log(`${name}: UCT=${uct}, USDU=${usdu}`);
    }

    log(`total UCT: ${totalUct} (expected ${TOTAL_UCT})`);
    log(`total USDU: ${totalUsdu} (expected ${TOTAL_USDU})`);

    // Global conservation: total supply must be exactly preserved
    expect(totalUct, `total UCT must be conserved: ${TOTAL_UCT}`).toBe(TOTAL_UCT);
    expect(totalUsdu, `total USDU must be conserved: ${TOTAL_USDU}`).toBe(TOTAL_USDU);
  }, 60_000);

  // --- Test 10: All agents report healthy STATUS ---------------------------

  it('all agents report healthy STATUS', async () => {
    for (const { name, agent, env } of allAgents()) {
      const status = await sendCommand(env, agent.instanceName, 'STATUS');
      log(`${name} STATUS: ${JSON.stringify(status)}`);
      expect(status['status'], `${name} must be RUNNING`).toBe('RUNNING');
    }
  }, 30_000);
});
