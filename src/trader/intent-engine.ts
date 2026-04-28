/**
 * IntentEngine — manages the full intent lifecycle: creation, validation,
 * signing, publication via MarketAdapter, background matching scans,
 * feed subscriptions, expiry sweeps, and partial fill handling.
 *
 * Implements the matching rules from protocol spec Section 5 and the
 * intent state machine from Section 6.1.
 */

import { randomBytes, randomInt } from 'node:crypto';

import type { CreateIntentParams } from './acp-types.js';
import type {
  IntentRecord,
  IntentState,
  MarketAdapter,
  MarketFeedListing,
  MarketSearchResult,
  OnMatchFound,
  TradingIntent,
  TraderStrategy,
} from './types.js';
import { VALID_INTENT_TRANSITIONS, TERMINAL_INTENT_STATES } from './types.js';
import type { VolumeReservationLedger } from './volume-reservation-ledger.js';
import {
  computeIntentId,
  encodeDescription,
  parseDescription,
  validateIntentParams,
} from './utils.js';
import { pubkeysEqual, canonicalPubkeyKey } from '../shared/crypto.js';
import type { Logger } from '../shared/logger.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface IntentEngine {
  createIntent(
    params: CreateIntentParams,
    agentPubkey: string,
    agentAddress: string,
  ): Promise<IntentRecord>;
  cancelIntent(intentId: string): Promise<IntentRecord>;
  listIntents(filter?: { state?: IntentState | IntentState[] }): Promise<IntentRecord[]>;
  getIntent(intentId: string): IntentRecord | null;
  /** Restore an intent to ACTIVE after a failed deal (e.g., negotiation timeout). */
  restoreToActive(intentId: string): void;
  /** Mark a counterparty as failed for a given intent so it won't be matched again. */
  markCounterpartyFailed(intentId: string, counterpartyPubkey: string): void;
  /** Record a partial or full fill after a successful swap. */
  recordFill(intentId: string, filledVolume: bigint): void;
  /** Look up an intent by its MarketModule ID (UUID). */
  getIntentByMarketId?(marketIntentId: string): IntentRecord | null;
  /** Update the strategy (e.g., after SET_STRATEGY command). */
  updateStrategy(newStrategy: TraderStrategy): void;
  start(): void;
  stop(): Promise<void>;
}

export interface IntentEngineDeps {
  readonly market: MarketAdapter;
  readonly ledger: VolumeReservationLedger;
  readonly strategy: TraderStrategy;
  readonly agentPubkey: string;
  readonly agentAddress: string;
  /** @nametag for use as contactHandle in market listings. Falls back to agentAddress. */
  readonly agentNametag?: string | null;
  readonly signMessage: (message: string) => string;
  readonly onMatchFound: OnMatchFound;
  readonly logger: Logger;
}

// ---------------------------------------------------------------------------
// State machine guard
// ---------------------------------------------------------------------------

function assertTransition(current: IntentState, target: IntentState): void {
  const allowed = VALID_INTENT_TRANSITIONS[current] as readonly IntentState[];
  if (!allowed.includes(target)) {
    throw new Error(
      `Invalid intent state transition: ${current} -> ${target}. ` +
        `Allowed: [${allowed.join(', ')}]`,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_ESCROW = 'any';
const DEFAULT_DEPOSIT_TIMEOUT_SEC = 300;
const EXPIRY_SWEEP_INTERVAL_MS = 10_000;

function nowMs(): number {
  return Date.now();
}

/** Build the semantic search query for an intent (opposite direction). */
function buildSearchQuery(intent: TradingIntent): string {
  const oppositeVerb = intent.direction === 'buy' ? 'Selling' : 'Buying';
  return `${oppositeVerb} ${intent.base_asset} for ${intent.quote_asset} rate ${intent.rate_min}-${intent.rate_max}`;
}

/** Check if two escrow addresses are compatible (spec 5.1 criterion 7). */
function isEscrowCompatible(
  ownEscrow: string,
  otherEscrow: string,
  trustedEscrows: readonly string[],
): boolean {
  // Both "any" — compatible (strategy trustedEscrows checked separately)
  if (ownEscrow === 'any' || otherEscrow === 'any') return true;
  if (ownEscrow === otherEscrow) return true;

  // If we have a trusted list, the other must be in it
  if (trustedEscrows.length > 0) {
    return trustedEscrows.includes(otherEscrow);
  }
  return false; // different specific escrows with no trusted list
}

/**
 * Determine if we are the proposer for a match (spec 5.7).
 * The agent with the lexicographically LOWER pubkey proposes.
 */
// Proposer selection helper — retained for NegotiationHandler's duplicate deal
// guard (spec 5.7) but no longer used in the IntentEngine scan loop.
// When both agents discover each other simultaneously, the NegotiationHandler
// rejects duplicate proposals via the AGENT_BUSY mechanism.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function weAreProposer(ownPubkey: string, counterpartyPubkey: string): boolean {
  return ownPubkey.toLowerCase() < counterpartyPubkey.toLowerCase();
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createIntentEngine(deps: IntentEngineDeps): IntentEngine {
  const {
    market,
    strategy: initialStrategy,
    agentPubkey,
    signMessage,
    onMatchFound,
    logger,
  } = deps;
  let strategy: TraderStrategy = { ...initialStrategy };
  // Precomputed Set<canonicalPubkeyKey> for blocked_counterparties. Refreshed on
  // every strategy update. Avoids O(n_blocked × m_results × k_intents) pubkeysEqual
  // work on every scan cycle; lookup is O(1). Kept in sync via updateStrategy().
  let blockedCounterpartiesSet = new Set<string>(
    strategy.blocked_counterparties.map(canonicalPubkeyKey),
  );
  const agentNametag = deps.agentNametag ?? null;

  // In-memory intent store, keyed by intent_id
  const intents = new Map<string, IntentRecord>();

  // Per-intent set of counterparty pubkeys that failed (timed out / rejected).
  // Prevents repeatedly matching against the same dead counterparty.
  const failedCounterparties = new Map<string, Set<string>>();

  // Timers
  let scanTimer: ReturnType<typeof setInterval> | null = null;
  let expiryTimer: ReturnType<typeof setInterval> | null = null;
  let feedUnsubscribe: (() => void) | null = null;
  let running = false;

  // Guard against concurrent scan runs
  let scanInProgress = false;

  // ---------------------------------------------------------------------------
  // Internal state helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolve an intent record from EITHER a local intent_id (the SHA-256 hash
   * keyed in `intents`) OR a market_intent_id (UUID assigned by MarketModule
   * when the intent is posted).
   *
   * Why both are accepted: DealTerms carry market IDs by necessity — peers
   * exchange their MarketModule-visible intent IDs in np.propose_deal /
   * np.accept_deal because they don't share each other's local hash IDs. So
   * any callback that runs from a deal-context (onSwapCompleted, onSwapFailed,
   * onDealCancelled) only has market IDs to work with, but the engine's
   * lookup table is local-id-keyed. Without this fallback, every fill record
   * and every state restore on a deal completion silently no-ops, leaving
   * the intent at volume_filled=0 and stuck in MATCHING.
   *
   * Local-id lookup is O(1) via the Map; market-id lookup falls back to a
   * linear scan, which is fine because `intents` is bounded by
   * `strategy.max_active_intents` (default 20).
   */
  function resolveIntentByEitherId(id: string): IntentRecord | undefined {
    const direct = intents.get(id);
    if (direct) return direct;
    for (const record of intents.values()) {
      if (record.intent.market_intent_id === id) return record;
    }
    return undefined;
  }

  function transitionIntent(
    record: IntentRecord,
    target: IntentState,
    updates?: Partial<Pick<TradingIntent, 'volume_filled' | 'market_intent_id'>>,
  ): IntentRecord {
    assertTransition(record.state, target);

    const updatedIntent: TradingIntent = updates
      ? { ...record.intent, ...updates }
      : record.intent;

    const updated: IntentRecord = {
      intent: updatedIntent,
      state: target,
      deal_ids: record.deal_ids,
      updated_at: nowMs(),
    };

    intents.set(updated.intent.intent_id, updated);
    logger.debug('intent_state_transition', {
      intent_id: updated.intent.intent_id,
      from: record.state,
      to: target,
    });
    return updated;
  }

  function getActiveIntentCount(): number {
    let count = 0;
    for (const record of intents.values()) {
      if (!TERMINAL_INTENT_STATES.includes(record.state)) {
        count += 1;
      }
    }
    return count;
  }

  function getMatchableIntents(): IntentRecord[] {
    const result: IntentRecord[] = [];
    for (const record of intents.values()) {
      if (record.state === 'ACTIVE' || record.state === 'PARTIALLY_FILLED') {
        result.push(record);
      }
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Matching logic (spec Section 5)
  // ---------------------------------------------------------------------------

  /**
   * Evaluate a single search result against an own intent.
   * Returns true if all 8 matching criteria pass.
   */
  function matchesCriteria(
    own: TradingIntent,
    result: MarketSearchResult,
  ): boolean {
    // Parse structured fields from the description
    const parsed = parseDescription(result.description);
    if (parsed === null) return false;

    // 1. Opposite direction
    if (own.direction === parsed.direction) return false;

    // 2. Same asset pair
    if (own.base_asset !== parsed.base_asset) return false;
    if (own.quote_asset !== parsed.quote_asset) return false;

    // 3. Overlapping rate ranges
    if (own.rate_min > parsed.rate_max) return false;
    if (parsed.rate_min > own.rate_max) return false;

    // 4. Sufficient volume
    const ownAvailable = own.volume_max - own.volume_filled;
    const otherAvailable = parsed.volume_max - 0n; // search results show max volume; filled unknown, assume 0
    const minRequired =
      own.volume_min > parsed.volume_min ? own.volume_min : parsed.volume_min;
    const availableForTrade =
      ownAvailable < otherAvailable ? ownAvailable : otherAvailable;
    if (availableForTrade < minRequired) return false;

    // 5. Not expired (spec 7.4)
    // Prefer the precise expiry_ms from the description (epoch ms) over the
    // MarketModule's coarse expiresAt (1-day granularity). Legacy descriptions
    // without expiry_ms fall back to the MarketModule field.
    const now = nowMs();
    const MAX_COUNTERPARTY_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
    if (parsed.expiry_ms > 0) {
      if (parsed.expiry_ms <= now) return false;
      // Reject suspiciously far-future expiry (steelman #6)
      if (parsed.expiry_ms > now + MAX_COUNTERPARTY_EXPIRY_MS) return false;
    } else {
      const expiresAt = new Date(result.expiresAt).getTime();
      if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;
    }

    // Own intent must also not be expired
    if (own.expiry_ms <= now) return false;

    // 6. Not self (filter own pubkey) — criterion 8.
    // pubkeysEqual handles format drift: agentPubkey is SDK-canonical (compressed)
    // while result.agentPublicKey may be x-only from market scan. A naive === would
    // let us match against ourselves and trade in a circle through the escrow.
    if (pubkeysEqual(result.agentPublicKey, agentPubkey)) return false;

    // 7. Not blocked. The precomputed Set<canonicalPubkeyKey> handles cross-format
    // match in O(1) — operator-supplied list in any format matches discovery keys.
    if (blockedCounterpartiesSet.has(canonicalPubkeyKey(result.agentPublicKey))) {
      return false;
    }

    // 7b. Not a recently-failed counterparty for this intent.
    // Normalize to a format-independent key so the same peer can't bypass the
    // failed-list by reconnecting with a different pubkey encoding.
    const failed = failedCounterparties.get(own.intent_id);
    if (failed?.has(canonicalPubkeyKey(result.agentPublicKey))) {
      return false;
    }

    // 8. Escrow compatible (criterion 7)
    if (
      !isEscrowCompatible(
        own.escrow_address,
        parsed.escrow_address,
        strategy.trusted_escrows,
      )
    ) {
      return false;
    }

    return true;
  }

  /**
   * Run matching for a single intent against search results.
   * Applies spec Section 5.5 match priority sorting and 5.7 proposer selection.
   */
  async function matchIntentAgainstResults(
    record: IntentRecord,
    results: MarketSearchResult[],
  ): Promise<void> {
    const own = record.intent;

    // Filter to valid matches
    const matches: MarketSearchResult[] = [];
    for (const result of results) {
      if (matchesCriteria(own, result)) {
        matches.push(result);
      }
    }

    if (matches.length === 0) return;

    // Sort by priority (spec 5.5)
    matches.sort((a, b) => {
      const parsedA = parseDescription(a.description);
      const parsedB = parseDescription(b.description);
      if (!parsedA || !parsedB) return 0;

      if (own.direction === 'buy') {
        // Lowest ask first
        if (parsedA.rate_min !== parsedB.rate_min) {
          return parsedA.rate_min < parsedB.rate_min ? -1 : 1;
        }
      } else {
        // Highest bid first
        if (parsedA.rate_max !== parsedB.rate_max) {
          return parsedA.rate_max > parsedB.rate_max ? -1 : 1;
        }
      }

      // Time priority — prefer newest listings (most likely to be live counterparties)
      const timeA = new Date(a.createdAt).getTime();
      const timeB = new Date(b.createdAt).getTime();
      if (timeA !== timeB) return timeB - timeA;

      // Volume preference (larger first — use volume_max from description)
      const volA = parsedA.volume_max;
      const volB = parsedB.volume_max;
      if (volA !== volB) return volA > volB ? -1 : 1;

      return 0;
    });

    // Re-check intent is still matchable (may have changed during async ops)
    const current = intents.get(own.intent_id);
    if (!current || (current.state !== 'ACTIVE' && current.state !== 'PARTIALLY_FILLED')) {
      return;
    }

    logger.info('matches_found', {
      intent_id: own.intent_id,
      count: matches.length,
      counterparties: matches.slice(0, 5).map((m) => m.agentPublicKey.slice(0, 12)),
    });

    // Transition to MATCHING BEFORE fanning out proposals to prevent the next
    // scan cycle from proposing more deals on the same intent
    try {
      transitionIntent(current, 'MATCHING');
    } catch {
      // Intent may have been cancelled/expired between check and transition
      return;
    }

    // Fan-out: propose to ALL matching counterparties in parallel.
    // The NegotiationHandler races them — first to accept wins, rest get cancelled.
    // Dead counterparties simply never respond and their proposals time out harmlessly.
    // Cap at max_concurrent_swaps to avoid flooding.
    const fanOutLimit = Math.max(1, strategy.max_concurrent_swaps * 3);
    const candidates = matches.slice(0, fanOutLimit);

    // F6 — divide remaining volume across fan-out candidates so two
    // concurrent accepts cannot exceed volume_max. Distribute the remainder
    // to a rotated window of candidates so the full remainingVolume is
    // offered; integer truncation would otherwise drop up to
    // (candidates.length - 1) units. Candidates that receive 0n are skipped.
    //
    // F7 — rotate the "+1 remainder" bonus across candidates via a per-scan
    // random offset. The previous implementation deterministically awarded
    // the bonus to the first-sorted candidate, giving an attacker who games
    // the sort keys (rate/time/volume) a small but real preference edge.
    // Uses crypto.randomInt — this is not a security-critical draw per se,
    // but randomInt is the correct primitive (uniform, cryptographically
    // secure) and avoids the Math.random() predictability/modulo-bias
    // concern that static analysis tools flag (round-13 F3).
    const remainingVolume = current.intent.volume_max - current.intent.volume_filled;
    const candidateCountBn = BigInt(candidates.length);
    const baseVolume = remainingVolume / candidateCountBn;
    const remainderVolume = remainingVolume % candidateCountBn;
    const rotationOffset = candidates.length > 0 ? randomInt(candidates.length) : 0;
    const volumeFor = (idx: number): bigint => {
      const rotated = (idx + rotationOffset) % candidates.length;
      return rotated < Number(remainderVolume) ? baseVolume + 1n : baseVolume;
    };

    // If even the smallest share would be zero (i.e. remainingVolume === 0n
    // OR there is nothing left to distribute), skip the fan-out entirely
    // and restore the intent to ACTIVE.
    if (remainingVolume <= 0n) {
      logger.info('fan_out_skipped_zero_remaining_volume', {
        intent_id: own.intent_id,
        remaining_volume: remainingVolume.toString(),
        candidate_count: candidates.length,
      });
      // Restore the intent to ACTIVE if we were just moved to MATCHING above.
      const currentAfter = intents.get(own.intent_id);
      if (currentAfter?.state === 'MATCHING') {
        try { transitionIntent(currentAfter, 'ACTIVE'); } catch { /* best effort */ }
      }
      return;
    }

    // Build the per-candidate volume list, skipping candidates whose share
    // would be zero (only happens when remainingVolume < candidates.length
    // for the tail candidates after the remainder is exhausted).
    const candidatesWithVolume: Array<MarketSearchResult & { __perCandidateVolume?: bigint }> = [];
    for (let i = 0; i < candidates.length; i += 1) {
      const share = volumeFor(i);
      if (share <= 0n) continue;
      const entry = candidates[i];
      if (!entry) continue;
      candidatesWithVolume.push({ ...entry, __perCandidateVolume: share });
    }

    if (candidatesWithVolume.length === 0) {
      logger.info('fan_out_skipped_zero_per_candidate_volume', {
        intent_id: own.intent_id,
        remaining_volume: remainingVolume.toString(),
        candidate_count: candidates.length,
      });
      const currentAfter = intents.get(own.intent_id);
      if (currentAfter?.state === 'MATCHING') {
        try { transitionIntent(currentAfter, 'ACTIVE'); } catch { /* best effort */ }
      }
      return;
    }

    const settled = await Promise.allSettled(
      candidatesWithVolume.map((counterparty) => onMatchFound(current, counterparty)),
    );

    const succeeded = settled.filter((r) => r.status === 'fulfilled').length;
    const failed = settled.filter((r) => r.status === 'rejected').length;
    for (const result of settled) {
      if (result.status === 'rejected') {
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        logger.debug('fan_out_proposal_failed', {
          intent_id: own.intent_id,
          error: message,
        });
      }
    }
    logger.info('fan_out_complete', {
      intent_id: own.intent_id,
      total: candidates.length,
      succeeded,
      failed,
    });

    // Only restore to ACTIVE if the intent is still in MATCHING AND no live
    // (non-terminal) deals exist for it. If even one proposal created a deal
    // that's still PROPOSED, the intent must stay in MATCHING until that deal
    // resolves via onDealCancelled (steelman R2 #1).
    const currentAfterFanOut = intents.get(own.intent_id);
    if (currentAfterFanOut?.state === 'MATCHING' && succeeded === 0) {
      try {
        transitionIntent(currentAfterFanOut, 'ACTIVE');
        logger.info('intent_restored_after_fan_out_failure', { intent_id: own.intent_id });
      } catch {
        // May have been cancelled/expired concurrently
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Scan loop
  // ---------------------------------------------------------------------------

  async function scanForMatches(): Promise<void> {
    if (scanInProgress) return;
    if (!strategy.auto_match) return;

    scanInProgress = true;
    try {
      const matchable = getMatchableIntents();
      if (matchable.length === 0) return;

      for (const record of matchable) {
        // Re-check still matchable (previous iteration may have changed state)
        const current = intents.get(record.intent.intent_id);
        if (!current || (current.state !== 'ACTIVE' && current.state !== 'PARTIALLY_FILLED')) {
          continue;
        }

        // Check expiry before scanning
        if (current.intent.expiry_ms <= nowMs()) continue;

        const query = buildSearchQuery(current.intent);
        const oppositeType = current.intent.direction === 'buy' ? 'sell' : 'buy';

        try {
          const results = await market.search(query, {
            filters: {
              intentType: oppositeType,
              category: `${current.intent.base_asset}/${current.intent.quote_asset}`,
              minScore: strategy.min_search_score,
            },
            limit: 50,
          });

          await matchIntentAgainstResults(current, results);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error('scan_search_error', {
            intent_id: current.intent.intent_id,
            error: message,
          });
        }
      }
    } finally {
      scanInProgress = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Feed subscription
  // ---------------------------------------------------------------------------

  function handleFeedListing(listing: MarketFeedListing): void {
    // Only process feed listings when auto_match is enabled — otherwise
    // the agent only accepts incoming proposals, never initiates matching.
    if (!strategy.auto_match) return;

    // For each feed listing, evaluate against all active intents
    const matchable = getMatchableIntents();
    if (matchable.length === 0) return;

    // We need full search results to match; the feed listing has limited info.
    // Trigger a search for each matchable intent that could match this listing.
    for (const record of matchable) {
      const own = record.intent;

      // Quick pre-filter: opposite direction
      if (own.direction === listing.type) continue;

      // Trigger an async search for this intent
      const query = buildSearchQuery(own);
      const oppositeType = own.direction === 'buy' ? 'sell' : 'buy';

      market
        .search(query, {
          filters: {
            intentType: oppositeType,
            category: `${own.base_asset}/${own.quote_asset}`,
            minScore: strategy.min_search_score,
          },
          limit: 50,
        })
        .then((results) => matchIntentAgainstResults(record, results))
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.error('feed_search_error', {
            intent_id: own.intent_id,
            listing_id: listing.id,
            error: message,
          });
        });
    }
  }

  function subscribeFeed(): void {
    try {
      feedUnsubscribe = market.subscribeFeed(handleFeedListing);
      logger.info('feed_subscribed');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('feed_subscribe_failed', { error: message });

      // Fallback: fetch recent listings once
      fetchRecentListings();
    }
  }

  function fetchRecentListings(): void {
    market
      .getRecentListings()
      .then((listings) => {
        for (const listing of listings) {
          handleFeedListing(listing);
        }
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn('get_recent_listings_failed', { error: message });
      });
  }

  // ---------------------------------------------------------------------------
  // Expiry sweep (spec 7.4)
  // ---------------------------------------------------------------------------

  function sweepExpired(): void {
    const now = nowMs();

    for (const record of intents.values()) {
      // Only ACTIVE and PARTIALLY_FILLED can expire
      if (record.state !== 'ACTIVE' && record.state !== 'PARTIALLY_FILLED') {
        continue;
      }

      if (record.intent.expiry_ms > now) continue;

      logger.info('intent_expired', {
        intent_id: record.intent.intent_id,
        expiry_ms: record.intent.expiry_ms,
      });

      try {
        transitionIntent(record, 'EXPIRED');
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('expiry_transition_failed', {
          intent_id: record.intent.intent_id,
          error: message,
        });
        continue;
      }

      // Close on market
      market.closeIntent(record.intent.market_intent_id).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('close_expired_intent_failed', {
          intent_id: record.intent.intent_id,
          market_intent_id: record.intent.market_intent_id,
          error: message,
        });
      });
    }

    // Purge terminal intents older than 5 minutes to avoid unbounded memory growth
    const purgeThreshold = now - 5 * 60 * 1000;
    for (const [id, record] of intents) {
      if (TERMINAL_INTENT_STATES.includes(record.state) && record.updated_at < purgeThreshold) {
        intents.delete(id);
        failedCounterparties.delete(id);
        logger.debug('intent_purged', { intent_id: id, state: record.state });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  const engine: IntentEngine = {
    async createIntent(
      params: CreateIntentParams,
      pubkey: string,
      address: string,
    ): Promise<IntentRecord> {
      // Validate params
      const validationError = validateIntentParams(params);
      if (validationError !== null) {
        throw new Error(`Invalid intent params: ${validationError}`);
      }

      // Check max_active_intents
      if (getActiveIntentCount() >= strategy.max_active_intents) {
        throw new Error(
          `Max active intents reached (${String(strategy.max_active_intents)}). ` +
            'Cancel or wait for existing intents to complete.',
        );
      }

      // Generate salt (16 random bytes → 32 hex chars)
      const salt = randomBytes(16).toString('hex');

      // Compute expiry_ms from expiry_sec
      const expiryMs = nowMs() + params.expiry_sec * 1000;

      // Build intent fields for ID computation
      const rateMin = BigInt(params.rate_min);
      const rateMax = BigInt(params.rate_max);
      const volumeMin = BigInt(params.volume_min);
      const volumeMax = BigInt(params.volume_max);
      const escrowAddress = params.escrow_address ?? DEFAULT_ESCROW;
      const depositTimeoutSec = params.deposit_timeout_sec ?? DEFAULT_DEPOSIT_TIMEOUT_SEC;

      const createdMs = nowMs();
      const intentFields = {
        agent_pubkey: pubkey,
        agent_address: address,
        salt,
        direction: params.direction,
        base_asset: params.base_asset,
        quote_asset: params.quote_asset,
        rate_min: rateMin,
        rate_max: rateMax,
        volume_min: volumeMin,
        volume_max: volumeMax,
        escrow_address: escrowAddress,
        deposit_timeout_sec: depositTimeoutSec,
        expiry_ms: expiryMs,
        created_ms: createdMs,
      };

      // Compute intent_id
      const intentId = computeIntentId(intentFields);

      // Sign the intent_id
      const signature = signMessage(intentId);

      // Build the full TradingIntent (DRAFT state, no market_intent_id yet)
      const tradingIntent: TradingIntent = {
        intent_id: intentId,
        market_intent_id: '', // will be set after posting
        agent_pubkey: pubkey,
        agent_address: address,
        salt,
        direction: params.direction,
        base_asset: params.base_asset,
        quote_asset: params.quote_asset,
        rate_min: rateMin,
        rate_max: rateMax,
        volume_min: volumeMin,
        volume_max: volumeMax,
        volume_filled: 0n,
        escrow_address: escrowAddress,
        deposit_timeout_sec: depositTimeoutSec,
        expiry_ms: expiryMs,
        signature,
      };

      // Create draft record
      const draftRecord: IntentRecord = {
        intent: tradingIntent,
        state: 'DRAFT',
        deal_ids: [],
        updated_at: nowMs(),
      };
      intents.set(intentId, draftRecord);

      // Transition DRAFT → ACTIVE (validates transition)
      // Build description for market posting
      const description = encodeDescription(tradingIntent);
      const midpointRate = Number((rateMin + rateMax) / 2n);
      const expiresInDays = Math.max(
        1,
        Math.ceil((expiryMs - nowMs()) / 86_400_000),
      );

      let marketIntentId: string;
      try {
        const postResult = await market.postIntent({
          description,
          intentType: params.direction,
          category: `${params.base_asset}/${params.quote_asset}`,
          price: midpointRate,
          currency: params.quote_asset,
          // Prefer @nametag for contactHandle — it resolves faster than DIRECT://
          // which requires a binding event lookup that may not have propagated yet.
          contactHandle: agentNametag ? `@${agentNametag}` : address,
          expiresInDays,
        });
        marketIntentId = postResult.intentId;
      } catch (err: unknown) {
        // Failed to post — remove draft
        intents.delete(intentId);
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to post intent to market: ${message}`);
      }

      // Transition to ACTIVE with market_intent_id
      const activeRecord = transitionIntent(draftRecord, 'ACTIVE', {
        market_intent_id: marketIntentId,
      });

      logger.info('intent_created', {
        intent_id: intentId,
        market_intent_id: marketIntentId,
        direction: params.direction,
        base_asset: params.base_asset,
        quote_asset: params.quote_asset,
        rate_min: rateMin.toString(),
        rate_max: rateMax.toString(),
        volume_min: volumeMin.toString(),
        volume_max: volumeMax.toString(),
        expiry_ms: expiryMs,
      });

      return activeRecord;
    },

    async cancelIntent(intentId: string): Promise<IntentRecord> {
      const record = intents.get(intentId);
      if (!record) {
        throw new Error(`Intent not found: ${intentId}`);
      }

      if (TERMINAL_INTENT_STATES.includes(record.state)) {
        throw new Error(
          `Cannot cancel intent in terminal state: ${record.state}`,
        );
      }

      // Transition to CANCELLED (validates transition)
      const cancelled = transitionIntent(record, 'CANCELLED');

      // Close on market
      if (record.intent.market_intent_id) {
        market.closeIntent(record.intent.market_intent_id).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.error('close_cancelled_intent_failed', {
            intent_id: intentId,
            market_intent_id: record.intent.market_intent_id,
            error: message,
          });
        });
      }

      logger.info('intent_cancelled', {
        intent_id: intentId,
        previous_state: record.state,
        volume_filled: record.intent.volume_filled.toString(),
      });

      return cancelled;
    },

    async listIntents(
      filter?: { state?: IntentState | IntentState[] },
    ): Promise<IntentRecord[]> {
      const results: IntentRecord[] = [];

      for (const record of intents.values()) {
        if (filter?.state !== undefined) {
          const states = Array.isArray(filter.state)
            ? filter.state
            : [filter.state];
          if (!states.includes(record.state)) continue;
        }
        results.push(record);
      }

      // Sort by updated_at descending
      results.sort((a, b) => b.updated_at - a.updated_at);
      return results;
    },

    getIntent(intentId: string): IntentRecord | null {
      return intents.get(intentId) ?? null;
    },

    getIntentByMarketId(marketIntentId: string): IntentRecord | null {
      for (const record of intents.values()) {
        if (record.intent.market_intent_id === marketIntentId) return record;
      }
      return null;
    },

    restoreToActive(intentId: string): void {
      const record = resolveIntentByEitherId(intentId);
      if (!record) return;
      if (record.state === 'MATCHING' || record.state === 'NEGOTIATING') {
        try {
          transitionIntent(record, 'ACTIVE');
          logger.info('intent_restored_to_active', { intent_id: record.intent.intent_id });
        } catch {
          // Transition failed — intent may have been cancelled/expired
        }
      }
    },

    markCounterpartyFailed(intentId: string, counterpartyPubkey: string): void {
      // Resolve to the LOCAL intent_id so the failed-counterparty Set is
      // keyed consistently regardless of whether the caller passed a local
      // or a market intent_id (DealTerms carry market IDs).
      const record = resolveIntentByEitherId(intentId);
      const localId = record?.intent.intent_id ?? intentId;

      const MAX_FAILED_PER_INTENT = 1000;
      let set = failedCounterparties.get(localId);
      if (!set) {
        set = new Set();
        failedCounterparties.set(localId, set);
      }
      // Use canonical form so a peer can't re-engage by presenting a different
      // pubkey encoding of the same identity.
      const key = canonicalPubkeyKey(counterpartyPubkey);
      // LRU semantics: if this peer is already on the list, delete+re-add
      // refreshes their position (most-recently-failed). This ensures actively
      // failing peers stay blocked even as new failures push the oldest out.
      if (set.has(key)) {
        set.delete(key);
      } else if (set.size >= MAX_FAILED_PER_INTENT) {
        // Capacity eviction: drop the LEAST-recently-failed (first-inserted under
        // LRU ordering) to make room. Set iteration order is insertion order, and
        // the delete+re-add pattern above moves refreshed peers to the end.
        const oldest = set.values().next().value;
        if (oldest !== undefined) set.delete(oldest);
      }
      set.add(key);
      logger.info('counterparty_marked_failed', { intent_id: localId, counterparty: counterpartyPubkey });
    },

    recordFill(intentId: string, filledVolume: bigint): void {
      const record = resolveIntentByEitherId(intentId);
      if (!record) return;
      const newFilled = record.intent.volume_filled + filledVolume;
      const remaining = record.intent.volume_max - newFilled;
      const targetState: IntentState =
        (remaining <= 0n || remaining < record.intent.volume_min)
          ? 'FILLED'
          : 'PARTIALLY_FILLED';
      transitionIntent(record, targetState, { volume_filled: newFilled });
      logger.info('intent_fill_recorded', {
        intent_id: intentId,
        filled_volume: filledVolume.toString(),
        total_filled: newFilled.toString(),
        new_state: targetState,
      });

      // Close fully filled intents on the MarketModule so other agents stop matching against them
      if (targetState === 'FILLED') {
        market.closeIntent(record.intent.market_intent_id).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.error('close_filled_intent_failed', {
            intent_id: intentId,
            market_intent_id: record.intent.market_intent_id,
            error: message,
          });
        });
      }
    },

    start(): void {
      if (running) return;
      running = true;

      // Start scan loop
      scanTimer = setInterval(() => {
        scanForMatches().catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.error('scan_loop_error', { error: message });
        });
      }, strategy.scan_interval_ms);

      // Start expiry sweep
      expiryTimer = setInterval(sweepExpired, EXPIRY_SWEEP_INTERVAL_MS);

      // Subscribe to feed
      subscribeFeed();

      // Also fetch recent listings as a fallback on startup
      fetchRecentListings();

      logger.info('intent_engine_started', {
        scan_interval_ms: strategy.scan_interval_ms,
        max_active_intents: strategy.max_active_intents,
      });
    },

    async stop(): Promise<void> {
      if (!running) return;
      running = false;

      if (scanTimer !== null) {
        clearInterval(scanTimer);
        scanTimer = null;
      }

      if (expiryTimer !== null) {
        clearInterval(expiryTimer);
        expiryTimer = null;
      }

      if (feedUnsubscribe !== null) {
        feedUnsubscribe();
        feedUnsubscribe = null;
      }

      // Close all non-terminal intents on the MarketModule so stale listings
      // don't persist after the container shuts down. Await with a timeout so
      // shutdown doesn't hang if the market adapter is unresponsive (steelman #8).
      const SHUTDOWN_CLOSE_TIMEOUT_MS = 5_000;
      const closePromises: Promise<void>[] = [];
      for (const record of intents.values()) {
        if (!TERMINAL_INTENT_STATES.includes(record.state)) {
          const intentId = record.intent.intent_id;
          const marketId = record.intent.market_intent_id;
          closePromises.push(
            new Promise<void>((resolve) => {
              let settled = false;
              const timer = setTimeout(() => {
                if (!settled) {
                  settled = true;
                  logger.warn('close_intent_on_shutdown_timeout', { intent_id: intentId });
                  resolve();
                }
              }, SHUTDOWN_CLOSE_TIMEOUT_MS);
              market.closeIntent(marketId).then(
                () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } },
                (err: unknown) => {
                  if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    const message = err instanceof Error ? err.message : String(err);
                    logger.warn('close_intent_on_shutdown_failed', { intent_id: intentId, error: message });
                    resolve();
                  }
                },
              );
            }),
          );
        }
      }
      if (closePromises.length > 0) {
        await Promise.allSettled(closePromises);
      }

      logger.info('intent_engine_stopped');
    },

    updateStrategy(newStrategy: TraderStrategy): void {
      strategy = { ...newStrategy };
      // Rebuild the precomputed blocked-set so lookups stay O(1) after strategy changes.
      blockedCounterpartiesSet = new Set<string>(
        strategy.blocked_counterparties.map(canonicalPubkeyKey),
      );
      logger.info('intent_engine_strategy_updated', {
        auto_match: strategy.auto_match,
        auto_negotiate: strategy.auto_negotiate,
      });
    },
  };

  return engine;
}
