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

  // =========================================================================
  // Round-5 audit fixes — registerSwapId escrow term-binding (H1, N2,
  // CRITICAL wildcard skip) + EXECUTION_TIMEOUT rejectSwap (C3, N4)
  // =========================================================================

  describe('registerSwapId() — escrow term-binding (round-5 audit)', () => {
    const ESCROW_DIRECT = 'DIRECT://' + 'e'.repeat(64);
    const ESCROW_PUBKEY = 'e'.repeat(64);
    const PROPOSER_PUBKEY = 'b'.repeat(64);

    async function trackAcceptorDealWithEscrow(escrowAddr: string): Promise<DealRecord> {
      const deal = makeDealRecord({
        terms: {
          proposer_pubkey: PROPOSER_PUBKEY,
          acceptor_pubkey: AGENT_PUBKEY,
          escrow_address: escrowAddr,
        },
      });
      await executor.executeDeal(deal);
      return deal;
    }

    it('CRITICAL — accepts proposal when negotiated escrow is "any" (wildcard)', async () => {
      // The default escrow on intents is the wildcard sentinel 'any'.
      // The trusted_escrows allowlist already enforced policy at NP-0
      // negotiation time; the SDK-level binding should NOT reject the
      // legitimate default-escrow flow.
      await trackAcceptorDealWithEscrow('any');
      const result = executor.registerSwapId('swap-1', {
        partyACurrency: 'ALPHA',
        partyAAmount: '10',
        partyBCurrency: 'USDC',
        partyBAmount: '500',
        counterpartyPubkey: PROPOSER_PUBKEY,
        escrowDirectAddress: ESCROW_DIRECT,
        escrowPubkey: ESCROW_PUBKEY,
      });
      expect(result).toBe(true);
    });

    it('CRITICAL — accepts proposal when negotiated escrow is a nametag (@…)', async () => {
      await trackAcceptorDealWithEscrow('@trusted-escrow');
      const result = executor.registerSwapId('swap-2', {
        partyACurrency: 'ALPHA',
        partyAAmount: '10',
        partyBCurrency: 'USDC',
        partyBAmount: '500',
        counterpartyPubkey: PROPOSER_PUBKEY,
        escrowDirectAddress: ESCROW_DIRECT,
        escrowPubkey: ESCROW_PUBKEY,
      });
      expect(result).toBe(true);
    });

    it('H1 — rejects proposal when concrete escrow does NOT match negotiated', async () => {
      await trackAcceptorDealWithEscrow(ESCROW_DIRECT);
      const result = executor.registerSwapId('swap-3', {
        partyACurrency: 'ALPHA',
        partyAAmount: '10',
        partyBCurrency: 'USDC',
        partyBAmount: '500',
        counterpartyPubkey: PROPOSER_PUBKEY,
        escrowDirectAddress: 'DIRECT://' + 'f'.repeat(64), // ROGUE
        escrowPubkey: 'f'.repeat(64),
      });
      expect(result).toBe(false);
    });

    it('N2 — rejects when escrowDirectAddress matches but escrowPubkey is wrong', async () => {
      // Counterparty spoofs ONE field. Round-5 requires BOTH to match
      // when both supplied (was OR before — ship-blocker fix N2).
      await trackAcceptorDealWithEscrow(ESCROW_DIRECT);
      const result = executor.registerSwapId('swap-4', {
        partyACurrency: 'ALPHA',
        partyAAmount: '10',
        partyBCurrency: 'USDC',
        partyBAmount: '500',
        counterpartyPubkey: PROPOSER_PUBKEY,
        escrowDirectAddress: ESCROW_DIRECT,
        escrowPubkey: 'f'.repeat(64), // SPOOF
      });
      expect(result).toBe(false);
    });

    it('H1 — rejects on deposit_timeout_sec mismatch', async () => {
      const deal = makeDealRecord({
        terms: {
          proposer_pubkey: PROPOSER_PUBKEY,
          acceptor_pubkey: AGENT_PUBKEY,
          escrow_address: ESCROW_DIRECT,
          deposit_timeout_sec: 60,
        },
      });
      await executor.executeDeal(deal);
      const result = executor.registerSwapId('swap-5', {
        partyACurrency: 'ALPHA',
        partyAAmount: '10',
        partyBCurrency: 'USDC',
        partyBAmount: '500',
        counterpartyPubkey: PROPOSER_PUBKEY,
        escrowDirectAddress: ESCROW_DIRECT,
        escrowPubkey: ESCROW_PUBKEY,
        depositTimeoutSec: 300, // negotiated was 60
      });
      expect(result).toBe(false);
    });
  });

  describe('updateStrategy() — runtime strategy propagation (C1)', () => {
    it('updates max_concurrent_swaps so subsequent executeDeal sees the new cap', async () => {
      // Default deps.strategy.max_concurrent_swaps = 5; bring it to 1 so
      // the 2nd executeDeal returns early.
      executor.updateStrategy({ ...deps.strategy, max_concurrent_swaps: 1 });
      const d1 = makeDealRecord({
        terms: { deal_id: 'd-1', proposer_intent_id: 'i-1' },
      });
      const d2 = makeDealRecord({
        terms: { deal_id: 'd-2', proposer_intent_id: 'i-2' },
      });
      await executor.executeDeal(d1);
      await executor.executeDeal(d2);
      // Only the first one progressed.
      expect(executor.getActiveCount()).toBe(1);
    });
  });
});
