/**
 * E2E: Trader Intent Lifecycle (T1) and ACP Command Validation (T10).
 *
 * Exercises the full trader agent through the TraderCommandHandler,
 * covering intent creation, cancellation, expiry, filtering, and
 * validation of invalid ACP command parameters.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

import type { TraderStrategy } from '../../src/trader/types.js';
import { DEFAULT_STRATEGY } from '../../src/trader/types.js';
import { createMockMarketModule, type MockMarketModule } from '../mocks/mock-market-module.js';
import { createMockPaymentsModule, type MockPaymentsModule } from '../mocks/mock-payments-module.js';
import { createMockSwapModule, type MockSwapModule } from '../mocks/mock-swap-module.js';
import { createMockCommsModule, type MockCommsModule } from '../mocks/mock-communications-module.js';
import { createLogger } from '../../src/shared/logger.js';
import type { Logger } from '../../src/shared/logger.js';
import { createTraderCommandHandler } from '../../src/trader/trader-command-handler.js';
import { createIntentEngine, type IntentEngine } from '../../src/trader/intent-engine.js';
import { createNegotiationHandler, type NegotiationHandler } from '../../src/trader/negotiation-handler.js';
import { createSwapExecutor, type SwapExecutor } from '../../src/trader/swap-executor.js';
import { createVolumeReservationLedger, type VolumeReservationLedger } from '../../src/trader/volume-reservation-ledger.js';
import { createCommandHandler } from '../../src/tenant/command-handler.js';
import type { CommandHandler } from '../../src/tenant/command-handler.js';
import type { AcpResultPayload, AcpErrorPayload } from '../../src/protocols/acp.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AGENT_PUBKEY = '02aaaa00000000000000000000000000000000000000000000000000000000aa01';
const AGENT_ADDRESS = 'trader_agent_addr_000000000001';
// Manager pubkey available for future multi-agent tests

// ---------------------------------------------------------------------------
// Setup helper
// ---------------------------------------------------------------------------

interface TraderE2EContext {
  handler: CommandHandler;
  intentEngine: IntentEngine;
  negotiationHandler: NegotiationHandler;
  swapExecutor: SwapExecutor;
  ledger: VolumeReservationLedger;
  market: MockMarketModule;
  payments: MockPaymentsModule;
  swap: MockSwapModule;
  comms: MockCommsModule;
  logger: Logger;
  strategy: TraderStrategy;
}

function setupTraderE2E(opts?: {
  strategy?: Partial<TraderStrategy>;
  balance?: Record<string, bigint>;
}): TraderE2EContext {
  const market = createMockMarketModule();
  const payments = createMockPaymentsModule();
  const swap = createMockSwapModule();
  const comms = createMockCommsModule();

  // Set up balances
  if (opts?.balance) {
    for (const [coinId, amount] of Object.entries(opts.balance)) {
      payments.setBalance(coinId, amount);
    }
  }

  const strategy: TraderStrategy = { ...DEFAULT_STRATEGY, ...opts?.strategy };

  const logger = createLogger({
    component: 'trader-e2e-test',
    writer: () => { /* suppress output */ },
    level: 'debug',
  });

  const getBalance = (coinId: string): bigint => payments.getConfirmedBalance(coinId);
  const ledger = createVolumeReservationLedger(getBalance);

  const signMessage = (msg: string): string => `sig_${msg.slice(0, 16)}`;
  const verifySignature = (_sig: string, _msg: string, _pk: string): boolean => true;

  // Build IntentEngine
  const intentEngine = createIntentEngine({
    market,
    ledger,
    strategy,
    agentPubkey: AGENT_PUBKEY,
    agentAddress: AGENT_ADDRESS,
    signMessage,
    onMatchFound: async () => { /* no-op for intent lifecycle tests */ },
    logger: logger.child({ component: 'intent-engine' }),
  });

  // Build NegotiationHandler
  const negotiationHandler = createNegotiationHandler({
    sendDm: comms.sendDm.bind(comms),
    signMessage,
    verifySignature,
    onDealAccepted: async () => { /* no-op */ },
    onDealCancelled: () => { /* no-op */ },
    agentPubkey: AGENT_PUBKEY,
    agentAddress: AGENT_ADDRESS,
    logger: logger.child({ component: 'negotiation-handler' }),
  });

  // Build SwapExecutor
  const swapExecutor = createSwapExecutor({
    swap: swap as unknown as import('../../src/trader/swap-executor.js').SwapAdapter,
    strategy,
    onSwapCompleted: async () => { /* no-op */ },
    onSwapFailed: async () => { /* no-op */ },
    agentPubkey: AGENT_PUBKEY,
    agentAddress: AGENT_ADDRESS,
    swapDirectAddress: AGENT_ADDRESS,
    logger: logger.child({ component: 'swap-executor' }),
  });

  // Build base command handler
  const baseHandler = createCommandHandler(
    'test-instance-001',
    'test-trader',
    Date.now(),
    logger.child({ component: 'command-handler' }),
  );

  // Mutable strategy holder for saveStrategy
  let currentStrategy = { ...strategy };

  // Build TraderCommandHandler
  const handler = createTraderCommandHandler({
    baseHandler,
    intentEngine,
    negotiationHandler,
    swapExecutor,
    ledger,
    payments,
    strategy: currentStrategy,
    agentPubkey: AGENT_PUBKEY,
    agentAddress: AGENT_ADDRESS,
    saveStrategy: async (s: TraderStrategy) => { currentStrategy = s; },
    withdraw: async (params) => {
      const transferId = `txn_test_${params.asset}`;
      const remaining = payments.getConfirmedBalance(params.asset) - BigInt(params.amount);
      return { transfer_id: transferId, remaining_balance: remaining < 0n ? 0n : remaining };
    },
    logger,
  });

  return {
    handler,
    intentEngine,
    negotiationHandler,
    swapExecutor,
    ledger,
    market,
    payments,
    swap,
    comms,
    logger,
    strategy: currentStrategy,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validCreateIntentParams(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    command_id: 'cmd-001',
    direction: 'sell',
    base_asset: 'ALPHA',
    quote_asset: 'USDC',
    rate_min: '450',
    rate_max: '500',
    volume_min: '100',
    volume_max: '1000',
    expiry_sec: 86400,
    ...overrides,
  };
}

function isOk(result: AcpResultPayload | AcpErrorPayload): result is AcpResultPayload {
  return result.ok === true;
}

function isError(result: AcpResultPayload | AcpErrorPayload): result is AcpErrorPayload {
  return result.ok === false;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('E2E: Trader Intent Lifecycle (T1 + T10)', () => {
  let ctx: TraderE2EContext;

  afterEach(() => {
    ctx?.intentEngine?.stop();
    ctx?.negotiationHandler?.stop();
    ctx?.swapExecutor?.stop();
  });

  // =========================================================================
  // T1: Intent Lifecycle (Happy Path)
  // =========================================================================

  describe('T1: Intent Lifecycle', () => {
    it('T1.1: should create intent and publish to MarketModule via postIntent()', async () => {
      ctx = setupTraderE2E({ balance: { ALPHA: 1000n } });

      const result = await ctx.handler.execute('CREATE_INTENT', validCreateIntentParams());

      expect(isOk(result)).toBe(true);
      if (!isOk(result)) return;

      const r = result.result as Record<string, unknown>;
      expect(r['intent_id']).toBeDefined();
      expect(typeof r['intent_id']).toBe('string');
      expect((r['intent_id'] as string).length).toBe(64);
      expect(r['state']).toBe('ACTIVE');
      expect(r['market_intent_id']).toMatch(/^mock-intent-/);

      // Verify expiry_ms is approximately now + 86400000
      const expiryMs = r['expiry_ms'] as number;
      expect(expiryMs).toBeGreaterThan(Date.now());
      expect(expiryMs).toBeLessThanOrEqual(Date.now() + 86_400_000 + 1000);

      // Verify MarketModule.postIntent() was called
      expect(ctx.market.postIntentCalls).toHaveLength(1);
      const postCall = ctx.market.postIntentCalls[0]!;
      expect(postCall.intentType).toBe('sell');
      expect(postCall.category).toBe('ALPHA/USDC');
      expect(postCall.currency).toBe('USDC');
      expect(postCall.contactHandle).toBe(AGENT_ADDRESS);
      // Midpoint of 450-500 = 475
      expect(postCall.price).toBe(475);
      // Description must match canonical format
      expect(postCall.description).toContain('Selling 100-1000 ALPHA for USDC');
      expect(postCall.description).toContain('Rate: 450-500 USDC per ALPHA');
      expect(postCall.description).toContain('Escrow: any');
      expect(postCall.description).toContain('Deposit timeout: 300s');
    });

    it('T1.2: should produce unique intent_id for identical params due to random salt', async () => {
      ctx = setupTraderE2E({ balance: { ALPHA: 2000n } });

      const result1 = await ctx.handler.execute('CREATE_INTENT', validCreateIntentParams({ command_id: 'cmd-001' }));
      const result2 = await ctx.handler.execute('CREATE_INTENT', validCreateIntentParams({ command_id: 'cmd-002' }));

      expect(isOk(result1)).toBe(true);
      expect(isOk(result2)).toBe(true);
      if (!isOk(result1) || !isOk(result2)) return;

      const id1 = (result1.result as Record<string, unknown>)['intent_id'] as string;
      const id2 = (result2.result as Record<string, unknown>)['intent_id'] as string;

      expect(id1).not.toBe(id2);
      expect(id1).toHaveLength(64);
      expect(id2).toHaveLength(64);
    });

    it('T1.4: should cancel active intent and close on MarketModule', async () => {
      ctx = setupTraderE2E({ balance: { ALPHA: 1000n } });

      // Create an intent first
      const createResult = await ctx.handler.execute('CREATE_INTENT', validCreateIntentParams());
      expect(isOk(createResult)).toBe(true);
      if (!isOk(createResult)) return;

      const intentId = (createResult.result as Record<string, unknown>)['intent_id'] as string;
      const marketIntentId = (createResult.result as Record<string, unknown>)['market_intent_id'] as string;

      // Cancel it
      const cancelResult = await ctx.handler.execute('CANCEL_INTENT', {
        command_id: 'cmd-cancel',
        intent_id: intentId,
        reason: 'no longer needed',
      });

      expect(isOk(cancelResult)).toBe(true);
      if (!isOk(cancelResult)) return;

      const r = cancelResult.result as Record<string, unknown>;
      expect(r['intent_id']).toBe(intentId);
      expect(r['state']).toBe('CANCELLED');
      expect(r['volume_filled']).toBe('0');

      // closeIntent should have been called on the market
      expect(ctx.market.closeIntentCalls).toContain(marketIntentId);

      // Verify the intent is no longer ACTIVE in the engine
      const intent = ctx.intentEngine.getIntent(intentId);
      expect(intent).not.toBeNull();
      expect(intent!.state).toBe('CANCELLED');
    });

    it('T1.5: should transition intent to EXPIRED when expiry_ms is reached', async () => {
      vi.useFakeTimers();
      try {
        ctx = setupTraderE2E({ balance: { ALPHA: 1000n } });

        // Create intent with short expiry
        const result = await ctx.handler.execute('CREATE_INTENT', validCreateIntentParams({
          expiry_sec: 10,
        }));
        expect(isOk(result)).toBe(true);
        if (!isOk(result)) return;

        const intentId = (result.result as Record<string, unknown>)['intent_id'] as string;

        // Verify ACTIVE
        let intent = ctx.intentEngine.getIntent(intentId);
        expect(intent).not.toBeNull();
        expect(intent!.state).toBe('ACTIVE');

        // Start the engine to activate expiry sweep
        ctx.intentEngine.start();

        // Advance past expiry (10s) plus sweep interval (10s)
        await vi.advanceTimersByTimeAsync(21_000);

        // Verify EXPIRED
        intent = ctx.intentEngine.getIntent(intentId);
        expect(intent).not.toBeNull();
        expect(intent!.state).toBe('EXPIRED');

        // closeIntent should have been called
        expect(ctx.market.closeIntentCalls.length).toBeGreaterThan(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('T1.6: should filter intents by state via LIST_INTENTS command', async () => {
      vi.useFakeTimers();
      try {
        ctx = setupTraderE2E({
          balance: { ALPHA: 5000n, UNIT: 5000n },
        });

        // Create intent that will stay ACTIVE
        const active = await ctx.handler.execute('CREATE_INTENT', validCreateIntentParams({
          command_id: 'cmd-active',
          expiry_sec: 86400,
        }));
        expect(isOk(active)).toBe(true);

        // Create and cancel an intent (CANCELLED)
        const toCancel = await ctx.handler.execute('CREATE_INTENT', validCreateIntentParams({
          command_id: 'cmd-cancel',
          base_asset: 'UNIT',
          quote_asset: 'ALPHA',
          expiry_sec: 86400,
        }));
        expect(isOk(toCancel)).toBe(true);
        if (!isOk(toCancel)) return;
        const cancelId = (toCancel.result as Record<string, unknown>)['intent_id'] as string;
        await ctx.handler.execute('CANCEL_INTENT', { command_id: 'cmd-cc', intent_id: cancelId });

        // Create intent that will expire (EXPIRED)
        const toExpire = await ctx.handler.execute('CREATE_INTENT', validCreateIntentParams({
          command_id: 'cmd-expire',
          rate_min: '100',
          rate_max: '200',
          expiry_sec: 5,
        }));
        expect(isOk(toExpire)).toBe(true);

        // Start engine and advance time to expire the short-lived intent
        ctx.intentEngine.start();
        await vi.advanceTimersByTimeAsync(16_000);

        // LIST_INTENTS filter: 'active'
        const activeList = await ctx.handler.execute('LIST_INTENTS', { command_id: 'la', filter: 'active' });
        expect(isOk(activeList)).toBe(true);
        if (isOk(activeList)) {
          const r = activeList.result as Record<string, unknown>;
          const intents = r['intents'] as Array<Record<string, unknown>>;
          expect(intents.length).toBe(1);
          expect(intents[0]!['state']).toBe('ACTIVE');
        }

        // LIST_INTENTS filter: 'cancelled'
        const cancelledList = await ctx.handler.execute('LIST_INTENTS', { command_id: 'lc', filter: 'cancelled' });
        expect(isOk(cancelledList)).toBe(true);
        if (isOk(cancelledList)) {
          const r = cancelledList.result as Record<string, unknown>;
          const intents = r['intents'] as Array<Record<string, unknown>>;
          expect(intents.length).toBe(1);
          expect(intents[0]!['state']).toBe('CANCELLED');
        }

        // LIST_INTENTS filter: 'expired'
        const expiredList = await ctx.handler.execute('LIST_INTENTS', { command_id: 'le', filter: 'expired' });
        expect(isOk(expiredList)).toBe(true);
        if (isOk(expiredList)) {
          const r = expiredList.result as Record<string, unknown>;
          const intents = r['intents'] as Array<Record<string, unknown>>;
          expect(intents.length).toBe(1);
          expect(intents[0]!['state']).toBe('EXPIRED');
        }

        // LIST_INTENTS filter: 'all' — should return all 3
        const allList = await ctx.handler.execute('LIST_INTENTS', { command_id: 'lall', filter: 'all' });
        expect(isOk(allList)).toBe(true);
        if (isOk(allList)) {
          const r = allList.result as Record<string, unknown>;
          expect(r['total']).toBe(3);
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it('T1.12: GET_PORTFOLIO returns correct balances', async () => {
      ctx = setupTraderE2E({ balance: { ALPHA: 1000n, UNIT: 500n } });

      const result = await ctx.handler.execute('GET_PORTFOLIO', { command_id: 'cmd-port' });

      expect(isOk(result)).toBe(true);
      if (!isOk(result)) return;

      const r = result.result as Record<string, unknown>;
      expect(r['agent_pubkey']).toBe(AGENT_PUBKEY);
      expect(r['agent_address']).toBe(AGENT_ADDRESS);

      const balances = r['balances'] as Array<Record<string, unknown>>;
      expect(balances.length).toBeGreaterThanOrEqual(2);

      const alphaBalance = balances.find((b) => b['asset'] === 'ALPHA');
      expect(alphaBalance).toBeDefined();
      expect(alphaBalance!['confirmed']).toBe('1000');
      expect(alphaBalance!['available']).toBe('1000');

      const unitBalance = balances.find((b) => b['asset'] === 'UNIT');
      expect(unitBalance).toBeDefined();
      expect(unitBalance!['confirmed']).toBe('500');
      expect(unitBalance!['available']).toBe('500');

      expect(r['reserved']).toEqual([]);
    });
  });

  // =========================================================================
  // T10: ACP Command Validation
  // =========================================================================

  describe('T10: ACP Command Validation', () => {
    it('T10.1: should return INVALID_PARAM when required fields are missing', async () => {
      ctx = setupTraderE2E();

      // Missing everything except direction
      const result = await ctx.handler.execute('CREATE_INTENT', {
        command_id: 'cmd-bad',
        direction: 'sell',
      });

      expect(isError(result)).toBe(true);
      if (isError(result)) {
        expect(result.error_code).toBe('INVALID_PARAM');
      }
    });

    it('T10.2: should reject CREATE_INTENT with negative rate', async () => {
      ctx = setupTraderE2E();

      const result = await ctx.handler.execute('CREATE_INTENT', validCreateIntentParams({
        rate_min: '-10',
        rate_max: '500',
      }));

      expect(isError(result)).toBe(true);
      if (isError(result)) {
        expect(result.error_code).toBe('INVALID_PARAM');
      }
    });

    it('T10.3: should reject CREATE_INTENT with zero volume_min', async () => {
      ctx = setupTraderE2E();

      const result = await ctx.handler.execute('CREATE_INTENT', validCreateIntentParams({
        volume_min: '0',
        volume_max: '1000',
      }));

      expect(isError(result)).toBe(true);
      if (isError(result)) {
        expect(result.error_code).toBe('INVALID_PARAM');
      }
    });

    it('T10.4: should reject CREATE_INTENT with non-positive expiry_sec', async () => {
      ctx = setupTraderE2E();

      const result = await ctx.handler.execute('CREATE_INTENT', validCreateIntentParams({
        expiry_sec: 0,
      }));

      expect(isError(result)).toBe(true);
      if (isError(result)) {
        expect(result.error_code).toBe('INVALID_PARAM');
      }
    });

    it('T10.5: should reject CREATE_INTENT when rate_min > rate_max', async () => {
      ctx = setupTraderE2E();

      const result = await ctx.handler.execute('CREATE_INTENT', validCreateIntentParams({
        rate_min: '600',
        rate_max: '400',
      }));

      expect(isError(result)).toBe(true);
      if (isError(result)) {
        expect(result.error_code).toBe('INVALID_PARAM');
        expect(result.message).toContain('rate_min');
      }
    });

    it('T10.6: should reject CREATE_INTENT when base_asset equals quote_asset', async () => {
      ctx = setupTraderE2E();

      const result = await ctx.handler.execute('CREATE_INTENT', validCreateIntentParams({
        base_asset: 'ALPHA',
        quote_asset: 'ALPHA',
      }));

      expect(isError(result)).toBe(true);
      if (isError(result)) {
        expect(result.error_code).toBe('INVALID_PARAM');
        expect(result.message).toContain('differ');
      }
    });

    it('T10.7: should reject CREATE_INTENT with NaN/Infinity amounts', async () => {
      ctx = setupTraderE2E();

      // NaN rate_min (non-numeric string)
      const result = await ctx.handler.execute('CREATE_INTENT', validCreateIntentParams({
        rate_min: 'notanumber',
      }));

      expect(isError(result)).toBe(true);
      if (isError(result)) {
        expect(result.error_code).toBe('INVALID_PARAM');
      }

      // Infinity expiry_sec
      const result2 = await ctx.handler.execute('CREATE_INTENT', validCreateIntentParams({
        expiry_sec: Infinity,
      }));

      expect(isError(result2)).toBe(true);
      if (isError(result2)) {
        expect(result2.error_code).toBe('INVALID_PARAM');
      }
    });

    it('T10.8: should return LIMIT_EXCEEDED when max_active_intents reached', async () => {
      ctx = setupTraderE2E({
        strategy: { max_active_intents: 2 },
        balance: { ALPHA: 10000n },
      });

      // Create 2 intents (the limit)
      const r1 = await ctx.handler.execute('CREATE_INTENT', validCreateIntentParams({ command_id: 'c1' }));
      const r2 = await ctx.handler.execute('CREATE_INTENT', validCreateIntentParams({ command_id: 'c2', rate_min: '400', rate_max: '450' }));
      expect(isOk(r1)).toBe(true);
      expect(isOk(r2)).toBe(true);

      // 3rd should fail
      const r3 = await ctx.handler.execute('CREATE_INTENT', validCreateIntentParams({ command_id: 'c3', rate_min: '300', rate_max: '350' }));
      expect(isError(r3)).toBe(true);
      if (isError(r3)) {
        expect(r3.error_code).toBe('LIMIT_EXCEEDED');
      }
    });

    it('T10.10: should return NOT_FOUND for unknown intent_id on CANCEL_INTENT', async () => {
      ctx = setupTraderE2E();

      const result = await ctx.handler.execute('CANCEL_INTENT', {
        command_id: 'cmd-cancel-bad',
        intent_id: 'a'.repeat(64),
      });

      expect(isError(result)).toBe(true);
      if (isError(result)) {
        expect(result.error_code).toBe('NOT_FOUND');
      }
    });

    it('T10.11: should reject CANCEL_INTENT on already-cancelled intent', async () => {
      ctx = setupTraderE2E({ balance: { ALPHA: 1000n } });

      // Create and cancel
      const created = await ctx.handler.execute('CREATE_INTENT', validCreateIntentParams());
      expect(isOk(created)).toBe(true);
      if (!isOk(created)) return;
      const intentId = (created.result as Record<string, unknown>)['intent_id'] as string;

      await ctx.handler.execute('CANCEL_INTENT', {
        command_id: 'cancel-1',
        intent_id: intentId,
      });

      // Try to cancel again
      const result = await ctx.handler.execute('CANCEL_INTENT', {
        command_id: 'cancel-2',
        intent_id: intentId,
      });

      expect(isError(result)).toBe(true);
      if (isError(result)) {
        // Terminal state — either INTERNAL_ERROR (from cancelIntent throw) or a specific code
        expect(result.ok).toBe(false);
      }
    });

    it('T10.18: should reject CREATE_INTENT with deposit_timeout_sec out of range', async () => {
      ctx = setupTraderE2E({ balance: { ALPHA: 1000n } });

      // Below minimum (30)
      const resultLow = await ctx.handler.execute('CREATE_INTENT', validCreateIntentParams({
        deposit_timeout_sec: 10,
      }));
      expect(isError(resultLow)).toBe(true);
      if (isError(resultLow)) {
        expect(resultLow.error_code).toBe('INVALID_PARAM');
        expect(resultLow.message).toContain('deposit_timeout_sec');
      }

      // Above maximum (300)
      const resultHigh = await ctx.handler.execute('CREATE_INTENT', validCreateIntentParams({
        command_id: 'cmd-high',
        deposit_timeout_sec: 500,
      }));
      expect(isError(resultHigh)).toBe(true);
      if (isError(resultHigh)) {
        expect(resultHigh.error_code).toBe('INVALID_PARAM');
        expect(resultHigh.message).toContain('deposit_timeout_sec');
      }
    });

    it('T10.5b: should reject CREATE_INTENT with past expiry (negative expiry_sec)', async () => {
      ctx = setupTraderE2E({ balance: { ALPHA: 1000n } });

      const result = await ctx.handler.execute('CREATE_INTENT', validCreateIntentParams({
        expiry_sec: -100,
      }));

      expect(isError(result)).toBe(true);
      if (isError(result)) {
        expect(result.error_code).toBe('INVALID_PARAM');
      }
    });

    it('T10.7b: should reject CREATE_INTENT with invalid asset name format', async () => {
      ctx = setupTraderE2E({ balance: { ALPHA: 1000n } });

      // Lowercase
      const r1 = await ctx.handler.execute('CREATE_INTENT', validCreateIntentParams({
        base_asset: 'alpha',
      }));
      expect(isError(r1)).toBe(true);

      // Hyphen
      const r2 = await ctx.handler.execute('CREATE_INTENT', validCreateIntentParams({
        command_id: 'c2',
        base_asset: 'AL-PHA',
      }));
      expect(isError(r2)).toBe(true);
    });

    it('T10.14: GET_PORTFOLIO returns correct available/reserved breakdown', async () => {
      ctx = setupTraderE2E({ balance: { ALPHA: 1000n } });

      // Create a reservation via the ledger
      await ctx.ledger.reserve('ALPHA', 300n, 'deal-1');
      await ctx.ledger.reserve('ALPHA', 200n, 'deal-2');

      const result = await ctx.handler.execute('GET_PORTFOLIO', { command_id: 'cmd-port' });
      expect(isOk(result)).toBe(true);
      if (!isOk(result)) return;

      const r = result.result as Record<string, unknown>;
      const balances = r['balances'] as Array<Record<string, unknown>>;
      const alpha = balances.find((b) => b['asset'] === 'ALPHA');
      expect(alpha).toBeDefined();
      expect(alpha!['confirmed']).toBe('1000');
      // available = 1000 - 300 - 200 = 500
      expect(alpha!['available']).toBe('500');

      const reserved = r['reserved'] as Array<Record<string, unknown>>;
      expect(reserved).toHaveLength(2);
      const deal1 = reserved.find((r) => r['deal_id'] === 'deal-1');
      const deal2 = reserved.find((r) => r['deal_id'] === 'deal-2');
      expect(deal1).toBeDefined();
      expect(deal1!['amount']).toBe('300');
      expect(deal2).toBeDefined();
      expect(deal2!['amount']).toBe('200');
    });
  });
});
