/**
 * TraderCommandHandler — intercepts trader-specific ACP commands and
 * delegates unknown commands to the base tenant CommandHandler.
 *
 * Implements the command set from protocol spec Section 4:
 *   CREATE_INTENT, CANCEL_INTENT, LIST_INTENTS, LIST_SWAPS,
 *   SET_STRATEGY, GET_PORTFOLIO, WITHDRAW_TOKEN.
 *
 * Base commands (STATUS, SHUTDOWN_GRACEFUL, SET_LOG_LEVEL, EXEC)
 * pass through to the underlying handler.
 */

import type { AcpResultPayload, AcpErrorPayload } from '../protocols/acp.js';
import type { CommandHandler } from '../tenant/command-handler.js';
import { pubkeysEqual } from '../shared/crypto.js';
import type { Logger } from '../shared/logger.js';
import type { IntentEngine } from './intent-engine.js';
import type { NegotiationHandler } from './negotiation-handler.js';
import type { SwapExecutor } from './swap-executor.js';
import type { VolumeReservationLedger } from './volume-reservation-ledger.js';
import type {
  PaymentsAdapter,
  MarketAdapter,
  TraderStrategy,
  IntentRecord,
  DealRecord,
} from './types.js';
import { TERMINAL_DEAL_STATES } from './types.js';
import type {
  CreateIntentParams,
  CreateIntentResult,
  CancelIntentResult,
  IntentSummary,
  ListIntentsResult,
  DealSummary,
  ListSwapsResult,
  SetStrategyParams,
  SetStrategyResult,
  AssetBalance,
  GetPortfolioResult,
  WithdrawTokenParams,
  ListIntentsParams,
  ListSwapsParams,
} from './acp-types.js';
import type { VolumeReservation as AcpVolumeReservation } from './acp-types.js';
import { validateIntentParams } from './utils.js';

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface TraderCommandHandlerDeps {
  readonly baseHandler: CommandHandler;
  readonly intentEngine: IntentEngine;
  readonly negotiationHandler: NegotiationHandler;
  readonly swapExecutor: SwapExecutor;
  readonly ledger: VolumeReservationLedger;
  readonly payments: PaymentsAdapter;
  readonly market?: MarketAdapter;
  readonly strategy: TraderStrategy;
  readonly agentPubkey: string;
  readonly agentAddress: string;
  readonly saveStrategy: (strategy: TraderStrategy) => Promise<void>;
  readonly withdraw: (params: WithdrawTokenParams) => Promise<{ transfer_id: string; remaining_balance: bigint }>;
  /** Get SDK swap progress for all active swaps (from sphere.swap.getSwaps()) */
  readonly getSwapProgress?: () => Promise<Array<{ swapId: string; progress: string; payoutVerified?: boolean }>>;
  /** Debug: resolve an address via the SDK's transport resolver */
  readonly debugResolve?: (address: string) => Promise<{ directAddress?: string; chainPubkey?: string } | null>;
  /** Debug: get active addresses from the SDK */
  readonly debugGetActiveAddresses?: () => Array<{ directAddress: string; chainPubkey: string }>;
  readonly logger: Logger;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_EXPIRY_SEC = 7 * 24 * 60 * 60; // 7 days
// KNOWN_ASSETS removed — GET_PORTFOLIO now queries all SDK balances dynamically
const MAX_LIST_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 50;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorPayload(commandId: string, errorCode: string, message: string): AcpErrorPayload {
  return { command_id: commandId, ok: false, error_code: errorCode, message };
}

function okPayload(commandId: string, result: Record<string, unknown>): AcpResultPayload {
  return { command_id: commandId, ok: true as const, result };
}

function extractCommandId(params: Record<string, unknown>): string {
  return typeof params['command_id'] === 'string' ? params['command_id'] : '';
}

/**
 * Safely parse a string to bigint. Returns null if the string is not a valid
 * non-negative integer representation.
 */
function safeParseBigint(value: unknown): bigint | null {
  if (typeof value !== 'string') return null;
  // Reject empty, whitespace-only, non-numeric (allow leading minus for the check below)
  if (!/^-?\d+$/.test(value)) return null;
  try {
    const n = BigInt(value);
    if (n < 0n) return null;
    return n;
  } catch {
    return null;
  }
}

/**
 * Clamp a list parameter to safe bounds.
 */
function clampListParam(
  raw: unknown,
  defaultVal: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw === null) return defaultVal;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return defaultVal;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/**
 * Map IntentRecord to wire-format IntentSummary.
 */
function toIntentSummary(rec: IntentRecord): IntentSummary {
  return {
    intent_id: rec.intent.intent_id,
    direction: rec.intent.direction,
    base_asset: rec.intent.base_asset,
    quote_asset: rec.intent.quote_asset,
    rate_min: rec.intent.rate_min.toString(),
    rate_max: rec.intent.rate_max.toString(),
    volume_min: rec.intent.volume_min.toString(),
    volume_max: rec.intent.volume_max.toString(),
    volume_filled: rec.intent.volume_filled.toString(),
    state: rec.state,
    expiry_ms: rec.intent.expiry_ms,
    created_ms: rec.updated_at,
    active_deals: rec.deal_ids.filter((id) => id !== '').length,
  };
}

/**
 * Map DealRecord to wire-format DealSummary.
 */
function toDealSummary(rec: DealRecord, agentPubkey: string): DealSummary {
  // pubkeysEqual handles wire-vs-canonical format drift (x-only / compressed).
  const isProposer = pubkeysEqual(rec.terms.proposer_pubkey, agentPubkey);
  return {
    deal_id: rec.terms.deal_id,
    counterparty_pubkey: isProposer
      ? rec.terms.acceptor_pubkey
      : rec.terms.proposer_pubkey,
    base_asset: rec.terms.base_asset,
    quote_asset: rec.terms.quote_asset,
    rate: rec.terms.rate.toString(),
    volume: rec.terms.volume.toString(),
    state: rec.state,
    role: isProposer ? 'proposer' : 'acceptor',
    swap_id: rec.swap_id,
    created_ms: rec.terms.created_ms,
    updated_ms: rec.updated_at,
  };
}

/**
 * Filter intents based on the ACP filter string.
 */
function matchesIntentFilter(
  rec: IntentRecord,
  filter: string | undefined,
): boolean {
  if (!filter || filter === 'all') return true;
  switch (filter) {
    case 'active':
      return rec.state === 'ACTIVE' || rec.state === 'MATCHING' || rec.state === 'NEGOTIATING' || rec.state === 'PARTIALLY_FILLED';
    case 'filled':
      return rec.state === 'FILLED';
    case 'cancelled':
      return rec.state === 'CANCELLED';
    case 'expired':
      return rec.state === 'EXPIRED';
    default:
      return true;
  }
}

/**
 * Filter deals based on the ACP filter string.
 */
function matchesDealFilter(
  rec: DealRecord,
  filter: string | undefined,
): boolean {
  if (!filter || filter === 'all') return true;
  switch (filter) {
    case 'active':
      return !TERMINAL_DEAL_STATES.includes(rec.state);
    case 'completed':
      return rec.state === 'COMPLETED';
    case 'failed':
      return rec.state === 'FAILED';
    default:
      return true;
  }
}

// ---------------------------------------------------------------------------
// Strategy validation
// ---------------------------------------------------------------------------

function validateStrategyParams(params: SetStrategyParams): string | null {
  if (params.max_concurrent_swaps !== undefined) {
    if (!Number.isInteger(params.max_concurrent_swaps) || params.max_concurrent_swaps < 1 || params.max_concurrent_swaps > 10) {
      return 'max_concurrent_swaps must be an integer between 1 and 10';
    }
  }
  if (params.max_active_intents !== undefined) {
    if (!Number.isInteger(params.max_active_intents) || params.max_active_intents < 1 || params.max_active_intents > 100) {
      return 'max_active_intents must be an integer between 1 and 100';
    }
  }
  if (params.min_search_score !== undefined) {
    if (typeof params.min_search_score !== 'number' || !Number.isFinite(params.min_search_score) || params.min_search_score < 0 || params.min_search_score > 1) {
      return 'min_search_score must be a number between 0 and 1';
    }
  }
  if (params.scan_interval_ms !== undefined) {
    if (!Number.isInteger(params.scan_interval_ms) || params.scan_interval_ms < 1000 || params.scan_interval_ms > 300_000) {
      return 'scan_interval_ms must be an integer between 1000 and 300000';
    }
  }
  if (params.market_api_url !== undefined) {
    if (typeof params.market_api_url !== 'string' || params.market_api_url === '') {
      return 'market_api_url must be a non-empty string';
    }
  }
  if (params.trusted_escrows !== undefined) {
    if (!Array.isArray(params.trusted_escrows)) {
      return 'trusted_escrows must be an array of strings';
    }
    for (const e of params.trusted_escrows) {
      if (typeof e !== 'string' || e === '') return 'trusted_escrows entries must be non-empty strings';
    }
  }
  if (params.blocked_counterparties !== undefined) {
    if (!Array.isArray(params.blocked_counterparties)) {
      return 'blocked_counterparties must be an array of strings';
    }
    for (const cp of params.blocked_counterparties) {
      if (typeof cp !== 'string' || cp === '') return 'blocked_counterparties entries must be non-empty strings';
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Address validation (basic hex or bech32-like check)
// ---------------------------------------------------------------------------

const ADDRESS_RE = /^[a-zA-Z0-9]{10,128}$/;

function isValidAddress(addr: unknown): addr is string {
  return typeof addr === 'string' && ADDRESS_RE.test(addr);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTraderCommandHandler(
  deps: TraderCommandHandlerDeps,
): CommandHandler {
  const {
    baseHandler,
    intentEngine,
    negotiationHandler,
    // swapExecutor used indirectly via negotiationHandler callbacks
    ledger,
    payments,
    agentPubkey,
    agentAddress,
    saveStrategy,
    withdraw,
    logger,
  } = deps;

  // Mutable strategy reference — updated by SET_STRATEGY
  let currentStrategy: TraderStrategy = { ...deps.strategy };

  // ----- CREATE_INTENT -----

  async function handleCreateIntent(
    params: Record<string, unknown>,
    commandId: string,
  ): Promise<AcpResultPayload | AcpErrorPayload> {
    // Parse and validate string amounts to bigint
    const rateMin = safeParseBigint(params['rate_min']);
    const rateMax = safeParseBigint(params['rate_max']);
    const volumeMin = safeParseBigint(params['volume_min']);
    const volumeMax = safeParseBigint(params['volume_max']);

    if (rateMin === null) return errorPayload(commandId, 'INVALID_PARAM', 'rate_min must be a non-negative integer string');
    if (rateMax === null) return errorPayload(commandId, 'INVALID_PARAM', 'rate_max must be a non-negative integer string');
    if (volumeMin === null) return errorPayload(commandId, 'INVALID_PARAM', 'volume_min must be a non-negative integer string');
    if (volumeMax === null) return errorPayload(commandId, 'INVALID_PARAM', 'volume_max must be a non-negative integer string');

    const direction = params['direction'];
    if (direction !== 'buy' && direction !== 'sell') {
      return errorPayload(commandId, 'INVALID_PARAM', 'direction must be "buy" or "sell"');
    }

    const baseAsset = params['base_asset'];
    const quoteAsset = params['quote_asset'];
    if (typeof baseAsset !== 'string' || baseAsset === '') {
      return errorPayload(commandId, 'INVALID_PARAM', 'base_asset is required');
    }
    if (typeof quoteAsset !== 'string' || quoteAsset === '') {
      return errorPayload(commandId, 'INVALID_PARAM', 'quote_asset is required');
    }

    const expirySec = params['expiry_sec'];
    if (typeof expirySec !== 'number' || !Number.isFinite(expirySec)) {
      return errorPayload(commandId, 'INVALID_PARAM', 'expiry_sec must be a finite number');
    }

    // Additional spec 7.7 validation: expiry in the past
    const expiryMs = Date.now() + expirySec * 1000;
    if (expiryMs <= Date.now()) {
      return errorPayload(commandId, 'INVALID_PARAM', 'expiry_sec must be positive');
    }
    if (expirySec > MAX_EXPIRY_SEC) {
      return errorPayload(commandId, 'INVALID_PARAM', 'expiry_sec must not exceed 7 days');
    }

    // Build the typed params for validation
    const intentParams: CreateIntentParams = {
      direction,
      base_asset: baseAsset,
      quote_asset: quoteAsset,
      rate_min: rateMin.toString(),
      rate_max: rateMax.toString(),
      volume_min: volumeMin.toString(),
      volume_max: volumeMax.toString(),
      escrow_address: typeof params['escrow_address'] === 'string' ? params['escrow_address'] : undefined,
      deposit_timeout_sec: typeof params['deposit_timeout_sec'] === 'number' ? params['deposit_timeout_sec'] : undefined,
      expiry_sec: expirySec,
    };

    const validationError = validateIntentParams(intentParams);
    if (validationError !== null) {
      return errorPayload(commandId, 'INVALID_PARAM', validationError);
    }

    // Check max_active_intents limit
    const activeIntents = await intentEngine.listIntents({
      state: ['ACTIVE', 'MATCHING', 'NEGOTIATING', 'PARTIALLY_FILLED'],
    });
    if (activeIntents.length >= currentStrategy.max_active_intents) {
      return errorPayload(
        commandId,
        'LIMIT_EXCEEDED',
        `Maximum active intents (${String(currentStrategy.max_active_intents)}) reached`,
      );
    }

    try {
      const record = await intentEngine.createIntent(intentParams, agentPubkey, agentAddress);

      const result: CreateIntentResult = {
        intent_id: record.intent.intent_id,
        market_intent_id: record.intent.market_intent_id,
        state: 'ACTIVE',
        direction: record.intent.direction,
        base_asset: record.intent.base_asset,
        quote_asset: record.intent.quote_asset,
        rate_min: record.intent.rate_min.toString(),
        rate_max: record.intent.rate_max.toString(),
        volume_min: record.intent.volume_min.toString(),
        volume_max: record.intent.volume_max.toString(),
        expiry_ms: record.intent.expiry_ms,
        created_ms: record.updated_at,
      };

      logger.info('intent_created', { intent_id: result.intent_id });
      return okPayload(commandId, result as unknown as Record<string, unknown>);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error creating intent';
      logger.error('create_intent_failed', { error: msg });
      return errorPayload(commandId, 'INTERNAL_ERROR', msg);
    }
  }

  // ----- CANCEL_INTENT -----

  async function handleCancelIntent(
    params: Record<string, unknown>,
    commandId: string,
  ): Promise<AcpResultPayload | AcpErrorPayload> {
    const intentId = params['intent_id'];
    if (typeof intentId !== 'string' || intentId === '') {
      return errorPayload(commandId, 'INVALID_PARAM', 'intent_id is required');
    }

    const intent = intentEngine.getIntent(intentId);
    if (intent === null) {
      return errorPayload(commandId, 'NOT_FOUND', `Intent not found: ${intentId}`);
    }

    // Check for active deals — cannot cancel intent with a deal in progress
    if (intent.deal_ids.length > 0) {
      // Check if any deals are non-terminal
      for (const dealId of intent.deal_ids) {
        const deal = negotiationHandler.getDeal(dealId);
        if (deal !== null && !TERMINAL_DEAL_STATES.includes(deal.state)) {
          return errorPayload(
            commandId,
            'DEAL_IN_PROGRESS',
            `Cannot cancel intent with active deal: ${dealId}`,
          );
        }
      }
    }

    try {
      const cancelled = await intentEngine.cancelIntent(intentId);

      const result: CancelIntentResult = {
        intent_id: cancelled.intent.intent_id,
        state: 'CANCELLED',
        volume_filled: cancelled.intent.volume_filled.toString(),
      };

      logger.info('intent_cancelled', { intent_id: intentId });
      return okPayload(commandId, result as unknown as Record<string, unknown>);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error cancelling intent';
      logger.error('cancel_intent_failed', { error: msg, intent_id: intentId });
      return errorPayload(commandId, 'INTERNAL_ERROR', msg);
    }
  }

  // ----- LIST_INTENTS -----

  async function handleListIntents(
    params: Record<string, unknown>,
    commandId: string,
  ): Promise<AcpResultPayload | AcpErrorPayload> {
    const filterParam = params['filter'] as ListIntentsParams['filter'] | undefined;
    const limit = clampListParam(params['limit'], DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
    const offset = clampListParam(params['offset'], 0, 0, Number.MAX_SAFE_INTEGER);

    try {
      const allIntents = await intentEngine.listIntents();
      const filtered = allIntents.filter((rec) => matchesIntentFilter(rec, filterParam));
      const paged = filtered.slice(offset, offset + limit);
      const summaries: IntentSummary[] = paged.map(toIntentSummary);

      const result: ListIntentsResult = {
        intents: summaries,
        total: filtered.length,
      };

      return okPayload(commandId, result as unknown as Record<string, unknown>);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error listing intents';
      logger.error('list_intents_failed', { error: msg });
      return errorPayload(commandId, 'INTERNAL_ERROR', msg);
    }
  }

  // ----- LIST_SWAPS -----

  async function handleListSwaps(
    params: Record<string, unknown>,
    commandId: string,
  ): Promise<AcpResultPayload | AcpErrorPayload> {
    const filterParam = params['filter'] as ListSwapsParams['filter'] | undefined;
    const limit = clampListParam(params['limit'], DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
    const offset = clampListParam(params['offset'], 0, 0, Number.MAX_SAFE_INTEGER);

    try {
      const allDeals = await negotiationHandler.listDeals();
      const filtered = allDeals.filter((rec) => matchesDealFilter(rec, filterParam));
      const paged = filtered.slice(offset, offset + limit);
      const summaries: DealSummary[] = paged.map((rec) => toDealSummary(rec, agentPubkey));

      const result: ListSwapsResult = {
        deals: summaries,
        total: filtered.length,
      };

      return okPayload(commandId, result as unknown as Record<string, unknown>);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error listing swaps';
      logger.error('list_swaps_failed', { error: msg });
      return errorPayload(commandId, 'INTERNAL_ERROR', msg);
    }
  }

  // ----- SET_STRATEGY -----

  async function handleSetStrategy(
    params: Record<string, unknown>,
    commandId: string,
  ): Promise<AcpResultPayload | AcpErrorPayload> {
    const strategyParams: SetStrategyParams = {
      ...(params['auto_match'] !== undefined && { auto_match: Boolean(params['auto_match']) }),
      ...(params['auto_negotiate'] !== undefined && { auto_negotiate: Boolean(params['auto_negotiate']) }),
      ...(params['max_concurrent_swaps'] !== undefined && { max_concurrent_swaps: Number(params['max_concurrent_swaps']) }),
      ...(params['max_active_intents'] !== undefined && { max_active_intents: Number(params['max_active_intents']) }),
      ...(params['min_search_score'] !== undefined && { min_search_score: Number(params['min_search_score']) }),
      ...(params['scan_interval_ms'] !== undefined && { scan_interval_ms: Number(params['scan_interval_ms']) }),
      ...(params['market_api_url'] !== undefined && { market_api_url: String(params['market_api_url']) }),
      ...(params['trusted_escrows'] !== undefined && { trusted_escrows: params['trusted_escrows'] as readonly string[] }),
      ...(params['blocked_counterparties'] !== undefined && { blocked_counterparties: params['blocked_counterparties'] as readonly string[] }),
    };

    const validationError = validateStrategyParams(strategyParams);
    if (validationError !== null) {
      return errorPayload(commandId, 'INVALID_PARAM', validationError);
    }

    // Merge with current strategy
    const merged: TraderStrategy = {
      auto_match: strategyParams.auto_match ?? currentStrategy.auto_match,
      auto_negotiate: strategyParams.auto_negotiate ?? currentStrategy.auto_negotiate,
      max_concurrent_swaps: strategyParams.max_concurrent_swaps ?? currentStrategy.max_concurrent_swaps,
      max_active_intents: strategyParams.max_active_intents ?? currentStrategy.max_active_intents,
      min_search_score: strategyParams.min_search_score ?? currentStrategy.min_search_score,
      scan_interval_ms: strategyParams.scan_interval_ms ?? currentStrategy.scan_interval_ms,
      market_api_url: strategyParams.market_api_url ?? currentStrategy.market_api_url,
      trusted_escrows: strategyParams.trusted_escrows ?? currentStrategy.trusted_escrows,
      blocked_counterparties: strategyParams.blocked_counterparties ?? currentStrategy.blocked_counterparties,
    };

    try {
      await saveStrategy(merged);
      currentStrategy = merged;
      // Propagate to intent engine so scan/feed guards reflect the new strategy
      intentEngine.updateStrategy(merged);

      const result: SetStrategyResult = {
        strategy: strategyParams,
      };

      logger.info('strategy_updated', { changed_keys: Object.keys(strategyParams) });
      return okPayload(commandId, result as unknown as Record<string, unknown>);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error saving strategy';
      logger.error('set_strategy_failed', { error: msg });
      return errorPayload(commandId, 'INTERNAL_ERROR', msg);
    }
  }

  // ----- GET_PORTFOLIO -----

  async function handleGetPortfolio(
    _params: Record<string, unknown>,
    commandId: string,
  ): Promise<AcpResultPayload | AcpErrorPayload> {
    try {
      // Trigger a receive to pick up any pending Nostr transfers (e.g., faucet grants)
      await payments.refresh();

      const reservations = ledger.getReservations();

      // Get ALL balances from the SDK (not filtered by hardcoded KNOWN_ASSETS)
      const allAssets = payments.getAllBalances();
      // Also include assets from active reservations that may not have balance
      const reservedAssets = new Set(reservations.map((r) => r.coinId));

      const balances: AssetBalance[] = [];
      for (const asset of allAssets) {
        const available = ledger.getAvailable(asset.coinId);
        balances.push({
          asset: asset.symbol || asset.coinId,
          available: available.toString(),
          total: asset.totalAmount.toString(),
          confirmed: asset.confirmedAmount.toString(),
          unconfirmed: (asset.totalAmount - asset.confirmedAmount).toString(),
        });
        reservedAssets.delete(asset.coinId);
      }
      // Add reserved assets that have no balance (shouldn't happen but defensive)
      for (const coinId of reservedAssets) {
        balances.push({
          asset: coinId,
          available: '0',
          total: '0',
          confirmed: '0',
          unconfirmed: '0',
        });
      }

      const reservedWire: AcpVolumeReservation[] = reservations.map((r) => ({
        asset: r.coinId,
        amount: r.amount.toString(),
        deal_id: r.dealId,
      }));

      const result: GetPortfolioResult = {
        agent_pubkey: agentPubkey,
        agent_address: agentAddress,
        balances,
        reserved: reservedWire,
        updated_ms: Date.now(),
      };

      return okPayload(commandId, result as unknown as Record<string, unknown>);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error getting portfolio';
      logger.error('get_portfolio_failed', { error: msg });
      return errorPayload(commandId, 'INTERNAL_ERROR', msg);
    }
  }

  // ----- WITHDRAW_TOKEN -----

  async function handleWithdrawToken(
    params: Record<string, unknown>,
    commandId: string,
  ): Promise<AcpResultPayload | AcpErrorPayload> {
    const asset = params['asset'];
    if (typeof asset !== 'string' || asset === '') {
      return errorPayload(commandId, 'INVALID_PARAM', 'asset is required');
    }

    const amountStr = params['amount'];
    const amount = safeParseBigint(amountStr);
    if (amount === null || amount <= 0n) {
      return errorPayload(commandId, 'INVALID_PARAM', 'amount must be a positive integer string');
    }

    const toAddress = params['to_address'];
    if (!isValidAddress(toAddress)) {
      return errorPayload(commandId, 'INVALID_PARAM', 'to_address must be a valid address (10-128 alphanumeric characters)');
    }

    // Check available balance (confirmed - reserved)
    const available = ledger.getAvailable(asset);
    if (amount > available) {
      return errorPayload(
        commandId,
        'INSUFFICIENT_BALANCE',
        `Insufficient available balance: requested ${amount.toString()} ${asset}, available ${available.toString()} ${asset}`,
      );
    }

    // Forward to the trader's withdraw helper, which calls
    // payments.send (PaymentsModule.send via the adapter wired in
    // trader/main.ts). On error we map to a typed acp.error so the
    // controller can retry or escalate; on success we return the SDK
    // transfer_id so callers can verify settlement via getHistory().
    try {
      const result = await withdraw({ asset, amount: amount.toString(), to_address: toAddress });
      logger.info('withdraw_complete', {
        asset,
        amount: amount.toString(),
        to_address: toAddress,
        transfer_id: result.transfer_id,
      });
      return okPayload(commandId, {
        asset,
        amount: amount.toString(),
        to_address: toAddress,
        transfer_id: result.transfer_id,
        remaining_balance: result.remaining_balance.toString(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('withdraw_failed', {
        asset,
        amount: amount.toString(),
        to_address: toAddress,
        error: message,
      });
      return errorPayload(commandId, 'WITHDRAW_FAILED', message);
    }
  }

  // ----- CommandHandler implementation -----

  return {
    async execute(
      commandName: string,
      params: Record<string, unknown>,
    ): Promise<AcpResultPayload | AcpErrorPayload> {
      const commandId = extractCommandId(params);

      switch (commandName.toUpperCase()) {
        case 'CREATE_INTENT':
          return handleCreateIntent(params, commandId);

        case 'CANCEL_INTENT':
          return handleCancelIntent(params, commandId);

        case 'LIST_INTENTS':
          return handleListIntents(params, commandId);

        case 'LIST_SWAPS':
          return handleListSwaps(params, commandId);

        case 'SET_STRATEGY':
          return handleSetStrategy(params, commandId);

        case 'GET_PORTFOLIO':
          return handleGetPortfolio(params, commandId);

        case 'WITHDRAW_TOKEN':
          return handleWithdrawToken(params, commandId);

        case 'DEBUG_SEARCH': {
          const query = typeof params['query'] === 'string' ? params['query'] : 'Buying UCT for USDU';
          const intentType = typeof params['intent_type'] === 'string' ? params['intent_type'] as 'buy' | 'sell' : undefined;
          const category = typeof params['category'] === 'string' ? params['category'] : undefined;
          try {
            if (!deps.market) {
              return errorPayload(commandId, 'NOT_AVAILABLE', 'MarketAdapter not available');
            }
            const results = await deps.market.search(query, {
              filters: { intentType, category, minScore: 0.3 },
              limit: 5,
            });
            return okPayload(commandId, {
              query,
              result_count: results.length,
              results: results.slice(0, 5).map((r) => ({
                score: r.score,
                intentType: r.intentType,
                category: r.category,
                description: r.description?.slice(0, 80),
                agentPublicKey: r.agentPublicKey,
                contactHandle: r.contactHandle ?? '(not set)',
                expiresAt: r.expiresAt,
                createdAt: r.createdAt,
              })),
            });
          } catch (err: unknown) {
            return errorPayload(commandId, 'SEARCH_FAILED', err instanceof Error ? err.message : String(err));
          }
        }

        case 'DEBUG_IDENTITY': {
          // Live resolution check: resolve our own nametag and compare
          const result: Record<string, unknown> = {
            agent_pubkey: agentPubkey,
            agent_address: agentAddress,
          };
          if (deps.debugGetActiveAddresses) {
            const active = deps.debugGetActiveAddresses();
            result['active_addresses'] = active.map((a) => ({
              directAddress: a.directAddress,
              chainPubkey: a.chainPubkey.slice(0, 20) + '...',
            }));
          }
          if (deps.debugResolve && agentAddress.startsWith('@')) {
            try {
              const resolved = await deps.debugResolve(agentAddress);
              result['resolved_self'] = {
                directAddress: resolved?.directAddress ?? '(null)',
                chainPubkey: resolved?.chainPubkey ? resolved.chainPubkey.slice(0, 20) + '...' : '(null)',
              };
              if (deps.debugGetActiveAddresses) {
                const active = deps.debugGetActiveAddresses();
                result['direct_address_match'] = active.some(
                  (a) => a.directAddress === resolved?.directAddress,
                );
              }
            } catch (err: unknown) {
              result['resolve_error'] = err instanceof Error ? err.message : String(err);
            }
          }
          return okPayload(commandId, result);
        }

        case 'GET_SWAP_PROGRESS': {
          if (!deps.getSwapProgress) {
            return okPayload(commandId, { swaps: [] } as unknown as Record<string, unknown>);
          }
          try {
            const swaps = await deps.getSwapProgress();
            return okPayload(commandId, { swaps } as unknown as Record<string, unknown>);
          } catch (err: unknown) {
            return errorPayload(commandId, 'INTERNAL_ERROR', String(err));
          }
        }

        case 'DEBUG_SWAP_EXEC': {
          const activeDeals = deps.swapExecutor.getActiveDeals();
          const lastErrors = deps.swapExecutor.getLastErrors();
          return okPayload(commandId, {
            active_count: activeDeals.length,
            active_deals: activeDeals,
            last_errors: lastErrors,
            strategy_trusted_escrows: currentStrategy.trusted_escrows,
            strategy_max_concurrent_swaps: currentStrategy.max_concurrent_swaps,
          } as unknown as Record<string, unknown>);
        }

        // Base commands: STATUS, SHUTDOWN_GRACEFUL, SET_LOG_LEVEL, EXEC
        default:
          return baseHandler.execute(commandName, params);
      }
    },

    isShutdownRequested(): boolean {
      return baseHandler.isShutdownRequested();
    },
  };
}
