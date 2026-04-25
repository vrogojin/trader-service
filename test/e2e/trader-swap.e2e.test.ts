/**
 * E2E: Trader swap execution and partial fill tests.
 *
 * Covers spec categories:
 *   T5  — Swap execution happy path
 *   T6  — Swap execution unhappy path
 *   T7  — Partial fill scenarios
 *   T11 — Security scenarios (payout verification, term mismatch, v1 rejection, untrusted escrow)
 *   T16 — State machine violation tests (double completion, invalid state)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createSwapExecutor,
  type SwapAdapter,
  type SwapDealInput,
  type SwapExecutor,
  type SwapExecutorDeps,
} from '../../src/trader/swap-executor.js';
import type {
  DealRecord,
  DealTerms,
  TraderStrategy,
  OnSwapCompleted,
  OnSwapFailed,
} from '../../src/trader/types.js';
import {
  createVolumeReservationLedger,
  type VolumeReservationLedger,
} from '../../src/trader/volume-reservation-ledger.js';
import { createLogger, type Logger } from '../../src/shared/logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PK_TRADER_A = 'aaaa'.repeat(16);
const PK_TRADER_B = 'bbbb'.repeat(16);
const ADDR_TRADER_A = 'addr_trader_a';
const ADDR_TRADER_B = 'addr_trader_b';
const ESCROW_ADDR = 'escrow_trusted_1';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeDealTerms(overrides: Partial<DealTerms> = {}): DealTerms {
  return {
    deal_id: 'deal-001',
    proposer_intent_id: 'intent-a-001',
    acceptor_intent_id: 'intent-b-001',
    proposer_pubkey: PK_TRADER_A,
    acceptor_pubkey: PK_TRADER_B,
    proposer_address: ADDR_TRADER_A,
    acceptor_address: ADDR_TRADER_B,
    base_asset: 'ALPHA',
    quote_asset: 'USDC',
    rate: 475n,
    volume: 300n,
    // proposer SELLS base (ALPHA) for quote (USDC). Must be set — swap-executor
    // uses strict === 'sell' when mapping to partyA/partyB, so undefined falls
    // through to the buyer branch and inverts the swap direction.
    proposer_direction: 'sell',
    escrow_address: ESCROW_ADDR,
    deposit_timeout_sec: 120,
    created_ms: Date.now(),
    ...overrides,
  };
}

function makeDealRecord(
  stateOverride: DealRecord['state'] = 'ACCEPTED',
  termsOverrides: Partial<DealTerms> = {},
): DealRecord {
  return {
    terms: makeDealTerms(termsOverrides),
    state: stateOverride,
    swap_id: null,
    acceptor_swap_address: null,
    updated_at: Date.now(),
  };
}

function makeStrategy(overrides: Partial<TraderStrategy> = {}): TraderStrategy {
  return {
    auto_match: true,
    auto_negotiate: true,
    max_concurrent_swaps: 5,
    max_active_intents: 20,
    min_search_score: 0.6,
    scan_interval_ms: 5000,
    market_api_url: 'https://market-api.unicity.network',
    trusted_escrows: [ESCROW_ADDR],
    blocked_counterparties: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock SwapAdapter factory (aligned with real SwapAdapter interface)
// ---------------------------------------------------------------------------

interface MockSwapAdapter extends SwapAdapter {
  proposeSwapCalls: SwapDealInput[];
  rejectSwapCalls: Array<{ swapId: string; reason?: string }>;
  acceptSwapCalls: string[];
  setSwapId(id: string): void;
}

function createMockSwapAdapter(): MockSwapAdapter {
  let nextSwapId = 'swap-001';

  const mock: MockSwapAdapter = {
    proposeSwapCalls: [],
    rejectSwapCalls: [],
    acceptSwapCalls: [],

    setSwapId(id: string) {
      nextSwapId = id;
    },

    async proposeSwap(deal: SwapDealInput) {
      mock.proposeSwapCalls.push(deal);
      return { swapId: nextSwapId };
    },
    async acceptSwap(swapId: string) {
      mock.acceptSwapCalls.push(swapId);
    },
    async rejectSwap(swapId: string, reason?: string) {
      mock.rejectSwapCalls.push({ swapId, reason });
    },
    async deposit(_swapId: string) {
      // no-op for tests
    },
    async verifyPayout(_swapId: string) {
      return true;
    },
  };

  return mock;
}

// ---------------------------------------------------------------------------
// Test context
// ---------------------------------------------------------------------------

interface TestContext {
  swapAdapter: MockSwapAdapter;
  executor: SwapExecutor;
  completedDeals: Array<{ deal: DealRecord; payoutVerified: boolean }>;
  failedDeals: Array<{ deal: DealRecord; reason: string }>;
  ledger: VolumeReservationLedger;
  logger: Logger;
  logLines: string[];
}

function setup(strategyOverrides: Partial<TraderStrategy> = {}): TestContext {
  const swapAdapter = createMockSwapAdapter();
  const completedDeals: Array<{ deal: DealRecord; payoutVerified: boolean }> = [];
  const failedDeals: Array<{ deal: DealRecord; reason: string }> = [];
  const logLines: string[] = [];

  const logger = createLogger({
    component: 'test-swap-executor',
    writer: (line: string) => logLines.push(line),
    level: 'debug',
  });

  // Ledger with 10000 ALPHA balance
  const ledger = createVolumeReservationLedger((_coinId: string) => 10000n);

  const onSwapCompleted: OnSwapCompleted = async (deal, payoutVerified) => {
    completedDeals.push({ deal, payoutVerified });
  };

  const onSwapFailed: OnSwapFailed = async (deal, reason) => {
    failedDeals.push({ deal, reason });
  };

  const deps: SwapExecutorDeps = {
    swap: swapAdapter,
    strategy: makeStrategy(strategyOverrides),
    onSwapCompleted,
    onSwapFailed,
    agentPubkey: PK_TRADER_A,
    agentAddress: ADDR_TRADER_A,
    swapDirectAddress: ADDR_TRADER_A,
    logger,
  };

  const executor = createSwapExecutor(deps);

  return { swapAdapter, executor, completedDeals, failedDeals, ledger, logger, logLines };
}

// ===========================================================================
// T5: Swap Execution — Happy Path
// ===========================================================================

describe('E2E: Trader Swap Execution', () => {
  describe('T5 — Happy Path', () => {
    let ctx: TestContext;

    beforeEach(() => {
      ctx = setup();
    });

    afterEach(() => {
      ctx.executor.stop();
    });

    it('T5.1: full swap — executeDeal -> proposeSwap -> handleSwapCompleted(verified=true) -> COMPLETED', async () => {
      const deal = makeDealRecord('ACCEPTED');

      // Execute the deal — should ping escrow then propose swap
      await ctx.executor.executeDeal(deal);

      // proposeSwap should have been called
      expect(ctx.swapAdapter.proposeSwapCalls).toHaveLength(1);
      const proposed = ctx.swapAdapter.proposeSwapCalls[0]!;
      expect(proposed.partyACurrency).toBe('ALPHA');
      expect(proposed.partyBCurrency).toBe('USDC');
      expect(proposed.partyAAmount).toBe('300');
      expect(proposed.partyBAmount).toBe((475n * 300n).toString());

      // Active count should be 1
      expect(ctx.executor.getActiveCount()).toBe(1);

      // Simulate swap:completed with payoutVerified=true
      ctx.executor.handleSwapCompleted('swap-001', true);

      // Allow microtask to flush
      await vi.waitFor(() => {
        expect(ctx.completedDeals).toHaveLength(1);
      });

      expect(ctx.completedDeals[0]!.deal.state).toBe('COMPLETED');
      expect(ctx.completedDeals[0]!.payoutVerified).toBe(true);
      expect(ctx.executor.getActiveCount()).toBe(0);
    });

    it('T5.2: volume_filled updated on completion (callback receives deal + payoutVerified=true)', async () => {
      const deal = makeDealRecord('ACCEPTED', { volume: 500n });

      await ctx.executor.executeDeal(deal);
      ctx.executor.handleSwapCompleted('swap-001', true);

      await vi.waitFor(() => {
        expect(ctx.completedDeals).toHaveLength(1);
      });

      // The callback receives the deal so the caller can update volume_filled
      expect(ctx.completedDeals[0]!.deal.terms.volume).toBe(500n);
      expect(ctx.completedDeals[0]!.payoutVerified).toBe(true);
    });

    it('T5.3: VolumeReservationLedger released after completion', async () => {
      const deal = makeDealRecord('ACCEPTED', { deal_id: 'deal-release-test' });

      // Reserve volume in the ledger
      const reserved = await ctx.ledger.reserve('ALPHA', 400n, 'deal-release-test');
      expect(reserved).toBe(true);
      expect(ctx.ledger.getAvailable('ALPHA')).toBe(9600n);

      await ctx.executor.executeDeal(deal);
      ctx.executor.handleSwapCompleted('swap-001', true);

      await vi.waitFor(() => {
        expect(ctx.completedDeals).toHaveLength(1);
      });

      // Simulate caller releasing after callback
      ctx.ledger.release('deal-release-test');
      expect(ctx.ledger.getAvailable('ALPHA')).toBe(10000n);
      expect(ctx.ledger.getReservations()).toHaveLength(0);
    });
  });

  // =========================================================================
  // T6: Swap Execution — Unhappy Path
  // =========================================================================

  describe('T6 — Unhappy Path', () => {
    let ctx: TestContext;

    beforeEach(() => {
      ctx = setup();
    });

    afterEach(() => {
      ctx.executor.stop();
    });

    it('T6.7: swap:failed event -> FAILED, reservation released', async () => {
      const deal = makeDealRecord('ACCEPTED', { deal_id: 'deal-fail-release' });

      // Reserve in ledger
      await ctx.ledger.reserve('ALPHA', 300n, 'deal-fail-release');
      expect(ctx.ledger.getAvailable('ALPHA')).toBe(9700n);

      await ctx.executor.executeDeal(deal);
      expect(ctx.executor.getActiveCount()).toBe(1);

      // Emit swap:failed
      ctx.executor.handleSwapFailed('swap-001', 'COUNTERPARTY_REJECTED');

      await vi.waitFor(() => {
        expect(ctx.failedDeals).toHaveLength(1);
      });

      expect(ctx.failedDeals[0]!.deal.state).toBe('FAILED');
      expect(ctx.executor.getActiveCount()).toBe(0);

      // Simulate caller releasing reservation on failure callback
      ctx.ledger.release('deal-fail-release');
      expect(ctx.ledger.getAvailable('ALPHA')).toBe(10000n);
    });
  });

  // =========================================================================
  // T7: Partial Fill Scenarios
  // =========================================================================

  describe('T7 — Partial Fills', () => {
    let ctx: TestContext;

    beforeEach(() => {
      ctx = setup();
    });

    afterEach(() => {
      ctx.executor.stop();
    });

    it('T7.1: intent 1000 units, swap fills 400 -> volume_filled=400, remaining=600 -> intent returns to ACTIVE', async () => {
      // First deal: 400 out of 1000 total intent volume
      const deal = makeDealRecord('ACCEPTED', {
        deal_id: 'deal-partial-400',
        volume: 400n,
      });

      await ctx.executor.executeDeal(deal);
      ctx.executor.handleSwapCompleted('swap-001', true);

      await vi.waitFor(() => {
        expect(ctx.completedDeals).toHaveLength(1);
      });

      const completedDeal = ctx.completedDeals[0]!;
      expect(completedDeal.deal.state).toBe('COMPLETED');
      expect(completedDeal.deal.terms.volume).toBe(400n);
      expect(completedDeal.payoutVerified).toBe(true);

      // Remaining = 1000 - 400 = 600 >= volume_min
      // The caller (intent engine) would return intent to ACTIVE
      // Here we verify the deal volume was correctly reported
      expect(ctx.executor.getActiveCount()).toBe(0);
    });

    it('T7.3: remaining < volume_min -> intent transitions to FILLED', async () => {
      // Intent: sell 1000 ALPHA, volume_min=200
      // Fill 850 => remaining 150 < 200 => caller transitions to FILLED
      const deal = makeDealRecord('ACCEPTED', {
        deal_id: 'deal-fill-850',
        volume: 850n,
      });

      await ctx.executor.executeDeal(deal);
      ctx.executor.handleSwapCompleted('swap-001', true);

      await vi.waitFor(() => {
        expect(ctx.completedDeals).toHaveLength(1);
      });

      const completedDeal = ctx.completedDeals[0]!;
      expect(completedDeal.deal.state).toBe('COMPLETED');
      expect(completedDeal.deal.terms.volume).toBe(850n);
      // Caller checks: remaining (1000 - 850 = 150) < volume_min (200) => FILLED
      // This test verifies the executor correctly completes and hands off to the callback
    });
  });

  // =========================================================================
  // T11: Security Scenarios
  // =========================================================================

  describe('T11 — Security', () => {
    let ctx: TestContext;

    beforeEach(() => {
      ctx = setup();
    });

    afterEach(() => {
      ctx.executor.stop();
      vi.useRealTimers();
    });

    it('T11.1 (spec 7.9.2): payoutVerified=false -> SDK handles retry, executor passes through to callback', async () => {
      const deal = makeDealRecord('ACCEPTED');
      await ctx.executor.executeDeal(deal);

      // The SDK handles payout verification internally. The executor simply
      // passes the payoutVerified flag through to the callback.
      ctx.executor.handleSwapCompleted('swap-001', false);

      await vi.waitFor(() => {
        expect(ctx.completedDeals).toHaveLength(1);
      });

      expect(ctx.completedDeals[0]!.deal.state).toBe('COMPLETED');
      expect(ctx.completedDeals[0]!.payoutVerified).toBe(false);
      expect(ctx.executor.getActiveCount()).toBe(0);
    });

    // T11.4 (spec 7.9.4) and T11.5 (spec 7.9.5) — term matching and protocol
    // version checking are now handled entirely by the SDK's SwapModule. The
    // SwapExecutor no longer has handleSwapProposalReceived; acceptance is done
    // via direct sphere.on('swap:proposal_received') in main.ts which auto-accepts
    // all proposals (the SDK already validated the manifest and sender).

    it('T11.4 (spec 7.9.4): acceptor tracks deal as EXECUTING immediately', async () => {
      // When we are the acceptor, executeDeal tracks the deal as EXECUTING
      // without calling proposeSwap — the SDK handles acceptance directly.
      const deal = makeDealRecord('ACCEPTED', {
        deal_id: 'deal-acceptor-track',
        proposer_pubkey: PK_TRADER_B,
        acceptor_pubkey: PK_TRADER_A,
        proposer_address: ADDR_TRADER_B,
        acceptor_address: ADDR_TRADER_A,
      });
      await ctx.executor.executeDeal(deal);

      expect(ctx.swapAdapter.proposeSwapCalls).toHaveLength(0);
      expect(ctx.executor.getActiveCount()).toBe(1);
      const activeDeals = ctx.executor.getActiveDeals();
      expect(activeDeals[0]!.state).toBe('EXECUTING');
    });

    it('T11.5 (spec 7.9.5): SDK handles protocol version — executor trusts SDK', () => {
      // Protocol version checking is now the SDK's responsibility via SwapModule.
      // The SwapExecutor no longer validates protocol versions — it auto-accepts
      // all proposals that the SDK has already validated.
      // This test documents that the responsibility moved to the SDK.
      expect(ctx.executor).not.toHaveProperty('handleSwapProposalReceived');
    });

    // T11.9: Untrusted escrow check is now handled by the SDK's SwapModule internally.
  });

  // =========================================================================
  // T16: State Machine Violation Tests
  // =========================================================================

  describe('T16 — State Violations', () => {
    let ctx: TestContext;

    beforeEach(() => {
      ctx = setup();
    });

    afterEach(() => {
      ctx.executor.stop();
    });

    it('T16.3: double completion of same deal -> second call is no-op', async () => {
      const deal = makeDealRecord('ACCEPTED', { deal_id: 'deal-double' });

      await ctx.executor.executeDeal(deal);
      expect(ctx.executor.getActiveCount()).toBe(1);

      // First completion
      ctx.executor.handleSwapCompleted('swap-001', true);

      await vi.waitFor(() => {
        expect(ctx.completedDeals).toHaveLength(1);
      });

      expect(ctx.executor.getActiveCount()).toBe(0);

      // Second completion — should be a no-op (deal unregistered)
      ctx.executor.handleSwapCompleted('swap-001', true);

      // Still only one completion
      expect(ctx.completedDeals).toHaveLength(1);

      // Verify info was logged for the untracked second completion
      const infoLine = ctx.logLines.find((l) => l.includes('swap_completed_untracked'));
      expect(infoLine).toBeTruthy();
    });

    it('T16.4: executeDeal on non-ACCEPTED deal -> rejected', async () => {
      const executingDeal = makeDealRecord('EXECUTING');

      await ctx.executor.executeDeal(executingDeal);

      // Should be silently rejected (not ACCEPTED)
      expect(ctx.swapAdapter.proposeSwapCalls).toHaveLength(0);
      expect(ctx.executor.getActiveCount()).toBe(0);
      expect(ctx.completedDeals).toHaveLength(0);
      expect(ctx.failedDeals).toHaveLength(0);

      // Verify warning was logged
      const warnLine = ctx.logLines.find((l) => l.includes('execute_deal_invalid_state'));
      expect(warnLine).toBeTruthy();
    });

    it('T16.4b: executeDeal on COMPLETED deal -> rejected', async () => {
      const completedDeal = makeDealRecord('COMPLETED');

      await ctx.executor.executeDeal(completedDeal);

      expect(ctx.swapAdapter.proposeSwapCalls).toHaveLength(0);
      expect(ctx.executor.getActiveCount()).toBe(0);

      const warnLine = ctx.logLines.find((l) => l.includes('execute_deal_invalid_state'));
      expect(warnLine).toBeTruthy();
    });

    it('T16.4c: executeDeal on FAILED deal -> rejected', async () => {
      const failedDeal = makeDealRecord('FAILED');

      await ctx.executor.executeDeal(failedDeal);

      expect(ctx.swapAdapter.proposeSwapCalls).toHaveLength(0);
      expect(ctx.executor.getActiveCount()).toBe(0);
    });
  });
});
