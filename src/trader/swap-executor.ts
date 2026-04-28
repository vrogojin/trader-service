/**
 * SwapExecutor — deal tracker and proposer for the NP-0 → SDK swap bridge.
 *
 * The SDK's SwapModule handles the full swap lifecycle (accept, deposit,
 * payout, completion) via direct sphere.on() listeners wired in main.ts.
 * This executor only:
 * - Proposes swaps for deals we initiated (proposeSwap) — proposer path
 * - Tracks active deal→swap mappings for LIST_SWAPS and DEBUG_SWAP_EXEC
 * - Relays swap completion/failure events to NP-0 callbacks
 * - Enforces concurrent swap limit from strategy
 *
 * The acceptor path is handled entirely by the SDK: main.ts auto-accepts
 * incoming swap proposals via sphere.on('swap:proposal_received').
 *
 * Spec references: Section 6.2 (deal state machine), Section 7.9.1–7.9.5
 */

import { pubkeysEqual } from '../shared/crypto.js';
import type { Logger } from '../shared/logger.js';
import type {
  DealRecord,
  DealState,
  TraderStrategy,
  OnSwapCompleted,
  OnSwapFailed,
} from './types.js';
import { VALID_DEAL_TRANSITIONS } from './types.js';

// ---------------------------------------------------------------------------
// SwapAdapter — narrow abstraction over Sphere SDK SwapModule
// ---------------------------------------------------------------------------

export interface SwapAdapter {
  proposeSwap(deal: SwapDealInput): Promise<{ swapId: string }>;
  acceptSwap(swapId: string): Promise<void>;
  rejectSwap(swapId: string, reason?: string): Promise<void>;
  /** Deposit our tokens into the escrow's deposit invoice. Called after 'announced'. */
  deposit(swapId: string): Promise<void>;
  /** Verify the payout invoice from the escrow. Called after 'payout_received'. */
  verifyPayout(swapId: string): Promise<boolean>;
  /** Wait for background operations (e.g. change token persistence) to complete. */
  waitForPendingOperations?(): Promise<void>;
}

export interface SwapDealInput {
  partyA: string;
  partyB: string;
  partyACurrency: string;
  partyAAmount: string;
  partyBCurrency: string;
  partyBAmount: string;
  timeout: number;
  escrowAddress?: string;
}

// ---------------------------------------------------------------------------
// SwapExecutor interface
// ---------------------------------------------------------------------------

/**
 * Identifying info for matching an incoming swap proposal to a tracked
 * NP-0 deal on the acceptor path (C16). Previously the executor picked
 * "the one deal with null swapId" — that heuristic breaks when there
 * are two concurrent acceptor deals and silently binds the wrong swap
 * to the wrong deal, potentially routing funds to the wrong counterparty.
 */
export interface SwapProposalMatchInfo {
  /** Currency that partyA (proposer) deposits. */
  partyACurrency?: string;
  /** Amount that partyA deposits (stringified bigint). */
  partyAAmount?: string;
  /** Currency that partyB (acceptor — us) deposits. */
  partyBCurrency?: string;
  /** Amount that partyB deposits (stringified bigint). */
  partyBAmount?: string;
  /** Pubkey of the counterparty (proposer), for disambiguation. */
  counterpartyPubkey?: string;
  /**
   * SECURITY (spec 7.9.4 / H1): escrow address advertised by the SDK swap
   * proposal. Compared against the negotiated DealTerms.escrow_address — a
   * mismatch means the counterparty pivoted to a different escrow at the
   * SDK layer than what was negotiated, defeating the trusted_escrows
   * allowlist. Reject on mismatch.
   */
  escrowDirectAddress?: string;
  /** Escrow chain pubkey (alternate identification when DIRECT addresses don't match). */
  escrowPubkey?: string;
  /**
   * SECURITY (spec 7.9.4 / H1): deposit timeout from the SDK proposal, in
   * seconds. Compared against DealTerms.deposit_timeout_sec; a hostile
   * counterparty who lengthens the timeout shifts the funds-at-risk window.
   */
  depositTimeoutSec?: number;
}

export interface SwapExecutor {
  /**
   * Execute a deal that has been accepted via NP-0 negotiation.
   * For proposers: calls proposeSwap and tracks the deal.
   * For acceptors: tracks the deal (SDK handles acceptance via sphere.on).
   */
  executeDeal(deal: DealRecord): Promise<void>;

  /**
   * Associate an SDK swapId with a tracked deal (acceptor path where swapId
   * arrives later). When `match` is provided, the executor uses asset/amount/
   * counterparty fields to identify the correct deal. If no unambiguous match
   * is found, assignment is skipped and a warning is logged (C16).
   *
   * F3: Returns `true` if a matching LIVE NP-0 deal (in ACCEPTED or EXECUTING
   * state) was found and bound to the swapId, OR if no match was found at all
   * (no candidate, no action needed). Returns `false` when a candidate deal
   * exists but is NOT in a LIVE state (e.g. CANCELLED because the accept DM
   * send failed) — the caller MUST treat this as a block signal and reject
   * the incoming swap via the SDK. Without this gate, a counterparty who
   * observed the (partially-flushed) accept DM could proceed to proposeSwap
   * and the SDK would auto-accept it, moving funds despite our NP-0 state
   * indicating we should no longer be ready to execute.
   */
  registerSwapId(swapId: string, match?: SwapProposalMatchInfo): boolean;

  /** Notify the tracker that a swap completed (called from main.ts sphere.on handler). */
  handleSwapCompleted(swapId: string, payoutVerified: boolean): void;

  /** Notify the tracker that a swap failed (called from main.ts sphere.on handler). */
  handleSwapFailed(swapId: string, reason: string): void;

  /** Get active deal count. */
  getActiveCount(): number;

  /** Get active deal summaries for debugging. */
  getActiveDeals(): Array<{ deal_id: string; swap_id: string | null; state: string }>;
  /** Get recent errors for debugging. */
  getLastErrors(): Array<{ ts: number; deal_id: string; error: string }>;

  /**
   * Replace the executor's strategy snapshot. Called from the SET_STRATEGY
   * command handler so changes to `max_concurrent_swaps`, `trusted_escrows`,
   * etc. take effect at runtime. Without this, the executor keeps the
   * startup snapshot and operators see "set-strategy didn't take effect"
   * until the trader restarts.
   */
  updateStrategy(newStrategy: TraderStrategy): void;

  /** Stop all pending operations. */
  stop(): void;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** Minimal payments interface needed by SwapExecutor for post-swap token receive. */
export interface SwapPaymentsAdapter {
  /** Trigger receive({ finalize: true }) to pick up payout tokens via DM. */
  receive(): Promise<void>;
}

export interface SwapExecutorDeps {
  swap: SwapAdapter;
  strategy: TraderStrategy;
  onSwapCompleted: OnSwapCompleted;
  onSwapFailed: OnSwapFailed;
  agentPubkey: string;
  agentAddress: string;
  /** Direct address (DIRECT://...) for swap proposals — avoids nametag resolution issues. */
  swapDirectAddress: string;
  /** Optional payments adapter for explicit receive after swap completion. */
  payments?: SwapPaymentsAdapter;
  logger: Logger;
}

// ---------------------------------------------------------------------------
// Internal tracking for active deals
// ---------------------------------------------------------------------------

interface ActiveDeal {
  deal: DealRecord;
  swapId: string | null;
  /** Execution timeout timer — transitions to FAILED if swap takes too long. */
  executionTimer?: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function transitionDeal(deal: DealRecord, newState: DealState, swapId?: string | null): DealRecord {
  const allowed = VALID_DEAL_TRANSITIONS[deal.state] as readonly DealState[];
  if (!allowed.includes(newState)) {
    throw new Error(
      `Invalid deal state transition: ${deal.state} -> ${newState}. ` +
        `Allowed: [${allowed.join(', ')}]`,
    );
  }
  return {
    ...deal,
    state: newState,
    swap_id: swapId !== undefined ? swapId : deal.swap_id,
    updated_at: Date.now(),
  };
}

/**
 * Build a SwapDealInput from deal terms.
 *
 * The proposer is partyA, the acceptor is partyB.
 * Which asset each party deposits depends on proposer_direction:
 *   - If proposer is SELLING base_asset: partyA deposits base, partyB deposits quote.
 *   - If proposer is BUYING base_asset: partyA deposits quote, partyB deposits base.
 *
 * Exported so callers (e.g. trader-main.ts onDealAccepted) can use it directly.
 */
export function buildSwapDealInput(
  deal: DealRecord,
  agentPubkey: string,
  agentAddress: string,
): SwapDealInput {
  const { terms } = deal;
  // Use pubkeysEqual to handle format drift between terms.*_pubkey (wire format,
  // possibly x-only) and agentPubkey (SDK-canonical, possibly compressed).
  const isProposer = pubkeysEqual(terms.proposer_pubkey, agentPubkey);

  const ourAddress = agentAddress;
  const theirAddress = isProposer ? terms.acceptor_address : terms.proposer_address;

  const baseAmount = terms.volume.toString();
  const quoteAmount = (terms.rate * terms.volume).toString();

  const proposerSellsBase = terms.proposer_direction === 'sell';

  return {
    partyA: isProposer ? ourAddress : theirAddress,
    partyB: isProposer ? theirAddress : ourAddress,
    partyACurrency: proposerSellsBase ? terms.base_asset : terms.quote_asset,
    partyAAmount: proposerSellsBase ? baseAmount : quoteAmount,
    partyBCurrency: proposerSellsBase ? terms.quote_asset : terms.base_asset,
    partyBAmount: proposerSellsBase ? quoteAmount : baseAmount,
    timeout: terms.deposit_timeout_sec,
    escrowAddress: terms.escrow_address,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSwapExecutor(deps: SwapExecutorDeps): SwapExecutor {
  const { swap, onSwapCompleted, onSwapFailed, agentPubkey, agentAddress, logger } = deps;
  // C1 (steelman round-4): keep `strategy` mutable so SET_STRATEGY changes
  // propagate at runtime via updateStrategy(). All callsites read through
  // this binding (NOT a destructured copy), so they see the current values.
  let strategy: TraderStrategy = { ...deps.strategy };
  // Use directAddress for swap proposals to avoid nametag resolution timing issues
  // in bundled/containerized environments. Falls back to agentAddress if not provided.
  const swapAddress = deps.swapDirectAddress || agentAddress;

  /** swapId -> ActiveDeal */
  const activeBySwapId = new Map<string, ActiveDeal>();

  /** deal_id -> ActiveDeal (indexed by deal_id for proposal matching) */
  const activeByDealId = new Map<string, ActiveDeal>();

  let stopped = false;

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  const lastErrors: Array<{ ts: number; deal_id: string; error: string }> = [];
  const MAX_LAST_ERRORS = 10;
  function recordError(dealId: string, error: string): void {
    lastErrors.push({ ts: Date.now(), deal_id: dealId, error });
    if (lastErrors.length > MAX_LAST_ERRORS) lastErrors.shift();
  }

  /** Extra grace period on top of deposit_timeout_sec for the full swap to complete. */
  const EXECUTION_TIMEOUT_GRACE_SEC = 120;
  /**
   * Hard upper bound on deposit_timeout_sec used to compute the execution
   * timer. Without this, a malicious counterparty can supply
   * `deposit_timeout_sec: Number.MAX_SAFE_INTEGER` and park the deal in
   * EXECUTING forever, leaking a volume reservation (warning fix).
   */
  const MAX_DEPOSIT_TIMEOUT_SEC = 3600;

  function startExecutionTimer(entry: ActiveDeal): void {
    const rawTimeoutSec = entry.deal.terms.deposit_timeout_sec;
    const clampedTimeoutSec = Math.min(
      Number.isFinite(rawTimeoutSec) ? rawTimeoutSec : MAX_DEPOSIT_TIMEOUT_SEC,
      MAX_DEPOSIT_TIMEOUT_SEC,
    );
    const timeoutMs = (clampedTimeoutSec + EXECUTION_TIMEOUT_GRACE_SEC) * 1000;
    if (clampedTimeoutSec !== rawTimeoutSec) {
      logger.warn('deposit_timeout_clamped', {
        deal_id: entry.deal.terms.deal_id,
        requested_sec: rawTimeoutSec,
        clamped_sec: clampedTimeoutSec,
      });
    }
    entry.executionTimer = setTimeout(() => {
      if (stopped) return;
      const dealId = entry.deal.terms.deal_id;
      const swapId = entry.swapId;
      logger.error('execution_timeout', {
        deal_id: dealId,
        swap_id: swapId,
        timeout_sec: clampedTimeoutSec + EXECUTION_TIMEOUT_GRACE_SEC,
      });
      entry.deal = transitionDeal(entry.deal, 'FAILED');
      // SECURITY (C3): cancel the SDK swap BEFORE unregistering. Without
      // this, a swap that completes after the timeout would emit
      // swap:completed for a swapId no longer in activeBySwapId — the
      // handler logs and drops, but the escrow has already moved funds.
      // Result: ledger says FAILED, chain says COMPLETED, fill never
      // recorded. Best-effort: if rejectSwap fails (already terminal,
      // network), log and continue — the failure-path semantics still
      // hold from the trader's perspective; reconciliation surfaces the
      // discrepancy.
      if (swapId !== null) {
        deps.swap.rejectSwap(swapId, 'EXECUTION_TIMEOUT').catch((err: unknown) => {
          logger.warn('execution_timeout_reject_failed', {
            deal_id: dealId,
            swap_id: swapId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
      unregisterActive(entry);
      void onSwapFailed(entry.deal, 'EXECUTION_TIMEOUT').catch((err: unknown) => {
        logger.error('on_swap_failed_callback_error', {
          deal_id: dealId,
          error: String(err),
        });
      });
    }, timeoutMs);
  }

  function clearExecutionTimer(entry: ActiveDeal): void {
    if (entry.executionTimer) {
      clearTimeout(entry.executionTimer);
      entry.executionTimer = undefined;
    }
  }

  function registerActive(entry: ActiveDeal): void {
    activeByDealId.set(entry.deal.terms.deal_id, entry);
    if (entry.swapId) {
      activeBySwapId.set(entry.swapId, entry);
    }
  }

  function unregisterActive(entry: ActiveDeal): void {
    activeByDealId.delete(entry.deal.terms.deal_id);
    if (entry.swapId) {
      activeBySwapId.delete(entry.swapId);
    }
  }

  function getActiveCount(): number {
    return activeByDealId.size;
  }

  // -----------------------------------------------------------------------
  // Public methods
  // -----------------------------------------------------------------------

  async function executeDeal(deal: DealRecord): Promise<void> {
    if (stopped) return;

    // 1. Verify deal is in ACCEPTED state
    if (deal.state !== 'ACCEPTED') {
      logger.warn('execute_deal_invalid_state', {
        deal_id: deal.terms.deal_id,
        state: deal.state,
        expected: 'ACCEPTED',
      });
      return;
    }

    // 2. Concurrent swap limit
    if (getActiveCount() >= strategy.max_concurrent_swaps) {
      logger.info('execute_deal_concurrent_limit', {
        deal_id: deal.terms.deal_id,
        active: getActiveCount(),
        max: strategy.max_concurrent_swaps,
      });
      return;
    }

    // 3. Only the NP-0 deal PROPOSER initiates the swap-level proposal.
    //    The acceptor's swap is handled entirely by the SDK — main.ts
    //    auto-accepts via sphere.on('swap:proposal_received').
    const isNpProposer = pubkeysEqual(deal.terms.proposer_pubkey, agentPubkey);
    if (!isNpProposer) {
      logger.info('execute_deal_acceptor_tracking', {
        deal_id: deal.terms.deal_id,
        note: 'Acceptor tracked — SDK auto-accepts via sphere.on(swap:proposal_received)',
      });
      const entry: ActiveDeal = { deal: transitionDeal(deal, 'EXECUTING'), swapId: null };
      registerActive(entry);
      startExecutionTimer(entry);
      return;
    }

    // 4. Build SwapDealInput from DealTerms (proposer only)
    const swapDealInput = buildSwapDealInput(deal, agentPubkey, swapAddress);

    // DIAGNOSTIC: log the full SwapDealInput so we can verify direction-to-
    // currency mapping. Bug-suspicion: if proposer is direction='buy' but
    // partyACurrency lands on base_asset (UCT) instead of quote_asset (USDU),
    // the buyer ends up depositing the wrong currency.
    logger.info('swap_propose_input_diag', {
      deal_id: deal.terms.deal_id,
      proposer_direction: deal.terms.proposer_direction,
      base_asset: deal.terms.base_asset,
      quote_asset: deal.terms.quote_asset,
      rate: deal.terms.rate.toString(),
      volume: deal.terms.volume.toString(),
      partyA: swapDealInput.partyA,
      partyB: swapDealInput.partyB,
      partyACurrency: swapDealInput.partyACurrency,
      partyAAmount: swapDealInput.partyAAmount,
      partyBCurrency: swapDealInput.partyBCurrency,
      partyBAmount: swapDealInput.partyBAmount,
    });

    // 5. Register before proposeSwap
    const entry: ActiveDeal = { deal, swapId: null };
    registerActive(entry);

    // 6. Propose swap — the SDK handles escrow ping, deposit, and timeout internally
    let swapId: string;
    try {
      const result = await swap.proposeSwap(swapDealInput);
      swapId = result.swapId;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error('propose_swap_failed', {
        deal_id: deal.terms.deal_id,
        error: errMsg,
      });
      recordError(deal.terms.deal_id,
        `PROPOSE_SWAP_FAILED: ${errMsg} | partyA=${swapDealInput.partyA} | partyB=${swapDealInput.partyB} | swapAddr=${swapAddress}`);
      entry.deal = transitionDeal(deal, 'FAILED');
      unregisterActive(entry);
      await onSwapFailed(entry.deal, `PROPOSE_SWAP_FAILED: ${errMsg}`);
      return;
    }

    // 7. Store swap_id and transition to EXECUTING
    entry.swapId = swapId;
    activeBySwapId.set(swapId, entry);
    entry.deal = transitionDeal(deal, 'EXECUTING', swapId);

    startExecutionTimer(entry);

    logger.info('deal_executing', {
      deal_id: deal.terms.deal_id,
      swap_id: swapId,
    });
  }

  function handleSwapCompleted(swapId: string, payoutVerified: boolean): void {
    if (stopped) return;

    const entry = activeBySwapId.get(swapId);
    if (!entry) {
      // Not tracked — this is normal for the acceptor path where we only
      // have a deal_id, not a swapId. Log at debug level.
      logger.info('swap_completed_untracked', { swap_id: swapId });
      return;
    }

    logger.info('swap_completed_event', {
      deal_id: entry.deal.terms.deal_id,
      swap_id: swapId,
      payout_verified: payoutVerified,
    });

    clearExecutionTimer(entry);
    entry.deal = transitionDeal(entry.deal, 'COMPLETED');
    unregisterActive(entry);

    // Trigger an explicit receive to pick up payout tokens delivered via DM.
    // The periodic 15s sync may be too slow; an immediate receive ensures
    // payout tokens are available for balance checks right after completion.
    if (deps.payments) {
      void deps.payments.receive().catch((err: unknown) => {
        logger.warn('swap_completed_receive_failed', {
          deal_id: entry.deal.terms.deal_id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    void onSwapCompleted(entry.deal, payoutVerified).catch((err: unknown) => {
      logger.error('on_swap_completed_callback_error', {
        deal_id: entry.deal.terms.deal_id,
        error: String(err),
      });
    });
  }

  function handleSwapFailed(swapId: string, reason: string): void {
    if (stopped) return;

    const entry = activeBySwapId.get(swapId);
    if (!entry) {
      logger.info('swap_failed_untracked', { swap_id: swapId, reason });
      return;
    }

    logger.info('swap_failed_event', {
      deal_id: entry.deal.terms.deal_id,
      swap_id: swapId,
      reason,
    });

    clearExecutionTimer(entry);
    entry.deal = transitionDeal(entry.deal, 'FAILED');
    unregisterActive(entry);

    void onSwapFailed(entry.deal, reason).catch((err: unknown) => {
      logger.error('on_swap_failed_callback_error', {
        deal_id: entry.deal.terms.deal_id,
        error: String(err),
      });
    });
  }

  function stopAll(): void {
    stopped = true;
    // Clear all execution timers before clearing maps
    for (const entry of activeByDealId.values()) {
      clearExecutionTimer(entry);
    }
    activeBySwapId.clear();
    activeByDealId.clear();
  }

  function registerSwapId(swapId: string, match?: SwapProposalMatchInfo): boolean {
    // Collect all acceptor-path deals awaiting a swapId.
    const nullSwapEntries: ActiveDeal[] = [];
    for (const entry of activeByDealId.values()) {
      if (entry.swapId === null) {
        nullSwapEntries.push(entry);
      }
    }

    if (nullSwapEntries.length === 0) {
      // F3: No active deal matches. If a lookup callback is provided AND we
      // have enough match info, probe the negotiation handler for a deal in
      // a non-live terminal state (CANCELLED / FAILED) that matches the
      // incoming swap — if found, block. If no historical deal matches
      // either, we have no NP-0 context for this swap at all → also block
      // (a counterparty we never agreed to trade with cannot unilaterally
      // initiate a swap with us).
      logger.warn('swap_id_register_no_live_deal_blocked', {
        swap_id: swapId,
        match_provided: match !== undefined,
        note: 'No live NP-0 deal tracked for this swap — blocking auto-accept.',
      });
      return false;
    }

    /**
     * C16: Match by identifying info when available. We are the acceptor
     * (partyB), the counterparty is the proposer (partyA). For each deal
     * we recompute what the swap input looked like from the NP-0 terms and
     * compare the provided match against it.
     */
    let candidates: ActiveDeal[] = nullSwapEntries;
    if (match !== undefined) {
      candidates = nullSwapEntries.filter((entry) => {
        const input = buildSwapDealInput(entry.deal, agentPubkey, swapAddress);
        if (match.partyACurrency !== undefined && match.partyACurrency !== input.partyACurrency) return false;
        if (match.partyAAmount !== undefined && match.partyAAmount !== input.partyAAmount) return false;
        if (match.partyBCurrency !== undefined && match.partyBCurrency !== input.partyBCurrency) return false;
        if (match.partyBAmount !== undefined && match.partyBAmount !== input.partyBAmount) return false;
        if (match.counterpartyPubkey !== undefined) {
          // On the acceptor path, counterparty is the proposer.
          if (!pubkeysEqual(entry.deal.terms.proposer_pubkey, match.counterpartyPubkey)) return false;
        }
        // SECURITY (spec 7.9.4 / H1): extend term-binding to escrow address
        // and timeout. If the SDK proposal advertises a different escrow
        // address than what was negotiated, or a different deposit timeout,
        // a hostile counterparty has pivoted at the SDK layer — refuse to
        // bind. Only enforce when the SDK actually surfaced these fields
        // (some SDK versions don't expose them); the absence is logged
        // upstream in main.ts.
        if (match.escrowDirectAddress !== undefined && match.escrowDirectAddress !== '') {
          const negotiatedEscrow = entry.deal.terms.escrow_address;
          // Compare both as DIRECT://hex strings; the negotiated form may
          // also be a nametag, in which case we accept it (resolution
          // happens elsewhere). Strict equality is sufficient for the
          // DIRECT://hex case which is what the SDK reports.
          if (negotiatedEscrow !== match.escrowDirectAddress &&
              negotiatedEscrow !== match.escrowPubkey) {
            logger.warn('swap_id_register_escrow_mismatch', {
              swap_id: swapId,
              negotiated_escrow: negotiatedEscrow,
              proposal_escrow: match.escrowDirectAddress,
              proposal_escrow_pubkey: match.escrowPubkey,
            });
            return false;
          }
        }
        if (match.depositTimeoutSec !== undefined) {
          const negotiated = entry.deal.terms.deposit_timeout_sec;
          if (negotiated !== undefined && negotiated !== match.depositTimeoutSec) {
            logger.warn('swap_id_register_timeout_mismatch', {
              swap_id: swapId,
              negotiated_timeout_sec: negotiated,
              proposal_timeout_sec: match.depositTimeoutSec,
            });
            return false;
          }
        }
        return true;
      });
    }

    if (candidates.length === 0) {
      logger.warn('swap_id_register_no_match_after_filter', {
        swap_id: swapId,
        pending_deal_count: nullSwapEntries.length,
        match_provided: match !== undefined,
        note: 'Incoming swap proposal does not match any tracked deal — blocking auto-accept.',
      });
      return false;
    }

    if (candidates.length > 1) {
      // Still ambiguous — refuse to pick arbitrarily. Routing the wrong swap
      // to the wrong deal is a financial-correctness failure, not a nuisance.
      logger.warn('swap_id_register_ambiguous', {
        swap_id: swapId,
        pending_deal_count: candidates.length,
        pending_deal_ids: candidates.map((e) => e.deal.terms.deal_id),
        match_provided: match !== undefined,
        note: 'Multiple deals match the proposal — cannot determine correct match. Blocking auto-accept.',
      });
      return false;
    }

    const entry = candidates[0];
    if (!entry) return false;

    // F3: The candidate ActiveDeal exists — ensure its NP-0 deal is still
    // in a LIVE state (ACCEPTED or EXECUTING). Anything else (PROPOSED
    // shouldn't reach here, but COMPLETED/FAILED/CANCELLED explicitly
    // should) means we are no longer committed to this deal and MUST NOT
    // auto-accept the incoming swap — funds would move despite our side
    // having torn the deal down (e.g., the accept DM send failed after
    // partial relay propagation). The caller (main.ts) translates a
    // `false` return into sphere.swap.rejectSwap().
    const dealState = entry.deal.state;
    if (dealState !== 'ACCEPTED' && dealState !== 'EXECUTING') {
      logger.warn('swap_auto_accept_blocked_by_np0_state', {
        swap_id: swapId,
        deal_id: entry.deal.terms.deal_id,
        np0_state: dealState,
      });
      return false;
    }

    entry.swapId = swapId;
    activeBySwapId.set(swapId, entry);
    logger.info('swap_id_registered', {
      deal_id: entry.deal.terms.deal_id,
      swap_id: swapId,
      matched_by: match !== undefined ? 'proposal_info' : 'null_swap_heuristic',
    });
    return true;
  }

  return {
    executeDeal,
    registerSwapId,
    handleSwapCompleted,
    handleSwapFailed,
    getActiveCount,
    getActiveDeals() {
      return [...activeByDealId.values()].map((entry) => ({
        deal_id: entry.deal.terms.deal_id,
        swap_id: entry.swapId,
        state: entry.deal.state,
      }));
    },
    getLastErrors() {
      return [...lastErrors];
    },
    updateStrategy(newStrategy: TraderStrategy): void {
      strategy = { ...newStrategy };
      logger.info('swap_executor_strategy_updated', {
        max_concurrent_swaps: strategy.max_concurrent_swaps,
        trusted_escrows_count: strategy.trusted_escrows.length,
      });
    },
    stop: stopAll,
  };
}
