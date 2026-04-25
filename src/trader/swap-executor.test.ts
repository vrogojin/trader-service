import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createSwapExecutor,
  buildSwapDealInput,
  type SwapAdapter,
  type SwapDealInput,
  type SwapExecutor,
  type SwapExecutorDeps,
} from './swap-executor.js';
import type { DealRecord, DealTerms, TraderStrategy, DealState } from './types.js';
import type { Logger } from '../shared/logger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => makeLogger()),
    setLevel: vi.fn(),
  };
}

function makeSwapAdapter(overrides?: Partial<SwapAdapter>): SwapAdapter {
  return {
    proposeSwap: vi.fn().mockResolvedValue({ swapId: 'swap-1' }),
    acceptSwap: vi.fn().mockResolvedValue(undefined),
    rejectSwap: vi.fn().mockResolvedValue(undefined),
    deposit: vi.fn().mockResolvedValue(undefined),
    verifyPayout: vi.fn().mockResolvedValue(true),
    waitForPendingOperations: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// Valid 64-char x-only hex — pubkeysEqual requires valid secp256k1 format.
const AGENT_PUBKEY = 'a'.repeat(64);
const AGENT_ADDRESS = 'agent-addr-1';

function makeStrategy(overrides?: Partial<TraderStrategy>): TraderStrategy {
  return {
    auto_match: true,
    auto_negotiate: true,
    max_concurrent_swaps: 3,
    max_active_intents: 20,
    min_search_score: 0.6,
    scan_interval_ms: 5000,
    market_api_url: 'https://market.example',
    trusted_escrows: [],
    blocked_counterparties: [],
    ...overrides,
  };
}

function makeDealTerms(overrides?: Partial<DealTerms>): DealTerms {
  return {
    deal_id: 'deal-1',
    proposer_intent_id: 'intent-p',
    acceptor_intent_id: 'intent-a',
    proposer_pubkey: AGENT_PUBKEY,
    acceptor_pubkey: 'b'.repeat(64),
    proposer_address: AGENT_ADDRESS,
    acceptor_address: 'counterparty-addr',
    base_asset: 'ALPHA',
    quote_asset: 'USDC',
    rate: 50n as unknown as bigint,
    volume: 10n as unknown as bigint,
    proposer_direction: 'sell',
    escrow_address: 'escrow-1',
    deposit_timeout_sec: 300,
    created_ms: Date.now(),
    ...overrides,
  };
}

function makeDealRecord(
  overrides?: Omit<Partial<DealRecord>, 'terms'> & { terms?: Partial<DealTerms>; state?: DealState },
): DealRecord {
  const { terms: termOverrides, ...rest } = overrides ?? {};
  return {
    terms: makeDealTerms(termOverrides),
    state: 'ACCEPTED',
    swap_id: null,
    acceptor_swap_address: null,
    updated_at: Date.now(),
    ...rest,
  };
}

function makeDeps(overrides?: Partial<SwapExecutorDeps>): SwapExecutorDeps {
  return {
    swap: makeSwapAdapter(),
    strategy: makeStrategy(),
    onSwapCompleted: vi.fn().mockResolvedValue(undefined),
    onSwapFailed: vi.fn().mockResolvedValue(undefined),
    agentPubkey: AGENT_PUBKEY,
    agentAddress: AGENT_ADDRESS,
    swapDirectAddress: AGENT_ADDRESS,
    payments: { receive: vi.fn().mockResolvedValue(undefined) },
    logger: makeLogger(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SwapExecutor', () => {
  let deps: SwapExecutorDeps;
  let executor: SwapExecutor;

  beforeEach(() => {
    deps = makeDeps();
    executor = createSwapExecutor(deps);
  });

  afterEach(() => {
    executor.stop();
  });

  // =========================================================================
  // 1. executeDeal()
  // =========================================================================

  describe('executeDeal()', () => {
    it('constructs correct SwapDealInput from DealTerms', async () => {
      const deal = makeDealRecord();
      await executor.executeDeal(deal);

      const expectedInput: SwapDealInput = {
        partyA: AGENT_ADDRESS,
        partyB: 'counterparty-addr',
        partyACurrency: 'ALPHA',
        partyAAmount: '10',
        partyBCurrency: 'USDC',
        partyBAmount: '500',
        timeout: 300,
        escrowAddress: 'escrow-1',
      };

      expect(deps.swap.proposeSwap).toHaveBeenCalledWith(expectedInput);
    });

    it('transitions deal to EXECUTING', async () => {
      const deal = makeDealRecord();
      await executor.executeDeal(deal);

      expect(executor.getActiveCount()).toBe(1);
      expect(deps.logger.info).toHaveBeenCalledWith(
        'deal_executing',
        expect.objectContaining({ deal_id: 'deal-1', swap_id: 'swap-1' }),
      );
    });

    it('returns early when max_concurrent_swaps reached', async () => {
      deps = makeDeps({ strategy: makeStrategy({ max_concurrent_swaps: 1 }) });
      executor = createSwapExecutor(deps);

      await executor.executeDeal(makeDealRecord({ terms: { deal_id: 'deal-1' } }));
      await executor.executeDeal(makeDealRecord({ terms: { deal_id: 'deal-2' } }));

      expect(executor.getActiveCount()).toBe(1);
      expect(deps.swap.proposeSwap).toHaveBeenCalledTimes(1);
    });

    it('transitions to FAILED when proposeSwap throws', async () => {
      const swapAdapter = makeSwapAdapter({
        proposeSwap: vi.fn().mockRejectedValue(new Error('sdk error')),
      });
      deps = makeDeps({ swap: swapAdapter });
      executor = createSwapExecutor(deps);

      const deal = makeDealRecord();
      await executor.executeDeal(deal);

      expect(deps.onSwapFailed).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'FAILED' }),
        expect.stringContaining('PROPOSE_SWAP_FAILED'),
      );
    });

    it('acceptor tracks deal as EXECUTING (does not call proposeSwap)', async () => {
      // We are the acceptor: proposer_pubkey !== agentPubkey
      const deal = makeDealRecord({
        terms: {
          proposer_pubkey: 'b'.repeat(64),
          acceptor_pubkey: AGENT_PUBKEY,
        },
      });
      await executor.executeDeal(deal);

      expect(deps.swap.proposeSwap).not.toHaveBeenCalled();
      expect(executor.getActiveCount()).toBe(1);
      // Acceptor should be tracked as EXECUTING (SDK handles acceptance via sphere.on)
      const activeDeals = executor.getActiveDeals();
      expect(activeDeals[0]!.state).toBe('EXECUTING');
    });
  });

  // =========================================================================
  // 2. buildSwapDealInput() utility
  // =========================================================================

  describe('buildSwapDealInput()', () => {
    it('builds correct input for proposer', () => {
      const deal = makeDealRecord();
      const input = buildSwapDealInput(deal, AGENT_PUBKEY, AGENT_ADDRESS);

      expect(input).toEqual({
        partyA: AGENT_ADDRESS,
        partyB: 'counterparty-addr',
        partyACurrency: 'ALPHA',
        partyAAmount: '10',
        partyBCurrency: 'USDC',
        partyBAmount: '500',
        timeout: 300,
        escrowAddress: 'escrow-1',
      });
    });

    it('builds correct input for acceptor', () => {
      const deal = makeDealRecord();
      const input = buildSwapDealInput(deal, 'b'.repeat(64), 'counterparty-addr');

      expect(input).toEqual({
        partyA: AGENT_ADDRESS,
        partyB: 'counterparty-addr',
        partyACurrency: 'ALPHA',
        partyAAmount: '10',
        partyBCurrency: 'USDC',
        partyBAmount: '500',
        timeout: 300,
        escrowAddress: 'escrow-1',
      });
    });
  });

  // =========================================================================
  // 3. handleSwapCompleted()
  // =========================================================================

  describe('handleSwapCompleted()', () => {
    it('with payoutVerified=true: transitions to COMPLETED and calls onSwapCompleted(deal, true)', async () => {
      const deal = makeDealRecord();
      await executor.executeDeal(deal);

      executor.handleSwapCompleted('swap-1', true);

      await vi.waitFor(() => {
        expect(deps.onSwapCompleted).toHaveBeenCalledWith(
          expect.objectContaining({ state: 'COMPLETED' }),
          true,
        );
      });
      expect(executor.getActiveCount()).toBe(0);
    });

    it('with payoutVerified=false: transitions to COMPLETED and calls onSwapCompleted(deal, false)', async () => {
      const deal = makeDealRecord();
      await executor.executeDeal(deal);

      executor.handleSwapCompleted('swap-1', false);

      await vi.waitFor(() => {
        expect(deps.onSwapCompleted).toHaveBeenCalledWith(
          expect.objectContaining({ state: 'COMPLETED' }),
          false,
        );
      });
      expect(executor.getActiveCount()).toBe(0);
    });

    it('logs info for untracked swapId (acceptor path)', () => {
      executor.handleSwapCompleted('unknown-swap', true);

      expect(deps.logger.info).toHaveBeenCalledWith(
        'swap_completed_untracked',
        expect.objectContaining({ swap_id: 'unknown-swap' }),
      );
    });
  });

  // =========================================================================
  // 4. handleSwapFailed()
  // =========================================================================

  describe('handleSwapFailed()', () => {
    it('transitions to FAILED and calls onSwapFailed', async () => {
      const deal = makeDealRecord();
      await executor.executeDeal(deal);

      executor.handleSwapFailed('swap-1', 'DEPOSIT_TIMEOUT');

      await vi.waitFor(() => {
        expect(deps.onSwapFailed).toHaveBeenCalledWith(
          expect.objectContaining({ state: 'FAILED' }),
          'DEPOSIT_TIMEOUT',
        );
      });
      expect(executor.getActiveCount()).toBe(0);
    });

    it('logs info for untracked swapId', () => {
      executor.handleSwapFailed('unknown-swap', 'TIMEOUT');

      expect(deps.logger.info).toHaveBeenCalledWith(
        'swap_failed_untracked',
        expect.objectContaining({ swap_id: 'unknown-swap' }),
      );
    });
  });

  // =========================================================================
  // 5. stop()
  // =========================================================================

  describe('stop()', () => {
    it('clears all active deals', async () => {
      deps = makeDeps();
      executor = createSwapExecutor(deps);

      await executor.executeDeal(makeDealRecord({ terms: { deal_id: 'deal-a' } }));
      await executor.executeDeal(
        makeDealRecord({
          terms: { deal_id: 'deal-b' },
        }),
      );

      expect(executor.getActiveCount()).toBe(2);

      executor.stop();

      expect(executor.getActiveCount()).toBe(0);
    });
  });
});
