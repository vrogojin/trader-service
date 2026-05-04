/**
 * Multi-agent E2E tests for the Trader Agent.
 *
 * Covers test spec categories:
 *   T13 — Multi-agent swap flows (full swap, AGENT_BUSY, proposer selection, concurrent)
 *   T2.6 — Proposer selection across agents
 *
 * Wires N independent trader agents together via a shared DM router so that
 * NP-0 negotiation messages flow between NegotiationHandler instances without
 * any real Nostr transport.
 */

import { createHash } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { createIntentEngine, type IntentEngine } from '../../src/trader/intent-engine.js';
import {
  createNegotiationHandler,
  type NegotiationHandler,
  type NegotiationHandlerDeps,
} from '../../src/trader/negotiation-handler.js';
import {
  createSwapExecutor,
  type SwapExecutor,
  type SwapAdapter,
  type SwapDealInput,
  type SwapExecutorDeps,
} from '../../src/trader/swap-executor.js';
import {
  createVolumeReservationLedger,
  type VolumeReservationLedger,
} from '../../src/trader/volume-reservation-ledger.js';
import type {
  DealRecord,
  IntentRecord,
  MarketSearchResult,
  TradingIntent,
  TraderStrategy,
  OnMatchFound,
  NpMessage,
} from '../../src/trader/types.js';
import { DEFAULT_STRATEGY } from '../../src/trader/types.js';
import { createMockMarketModule, type MockMarketModule } from '../mocks/mock-market-module.js';
import { createMockPaymentsModule, type MockPaymentsModule } from '../mocks/mock-payments-module.js';
import { createLogger } from '../../src/shared/logger.js';
import { encodeDescription } from '../../src/trader/utils.js';

// ---------------------------------------------------------------------------
// Deterministic key material (66-char compressed secp256k1 pubkeys)
// ---------------------------------------------------------------------------

const PK_A = '02' + 'a'.repeat(64);
const PK_B = '02' + 'b'.repeat(64);
const PK_C = '02' + 'c'.repeat(64);
const PK_D = '02' + 'd'.repeat(64);

const ADDR_A = 'DIRECT://agent-a';
const ADDR_B = 'DIRECT://agent-b';
const ADDR_C = 'DIRECT://agent-c';
const ADDR_D = 'DIRECT://agent-d';

// Pre-built arrays so tests can pick N agents deterministically.
const AGENT_KEYS = [
  { pubkey: PK_A, address: ADDR_A },
  { pubkey: PK_B, address: ADDR_B },
  { pubkey: PK_C, address: ADDR_C },
  { pubkey: PK_D, address: ADDR_D },
];

// ---------------------------------------------------------------------------
// Crypto helpers (deterministic sign/verify matching negotiation-handler tests)
// ---------------------------------------------------------------------------

function makeSign(agentPubkey: string) {
  return (message: string): string =>
    createHash('sha256').update(`${agentPubkey}:${message}`).digest('hex');
}

function makeVerify() {
  return (signature: string, message: string, pubkey: string): boolean => {
    const expected = createHash('sha256').update(`${pubkey}:${message}`).digest('hex');
    return signature === expected;
  };
}

// ---------------------------------------------------------------------------
// Mock SwapAdapter — minimal adapter that auto-completes swaps
// ---------------------------------------------------------------------------

interface MockSwapAdapter extends SwapAdapter {
  proposeSwapCalls: SwapDealInput[];
  completeSwap: (swapId: string) => void;
}

function createMockSwapAdapter(): MockSwapAdapter {
  let nextSwapCounter = 1;

  const adapter: MockSwapAdapter = {
    proposeSwapCalls: [],

    async proposeSwap(deal: SwapDealInput) {
      adapter.proposeSwapCalls.push(deal);
      const swapId = `swap-${String(nextSwapCounter++)}`;
      return { swapId };
    },

    async acceptSwap(_swapId: string) {
      // no-op for tests
    },

    async rejectSwap(_swapId: string, _reason?: string) {
      // no-op for tests
    },

    async deposit(_swapId: string) {
      // no-op for tests
    },

    async verifyPayout(_swapId: string) {
      return true;
    },

    // Test helper to trigger the onSwapCompleted callback
    completeSwap(_swapId: string) {
      // This is a no-op placeholder; callers use swapExecutor.handleSwapCompleted()
    },
  };

  return adapter;
}

// ---------------------------------------------------------------------------
// AgentContext and multi-agent setup
// ---------------------------------------------------------------------------

interface AgentContext {
  pubkey: string;
  address: string;
  intentEngine: IntentEngine;
  negotiationHandler: NegotiationHandler;
  swapExecutor: SwapExecutor;
  ledger: VolumeReservationLedger;
  market: MockMarketModule;
  payments: MockPaymentsModule;
  swap: MockSwapAdapter;
  sentDms: Array<{ to: string; content: string }>;
  acceptedDeals: DealRecord[];
  completedDeals: Array<{ deal: DealRecord; payoutVerified: boolean }>;
  failedDeals: Array<{ deal: DealRecord; reason: string }>;
  matchFoundCalls: Array<{ own: IntentRecord; counterparty: MarketSearchResult }>;
}

interface MultiAgentSetup {
  agents: AgentContext[];
  deliverDm: (from: string, to: string, content: string) => Promise<void>;
}

function createMultiAgentSetup(
  agentCount: number,
  strategyOverrides?: Partial<TraderStrategy>,
): MultiAgentSetup {
  if (agentCount > AGENT_KEYS.length) {
    throw new Error(`Max ${String(AGENT_KEYS.length)} agents supported`);
  }

  const logger = createLogger({ component: 'multi-agent-e2e', level: 'warn' });
  const verifyFn = makeVerify();

  // We need late-binding references because sendDm closures must route to
  // the correct agent's handler, but handlers are created below.
  const agents: AgentContext[] = [];

  // DM router: find target agent by address, deliver to its negotiationHandler.
  async function deliverDm(fromPubkey: string, toAddress: string, content: string): Promise<void> {
    const fromAgent = agents.find((a) => a.pubkey === fromPubkey);
    const fromAddress = fromAgent?.address ?? 'UNKNOWN';
    const target = agents.find((a) => a.address === toAddress);
    if (target) {
      await target.negotiationHandler.handleIncomingDm(fromPubkey, fromAddress, content);
    }
  }

  for (let i = 0; i < agentCount; i++) {
    const keys = AGENT_KEYS[i]!;
    const sentDms: Array<{ to: string; content: string }> = [];
    const acceptedDeals: DealRecord[] = [];
    const completedDeals: Array<{ deal: DealRecord; payoutVerified: boolean }> = [];
    const failedDeals: Array<{ deal: DealRecord; reason: string }> = [];

    const market = createMockMarketModule();
    const payments = createMockPaymentsModule();
    payments.setBalance('ALPHA', 10_000n);
    payments.setBalance('USDC', 50_000n);

    const swap = createMockSwapAdapter();

    const strategy: TraderStrategy = {
      ...DEFAULT_STRATEGY,
      scan_interval_ms: 5000,
      ...strategyOverrides,
    };

    const ledger = createVolumeReservationLedger(
      (coinId) => payments.getConfirmedBalance(coinId),
    );

    // Negotiation handler — sendDm routes through the shared router
    const negDeps: NegotiationHandlerDeps = {
      sendDm: async (recipientAddress: string, content: string) => {
        sentDms.push({ to: recipientAddress, content });
        await deliverDm(keys.pubkey, recipientAddress, content);
      },
      signMessage: makeSign(keys.pubkey),
      verifySignature: verifyFn,
      onDealAccepted: async (deal: DealRecord) => {
        acceptedDeals.push(deal);
      },
      onDealCancelled: () => {},
      agentPubkey: keys.pubkey,
      agentAddress: keys.address,
      logger,
    };
    const negotiationHandler = createNegotiationHandler(negDeps);

    // Swap executor
    const swapDeps: SwapExecutorDeps = {
      swap,
      strategy,
      onSwapCompleted: async (deal: DealRecord, payoutVerified: boolean) => {
        completedDeals.push({ deal, payoutVerified });
      },
      onSwapFailed: async (deal: DealRecord, reason: string) => {
        failedDeals.push({ deal, reason });
      },
      agentPubkey: keys.pubkey,
      agentAddress: keys.address,
      swapDirectAddress: keys.address,
      logger,
    };
    const swapExecutor = createSwapExecutor(swapDeps);

    // Intent engine — onMatchFound is a no-op here; tests drive matching manually
    const matchFoundCalls: Array<{ own: IntentRecord; counterparty: MarketSearchResult }> = [];
    const onMatchFound: OnMatchFound = async (own, counterparty) => {
      matchFoundCalls.push({ own, counterparty });
    };

    const intentEngine = createIntentEngine({
      market,
      ledger,
      strategy,
      agentPubkey: keys.pubkey,
      agentAddress: keys.address,
      signMessage: makeSign(keys.pubkey),
      onMatchFound,
      logger,
    });

    agents.push({
      pubkey: keys.pubkey,
      address: keys.address,
      intentEngine,
      negotiationHandler,
      swapExecutor,
      ledger,
      market,
      payments,
      swap,
      sentDms,
      acceptedDeals,
      completedDeals,
      failedDeals,
      matchFoundCalls,
    });
  }

  return { agents, deliverDm };
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeIntentRecord(opts: {
  intentId: string;
  agentPubkey: string;
  agentAddress: string;
  direction: 'buy' | 'sell';
  baseAsset?: string;
  quoteAsset?: string;
  rateMin?: bigint;
  rateMax?: bigint;
  volumeMin?: bigint;
  volumeMax?: bigint;
  volumeFilled?: bigint;
}): IntentRecord {
  const intent: TradingIntent = {
    intent_id: opts.intentId,
    market_intent_id: `market-${opts.intentId}`,
    agent_pubkey: opts.agentPubkey,
    agent_address: opts.agentAddress,
    salt: `salt-${opts.intentId}`,
    direction: opts.direction,
    base_asset: opts.baseAsset ?? 'ALPHA',
    quote_asset: opts.quoteAsset ?? 'USDC',
    rate_min: opts.rateMin ?? 450n,
    rate_max: opts.rateMax ?? 500n,
    volume_min: opts.volumeMin ?? 100n,
    volume_max: opts.volumeMax ?? 1000n,
    volume_filled: opts.volumeFilled ?? 0n,
    escrow_address: 'escrow-001',
    deposit_timeout_sec: 120,
    expiry_ms: Date.now() + 86_400_000,
    signature: `sig-${opts.intentId}`,
  };
  return {
    intent,
    state: 'MATCHING',
    deal_ids: [],
    updated_at: Date.now(),
  };
}

function makeCounterpartyResult(opts: {
  id: string;
  agentPublicKey: string;
  agentAddress: string;
  direction: 'buy' | 'sell';
  baseAsset?: string;
  quoteAsset?: string;
  rateMin?: bigint;
  rateMax?: bigint;
  volumeMin?: bigint;
  volumeMax?: bigint;
}): MarketSearchResult {
  const description = encodeDescription({
    intent_id: opts.id,
    market_intent_id: `market-${opts.id}`,
    agent_pubkey: opts.agentPublicKey,
    agent_address: opts.agentAddress,
    salt: '0000',
    direction: opts.direction,
    base_asset: opts.baseAsset ?? 'ALPHA',
    quote_asset: opts.quoteAsset ?? 'USDC',
    rate_min: opts.rateMin ?? 450n,
    rate_max: opts.rateMax ?? 500n,
    volume_min: opts.volumeMin ?? 100n,
    volume_max: opts.volumeMax ?? 1000n,
    volume_filled: 0n,
    escrow_address: 'escrow-001',
    deposit_timeout_sec: 120,
    expiry_ms: Date.now() + 86_400_000,
    signature: 'dummy',
  });

  return {
    id: opts.id,
    score: 0.95,
    agentPublicKey: opts.agentPublicKey,
    description,
    intentType: opts.direction,
    currency: opts.quoteAsset ?? 'USDC',
    contactHandle: opts.agentAddress,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  };
}

// ===========================================================================
// T13 — Multi-Agent Swap Flows
// ===========================================================================

describe('T13 — Multi-Agent Swap Flows', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-04-03T12:00:00Z') });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // T13.1: Two agents complete a full swap
  // -------------------------------------------------------------------------

  it('T13.1 — two agents complete a full swap end-to-end', async () => {
    const { agents } = createMultiAgentSetup(2);
    const [agentA, agentB] = agents as [AgentContext, AgentContext];

    // 1. Create intents
    const intentA = makeIntentRecord({
      intentId: 'intent-a-sell',
      agentPubkey: agentA.pubkey,
      agentAddress: agentA.address,
      direction: 'sell',
    });

    const counterpartyB = makeCounterpartyResult({
      id: 'intent-b-buy',
      agentPublicKey: agentB.pubkey,
      agentAddress: agentB.address,
      direction: 'buy',
    });

    // 2. Reserve volume on A's ledger for this deal
    const reserved = await agentA.ledger.reserve('ALPHA', 300n, 'pre-deal-a');
    expect(reserved).toBe(true);
    expect(agentA.ledger.getAvailable('ALPHA')).toBe(9700n);

    // 3. Verify proposer selection: PK_A < PK_B so A should propose
    expect(PK_A < PK_B).toBe(true);

    // Route matching through the intent engine: create intent on A, set search
    // results to include B, advance the scan timer, verify onMatchFound fires.
    agentA.market.setSearchResults([counterpartyB]);
    agentA.intentEngine.start();

    await agentA.intentEngine.createIntent(
      {
        direction: 'sell',
        base_asset: 'ALPHA',
        quote_asset: 'USDC',
        rate_min: '450',
        rate_max: '500',
        volume_min: '100',
        volume_max: '1000',
        expiry_sec: 86400,
      },
      agentA.pubkey,
      agentA.address,
    );

    // Advance past scan interval so the engine finds B
    await vi.advanceTimersByTimeAsync(5200);

    // The intent engine should have called onMatchFound exactly once (A proposes)
    expect(agentA.matchFoundCalls).toHaveLength(1);
    expect(agentA.matchFoundCalls[0]!.counterparty.agentPublicKey).toBe(PK_B);

    agentA.intentEngine.stop();

    // Now also test the full negotiation flow manually
    const agreedRate = 475n;
    const agreedVolume = 300n;
    const dealRecord = await agentA.negotiationHandler.proposeDeal(
      intentA,
      counterpartyB,
      agreedRate,
      agreedVolume,
      'escrow-001',
    );

    // 4. Verify proposal was sent and auto-accepted by B
    expect(agentA.sentDms.length).toBe(1);
    const proposeDm = agentA.sentDms.find((dm) => {
      const parsed = JSON.parse(dm.content) as NpMessage;
      return parsed.type === 'np.propose_deal';
    });
    expect(proposeDm).toBeDefined();
    expect(proposeDm!.to).toBe(ADDR_B);

    // B sent back an accept
    expect(agentB.sentDms).toHaveLength(1);
    const acceptDm = agentB.sentDms.find((dm) => {
      const parsed = JSON.parse(dm.content) as NpMessage;
      return parsed.type === 'np.accept_deal';
    });
    expect(acceptDm).toBeDefined();

    // 5. Both agents should have ACCEPTED deals
    const aliceDeal = agentA.negotiationHandler.getDeal(dealRecord.terms.deal_id);
    expect(aliceDeal).not.toBeNull();
    expect(aliceDeal!.state).toBe('ACCEPTED');

    const bobDeal = agentB.negotiationHandler.getDeal(dealRecord.terms.deal_id);
    expect(bobDeal).not.toBeNull();
    expect(bobDeal!.state).toBe('ACCEPTED');

    expect(agentA.acceptedDeals).toHaveLength(1);
    expect(agentB.acceptedDeals).toHaveLength(1);

    // 6. Execute deal on A's side (proposer initiates swap)
    await agentA.swapExecutor.executeDeal(aliceDeal!);
    expect(agentA.swap.proposeSwapCalls).toHaveLength(1);

    // 7. Simulate swap completion
    agentA.swapExecutor.handleSwapCompleted('swap-1', true);

    expect(agentA.completedDeals).toHaveLength(1);
    expect(agentA.completedDeals[0]!.payoutVerified).toBe(true);

    // 8. Release reservation now that deal is completed
    agentA.ledger.release('pre-deal-a');
    expect(agentA.ledger.getAvailable('ALPHA')).toBe(10_000n);
    expect(agentA.ledger.getReservations()).toHaveLength(0);

    // Cleanup — stop ALL components on ALL agents
    for (const agent of agents) {
      agent.intentEngine.stop();
      agent.negotiationHandler.stop();
      agent.swapExecutor.stop();
    }
  });

  // -------------------------------------------------------------------------
  // T13.2: Three agents — first accepted, others AGENT_BUSY
  // -------------------------------------------------------------------------

  it('T13.2 — first proposal accepted, second gets AGENT_BUSY rejection', async () => {
    const { agents } = createMultiAgentSetup(3);
    const [agentA, agentB, agentC] = agents as [AgentContext, AgentContext, AgentContext];

    // B's view of A's sell intent
    const counterpartyA_forB = makeCounterpartyResult({
      id: 'intent-a-sell',
      agentPublicKey: agentA.pubkey,
      agentAddress: agentA.address,
      direction: 'sell',
    });

    // C's view of A's intent (same id — same intent on market)
    const counterpartyA_forC = makeCounterpartyResult({
      id: 'intent-a-sell',
      agentPublicKey: agentA.pubkey,
      agentAddress: agentA.address,
      direction: 'sell',
    });

    // B's intent (used as proposer intent for B's proposal)
    const intentB = makeIntentRecord({
      intentId: 'intent-b-buy',
      agentPubkey: agentB.pubkey,
      agentAddress: agentB.address,
      direction: 'buy',
    });

    // C's intent
    const intentC = makeIntentRecord({
      intentId: 'intent-c-buy',
      agentPubkey: agentC.pubkey,
      agentAddress: agentC.address,
      direction: 'buy',
    });

    // 1. B proposes to A first
    const dealB = await agentB.negotiationHandler.proposeDeal(
      intentB,
      counterpartyA_forB,
      475n,
      300n,
      'escrow-001',
    );

    // B's proposal was accepted by A
    const dealOnA = agentA.negotiationHandler.getDeal(dealB.terms.deal_id);
    expect(dealOnA).not.toBeNull();
    expect(dealOnA!.state).toBe('ACCEPTED');

    const dealOnB = agentB.negotiationHandler.getDeal(dealB.terms.deal_id);
    expect(dealOnB).not.toBeNull();
    expect(dealOnB!.state).toBe('ACCEPTED');

    // 2. C proposes to A second — should get AGENT_BUSY (duplicate guard on intent-a-sell)
    const dealC = await agentC.negotiationHandler.proposeDeal(
      intentC,
      counterpartyA_forC,
      480n,
      200n,
      'escrow-001',
    );

    // A should have sent a reject to C
    const rejectDm = agentA.sentDms.find((dm) => {
      try {
        const parsed = JSON.parse(dm.content) as NpMessage;
        return parsed.type === 'np.reject_deal' && dm.to === ADDR_C;
      } catch {
        return false;
      }
    });
    expect(rejectDm).toBeDefined();

    const rejectMsg = JSON.parse(rejectDm!.content) as NpMessage;
    expect(rejectMsg.payload).toHaveProperty('reason_code', 'AGENT_BUSY');

    // C's deal should be CANCELLED (rejection received)
    const dealCOnC = agentC.negotiationHandler.getDeal(dealC.terms.deal_id);
    expect(dealCOnC).not.toBeNull();
    expect(dealCOnC!.state).toBe('CANCELLED');

    // Exactly one deal accepted on A's side
    expect(agentA.acceptedDeals).toHaveLength(1);
    expect(agentA.acceptedDeals[0]!.terms.deal_id).toBe(dealB.terms.deal_id);

    // B got accepted, C did not
    expect(agentB.acceptedDeals).toHaveLength(1);
    expect(agentC.acceptedDeals).toHaveLength(0);

    // Cleanup — stop ALL components on ALL agents
    for (const agent of agents) {
      agent.intentEngine.stop();
      agent.negotiationHandler.stop();
      agent.swapExecutor.stop();
    }
  });

  // -------------------------------------------------------------------------
  // T13.3: Simultaneous discovery — proposer election (spec 5.7) decides who proposes
  // -------------------------------------------------------------------------

  it('T13.3 — both agents discover match, only the lower-pubkey side proposes (spec 5.7)', async () => {
    const { agents } = createMultiAgentSetup(2);
    const [agentA, agentB] = agents as [AgentContext, AgentContext];

    // PK_A (02aaa...) < PK_B (02bbb...). Per spec 5.7 the lower-pubkey side
    // proposes; A's engine fires onMatchFound, B's engine yields. The
    // duplicate-guard race the previous behavior relied on is no longer
    // exercised — both sides racing fan-outs would deadlock the pair on
    // each other's failed-counterparty list (see fix/e2e-live-real-issues
    // session for the live-testnet failure mode that motivated the change).

    // A's intent and B's counterparty view
    const intentA = makeIntentRecord({
      intentId: 'intent-a-sell',
      agentPubkey: agentA.pubkey,
      agentAddress: agentA.address,
      direction: 'sell',
    });

    const counterpartyB = makeCounterpartyResult({
      id: 'intent-b-buy',
      agentPublicKey: agentB.pubkey,
      agentAddress: agentB.address,
      direction: 'buy',
    });

    // A's counterparty view (what B's engine would see)
    const counterpartyA = makeCounterpartyResult({
      id: 'intent-a-sell',
      agentPublicKey: agentA.pubkey,
      agentAddress: agentA.address,
      direction: 'sell',
    });

    // Set up search results: both agents "find" each other
    agentA.market.setSearchResults([counterpartyB]);
    agentB.market.setSearchResults([counterpartyA]);

    // Start both engines
    agentA.intentEngine.start();
    agentB.intentEngine.start();

    // Create intents
    await agentA.intentEngine.createIntent(
      {
        direction: 'sell',
        base_asset: 'ALPHA',
        quote_asset: 'USDC',
        rate_min: '450',
        rate_max: '500',
        volume_min: '100',
        volume_max: '1000',
        expiry_sec: 86400,
      },
      agentA.pubkey,
      agentA.address,
    );

    await agentB.intentEngine.createIntent(
      {
        direction: 'buy',
        base_asset: 'ALPHA',
        quote_asset: 'USDC',
        rate_min: '450',
        rate_max: '500',
        volume_min: '100',
        volume_max: '1000',
        expiry_sec: 86400,
      },
      agentB.pubkey,
      agentB.address,
    );

    // Advance past scan interval
    await vi.advanceTimersByTimeAsync(5200);

    // Both agents should have searched the market at least once.
    expect(agentA.market.searchCalls.length).toBe(1);
    expect(agentB.market.searchCalls.length).toBe(1);

    // Spec 5.7: only the lower-pubkey side (A) discovers + proposes.
    // B's matcher sees A's intent in its results but yields because
    // canonicalPubkeyKey(B) > canonicalPubkeyKey(A).
    expect(agentA.matchFoundCalls).toHaveLength(1);
    expect(agentA.matchFoundCalls[0]!.counterparty.agentPublicKey).toBe(PK_B);
    expect(agentB.matchFoundCalls).toHaveLength(0);

    // A proposes a deal to B
    const dealFromA = await agentA.negotiationHandler.proposeDeal(
      intentA,
      counterpartyB,
      475n,
      300n,
      'escrow-001',
    );

    // A sent a proposal DM
    const proposalsFromA = agentA.sentDms.filter((dm) => {
      try {
        const parsed = JSON.parse(dm.content) as NpMessage;
        return parsed.type === 'np.propose_deal';
      } catch {
        return false;
      }
    });
    expect(proposalsFromA).toHaveLength(1);
    expect(proposalsFromA[0]!.to).toBe(ADDR_B);

    // B auto-accepted A's proposal
    const dealOnB = agentB.negotiationHandler.getDeal(dealFromA.terms.deal_id);
    expect(dealOnB).not.toBeNull();
    expect(dealOnB!.state).toBe('ACCEPTED');

    // Duplicate deal guard: only one deal exists on each side
    const allDealsA = await agentA.negotiationHandler.listDeals();
    const allDealsB = await agentB.negotiationHandler.listDeals();
    expect(allDealsA).toHaveLength(1);
    expect(allDealsB).toHaveLength(1);
    expect(allDealsA[0]!.terms.deal_id).toBe(allDealsB[0]!.terms.deal_id);

    // Cleanup — stop ALL components on ALL agents
    for (const agent of agents) {
      agent.intentEngine.stop();
      agent.negotiationHandler.stop();
      agent.swapExecutor.stop();
    }
  });

  // -------------------------------------------------------------------------
  // T13.4: Concurrent inbound + outbound on different intents
  // -------------------------------------------------------------------------

  it('T13.4 — concurrent inbound and outbound deals on separate intents', async () => {
    const { agents } = createMultiAgentSetup(3, { max_concurrent_swaps: 3 });
    const [agentA, agentB, agentC] = agents as [AgentContext, AgentContext, AgentContext];

    // A has two intents:
    //   intent-X: sell 1000 ALPHA (inbound: B will contact A)
    //   intent-Y: buy 500 USDC (outbound: A will contact C)

    const intentY = makeIntentRecord({
      intentId: 'intent-y-buy',
      agentPubkey: agentA.pubkey,
      agentAddress: agentA.address,
      direction: 'buy',
      baseAsset: 'USDC',
      quoteAsset: 'ALPHA',
      volumeMax: 500n,
    });

    // B's buy intent matches A's sell intent-X
    const intentB = makeIntentRecord({
      intentId: 'intent-b-buy',
      agentPubkey: agentB.pubkey,
      agentAddress: agentB.address,
      direction: 'buy',
    });

    // C's sell USDC intent matches A's buy intent-Y
    const counterpartyC = makeCounterpartyResult({
      id: 'intent-c-sell-usdc',
      agentPublicKey: agentC.pubkey,
      agentAddress: agentC.address,
      direction: 'sell',
      baseAsset: 'USDC',
      quoteAsset: 'ALPHA',
    });

    // A's intent-X as seen by B
    const counterpartyAX_forB = makeCounterpartyResult({
      id: 'intent-x-sell',
      agentPublicKey: agentA.pubkey,
      agentAddress: agentA.address,
      direction: 'sell',
    });

    // Reserve volumes
    const resX = await agentA.ledger.reserve('ALPHA', 500n, 'deal-x-reserve');
    expect(resX).toBe(true);

    // 1. B proposes to A on intent-X (inbound to A)
    const dealX = await agentB.negotiationHandler.proposeDeal(
      intentB,
      counterpartyAX_forB,
      475n,
      500n,
      'escrow-001',
    );

    const dealXonA = agentA.negotiationHandler.getDeal(dealX.terms.deal_id);
    expect(dealXonA).not.toBeNull();
    expect(dealXonA!.state).toBe('ACCEPTED');

    // 2. A proposes to C on intent-Y (outbound from A)
    const dealY = await agentA.negotiationHandler.proposeDeal(
      intentY,
      counterpartyC,
      10n,
      500n,
      'escrow-001',
    );

    const dealYonC = agentC.negotiationHandler.getDeal(dealY.terms.deal_id);
    expect(dealYonC).not.toBeNull();
    expect(dealYonC!.state).toBe('ACCEPTED');

    const dealYonA = agentA.negotiationHandler.getDeal(dealY.terms.deal_id);
    expect(dealYonA).not.toBeNull();
    expect(dealYonA!.state).toBe('ACCEPTED');

    // 3. Both deals proceed concurrently — execute both on A's side
    //    Deal X: A is the acceptor (B proposed), so A registers and waits
    //    Deal Y: A is the proposer, so A calls proposeSwap
    await agentA.swapExecutor.executeDeal(dealXonA!);
    await agentA.swapExecutor.executeDeal(dealYonA!);

    // Only deal Y was proposed (A is proposer); deal X tracked as EXECUTING
    // (acceptor path — SDK handles acceptance via sphere.on)
    expect(agentA.swap.proposeSwapCalls).toHaveLength(1);

    // Both deals now active (EXECUTING) — acceptor transitions immediately
    expect(agentA.swapExecutor.getActiveCount()).toBe(2);

    // 4. Deal Y completes (A was proposer, has swapId 'swap-1')
    agentA.swapExecutor.handleSwapCompleted('swap-1', true);

    expect(agentA.completedDeals).toHaveLength(1);

    // Volume reservations don't interfere — release X, check Y unaffected
    agentA.ledger.release('deal-x-reserve');
    expect(agentA.ledger.getAvailable('ALPHA')).toBe(10_000n);

    // A had two accepted deals total
    expect(agentA.acceptedDeals).toHaveLength(2);

    // Cleanup — stop ALL components on ALL agents
    for (const agent of agents) {
      agent.intentEngine.stop();
      agent.negotiationHandler.stop();
      agent.swapExecutor.stop();
    }
  });

  // -------------------------------------------------------------------------
  // T13.5: Best match selection — agent picks most favorable rate
  // -------------------------------------------------------------------------

  it('T13.5 — agent proposes to the counterparty with the best rate', async () => {
    const { agents } = createMultiAgentSetup(4);
    const [agentA, agentB, agentC, agentD] = agents as [
      AgentContext, AgentContext, AgentContext, AgentContext,
    ];

    // A is selling ALPHA, rate 450-500
    const intentA = makeIntentRecord({
      intentId: 'intent-a-sell',
      agentPubkey: agentA.pubkey,
      agentAddress: agentA.address,
      direction: 'sell',
      rateMin: 450n,
      rateMax: 500n,
    });

    // Three counterparty buy intents with different rates:
    //   B: rate 460 (worst for seller)
    //   C: rate 490 (best for seller)
    //   D: rate 475 (middle)
    const counterpartyB = makeCounterpartyResult({
      id: 'intent-b-buy',
      agentPublicKey: agentB.pubkey,
      agentAddress: agentB.address,
      direction: 'buy',
      rateMin: 455n,
      rateMax: 460n,
    });

    const counterpartyC = makeCounterpartyResult({
      id: 'intent-c-buy',
      agentPublicKey: agentC.pubkey,
      agentAddress: agentC.address,
      direction: 'buy',
      rateMin: 485n,
      rateMax: 490n,
    });

    const counterpartyD = makeCounterpartyResult({
      id: 'intent-d-buy',
      agentPublicKey: agentD.pubkey,
      agentAddress: agentD.address,
      direction: 'buy',
      rateMin: 470n,
      rateMax: 475n,
    });

    // For a seller, the best rate is the highest buyer rate.
    // Agent should select counterpartyC (rate 490).

    // Set mock search results to return all 3 counterparties and let the
    // intent engine's matchIntentAgainstResults do the sorting/selection.
    agentA.market.setSearchResults([counterpartyB, counterpartyC, counterpartyD]);
    agentA.intentEngine.start();

    await agentA.intentEngine.createIntent(
      {
        direction: 'sell',
        base_asset: 'ALPHA',
        quote_asset: 'USDC',
        rate_min: '450',
        rate_max: '500',
        volume_min: '100',
        volume_max: '1000',
        expiry_sec: 86400,
      },
      agentA.pubkey,
      agentA.address,
    );

    // Advance past scan interval so the engine evaluates all candidates
    await vi.advanceTimersByTimeAsync(5200);

    // With fan-out matching, the engine proposes to ALL valid counterparties in parallel.
    // C should be FIRST (best rate 490 for seller — highest bid).
    expect(agentA.matchFoundCalls.length).toBeGreaterThanOrEqual(1);
    expect(agentA.matchFoundCalls[0]!.counterparty.agentPublicKey).toBe(PK_C);
    expect(agentA.matchFoundCalls[0]!.counterparty.id).toBe('intent-c-buy');

    agentA.intentEngine.stop();

    // Now execute the proposal to C to verify the full negotiation flow
    const deal = await agentA.negotiationHandler.proposeDeal(
      intentA,
      counterpartyC,
      490n,
      300n,
      'escrow-001',
    );

    // Verify A's proposal went to C specifically
    const proposalToC = agentA.sentDms.filter((dm) => dm.to === ADDR_C);
    expect(proposalToC).toHaveLength(1);

    const proposalMsg = JSON.parse(proposalToC[0]!.content) as NpMessage;
    expect(proposalMsg.type).toBe('np.propose_deal');

    // A did NOT send proposals to B or D
    const proposalsToB = agentA.sentDms.filter((dm) => dm.to === ADDR_B);
    expect(proposalsToB).toHaveLength(0);

    const proposalsToD = agentA.sentDms.filter((dm) => dm.to === ADDR_D);
    expect(proposalsToD).toHaveLength(0);

    // C accepted the deal
    const dealOnC = agentC.negotiationHandler.getDeal(deal.terms.deal_id);
    expect(dealOnC).not.toBeNull();
    expect(dealOnC!.state).toBe('ACCEPTED');

    // Cleanup
    for (const agent of agents) {
      agent.intentEngine.stop();
      agent.negotiationHandler.stop();
      agent.swapExecutor.stop();
    }
  });

  // -------------------------------------------------------------------------
  // T13.6: Volume reservation prevents double-booking
  // -------------------------------------------------------------------------

  it('T13.6 — volume reservation prevents double-booking across concurrent matches', async () => {
    const { agents } = createMultiAgentSetup(3);
    const [agentA, agentB, agentC] = agents as [AgentContext, AgentContext, AgentContext];

    // A has 1000 ALPHA, intent to sell all 1000
    agentA.payments.setBalance('ALPHA', 1000n);

    // Two matches arrive for 700 each
    // First match: reserve 700 for B => succeeds
    const r1 = await agentA.ledger.reserve('ALPHA', 700n, 'deal-with-b');
    expect(r1).toBe(true);
    expect(agentA.ledger.getAvailable('ALPHA')).toBe(300n);

    // Second match: reserve 700 for C => FAILS (only 300 available)
    const r2 = await agentA.ledger.reserve('ALPHA', 700n, 'deal-with-c');
    expect(r2).toBe(false);
    expect(agentA.ledger.getAvailable('ALPHA')).toBe(300n);

    // Exactly one reservation exists
    expect(agentA.ledger.getReservations()).toHaveLength(1);
    expect(agentA.ledger.getReservations()[0]!.dealId).toBe('deal-with-b');
    expect(agentA.ledger.getReservations()[0]!.amount).toBe(700n);

    // Only B's deal should proceed. Create the deals to verify.
    const counterpartyBView = makeCounterpartyResult({
      id: 'intent-a-sell-all',
      agentPublicKey: agentA.pubkey,
      agentAddress: agentA.address,
      direction: 'sell',
    });

    // B can propose (volume was reserved successfully)
    const intentB = makeIntentRecord({
      intentId: 'intent-b-buy-700',
      agentPubkey: agentB.pubkey,
      agentAddress: agentB.address,
      direction: 'buy',
      volumeMin: 100n,
      volumeMax: 700n,
    });

    const dealB = await agentB.negotiationHandler.proposeDeal(
      intentB,
      counterpartyBView,
      475n,
      700n,
      'escrow-001',
    );

    // Deal accepted on A's side
    const dealBonA = agentA.negotiationHandler.getDeal(dealB.terms.deal_id);
    expect(dealBonA).not.toBeNull();
    expect(dealBonA!.state).toBe('ACCEPTED');

    // C's reservation failed, so C should not create a deal for that volume.
    // Verify C has no reservations and the ledger is consistent.
    const cReservations = agentC.ledger.getReservations();
    expect(cReservations).toHaveLength(0);

    // Concurrent reserve must serialize: verify via Promise.all
    agentA.ledger.release('deal-with-b');
    agentA.payments.setBalance('ALPHA', 1000n);

    const [cr1, cr2] = await Promise.all([
      agentA.ledger.reserve('ALPHA', 700n, 'concurrent-deal-1'),
      agentA.ledger.reserve('ALPHA', 700n, 'concurrent-deal-2'),
    ]);

    // Exactly one succeeds
    const successes = [cr1, cr2].filter(Boolean);
    expect(successes).toHaveLength(1);

    // Total reserved must equal exactly the single successful reservation
    const totalReserved = agentA.ledger.getReservations().reduce(
      (sum, r) => sum + r.amount, 0n,
    );
    expect(totalReserved).toBe(700n);

    // Cleanup — stop ALL components on ALL agents
    for (const agent of agents) {
      agent.intentEngine.stop();
      agent.negotiationHandler.stop();
      agent.swapExecutor.stop();
    }
  });

  // -------------------------------------------------------------------------
  // T13.7: Impersonation — Agent C forges proposal claiming to be Agent B
  // -------------------------------------------------------------------------

  it('T13.7 — rejects proposal with forged sender pubkey', async () => {
    const { agents } = createMultiAgentSetup(3);
    const [agentA, agentB] = agents as [AgentContext, AgentContext, AgentContext];

    // A and B have complementary intents
    const intentB = makeIntentRecord({
      intentId: 'intent-b-buy',
      agentPubkey: agentB.pubkey,
      agentAddress: agentB.address,
      direction: 'buy',
    });

    const counterpartyA = makeCounterpartyResult({
      id: 'intent-a-sell',
      agentPublicKey: agentA.pubkey,
      agentAddress: agentA.address,
      direction: 'sell',
    });

    // C crafts a forged np.propose_deal where:
    //   - The NP envelope sender_pubkey = PK_B (forged — C claims to be B)
    //   - The DM transport layer delivers with fromPubkey = PK_C (true identity)
    // The handler checks DM-layer senderPubkey vs envelope sender_pubkey.
    const forgedTerms = {
      deal_id: 'deadbeef'.repeat(8),
      proposer_intent_id: intentB.intent.intent_id,
      acceptor_intent_id: counterpartyA.id,
      proposer_pubkey: PK_B,  // forged: claims to be B
      acceptor_pubkey: PK_A,
      proposer_address: ADDR_B,
      acceptor_address: ADDR_A,
      base_asset: 'ALPHA',
      quote_asset: 'USDC',
      rate: '475',
      volume: '300',
      escrow_address: 'escrow-001',
      deposit_timeout_sec: 120,
      created_ms: Date.now(),
    };

    // C signs as B (forged) in the NP envelope
    const signAsB = makeSign(PK_B);
    const msgId = crypto.randomUUID();
    const sigPayload = createHash('sha256')
      .update(`${'deadbeef'.repeat(8)}:${msgId}:np.propose_deal`)
      .digest('hex');
    const signature = signAsB(sigPayload);

    const forgedMessage: NpMessage = {
      np_version: '0.1',
      msg_id: msgId,
      deal_id: 'deadbeef'.repeat(8),
      sender_pubkey: PK_B,  // forged: claims to be B
      type: 'np.propose_deal',
      ts_ms: Date.now(),
      payload: { terms: forgedTerms, proposer_swap_address: ADDR_C, message: '' },
      signature,
    };

    // Deliver via DM router with true sender PK_C (the DM transport layer truth)
    // The handler will compare DM-layer senderPubkey (PK_C) vs envelope sender_pubkey (PK_B)
    await agentA.negotiationHandler.handleIncomingDm(
      PK_C,       // true DM sender — C's real identity
      ADDR_C,     // C's real address
      JSON.stringify(forgedMessage),
    );

    // A should have rejected: no deal created since PK_C != PK_B (pubkey mismatch)
    const deals = await agentA.negotiationHandler.listDeals();
    expect(deals).toHaveLength(0);
    expect(agentA.acceptedDeals).toHaveLength(0);

    // A should NOT have sent any accept DM
    const acceptDms = agentA.sentDms.filter((dm) => {
      try {
        const parsed = JSON.parse(dm.content) as NpMessage;
        return parsed.type === 'np.accept_deal';
      } catch {
        return false;
      }
    });
    expect(acceptDms).toHaveLength(0);

    // Cleanup — stop ALL components on ALL agents
    for (const agent of agents) {
      agent.intentEngine.stop();
      agent.negotiationHandler.stop();
      agent.swapExecutor.stop();
    }
  });

  // -------------------------------------------------------------------------
  // T13.8: Volume double-booking with negotiation + ledger combined
  // -------------------------------------------------------------------------

  it('T13.8 — AGENT_BUSY + ledger prevents double-booking on same intent', async () => {
    const { agents } = createMultiAgentSetup(3);
    const [agentA, agentB, agentC] = agents as [AgentContext, AgentContext, AgentContext];

    // A has intent-X with 1000 ALPHA, balance 1000
    agentA.payments.setBalance('ALPHA', 1000n);

    // Reserve 700 ALPHA for the first deal (B)
    const reserved = await agentA.ledger.reserve('ALPHA', 700n, 'deal-with-b');
    expect(reserved).toBe(true);
    expect(agentA.ledger.getAvailable('ALPHA')).toBe(300n);

    // B proposes on intent-X => A accepts (first proposal on this intent)
    const counterpartyA_forB = makeCounterpartyResult({
      id: 'intent-x-sell',
      agentPublicKey: agentA.pubkey,
      agentAddress: agentA.address,
      direction: 'sell',
    });

    const intentB = makeIntentRecord({
      intentId: 'intent-b-buy',
      agentPubkey: agentB.pubkey,
      agentAddress: agentB.address,
      direction: 'buy',
      volumeMax: 700n,
    });

    const dealB = await agentB.negotiationHandler.proposeDeal(
      intentB,
      counterpartyA_forB,
      475n,
      700n,
      'escrow-001',
    );

    // A should have accepted B's proposal
    const dealBonA = agentA.negotiationHandler.getDeal(dealB.terms.deal_id);
    expect(dealBonA).not.toBeNull();
    expect(dealBonA!.state).toBe('ACCEPTED');

    // C proposes on intent-X => A rejects AGENT_BUSY (duplicate guard)
    const counterpartyA_forC = makeCounterpartyResult({
      id: 'intent-x-sell',  // same intent as B targeted
      agentPublicKey: agentA.pubkey,
      agentAddress: agentA.address,
      direction: 'sell',
    });

    const intentC = makeIntentRecord({
      intentId: 'intent-c-buy',
      agentPubkey: agentC.pubkey,
      agentAddress: agentC.address,
      direction: 'buy',
      volumeMax: 500n,
    });

    const dealC = await agentC.negotiationHandler.proposeDeal(
      intentC,
      counterpartyA_forC,
      480n,
      500n,
      'escrow-001',
    );

    // A should have rejected C's proposal with AGENT_BUSY
    const rejectDm = agentA.sentDms.find((dm) => {
      try {
        const parsed = JSON.parse(dm.content) as NpMessage;
        return parsed.type === 'np.reject_deal' && dm.to === ADDR_C;
      } catch {
        return false;
      }
    });
    expect(rejectDm).toBeDefined();
    const rejectMsg = JSON.parse(rejectDm!.content) as NpMessage;
    expect(rejectMsg.payload).toHaveProperty('reason_code', 'AGENT_BUSY');

    // C's deal should be CANCELLED (rejection received)
    const dealCOnC = agentC.negotiationHandler.getDeal(dealC.terms.deal_id);
    expect(dealCOnC).not.toBeNull();
    expect(dealCOnC!.state).toBe('CANCELLED');

    // Ledger should have exactly 1 reservation for 700
    const reservations = agentA.ledger.getReservations();
    expect(reservations).toHaveLength(1);
    expect(reservations[0]!.amount).toBe(700n);
    expect(reservations[0]!.dealId).toBe('deal-with-b');

    // Available balance should be 300 (1000 - 700 reserved)
    expect(agentA.ledger.getAvailable('ALPHA')).toBe(300n);

    // Cleanup — stop ALL components on ALL agents
    for (const agent of agents) {
      agent.intentEngine.stop();
      agent.negotiationHandler.stop();
      agent.swapExecutor.stop();
    }
  });
});
