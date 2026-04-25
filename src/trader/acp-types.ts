/**
 * Trader Agent Template — ACP command parameter and result types.
 *
 * All amounts are transmitted as `string` over the ACP wire format.
 * Conversion to/from `bigint` happens in the command handler layer.
 *
 * Corresponds to protocol spec Section 4.2–4.9.
 */

import type { DealState, IntentState } from './types.js';

// ---------------------------------------------------------------------------
// 4.2 CREATE_INTENT
// ---------------------------------------------------------------------------

export interface CreateIntentParams {
  readonly direction: 'buy' | 'sell';
  readonly base_asset: string;
  readonly quote_asset: string;
  readonly rate_min: string;
  readonly rate_max: string;
  readonly volume_min: string;
  readonly volume_max: string;
  readonly escrow_address?: string;
  readonly deposit_timeout_sec?: number;
  readonly expiry_sec: number;
}

export interface CreateIntentResult {
  readonly intent_id: string;
  readonly market_intent_id: string;
  readonly state: 'ACTIVE';
  readonly direction: 'buy' | 'sell';
  readonly base_asset: string;
  readonly quote_asset: string;
  readonly rate_min: string;
  readonly rate_max: string;
  readonly volume_min: string;
  readonly volume_max: string;
  readonly expiry_ms: number;
  readonly created_ms: number;
}

// ---------------------------------------------------------------------------
// 4.3 CANCEL_INTENT
// ---------------------------------------------------------------------------

export interface CancelIntentParams {
  readonly intent_id: string;
  readonly reason?: string;
}

export interface CancelIntentResult {
  readonly intent_id: string;
  readonly state: 'CANCELLED';
  readonly volume_filled: string;
}

// ---------------------------------------------------------------------------
// 4.4 LIST_INTENTS
// ---------------------------------------------------------------------------

export interface ListIntentsParams {
  readonly filter?: 'active' | 'filled' | 'cancelled' | 'expired' | 'all';
  readonly limit?: number;
  readonly offset?: number;
}

export interface IntentSummary {
  readonly intent_id: string;
  readonly direction: 'buy' | 'sell';
  readonly base_asset: string;
  readonly quote_asset: string;
  readonly rate_min: string;
  readonly rate_max: string;
  readonly volume_min: string;
  readonly volume_max: string;
  readonly volume_filled: string;
  readonly state: IntentState;
  readonly expiry_ms: number;
  readonly created_ms: number;
  readonly active_deals: number;
}

export interface ListIntentsResult {
  readonly intents: readonly IntentSummary[];
  readonly total: number;
}

// ---------------------------------------------------------------------------
// 4.5 LIST_SWAPS
// ---------------------------------------------------------------------------

export interface ListSwapsParams {
  readonly filter?: 'active' | 'completed' | 'failed' | 'all';
  readonly limit?: number;
  readonly offset?: number;
}

export interface DealSummary {
  readonly deal_id: string;
  readonly counterparty_pubkey: string;
  readonly base_asset: string;
  readonly quote_asset: string;
  readonly rate: string;
  readonly volume: string;
  readonly state: DealState;
  readonly role: 'proposer' | 'acceptor';
  readonly swap_id: string | null;
  readonly created_ms: number;
  readonly updated_ms: number;
}

export interface ListSwapsResult {
  readonly deals: readonly DealSummary[];
  readonly total: number;
}

// ---------------------------------------------------------------------------
// 4.6 SET_STRATEGY
// ---------------------------------------------------------------------------

export interface SetStrategyParams {
  readonly auto_match?: boolean;
  readonly auto_negotiate?: boolean;
  readonly max_concurrent_swaps?: number;
  readonly max_active_intents?: number;
  readonly min_search_score?: number;
  readonly scan_interval_ms?: number;
  readonly market_api_url?: string;
  readonly trusted_escrows?: readonly string[];
  readonly blocked_counterparties?: readonly string[];
}

export interface SetStrategyResult {
  readonly strategy: SetStrategyParams;
}

// ---------------------------------------------------------------------------
// 4.7 GET_PORTFOLIO
// ---------------------------------------------------------------------------

export interface AssetBalance {
  readonly asset: string;
  readonly available: string;
  readonly total: string;
  readonly confirmed: string;
  readonly unconfirmed: string;
}

export interface VolumeReservation {
  readonly asset: string;
  readonly amount: string;
  readonly deal_id: string;
}

export interface GetPortfolioResult {
  readonly agent_pubkey: string;
  readonly agent_address: string;
  readonly balances: readonly AssetBalance[];
  readonly reserved: readonly VolumeReservation[];
  readonly updated_ms: number;
}

// ---------------------------------------------------------------------------
// 4.9 WITHDRAW_TOKEN
// ---------------------------------------------------------------------------

export interface WithdrawTokenParams {
  readonly asset: string;
  readonly amount: string;
  readonly to_address: string;
}

export interface WithdrawTokenResult {
  readonly asset: string;
  readonly amount: string;
  readonly to_address: string;
  readonly transfer_id: string;
  readonly remaining_balance: string;
}
