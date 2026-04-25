/**
 * Trader Agent Template — domain types.
 *
 * All monetary amounts (rates, volumes) use bigint internally.
 * Wire-format types in acp-types.ts use string; conversion happens
 * in the command handler layer.
 */

// ---------------------------------------------------------------------------
// Intent States (spec Section 6.1)
// ---------------------------------------------------------------------------

export const INTENT_STATES = [
  'DRAFT', 'ACTIVE', 'MATCHING', 'NEGOTIATING',
  'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'EXPIRED',
] as const;
export type IntentState = (typeof INTENT_STATES)[number];

export const TERMINAL_INTENT_STATES: readonly IntentState[] = ['FILLED', 'CANCELLED', 'EXPIRED'];

export const VALID_INTENT_TRANSITIONS: Record<IntentState, readonly IntentState[]> = {
  DRAFT: ['ACTIVE'],
  ACTIVE: ['MATCHING', 'CANCELLED', 'EXPIRED'],
  MATCHING: ['NEGOTIATING', 'ACTIVE', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED'],
  NEGOTIATING: ['ACTIVE', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED'],
  PARTIALLY_FILLED: ['MATCHING', 'FILLED', 'CANCELLED', 'EXPIRED'],
  FILLED: [],
  CANCELLED: [],
  EXPIRED: [],
} as const;

// ---------------------------------------------------------------------------
// Deal States (spec Section 6.2)
// ---------------------------------------------------------------------------

export const DEAL_STATES = [
  'PROPOSED', 'ACCEPTED', 'EXECUTING',
  'COMPLETED', 'FAILED', 'CANCELLED',
] as const;
export type DealState = (typeof DEAL_STATES)[number];

export const TERMINAL_DEAL_STATES: readonly DealState[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

export const VALID_DEAL_TRANSITIONS: Record<DealState, readonly DealState[]> = {
  PROPOSED: ['ACCEPTED', 'CANCELLED'],
  ACCEPTED: ['EXECUTING', 'COMPLETED', 'FAILED', 'CANCELLED'],
  EXECUTING: ['COMPLETED', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
} as const;

// ---------------------------------------------------------------------------
// TradingIntent (spec Section 2.4, architecture Section 3)
// ---------------------------------------------------------------------------

export interface TradingIntent {
  readonly intent_id: string;
  readonly market_intent_id: string;
  readonly agent_pubkey: string;
  readonly agent_address: string;
  readonly salt: string;
  readonly direction: 'buy' | 'sell';
  readonly base_asset: string;
  readonly quote_asset: string;
  readonly rate_min: bigint;
  readonly rate_max: bigint;
  readonly volume_min: bigint;
  readonly volume_max: bigint;
  readonly volume_filled: bigint;
  readonly escrow_address: string;
  readonly deposit_timeout_sec: number;
  readonly expiry_ms: number;
  readonly signature: string;
}

// ---------------------------------------------------------------------------
// IntentRecord (internal tracking)
// ---------------------------------------------------------------------------

export interface IntentRecord {
  readonly intent: TradingIntent;
  readonly state: IntentState;
  readonly deal_ids: readonly string[];
  readonly updated_at: number;
}

// ---------------------------------------------------------------------------
// DealTerms (spec Section 3.6)
// ---------------------------------------------------------------------------

export interface DealTerms {
  readonly deal_id: string;
  readonly proposer_intent_id: string;
  readonly acceptor_intent_id: string;
  readonly proposer_pubkey: string;
  readonly acceptor_pubkey: string;
  readonly proposer_address: string;
  readonly acceptor_address: string;
  readonly base_asset: string;
  readonly quote_asset: string;
  readonly rate: bigint;
  readonly volume: bigint;
  readonly proposer_direction: 'buy' | 'sell';
  readonly escrow_address: string;
  readonly deposit_timeout_sec: number;
  readonly created_ms: number;
}

// ---------------------------------------------------------------------------
// DealRecord (internal tracking)
// ---------------------------------------------------------------------------

export interface DealRecord {
  readonly terms: DealTerms;
  readonly state: DealState;
  readonly swap_id: string | null;
  readonly acceptor_swap_address: string | null;
  readonly updated_at: number;
  /**
   * Round-17 F1: the counterparty-signed NP-0 envelope that proves this deal
   * was genuinely negotiated. For role=PROPOSER this is the `np.accept_deal`
   * message received from the acceptor; for role=ACCEPTOR this is the
   * `np.propose_deal` message received from the proposer.
   *
   * Verified on `hydrateDeal` during startup reconciliation and before
   * signing `np.reject_deal` in the reconciliation path — an attacker with
   * disk-write access cannot forge the counterparty's secp256k1 signature,
   * so this is the only way we know a persisted record isn't attacker-crafted.
   *
   * Optional during the legacy-migration window: pre-round-17 records on
   * disk have no envelope, and those deals must be treated as
   * unverifiable (skipped, not acted upon).
   */
  readonly counterparty_envelope?: NpMessage;
  /**
   * Round-17 F4: number of times startup reconciliation has failed for this
   * deal. Incremented on saveDeal failure during reconciliation, reset on
   * success. When it exceeds RECONCILIATION_MAX_ATTEMPTS, operators must
   * intervene; reconciliation silently skips (no reject DM) to avoid
   * thrashing on a poisoned record.
   */
  readonly reconciliation_attempts?: number;
}

// ---------------------------------------------------------------------------
// NP-0 message envelope (spec Section 3.4)
// ---------------------------------------------------------------------------

export const NP_MESSAGE_TYPES = [
  'np.propose_deal',
  'np.accept_deal',
  'np.reject_deal',
] as const;
export type NpMessageType = (typeof NP_MESSAGE_TYPES)[number];

export interface NpMessage {
  readonly np_version: '0.1';
  readonly msg_id: string;
  readonly deal_id: string;
  readonly sender_pubkey: string;
  readonly type: NpMessageType;
  readonly ts_ms: number;
  readonly payload: Record<string, unknown>;
  readonly signature: string;
}

// ---------------------------------------------------------------------------
// TraderStrategy (spec Section 4.6)
// ---------------------------------------------------------------------------

export interface TraderStrategy {
  readonly auto_match: boolean;
  readonly auto_negotiate: boolean;
  readonly max_concurrent_swaps: number;
  readonly max_active_intents: number;
  readonly min_search_score: number;
  readonly scan_interval_ms: number;
  readonly market_api_url: string;
  readonly trusted_escrows: readonly string[];
  readonly blocked_counterparties: readonly string[];
}

export const DEFAULT_STRATEGY: TraderStrategy = {
  auto_match: true,
  auto_negotiate: true,
  max_concurrent_swaps: 3,
  max_active_intents: 20,
  min_search_score: 0.6,
  scan_interval_ms: 5000,
  market_api_url: 'https://market-api.unicity.network',
  trusted_escrows: [],
  blocked_counterparties: [],
};

// ---------------------------------------------------------------------------
// Narrow SDK adapter interfaces (Dependency Inversion)
// ---------------------------------------------------------------------------

export interface SdkAssetBalance {
  coinId: string;
  symbol: string;
  confirmedAmount: bigint;
  totalAmount: bigint;
}

export interface SendTokenRequest {
  readonly coinId: string;
  /** Amount as a stringified bigint (matches sphere-sdk's TransferRequest.amount). */
  readonly amount: string;
  /** Recipient: @nametag, DIRECT://<hex>, or x-only hex pubkey. */
  readonly recipient: string;
  readonly memo?: string;
}

export interface SendTokenResult {
  /** Transfer id assigned by PaymentsModule.send (TransferResult.id). */
  readonly transferId: string;
  /** Final / interim status reported by the SDK. */
  readonly status: string;
  /** Optional error string from the SDK when status is non-success. */
  readonly error?: string;
}

export interface PaymentsAdapter {
  getConfirmedBalance(coinId: string): bigint;
  /** Get all asset balances (no filter). */
  getAllBalances(): SdkAssetBalance[];
  /** Trigger a receive to fetch pending Nostr transfers. */
  refresh(): Promise<void>;
  /**
   * Send tokens to a recipient. Implemented by the standalone main.ts via
   * `sphere.payments.send(...)`. Tests inject a stub that records the
   * outgoing request without performing real I/O.
   *
   * Returns the SDK transfer id so callers can record settlement evidence
   * on the deal record. Throws on adapter-level failure (the SDK rejected
   * the request before posting); callers must catch.
   */
  send(request: SendTokenRequest): Promise<SendTokenResult>;
}

// ---------------------------------------------------------------------------
// MarketAdapter — narrow abstraction over Sphere SDK MarketModule
// ---------------------------------------------------------------------------

export interface MarketPostRequest {
  readonly description: string;
  readonly intentType: 'buy' | 'sell';
  readonly category: string;
  readonly price: number;
  readonly currency: string;
  readonly contactHandle: string;
  readonly expiresInDays: number;
}

export interface MarketSearchOptions {
  readonly filters?: MarketSearchFilters;
  readonly limit?: number;
}

export interface MarketSearchFilters {
  readonly intentType?: 'buy' | 'sell';
  readonly category?: string;
  readonly minPrice?: number;
  readonly maxPrice?: number;
  readonly minScore?: number;
}

export interface MarketSearchResult {
  readonly id: string;
  readonly score: number;
  readonly agentNametag?: string;
  readonly agentPublicKey: string;
  readonly description: string;
  readonly intentType: 'buy' | 'sell';
  readonly category?: string;
  readonly price?: number;
  readonly currency: string;
  readonly contactHandle?: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface MarketFeedListing {
  readonly id: string;
  readonly title: string;
  readonly descriptionPreview: string;
  readonly agentName: string;
  readonly agentId: number;
  readonly type: 'buy' | 'sell';
  readonly createdAt: string;
}

export interface MarketMyIntent {
  readonly id: string;
  readonly intentType: 'buy' | 'sell';
  readonly category?: string;
  readonly price?: string;
  readonly currency: string;
  readonly status: 'active' | 'closed' | 'expired';
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface MarketAdapter {
  postIntent(request: MarketPostRequest): Promise<{ intentId: string }>;
  search(query: string, opts?: MarketSearchOptions): Promise<MarketSearchResult[]>;
  subscribeFeed(listener: (listing: MarketFeedListing) => void): () => void;
  getMyIntents(): Promise<MarketMyIntent[]>;
  closeIntent(intentId: string): Promise<void>;
  getRecentListings(): Promise<MarketFeedListing[]>;
}

// ---------------------------------------------------------------------------
// Callback contracts between components
// ---------------------------------------------------------------------------

export type OnMatchFound = (
  ownIntent: IntentRecord,
  counterparty: MarketSearchResult,
) => Promise<void>;

export type OnDealAccepted = (deal: DealRecord) => Promise<void>;

export type OnDealCancelled = (deal: DealRecord) => void;

export type OnSwapCompleted = (
  deal: DealRecord,
  payoutVerified: boolean,
) => Promise<void>;

export type OnSwapFailed = (deal: DealRecord, reason: string) => Promise<void>;
