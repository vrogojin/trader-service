/**
 * E2E Live Trading Test: Six agents autonomously discover each other,
 * negotiate, and execute trades simultaneously with exact balance verification.
 *
 * Verifies the complete multi-agent trading pipeline:
 *   1. Six agents boot in Docker containers with real Sphere SDK
 *   2. Wallets funded via testnet faucet (10 UCT + 10 USDU each)
 *   3. Three independent trading pairs post matching intents simultaneously
 *   4. Scan loops discover counterparties via semantic search
 *   5. Fan-out proposals sent via Nostr DMs
 *   6. Three deals reach ACCEPTED (Alice-Bob, Carol-Dave, Eve-Frank)
 *   7. All deals complete via escrow (ACCEPTED -> EXECUTING -> COMPLETED)
 *   8. Exact balances verified with token conservation across all 6 agents
 *
 * Trading pairs:
 *   - Alice (SELL 500000 UCT) <-> Bob (BUY 500000 UCT) at rate=1
 *   - Carol (SELL 300000 UCT) <-> Dave (BUY 300000 UCT) at rate=1
 *   - Eve (SELL 200000 UCT) <-> Frank (BUY 200000 UCT) at rate=1
 *
 * Expected final balances:
 *   - Alice: UCT = 10e18 - 500000, USDU = 10e6 + 500000
 *   - Bob:   UCT = 10e18 + 500000, USDU = 10e6 - 500000
 *   - Carol: UCT = 10e18 - 300000, USDU = 10e6 + 300000
 *   - Dave:  UCT = 10e18 + 300000, USDU = 10e6 - 300000
 *   - Eve:   UCT = 10e18 - 200000, USDU = 10e6 + 200000
 *   - Frank: UCT = 10e18 + 200000, USDU = 10e6 - 200000
 *
 * Conservation: total UCT = 60e18, total USDU = 60e6
 *
 * The escrow service runs as a proper ACP tenant, spawned via hm.spawn.
 *
 * ASSERTIONS: This test FAILS if agents cannot find each other and
 * complete all three trades within the timeout.
 *
 * Run: npx vitest run --config vitest.e2e-live.config.ts test/e2e-live/multi-agent-trading.e2e-live.test.ts
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

let env: LiveTestEnvironment;
let escrow: SpawnedAgent;
let alice: SpawnedAgent;
let bob: SpawnedAgent;
let carol: SpawnedAgent;
let dave: SpawnedAgent;
let eve: SpawnedAgent;
let frank: SpawnedAgent;
let escrowNametag: string;

// Deal tracking across test cases
let aliceBobDealId: string | null = null;
let carolDaveDealId: string | null = null;
let eveFrankDealId: string | null = null;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Faucet gives 10 whole tokens per call. UCT has 18 decimals, USDU has 6.
const EXPECTED_UCT = 10_000_000_000_000_000_000n; // 10 x 10^18
const EXPECTED_USDU = 10_000_000n;                 // 10 x 10^6

// Trade volumes (raw units, rate=1 so quoteAmount = volume)
const ALICE_BOB_VOLUME = 500_000n;
const CAROL_DAVE_VOLUME = 300_000n;
const EVE_FRANK_VOLUME = 200_000n;

// Total initial supply across all 6 agents
const TOTAL_UCT = EXPECTED_UCT * 6n;
const TOTAL_USDU = EXPECTED_USDU * 6n;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string): void {
  console.log(`[multi-trade-e2e ${new Date().toISOString()}] ${msg}`);
}

/** Extract confirmed balance for a given asset from a GET_PORTFOLIO response. */
function getBalance(portfolio: Record<string, unknown>, asset: string): bigint {
  const balances = portfolio['balances'] as Array<Record<string, unknown>>;
  const entry = balances.find((b) => b['asset'] === asset);
  if (!entry) return 0n;
  return BigInt(String(entry['confirmed'] ?? '0'));
}

/** All 6 trader agents with labels. */
function allTraders(): Array<{ name: string; agent: SpawnedAgent }> {
  return [
    { name: 'alice', agent: alice },
    { name: 'bob', agent: bob },
    { name: 'carol', agent: carol },
    { name: 'dave', agent: dave },
    { name: 'eve', agent: eve },
    { name: 'frank', agent: frank },
  ];
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  log('creating environment');
  env = await createTestEnvironment();

  // 1. Spawn escrow service first — traders need its nametag for trusted_escrows
  log('spawning escrow (escrow-service)');
  escrow = await spawnAgent(env, 'escrow-service', 'multi-escrow');
  await verifyInstanceState(env, escrow.instanceName, 'RUNNING');
  escrowNametag = escrow.tenantNametag ?? '';
  log(`escrow RUNNING, nametag=${escrowNametag}`);

  // 2. Spawn all 6 traders
  log('spawning alice (trader-agent)');
  alice = await spawnAgent(env, 'trader-agent', 'multi-alice');
  await verifyInstanceState(env, alice.instanceName, 'RUNNING');
  log(`alice RUNNING, nametag=${alice.tenantNametag}`);

  log('spawning bob (trader-agent)');
  bob = await spawnAgent(env, 'trader-agent', 'multi-bob');
  await verifyInstanceState(env, bob.instanceName, 'RUNNING');
  log(`bob RUNNING, nametag=${bob.tenantNametag}`);

  log('spawning carol (trader-agent)');
  carol = await spawnAgent(env, 'trader-agent', 'multi-carol');
  await verifyInstanceState(env, carol.instanceName, 'RUNNING');
  log(`carol RUNNING, nametag=${carol.tenantNametag}`);

  log('spawning dave (trader-agent)');
  dave = await spawnAgent(env, 'trader-agent', 'multi-dave');
  await verifyInstanceState(env, dave.instanceName, 'RUNNING');
  log(`dave RUNNING, nametag=${dave.tenantNametag}`);

  log('spawning eve (trader-agent)');
  eve = await spawnAgent(env, 'trader-agent', 'multi-eve');
  await verifyInstanceState(env, eve.instanceName, 'RUNNING');
  log(`eve RUNNING, nametag=${eve.tenantNametag}`);

  log('spawning frank (trader-agent)');
  frank = await spawnAgent(env, 'trader-agent', 'multi-frank');
  await verifyInstanceState(env, frank.instanceName, 'RUNNING');
  log(`frank RUNNING, nametag=${frank.tenantNametag}`);

  // 3. Fund all wallets (10 UCT + 10 USDU each)
  log('funding trader wallets via faucet');
  for (const { name, agent } of allTraders()) {
    log(`funding ${name} with 10 UCT`);
    await fundWallet(env, agent, 'unicity', 10);
    log(`funding ${name} with 10 USDU`);
    await fundWallet(env, agent, 'unicity-usd', 10);
  }

  log('waiting 20s for Nostr delivery of faucet transfers');
  await new Promise((r) => setTimeout(r, 20_000));

  log('setup complete — 1 escrow + 6 agents spawned and funded');
}, 420_000);

afterAll(async () => {
  if (env) await teardownEnvironment(env);
}, 120_000);

// ===========================================================================
// Test Suite
// ===========================================================================

describe('Live Trading: 6-Agent Autonomous Discovery + Execution', () => {

  // ─── Test 1: Verify all agents are RUNNING and funded ─────────────────

  it('all 6 agents are RUNNING and funded', async () => {
    for (const { name, agent } of allTraders()) {
      const portfolio = await sendCommand(env, agent.instanceName, 'GET_PORTFOLIO');
      log(`${name} portfolio: ${JSON.stringify(portfolio)}`);

      const uct = getBalance(portfolio, 'UCT');
      const usdu = getBalance(portfolio, 'USDU');
      log(`${name}: UCT=${uct}, USDU=${usdu}`);
      expect(uct, `${name} UCT must be ${EXPECTED_UCT}`).toBe(EXPECTED_UCT);
      expect(usdu, `${name} USDU must be ${EXPECTED_USDU}`).toBe(EXPECTED_USDU);
    }
  }, 60_000);

  // ─── Test 2: Configure strategy with escrow on all agents ─────────────

  it('configure strategy with escrow on all agents', async () => {
    const escrowAddr = escrowNametag ? `@${escrowNametag}` : 'any';
    log(`using escrow address: ${escrowAddr}`);

    // Phase 1: Set auto_match=false so intents can be created without
    // triggering matching. All intents must be visible on the MarketModule
    // before any agent starts scanning — this ensures deterministic matching.
    for (const { name, agent } of allTraders()) {
      const result = await sendCommand(env, agent.instanceName, 'SET_STRATEGY', {
        auto_match: false,
        auto_negotiate: true,
        scan_interval_ms: 5000,
        max_concurrent_swaps: 3,
        trusted_escrows: [escrowAddr],
      });
      log(`${name} SET_STRATEGY (phase 1, no matching): ${JSON.stringify(result)}`);
    }
  }, 60_000);

  // ─── Test 3: Alice and Bob post matching intents ──────────────────────

  it('alice and bob post matching intents', async () => {
    const escrowAddr = escrowNametag ? `@${escrowNametag}` : 'any';

    const aliceIntent = await sendCommand(env, alice.instanceName, 'CREATE_INTENT', {
      direction: 'sell',
      base_asset: 'UCT',
      quote_asset: 'USDU',
      rate_min: '1',
      rate_max: '1',
      volume_min: '500000',
      volume_max: '500000',
      escrow_address: escrowAddr,
      expiry_sec: 600,
    });
    log(`alice CREATE_INTENT: ${JSON.stringify(aliceIntent)}`);
    expect(aliceIntent['state']).toBe('ACTIVE');
    expect(aliceIntent['intent_id']).toBeDefined();
    expect(aliceIntent['market_intent_id']).toBeDefined();
    expect(aliceIntent['direction'], 'alice intent direction must be sell').toBe('sell');
    expect(aliceIntent['base_asset']).toBe('UCT');
    expect(aliceIntent['quote_asset']).toBe('USDU');

    const bobIntent = await sendCommand(env, bob.instanceName, 'CREATE_INTENT', {
      direction: 'buy',
      base_asset: 'UCT',
      quote_asset: 'USDU',
      rate_min: '1',
      rate_max: '1',
      volume_min: '500000',
      volume_max: '500000',
      escrow_address: escrowAddr,
      expiry_sec: 600,
    });
    log(`bob CREATE_INTENT: ${JSON.stringify(bobIntent)}`);
    expect(bobIntent['state']).toBe('ACTIVE');
    expect(bobIntent['intent_id']).toBeDefined();
    expect(bobIntent['market_intent_id']).toBeDefined();
    expect(bobIntent['direction'], 'bob intent direction must be buy').toBe('buy');
    expect(bobIntent['base_asset']).toBe('UCT');
    expect(bobIntent['quote_asset']).toBe('USDU');
  }, 30_000);

  // ─── Test 4: Carol and Dave post matching intents ─────────────────────

  it('carol and dave post matching intents', async () => {
    const escrowAddr = escrowNametag ? `@${escrowNametag}` : 'any';

    const carolIntent = await sendCommand(env, carol.instanceName, 'CREATE_INTENT', {
      direction: 'sell',
      base_asset: 'UCT',
      quote_asset: 'USDU',
      rate_min: '1',
      rate_max: '1',
      volume_min: '300000',
      volume_max: '300000',
      escrow_address: escrowAddr,
      expiry_sec: 600,
    });
    log(`carol CREATE_INTENT: ${JSON.stringify(carolIntent)}`);
    expect(carolIntent['state']).toBe('ACTIVE');
    expect(carolIntent['intent_id']).toBeDefined();
    expect(carolIntent['market_intent_id']).toBeDefined();
    expect(carolIntent['direction'], 'carol intent direction must be sell').toBe('sell');
    expect(carolIntent['base_asset']).toBe('UCT');
    expect(carolIntent['quote_asset']).toBe('USDU');

    const daveIntent = await sendCommand(env, dave.instanceName, 'CREATE_INTENT', {
      direction: 'buy',
      base_asset: 'UCT',
      quote_asset: 'USDU',
      rate_min: '1',
      rate_max: '1',
      volume_min: '300000',
      volume_max: '300000',
      escrow_address: escrowAddr,
      expiry_sec: 600,
    });
    log(`dave CREATE_INTENT: ${JSON.stringify(daveIntent)}`);
    expect(daveIntent['state']).toBe('ACTIVE');
    expect(daveIntent['intent_id']).toBeDefined();
    expect(daveIntent['market_intent_id']).toBeDefined();
    expect(daveIntent['direction'], 'dave intent direction must be buy').toBe('buy');
    expect(daveIntent['base_asset']).toBe('UCT');
    expect(daveIntent['quote_asset']).toBe('USDU');
  }, 30_000);

  // ─── Test 5: Eve and Frank post matching intents ──────────────────────

  it('eve and frank post matching intents', async () => {
    const escrowAddr = escrowNametag ? `@${escrowNametag}` : 'any';

    const eveIntent = await sendCommand(env, eve.instanceName, 'CREATE_INTENT', {
      direction: 'sell',
      base_asset: 'UCT',
      quote_asset: 'USDU',
      rate_min: '1',
      rate_max: '1',
      volume_min: '200000',
      volume_max: '200000',
      escrow_address: escrowAddr,
      expiry_sec: 600,
    });
    log(`eve CREATE_INTENT: ${JSON.stringify(eveIntent)}`);
    expect(eveIntent['state']).toBe('ACTIVE');
    expect(eveIntent['intent_id']).toBeDefined();
    expect(eveIntent['market_intent_id']).toBeDefined();
    expect(eveIntent['direction'], 'eve intent direction must be sell').toBe('sell');
    expect(eveIntent['base_asset']).toBe('UCT');
    expect(eveIntent['quote_asset']).toBe('USDU');

    const frankIntent = await sendCommand(env, frank.instanceName, 'CREATE_INTENT', {
      direction: 'buy',
      base_asset: 'UCT',
      quote_asset: 'USDU',
      rate_min: '1',
      rate_max: '1',
      volume_min: '200000',
      volume_max: '200000',
      escrow_address: escrowAddr,
      expiry_sec: 600,
    });
    log(`frank CREATE_INTENT: ${JSON.stringify(frankIntent)}`);
    expect(frankIntent['state']).toBe('ACTIVE');
    expect(frankIntent['intent_id']).toBeDefined();
    expect(frankIntent['market_intent_id']).toBeDefined();
    expect(frankIntent['direction'], 'frank intent direction must be buy').toBe('buy');
    expect(frankIntent['base_asset']).toBe('UCT');
    expect(frankIntent['quote_asset']).toBe('USDU');
  }, 30_000);

  // ─── Test 6: All 6 intents are ACTIVE ─────────────────────────────────

  it('all 6 intents are ACTIVE', async () => {
    for (const { name, agent } of allTraders()) {
      const result = await sendCommand(env, agent.instanceName, 'LIST_INTENTS', { filter: 'active' });
      const intents = (result['intents'] ?? []) as Array<Record<string, unknown>>;
      log(`${name} active intents: ${intents.length}`);
      expect(intents.length, `${name} must have 1 active intent`).toBe(1);
      expect(intents[0]!['state']).toBe('ACTIVE');

      // Verify intent parameters
      const intent = intents[0]!;
      expect(intent['base_asset']).toBe('UCT');
      expect(intent['quote_asset']).toBe('USDU');
      expect(Number(intent['rate_min']), `${name} rate_min`).toBe(1);
      expect(Number(intent['rate_max']), `${name} rate_max`).toBe(1);
    }

    // Verify specific volumes
    const aliceIntents = await sendCommand(env, alice.instanceName, 'LIST_INTENTS', { filter: 'active' });
    const bobIntents = await sendCommand(env, bob.instanceName, 'LIST_INTENTS', { filter: 'active' });
    const carolIntents = await sendCommand(env, carol.instanceName, 'LIST_INTENTS', { filter: 'active' });
    const daveIntents = await sendCommand(env, dave.instanceName, 'LIST_INTENTS', { filter: 'active' });
    const eveIntents = await sendCommand(env, eve.instanceName, 'LIST_INTENTS', { filter: 'active' });
    const frankIntents = await sendCommand(env, frank.instanceName, 'LIST_INTENTS', { filter: 'active' });

    const aliceList = (aliceIntents['intents'] as Array<Record<string, unknown>>);
    const bobList = (bobIntents['intents'] as Array<Record<string, unknown>>);
    const carolList = (carolIntents['intents'] as Array<Record<string, unknown>>);
    const daveList = (daveIntents['intents'] as Array<Record<string, unknown>>);
    const eveList = (eveIntents['intents'] as Array<Record<string, unknown>>);
    const frankList = (frankIntents['intents'] as Array<Record<string, unknown>>);

    expect(aliceList[0]!['direction']).toBe('sell');
    expect(Number(aliceList[0]!['volume_max'])).toBe(500000);
    expect(bobList[0]!['direction']).toBe('buy');
    expect(Number(bobList[0]!['volume_max'])).toBe(500000);
    expect(carolList[0]!['direction']).toBe('sell');
    expect(Number(carolList[0]!['volume_max'])).toBe(300000);
    expect(daveList[0]!['direction']).toBe('buy');
    expect(Number(daveList[0]!['volume_max'])).toBe(300000);
    expect(eveList[0]!['direction']).toBe('sell');
    expect(Number(eveList[0]!['volume_max'])).toBe(200000);
    expect(frankList[0]!['direction']).toBe('buy');
    expect(Number(frankList[0]!['volume_max'])).toBe(200000);

    // Phase 2: All intents verified ACTIVE. Now enable matching on all agents.
    // This ensures all intents are visible on MarketModule before scanning starts,
    // making matching deterministic across runs.
    for (const { name, agent } of allTraders()) {
      await sendCommand(env, agent.instanceName, 'SET_STRATEGY', {
        auto_match: true,
        scan_interval_ms: 5000,
      });
      log(`${name} auto_match ENABLED`);
    }
  }, 60_000);

  // ─── Test 6: Agents discover and negotiate — at least 2 deals ACCEPTED ─

  it('agents discover and negotiate — at least 3 deals reach ACCEPTED', async () => {
    const MAX_ROUNDS = 8;
    const POLL_INTERVAL_MS = 15_000;
    let sufficientDeals = false;

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      log(`poll round ${round}/${MAX_ROUNDS} — waiting ${POLL_INTERVAL_MS / 1000}s...`);
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

      // Gather deal states from all 6 agents
      let acceptedEntries = 0;
      for (const { name, agent } of allTraders()) {
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

      // We need at least 3 unique deals, each visible on 2 sides = 6 entries minimum
      if (acceptedEntries >= 6) {
        log(`sufficient deals found: ${acceptedEntries} entries across all agents`);
        sufficientDeals = true;
        break;
      }
    }

    expect(
      sufficientDeals,
      'at least 3 deals must reach ACCEPTED/EXECUTING/COMPLETED (6 entries across 6 agents)',
    ).toBe(true);
  }, 150_000);

  // ─── Test 7: All deals reach COMPLETED via escrow ─────────────────────

  it('all deals reach COMPLETED via escrow', async () => {
    const MAX_SWAP_ROUNDS = 12;
    const SWAP_POLL_MS = 15_000;
    let allCompleted = false;

    for (let round = 1; round <= MAX_SWAP_ROUNDS; round++) {
      log(`swap poll round ${round}/${MAX_SWAP_ROUNDS} — waiting ${SWAP_POLL_MS / 1000}s...`);
      await new Promise((r) => setTimeout(r, SWAP_POLL_MS));

      let completedAgents = 0;

      for (const { name, agent } of allTraders()) {
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

        // Query SwapExecutor state for detailed progress (first 6 rounds only)
        if (round <= 6) {
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

      log(`round ${round}: ${completedAgents}/6 agents have COMPLETED deals`);

      if (completedAgents >= 6) {
        allCompleted = true;

        // Identify the deal IDs for each pair
        const aliceSwaps = await sendCommand(env, alice.instanceName, 'LIST_SWAPS', { filter: 'all' });
        const bobSwaps = await sendCommand(env, bob.instanceName, 'LIST_SWAPS', { filter: 'all' });
        const carolSwaps = await sendCommand(env, carol.instanceName, 'LIST_SWAPS', { filter: 'all' });
        const daveSwaps = await sendCommand(env, dave.instanceName, 'LIST_SWAPS', { filter: 'all' });
        const eveSwaps = await sendCommand(env, eve.instanceName, 'LIST_SWAPS', { filter: 'all' });
        const frankSwaps = await sendCommand(env, frank.instanceName, 'LIST_SWAPS', { filter: 'all' });

        const aliceDeals = (aliceSwaps['deals'] ?? []) as Array<Record<string, unknown>>;
        const bobDeals = (bobSwaps['deals'] ?? []) as Array<Record<string, unknown>>;
        const carolDeals = (carolSwaps['deals'] ?? []) as Array<Record<string, unknown>>;
        const daveDeals = (daveSwaps['deals'] ?? []) as Array<Record<string, unknown>>;
        const eveDeals = (eveSwaps['deals'] ?? []) as Array<Record<string, unknown>>;
        const frankDeals = (frankSwaps['deals'] ?? []) as Array<Record<string, unknown>>;

        // Find alice-bob shared completed deal
        const aliceCompleted = aliceDeals.filter((d) => d['state'] === 'COMPLETED');
        const bobCompleted = bobDeals.filter((d) => d['state'] === 'COMPLETED');
        for (const ad of aliceCompleted) {
          const match = bobCompleted.find((bd) => String(bd['deal_id']) === String(ad['deal_id']));
          if (match) {
            aliceBobDealId = String(ad['deal_id']);
            log(`Alice-Bob deal: ${aliceBobDealId}, volume=${ad['volume']}, rate=${ad['rate']}`);
            break;
          }
        }

        // Find carol-dave shared completed deal
        const carolCompleted = carolDeals.filter((d) => d['state'] === 'COMPLETED');
        const daveCompleted = daveDeals.filter((d) => d['state'] === 'COMPLETED');
        for (const cd of carolCompleted) {
          const match = daveCompleted.find((dd) => String(dd['deal_id']) === String(cd['deal_id']));
          if (match) {
            carolDaveDealId = String(cd['deal_id']);
            log(`Carol-Dave deal: ${carolDaveDealId}, volume=${cd['volume']}, rate=${cd['rate']}`);
            break;
          }
        }

        // Find eve-frank shared completed deal
        const eveCompleted = eveDeals.filter((d) => d['state'] === 'COMPLETED');
        const frankCompleted = frankDeals.filter((d) => d['state'] === 'COMPLETED');
        for (const ed of eveCompleted) {
          const match = frankCompleted.find((fd) => String(fd['deal_id']) === String(ed['deal_id']));
          if (match) {
            eveFrankDealId = String(ed['deal_id']);
            log(`Eve-Frank deal: ${eveFrankDealId}, volume=${ed['volume']}, rate=${ed['rate']}`);
            break;
          }
        }

        log('ALL 6 AGENTS COMPLETED');
        break;
      }

      // Early exit: if all deals are CANCELLED on all sides after round 6
      if (round > 6) {
        let allCancelled = true;
        for (const { agent } of allTraders()) {
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
    for (const { name, agent } of [...allTraders(), { name: 'escrow', agent: escrow }]) {
      const containerName = `agentic-${agent.instanceName}-${agent.instanceId.slice(0, 8)}`;
      try {
        const logs = execSync(
          `docker logs ${containerName} 2>&1`,
          { encoding: 'utf-8', timeout: 10000 },
        );
        const lines = logs.split('\n').slice(-60);
        log(`=== ${name} container logs (${lines.length} lines) ===`);
        for (const line of lines) {
          if (line.trim()) log(`  ${name}: ${line}`);
        }
      } catch {
        log(`could not fetch logs for ${name}`);
      }
    }

    // Hard assertions
    expect(allCompleted, 'all 6 agents must have COMPLETED deals').toBe(true);
    expect(aliceBobDealId, 'alice-bob deal must be identified').not.toBeNull();
    expect(carolDaveDealId, 'carol-dave deal must be identified').not.toBeNull();
    expect(eveFrankDealId, 'eve-frank deal must be identified').not.toBeNull();
    log(`deals completed: alice-bob=${aliceBobDealId}, carol-dave=${carolDaveDealId}, eve-frank=${eveFrankDealId}`);
  }, 210_000);

  // ─── Test 8: Exact balances after all trades ──────────────────────────

  it('exact balances after all trades', async () => {
    // Wait for SDK swap to reach terminal state on all 6 agents
    const PAYOUT_POLL_MS = 3_000;
    const PAYOUT_TIMEOUT_MS = 120_000;
    const payoutStart = Date.now();
    let allSwapsDone = false;

    while (Date.now() - payoutStart < PAYOUT_TIMEOUT_MS) {
      let doneCount = 0;
      for (const { name, agent } of allTraders()) {
        const progress = await sendCommand(env, agent.instanceName, 'GET_SWAP_PROGRESS');
        const swaps = (progress['swaps'] ?? []) as Array<Record<string, unknown>>;
        const hasDone = swaps.some((s) => s['progress'] === 'completed');
        if (hasDone) doneCount++;
        const progressStates = swaps.map((s) => s['progress']).join(',') || 'none';
        log(`payout poll: ${name}=${progressStates}`);
      }
      if (doneCount >= 6) {
        log(`all SDK swaps completed after ${Math.round((Date.now() - payoutStart) / 1000)}s`);
        allSwapsDone = true;
        break;
      }
      await new Promise((r) => setTimeout(r, PAYOUT_POLL_MS));
    }
    expect(allSwapsDone, 'SDK swap must reach completed on all 6 agents').toBe(true);

    // Expected post-trade balances (rate=1, so quoteAmount = volume):
    //   Alice (SELL 500000 UCT): loses 500000 UCT, gains 500000 USDU
    //   Bob   (BUY 500000 UCT):  gains 500000 UCT, loses 500000 USDU
    //   Carol (SELL 300000 UCT): loses 300000 UCT, gains 300000 USDU
    //   Dave  (BUY 300000 UCT):  gains 300000 UCT, loses 300000 USDU
    //   Eve   (SELL 200000 UCT): loses 200000 UCT, gains 200000 USDU
    //   Frank (BUY 200000 UCT):  gains 200000 UCT, loses 200000 USDU
    const expectedBalances = {
      alice: { uct: EXPECTED_UCT - ALICE_BOB_VOLUME, usdu: EXPECTED_USDU + ALICE_BOB_VOLUME },
      bob:   { uct: EXPECTED_UCT + ALICE_BOB_VOLUME, usdu: EXPECTED_USDU - ALICE_BOB_VOLUME },
      carol: { uct: EXPECTED_UCT - CAROL_DAVE_VOLUME, usdu: EXPECTED_USDU + CAROL_DAVE_VOLUME },
      dave:  { uct: EXPECTED_UCT + CAROL_DAVE_VOLUME, usdu: EXPECTED_USDU - CAROL_DAVE_VOLUME },
      eve:   { uct: EXPECTED_UCT - EVE_FRANK_VOLUME, usdu: EXPECTED_USDU + EVE_FRANK_VOLUME },
      frank: { uct: EXPECTED_UCT + EVE_FRANK_VOLUME, usdu: EXPECTED_USDU - EVE_FRANK_VOLUME },
    };

    // Poll for balance convergence
    const balanceDeadline = Date.now() + PAYOUT_TIMEOUT_MS;
    let balancesMatch = false;

    while (Date.now() < balanceDeadline) {
      let matchCount = 0;

      for (const { name, agent } of allTraders()) {
        const portfolio = await sendCommand(env, agent.instanceName, 'GET_PORTFOLIO');
        const uct = getBalance(portfolio, 'UCT');
        const usdu = getBalance(portfolio, 'USDU');
        const expected = expectedBalances[name as keyof typeof expectedBalances];
        log(`${name}: UCT=${uct} (expected ${expected.uct}), USDU=${usdu} (expected ${expected.usdu})`);
        if (uct === expected.uct && usdu === expected.usdu) matchCount++;
      }

      if (matchCount === 6) {
        balancesMatch = true;
        break;
      }

      await new Promise((r) => setTimeout(r, 2_000));
    }

    if (balancesMatch) {
      log('all balances converged within polling window');
    }

    // Final exact balance assertions for all 6 agents
    for (const { name, agent } of allTraders()) {
      const portfolio = await sendCommand(env, agent.instanceName, 'GET_PORTFOLIO');
      const uct = getBalance(portfolio, 'UCT');
      const usdu = getBalance(portfolio, 'USDU');
      const expected = expectedBalances[name as keyof typeof expectedBalances];

      log(`final ${name}: UCT=${uct} (expected ${expected.uct}), USDU=${usdu} (expected ${expected.usdu})`);
      expect(uct, `${name} UCT must be exactly ${expected.uct}`).toBe(expected.uct);
      expect(usdu, `${name} USDU must be exactly ${expected.usdu}`).toBe(expected.usdu);
    }

    // Verify directional deltas are exact
    const alicePortfolio = await sendCommand(env, alice.instanceName, 'GET_PORTFOLIO');
    const bobPortfolio = await sendCommand(env, bob.instanceName, 'GET_PORTFOLIO');
    const carolPortfolio = await sendCommand(env, carol.instanceName, 'GET_PORTFOLIO');
    const davePortfolio = await sendCommand(env, dave.instanceName, 'GET_PORTFOLIO');
    const evePortfolio = await sendCommand(env, eve.instanceName, 'GET_PORTFOLIO');
    const frankPortfolio = await sendCommand(env, frank.instanceName, 'GET_PORTFOLIO');

    // Alice (SELL UCT): loses UCT, gains USDU
    expect(getBalance(alicePortfolio, 'UCT') - EXPECTED_UCT, 'alice UCT delta').toBe(-ALICE_BOB_VOLUME);
    expect(getBalance(alicePortfolio, 'USDU') - EXPECTED_USDU, 'alice USDU delta').toBe(ALICE_BOB_VOLUME);
    // Bob (BUY UCT): gains UCT, loses USDU
    expect(getBalance(bobPortfolio, 'UCT') - EXPECTED_UCT, 'bob UCT delta').toBe(ALICE_BOB_VOLUME);
    expect(getBalance(bobPortfolio, 'USDU') - EXPECTED_USDU, 'bob USDU delta').toBe(-ALICE_BOB_VOLUME);
    // Carol (SELL UCT): loses UCT, gains USDU
    expect(getBalance(carolPortfolio, 'UCT') - EXPECTED_UCT, 'carol UCT delta').toBe(-CAROL_DAVE_VOLUME);
    expect(getBalance(carolPortfolio, 'USDU') - EXPECTED_USDU, 'carol USDU delta').toBe(CAROL_DAVE_VOLUME);
    // Dave (BUY UCT): gains UCT, loses USDU
    expect(getBalance(davePortfolio, 'UCT') - EXPECTED_UCT, 'dave UCT delta').toBe(CAROL_DAVE_VOLUME);
    expect(getBalance(davePortfolio, 'USDU') - EXPECTED_USDU, 'dave USDU delta').toBe(-CAROL_DAVE_VOLUME);
    // Eve (SELL UCT): loses UCT, gains USDU
    expect(getBalance(evePortfolio, 'UCT') - EXPECTED_UCT, 'eve UCT delta').toBe(-EVE_FRANK_VOLUME);
    expect(getBalance(evePortfolio, 'USDU') - EXPECTED_USDU, 'eve USDU delta').toBe(EVE_FRANK_VOLUME);
    // Frank (BUY UCT): gains UCT, loses USDU
    expect(getBalance(frankPortfolio, 'UCT') - EXPECTED_UCT, 'frank UCT delta').toBe(EVE_FRANK_VOLUME);
    expect(getBalance(frankPortfolio, 'USDU') - EXPECTED_USDU, 'frank USDU delta').toBe(-EVE_FRANK_VOLUME);

    log('all 6 agents have exact post-trade balances');
  }, 210_000);

  // ─── Test 9: Conservation — total tokens unchanged ────────────────────

  it('conservation: total tokens unchanged', async () => {
    let totalUct = 0n;
    let totalUsdu = 0n;

    for (const { name, agent } of allTraders()) {
      const portfolio = await sendCommand(env, agent.instanceName, 'GET_PORTFOLIO');
      const uct = getBalance(portfolio, 'UCT');
      const usdu = getBalance(portfolio, 'USDU');
      totalUct += uct;
      totalUsdu += usdu;
      log(`${name}: UCT=${uct}, USDU=${usdu}`);
    }

    log(`total UCT: ${totalUct} (expected ${TOTAL_UCT})`);
    log(`total USDU: ${totalUsdu} (expected ${TOTAL_USDU})`);

    // Global conservation: total supply must be exactly preserved (no fees on testnet)
    expect(totalUct, `total UCT must be conserved: ${TOTAL_UCT}`).toBe(TOTAL_UCT);
    expect(totalUsdu, `total USDU must be conserved: ${TOTAL_USDU}`).toBe(TOTAL_USDU);

    // Per-pair conservation: deltas within each trading pair must sum to zero
    const alicePortfolio = await sendCommand(env, alice.instanceName, 'GET_PORTFOLIO');
    const bobPortfolio = await sendCommand(env, bob.instanceName, 'GET_PORTFOLIO');
    const carolPortfolio = await sendCommand(env, carol.instanceName, 'GET_PORTFOLIO');
    const davePortfolio = await sendCommand(env, dave.instanceName, 'GET_PORTFOLIO');
    const evePortfolio = await sendCommand(env, eve.instanceName, 'GET_PORTFOLIO');
    const frankPortfolio = await sendCommand(env, frank.instanceName, 'GET_PORTFOLIO');

    // Alice + Bob pair: UCT and USDU deltas must each sum to zero
    const abUctDelta = (getBalance(alicePortfolio, 'UCT') - EXPECTED_UCT) +
                       (getBalance(bobPortfolio, 'UCT') - EXPECTED_UCT);
    const abUsduDelta = (getBalance(alicePortfolio, 'USDU') - EXPECTED_USDU) +
                        (getBalance(bobPortfolio, 'USDU') - EXPECTED_USDU);
    expect(abUctDelta, 'alice+bob UCT deltas must sum to zero').toBe(0n);
    expect(abUsduDelta, 'alice+bob USDU deltas must sum to zero').toBe(0n);

    // Carol + Dave pair: UCT and USDU deltas must each sum to zero
    const cdUctDelta = (getBalance(carolPortfolio, 'UCT') - EXPECTED_UCT) +
                       (getBalance(davePortfolio, 'UCT') - EXPECTED_UCT);
    const cdUsduDelta = (getBalance(carolPortfolio, 'USDU') - EXPECTED_USDU) +
                        (getBalance(davePortfolio, 'USDU') - EXPECTED_USDU);
    expect(cdUctDelta, 'carol+dave UCT deltas must sum to zero').toBe(0n);
    expect(cdUsduDelta, 'carol+dave USDU deltas must sum to zero').toBe(0n);

    // Eve + Frank pair: UCT and USDU deltas must each sum to zero
    const efUctDelta = (getBalance(evePortfolio, 'UCT') - EXPECTED_UCT) +
                       (getBalance(frankPortfolio, 'UCT') - EXPECTED_UCT);
    const efUsduDelta = (getBalance(evePortfolio, 'USDU') - EXPECTED_USDU) +
                        (getBalance(frankPortfolio, 'USDU') - EXPECTED_USDU);
    expect(efUctDelta, 'eve+frank UCT deltas must sum to zero').toBe(0n);
    expect(efUsduDelta, 'eve+frank USDU deltas must sum to zero').toBe(0n);

    log('token conservation verified: global totals and per-pair deltas');
  }, 60_000);

  // ─── Test 10: All agents report healthy STATUS ────────────────────────

  it('all agents report healthy STATUS', async () => {
    for (const { name, agent } of allTraders()) {
      const status = await sendCommand(env, agent.instanceName, 'STATUS');
      log(`${name} STATUS: ${JSON.stringify(status)}`);
      expect(status['status'], `${name} must be RUNNING`).toBe('RUNNING');
    }
  }, 30_000);
});
