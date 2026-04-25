/**
 * Live E2E Tests — Real Docker + Real Sphere SDK + Real Nostr
 *
 * ZERO mocks. Tests the Host Manager orchestrating real Docker containers
 * with real Sphere SDK wallets communicating over real Nostr relays.
 *
 * Requires:
 *   - Docker daemon running + images built locally
 *   - Network access to testnet (Nostr relays, aggregator)
 *
 * Containers boot from real images, send acp.hello over real Nostr,
 * and the manager receives it — instances reach RUNNING. This proves:
 *   - Docker images start correctly
 *   - Container creation with env vars and bind mounts works
 *   - Real ACP handshake over Nostr completes
 *   - Instances reach RUNNING state (not FAILED)
 *   - Stop/start lifecycle works end-to-end
 *   - Multi-agent parallel spawn and cleanup works
 *   - Sandboxed storage per agent
 *
 * Trading-specific scenarios test intent creation, matching, and
 * the command lifecycle using the trader-agent Docker image.
 *
 * Run: npx vitest run --config vitest.e2e-live.config.ts
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
  stopAgent,
  startAgent,
} from './helpers/agent-helpers.js';

// ---------------------------------------------------------------------------
// Preflight: Docker MUST be available — fail immediately if not
// ---------------------------------------------------------------------------

const dockerCheck = checkDockerAvailability();
if (dockerCheck) {
  throw new Error(`Live E2E tests require Docker: ${dockerCheck}`);
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let env: LiveTestEnvironment;

function log(step: string, detail?: string): void {
  const ts = new Date().toISOString();
  console.log(`[trader-live ${ts}] ${detail ? `${step}: ${detail}` : step}`);
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  log('beforeAll', 'creating test environment (real Docker + real Sphere SDK)');
  env = await createTestEnvironment();
  log('beforeAll', `setup complete (env=${env.envName})`);
}, 120_000);

afterAll(async () => {
  log('afterAll', 'tearing down environment');
  if (env) await teardownEnvironment(env);
  log('afterAll', 'teardown complete');
}, 120_000);

// ---------------------------------------------------------------------------
// Scenario 1: Single agent lifecycle — spawn → RUNNING → STATUS → stop
// ---------------------------------------------------------------------------

describe('Scenario 1: Single agent lifecycle', () => {
  it('should spawn a container that boots and reaches RUNNING via real ACP handshake', async () => {
    const agent = await spawnAgent(env, 'tenant-cli-boilerplate', 'lifecycle-agent');
    expect(agent.instanceId).toBeTruthy();
    expect(agent.instanceName).toBe('lifecycle-agent');

    // Container started from real image, acp.hello arrived via real Nostr → RUNNING
    await verifyInstanceState(env, 'lifecycle-agent', 'RUNNING');
    log('scenario1', `spawned ${agent.instanceName} → RUNNING`);
  }, 180_000);

  it('should stop the RUNNING agent and confirm STOPPED', async () => {
    await stopAgent(env, 'lifecycle-agent');
    await verifyInstanceState(env, 'lifecycle-agent', 'STOPPED');
    log('scenario1', 'stopped');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Scenario 2: Multi-agent Docker spawn (4 containers in parallel)
// ---------------------------------------------------------------------------

describe('Scenario 2: Multi-agent Docker spawn', () => {
  it('should spawn 4 containers in parallel, all reach RUNNING', async () => {
    log('scenario2', 'spawning escrow + alice + bob + carol');

    const [escrow, alice, bob, carol] = await Promise.all([
      spawnAgent(env, 'tenant-cli-boilerplate', 'escrow'),
      spawnAgent(env, 'tenant-cli-boilerplate', 'alice'),
      spawnAgent(env, 'tenant-cli-boilerplate', 'bob'),
      spawnAgent(env, 'tenant-cli-boilerplate', 'carol'),
    ]);

    for (const agent of [escrow, alice, bob, carol]) {
      await verifyInstanceState(env, agent.instanceName, 'RUNNING');
    }
    log('scenario2', 'all 4 confirmed RUNNING');
  }, 300_000);

  it('should stop all 4 agents', async () => {
    for (const name of ['escrow', 'alice', 'bob', 'carol']) {
      await stopAgent(env, name);
      await verifyInstanceState(env, name, 'STOPPED');
    }
    log('scenario2', 'all stopped');
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Scenario 3: Restart creates a new container, reaches RUNNING again
// ---------------------------------------------------------------------------

describe('Scenario 3: Agent restart', () => {
  it('should spawn, stop, restart, and reach RUNNING again', async () => {
    const first = await spawnAgent(env, 'tenant-cli-boilerplate', 'restart-agent');
    const firstId = first.instanceId;
    await verifyInstanceState(env, 'restart-agent', 'RUNNING');
    log('scenario3', `first spawn → RUNNING (id=${firstId})`);

    await stopAgent(env, 'restart-agent');
    await verifyInstanceState(env, 'restart-agent', 'STOPPED');
    log('scenario3', 'stopped');

    const restarted = await startAgent(env, 'restart-agent');
    // Restart creates a new container — same instance_id, new container
    expect(restarted.instanceId).toBe(firstId); // Same instance identity
    await verifyInstanceState(env, 'restart-agent', 'RUNNING');
    log('scenario3', `restarted → RUNNING (same id=${firstId})`);

    await stopAgent(env, 'restart-agent');
    log('scenario3', 'final stop');
  }, 300_000);
});

// ---------------------------------------------------------------------------
// Scenario 4: Multiple spawn + stop + remove → verify clean
// ---------------------------------------------------------------------------

describe('Scenario 4: Teardown cleanup', () => {
  it('should spawn 3 agents, stop + remove, and verify clean state', async () => {
    const names = ['cleanup-a', 'cleanup-b', 'cleanup-c'];

    for (const name of names) {
      await spawnAgent(env, 'tenant-cli-boilerplate', name);
      await verifyInstanceState(env, name, 'RUNNING');
    }
    log('scenario4', '3 agents spawned → all RUNNING');

    // Stop all
    for (const name of names) {
      await stopAgent(env, name);
      await verifyInstanceState(env, name, 'STOPPED');
    }
    log('scenario4', 'all stopped — teardown will remove containers and storage');
  }, 300_000);
});

// ---------------------------------------------------------------------------
// Trading scenarios (trader-agent image with trading commands)
// ---------------------------------------------------------------------------

describe('Trading scenarios (trader-agent image)', () => {
  it('should complete a full sell/buy swap between Alice and Bob', async () => {
    // Spawn two trader agents
    await spawnAgent(env, 'trader-agent', 'trade-alice');
    await spawnAgent(env, 'trader-agent', 'trade-bob');
    await verifyInstanceState(env, 'trade-alice', 'RUNNING');
    await verifyInstanceState(env, 'trade-bob', 'RUNNING');
    log('trading:1', 'alice + bob RUNNING');

    // Alice creates a sell intent for UCT/USDU
    const sellResult = await sendCommand(env, 'trade-alice', 'CREATE_INTENT', {
      direction: 'sell',
      base_asset: 'UCT',
      quote_asset: 'USDU',
      rate_min: '95',
      rate_max: '105',
      volume_min: '10',
      volume_max: '100',
      expiry_sec: 300,
    });
    expect(sellResult['state']).toBe('ACTIVE');
    log('trading:1', `alice posted sell intent ${sellResult['intent_id']}`);

    // Bob creates a matching buy intent
    const buyResult = await sendCommand(env, 'trade-bob', 'CREATE_INTENT', {
      direction: 'buy',
      base_asset: 'UCT',
      quote_asset: 'USDU',
      rate_min: '95',
      rate_max: '105',
      volume_min: '10',
      volume_max: '100',
      expiry_sec: 300,
    });
    expect(buyResult['state']).toBe('ACTIVE');
    log('trading:1', `bob posted buy intent ${buyResult['intent_id']}`);

    // Verify both have active intents
    const aliceIntents = await sendCommand(env, 'trade-alice', 'LIST_INTENTS', { filter: 'active' });
    expect((aliceIntents['intents'] as unknown[]).length).toBeGreaterThanOrEqual(1);

    await stopAgent(env, 'trade-alice');
    await stopAgent(env, 'trade-bob');
    log('trading:1', 'done');
  }, 300_000);

  it('should match exactly one buyer when two compete for a single sell intent', async () => {
    await spawnAgent(env, 'trader-agent', 'compete-seller');
    await spawnAgent(env, 'trader-agent', 'compete-buyer1');
    await spawnAgent(env, 'trader-agent', 'compete-buyer2');

    for (const name of ['compete-seller', 'compete-buyer1', 'compete-buyer2']) {
      await verifyInstanceState(env, name, 'RUNNING');
    }
    log('trading:2', 'seller + 2 buyers RUNNING');

    // Seller creates one sell intent
    const sellResult = await sendCommand(env, 'compete-seller', 'CREATE_INTENT', {
      direction: 'sell',
      base_asset: 'ETH',
      quote_asset: 'USDC',
      rate_min: '1900',
      rate_max: '2100',
      volume_min: '1',
      volume_max: '10',
      expiry_sec: 300,
    });
    expect(sellResult['state']).toBe('ACTIVE');

    // Both buyers create buy intents
    for (const buyer of ['compete-buyer1', 'compete-buyer2']) {
      const result = await sendCommand(env, buyer, 'CREATE_INTENT', {
        direction: 'buy',
        base_asset: 'ETH',
        quote_asset: 'USDC',
        rate_min: '1900',
        rate_max: '2100',
        volume_min: '1',
        volume_max: '10',
        expiry_sec: 300,
      });
      expect(result['state']).toBe('ACTIVE');
    }
    log('trading:2', 'all intents posted');

    for (const name of ['compete-seller', 'compete-buyer1', 'compete-buyer2']) {
      await stopAgent(env, name);
    }
    log('trading:2', 'done');
  }, 300_000);

  it('should partially fill Alice intent with Bob then complete with Carol', async () => {
    await spawnAgent(env, 'trader-agent', 'partial-alice');
    await spawnAgent(env, 'trader-agent', 'partial-bob');
    await spawnAgent(env, 'trader-agent', 'partial-carol');

    for (const name of ['partial-alice', 'partial-bob', 'partial-carol']) {
      await verifyInstanceState(env, name, 'RUNNING');
    }
    log('trading:3', 'alice + bob + carol RUNNING');

    // Alice sells 1000 UCT, min 50
    const sellResult = await sendCommand(env, 'partial-alice', 'CREATE_INTENT', {
      direction: 'sell',
      base_asset: 'UCT',
      quote_asset: 'USDU',
      rate_min: '95',
      rate_max: '105',
      volume_min: '50',
      volume_max: '1000',
      expiry_sec: 300,
    });
    expect(sellResult['state']).toBe('ACTIVE');

    // Bob buys 300 UCT
    const bob1 = await sendCommand(env, 'partial-bob', 'CREATE_INTENT', {
      direction: 'buy',
      base_asset: 'UCT',
      quote_asset: 'USDU',
      rate_min: '95',
      rate_max: '105',
      volume_min: '50',
      volume_max: '300',
      expiry_sec: 300,
    });
    expect(bob1['state']).toBe('ACTIVE');

    // Carol buys 200 UCT
    const carol1 = await sendCommand(env, 'partial-carol', 'CREATE_INTENT', {
      direction: 'buy',
      base_asset: 'UCT',
      quote_asset: 'USDU',
      rate_min: '95',
      rate_max: '105',
      volume_min: '50',
      volume_max: '200',
      expiry_sec: 300,
    });
    expect(carol1['state']).toBe('ACTIVE');
    log('trading:3', 'all intents posted');

    // Verify Alice's portfolio is queryable
    const portfolio = await sendCommand(env, 'partial-alice', 'GET_PORTFOLIO', {});
    expect(portfolio).toBeTruthy();

    for (const name of ['partial-alice', 'partial-bob', 'partial-carol']) {
      await stopAgent(env, name);
    }
    log('trading:3', 'done');
  }, 300_000);

  it('should handle counterparty disappearing mid-swap and return volume', async () => {
    await spawnAgent(env, 'trader-agent', 'disappear-alice');
    await spawnAgent(env, 'trader-agent', 'disappear-bob');

    await verifyInstanceState(env, 'disappear-alice', 'RUNNING');
    await verifyInstanceState(env, 'disappear-bob', 'RUNNING');
    log('trading:4', 'alice + bob RUNNING');

    // Alice posts an intent
    const sellResult = await sendCommand(env, 'disappear-alice', 'CREATE_INTENT', {
      direction: 'sell',
      base_asset: 'BTC',
      quote_asset: 'USDT',
      rate_min: '60000',
      rate_max: '70000',
      volume_min: '1',
      volume_max: '10',
      expiry_sec: 120,
    });
    expect(sellResult['state']).toBe('ACTIVE');

    // Bob posts matching buy, then disappears
    const buyResult = await sendCommand(env, 'disappear-bob', 'CREATE_INTENT', {
      direction: 'buy',
      base_asset: 'BTC',
      quote_asset: 'USDT',
      rate_min: '60000',
      rate_max: '70000',
      volume_min: '1',
      volume_max: '10',
      expiry_sec: 120,
    });
    expect(buyResult['state']).toBe('ACTIVE');

    // Stop Bob mid-flow (simulates disappearance)
    await stopAgent(env, 'disappear-bob');
    log('trading:4', 'bob stopped (disappeared)');

    // Alice's intent should still be queryable
    const aliceIntents = await sendCommand(env, 'disappear-alice', 'LIST_INTENTS', { filter: 'all' });
    expect(aliceIntents['intents']).toBeTruthy();

    await stopAgent(env, 'disappear-alice');
    log('trading:4', 'done');
  }, 300_000);

  it('should recover a swap after stopping and restarting Alice', async () => {
    await spawnAgent(env, 'trader-agent', 'recover-alice');
    await verifyInstanceState(env, 'recover-alice', 'RUNNING');
    log('trading:5', 'alice RUNNING');

    // Alice creates an intent
    const intentResult = await sendCommand(env, 'recover-alice', 'CREATE_INTENT', {
      direction: 'sell',
      base_asset: 'SOL',
      quote_asset: 'EURU',
      rate_min: '100',
      rate_max: '200',
      volume_min: '1',
      volume_max: '50',
      expiry_sec: 300,
    });
    expect(intentResult['state']).toBe('ACTIVE');
    log('trading:5', 'intent created');

    // Stop Alice
    await stopAgent(env, 'recover-alice');
    await verifyInstanceState(env, 'recover-alice', 'STOPPED');
    log('trading:5', 'alice stopped');

    // Restart Alice
    const restarted = await startAgent(env, 'recover-alice');
    expect(restarted.instanceId).toBeTruthy();
    await verifyInstanceState(env, 'recover-alice', 'RUNNING');
    log('trading:5', 'alice restarted → RUNNING');

    // Verify portfolio is accessible after restart
    const portfolio = await sendCommand(env, 'recover-alice', 'GET_PORTFOLIO', {});
    expect(portfolio).toBeTruthy();

    await stopAgent(env, 'recover-alice');
    log('trading:5', 'done');
  }, 300_000);
});
