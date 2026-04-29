/**
 * NegotiationHandler — NP-0 peer-to-peer deal negotiation over Nostr NIP-17 DMs.
 *
 * Implements the Negotiation Protocol (NP-0) from the Trader Agent Protocol
 * Specification (Section 3). Handles deal proposals, acceptances, rejections,
 * timeouts, deduplication, rate limiting, and signature verification.
 */

import { createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';

import type { Logger } from '../shared/logger.js';
import { isValidPubkey, pubkeysEqual, canonicalPubkeyKey } from '../shared/crypto.js';
import { MAX_MESSAGE_SIZE } from '../protocols/envelope.js';
import { hasDangerousKeys, canonicalJson } from './utils.js';
import { validateDealTerms } from './utils.js';
import type {
  DealTerms,
  DealRecord,
  DealState,
  IntentRecord,
  MarketSearchResult,
  NpMessage,
  NpMessageType,
  OnDealAccepted,
  OnDealCancelled,
} from './types.js';
import {
  NP_MESSAGE_TYPES,
  VALID_DEAL_TRANSITIONS,
  TERMINAL_DEAL_STATES,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NP_VERSION = '0.1';
const PROPOSE_TIMEOUT_MS = 30_000;
// Accept timeout removed — SwapExecutor owns execution timeouts.
const DEDUP_WINDOW_MS = 600_000;
const DEDUP_MAX_ENTRIES = 10_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 3;
/**
 * Upper bound on the number of per-counterparty rate-limit buckets tracked
 * in memory (warning fix). Without a cap, an attacker can create arbitrarily
 * many distinct pubkeys and OOM the agent. When the cap is reached, the
 * oldest (least-recently-inserted) bucket is evicted — Map iteration order is
 * insertion order in JS.
 */
const MAX_RATE_LIMIT_ENTRIES = 10_000;
const CLOCK_SKEW_TOLERANCE_MS = 300_000;
const MAX_MESSAGE_FIELD_LEN = 512;

/**
 * Round-19 F4: bound the age of a persisted counterparty_envelope. An
 * attacker with disk-write access who captured a past-valid envelope
 * could otherwise force us to emit signed reject DMs indefinitely — the
 * signature+terms checks pass forever because they have no time
 * component. 7 days is much longer than any legitimate in-flight deal
 * (typically seconds to hours) while still bounding replay exposure.
 */
const MAX_HYDRATE_ENVELOPE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Round-19 F5 / Round-21 F4: cap the serialized size of a persisted
 * envelope loaded from disk. Without this, a disk-write attacker can
 * inflate the envelope to hundreds of megabytes and OOM the agent at
 * startup (JSON.parse plus canonicalJson allocations). Matches the
 * wire-level MAX_MESSAGE_SIZE so legitimate envelopes always fit.
 *
 * Naming note: measured against `JSON.stringify(env).length`, which is
 * a count of UTF-16 code units — NOT bytes. We keep the suffix
 * `CODEUNITS` (rather than `BYTES`) to match the units the comparison
 * actually uses and to align with the wire-level MAX_MESSAGE_SIZE
 * convention, which also compares against `.length`. True byte
 * semantics would require `Buffer.byteLength(envSerialized, 'utf8')`;
 * we deliberately stay in code-unit land for symmetry with the wire
 * path (an ASCII envelope of N code units is also N bytes, and the
 * highest-density BMP envelope can at most double when re-encoded to
 * UTF-8 — still safely under any memory pressure threshold).
 */
const MAX_HYDRATE_ENVELOPE_SIZE_CODEUNITS = 64 * 1024;

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEAL_ID_RE = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/**
 * Round-21 F1: discriminated result returned by `hydrateDealAttempt`.
 *
 * The reconciliation path (trader-main.ts) needs more than a pass/fail
 * signal — it must distinguish:
 *
 *   - `ok: true`                        — record is trustworthy and now
 *                                          installed in the in-memory map.
 *
 *   - `no_envelope_proposer_record`     — legitimate proposer-side
 *                                          crash during the PROPOSED→ACCEPTED
 *                                          window. No counterparty envelope
 *                                          yet, but the terms were signed by
 *                                          US (we're the proposer); we can
 *                                          safely self-sign an
 *                                          `np.reject_deal` on them. The
 *                                          caller should release the
 *                                          reservation, delete the record,
 *                                          and best-effort notify the
 *                                          counterparty. Round-23 F4: the
 *                                          returned `record` is the CANCELLED
 *                                          copy that was installed in memory
 *                                          (not the caller-passed state); the
 *                                          caller can use it directly for its
 *                                          disk write.
 *
 *   - `no_envelope_acceptor_record`     — missing envelope on a record
 *                                          where we are the acceptor.
 *                                          Acceptor-side records always
 *                                          have an envelope attached in
 *                                          the same atomic write that
 *                                          created them, so this is
 *                                          suspicious (legacy record or
 *                                          attacker-crafted). Do NOT
 *                                          hydrate, do NOT touch disk —
 *                                          operator must triage.
 *
 *   - `bad_signature` | `stale_envelope`|
 *     `oversized`    | `invalid_shape` |
 *     `terms_mismatch`                  — envelope present but failed
 *                                          verification. Attacker-crafted
 *                                          record. Operator triage only.
 */
export type HydrateResult =
  | { ok: true }
  | { ok: false; reason: 'no_envelope_proposer_record'; record: DealRecord }
  | {
      ok: false;
      reason:
        | 'no_envelope_acceptor_record'
        | 'bad_signature'
        | 'stale_envelope'
        | 'oversized'
        | 'invalid_shape'
        | 'terms_mismatch'
        | 'non_participant';
      record: DealRecord;
    };

export interface NegotiationHandler {
  /** Initiate a deal proposal to a counterparty. */
  proposeDeal(
    ownIntent: IntentRecord,
    counterparty: MarketSearchResult,
    agreedRate: bigint,
    agreedVolume: bigint,
    escrowAddress: string,
  ): Promise<DealRecord>;

  /** Handle an incoming NP-0 DM from a counterparty. */
  handleIncomingDm(
    senderPubkey: string,
    senderAddress: string,
    content: string,
  ): Promise<void>;

  /** Transition a deal to COMPLETED (called when swap finishes). */
  completeDeal(dealId: string): void;

  /** Transition a deal to FAILED (called when swap fails). */
  /**
   * Transition the deal to FAILED. Optional `errorCode` is persisted on
   * the DealRecord so list-deals can surface a distinguishing reason
   * (e.g. `EXECUTION_TIMEOUT`, `ESCROW_UNREACHABLE`, `PAYOUT_UNVERIFIED`,
   * `PROPOSE_SWAP_FAILED: ...`).
   */
  failDeal(dealId: string, errorCode?: string): void;

  /** Get a deal record by ID. */
  getDeal(dealId: string): DealRecord | null;

  /** List deals with optional filter. */
  listDeals(filter?: { state?: DealState | DealState[] }): Promise<DealRecord[]>;

  /**
   * F4: Rehydrate a persisted deal into the in-memory map WITHOUT firing
   * any state transitions or callbacks. Used by startup reconciliation to
   * make pre-restart PROPOSED/ACCEPTED deals visible to the live DM
   * dispatcher so that late np.accept_deal messages can be properly
   * rejected (sender-participant checks depend on the deal existing).
   *
   * Round-21 F1: retained for backwards compatibility; callers that need
   * to distinguish legitimate proposer-crash records from attacker-crafted
   * records should prefer `hydrateDealAttempt`.
   */
  hydrateDeal(deal: DealRecord): void;

  /**
   * Round-21 F1: rehydrate a persisted deal, returning a discriminated
   * result that lets the reconciliation path distinguish:
   *
   *   - Trustworthy records (envelope verifies, installed in memory).
   *   - Our own proposer-side PROPOSED record whose counterparty never
   *     ack'd before we crashed — safely recoverable (we can self-sign
   *     a reject and release the reservation).
   *   - Suspicious or attacker-crafted records (do NOT touch disk, WARN
   *     for operator triage).
   *
   * The record is installed in the in-memory map only on `ok: true` OR
   * `no_envelope_proposer_record`. Round-23 F4: for the proposer-crash
   * branch, the record is installed as CANCELLED (not with the caller-
   * passed state) so a late np.accept_deal from the counterparty hits
   * the terminal-state guard in handleAcceptDeal regardless of whether
   * the caller does additional work. The returned `record` in that
   * case IS the CANCELLED copy — callers should use it for their disk
   * write rather than constructing their own.
   */
  hydrateDealAttempt(deal: DealRecord): HydrateResult;

  /**
   * F4: Build and sign an np.reject_deal message for a given deal so the
   * caller (e.g. startup reconciliation) can notify the counterparty
   * before cancelling locally. Exposed on the public interface so the
   * trader-main startup path can reuse the signing/canonicalization logic
   * without duplicating it. Returns the serialized JSON for sendDm.
   *
   * Round-13 F3: returns the signed-and-serialized envelope regardless of
   * whether the deal is tracked in-memory. The startup reconciliation path
   * needs to notify counterparties for deals that failed hydration (invalid
   * terms or deal_id mismatch in the persisted record) — those deals never
   * enter the in-memory map, but we still want the counterparty to learn
   * we're not honoring them. The method used to return null for any
   * unknown deal_id; now it only returns null if the deal_id is
   * syntactically malformed (cannot sign a bogus id — attacker-controlled
   * disk state could otherwise get us to publish signatures over arbitrary
   * attacker-chosen deal_ids).
   *
   * Round-15 F1: callers that load deal metadata from untrusted sources
   * (e.g. startup reconciliation reading persisted records that an
   * attacker with disk-write access could have crafted) MUST pass the
   * persisted participant pubkeys via the `participants` argument. When
   * provided, this method requires our agent pubkey to equal one of them
   * — otherwise an attacker can coerce us into signing an np.reject_deal
   * for a deal we never negotiated and addressing it to an
   * attacker-chosen counterparty.
   */
  buildRejectDealMessage(
    dealId: string,
    reasonCode: string,
    message: string,
    participants?: { proposer_pubkey: string; acceptor_pubkey: string },
  ): string | null;

  /** Cancel all pending deals (for shutdown). */
  cancelPending(): void;

  /**
   * F3 (round-23): wait for all in-flight per-deal persistence chains to
   * settle. `cancelPending` schedules one `transitionDeal(id, 'CANCELLED')`
   * per active deal, each of which queues an `onDealStateChange` write
   * through `persistChains`. Those writes run to completion asynchronously;
   * if the caller then immediately `stop()`s and lets the process exit, any
   * still-pending chain is abandoned and the CANCELLED state never lands
   * on disk — next startup's reconciliation re-sends rejects for deals the
   * counterparty has already abandoned, amplifying unsolicited DMs.
   *
   * Callers should invoke `cancelPending()` first to schedule the
   * transitions, then `await drainPersistChains()` to wait for them, then
   * `stop()` to clear timers. Bound the wait with `Promise.race` + a
   * shutdown-budget timer so a stuck disk can't block process exit.
   */
  drainPersistChains(): Promise<void>;

  /** Stop all timers. */
  stop(): void;
}

export interface NegotiationHandlerDeps {
  sendDm: (recipientAddress: string, content: string) => Promise<void>;
  signMessage: (message: string) => string;
  verifySignature: (signature: string, message: string, pubkey: string) => boolean;
  onDealAccepted: OnDealAccepted;
  onDealCancelled: OnDealCancelled;
  agentPubkey: string;
  agentAddress: string;
  logger: Logger;
  /** Look up the acceptor's own intent by ID for proposal validation. */
  getIntent?: (intentId: string) => { direction: 'buy' | 'sell'; base_asset: string; quote_asset: string; rate_min: bigint; rate_max: bigint; volume_min: bigint; volume_max: bigint } | null;
  /** Return the strategy's trusted escrow list for proposal validation. */
  getTrustedEscrows?: () => readonly string[];
  /**
   * Persist a deal record whenever its state changes (C14). Without this,
   * a restart mid-negotiation loses all in-flight deals — the counterparty's
   * np.accept_deal arrives and is silently dropped.
   */
  onDealStateChange?: (deal: DealRecord) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createNegotiationHandler(deps: NegotiationHandlerDeps): NegotiationHandler {
  const {
    sendDm,
    signMessage,
    verifySignature,
    onDealAccepted,
    agentPubkey,
    agentAddress,
    logger,
  } = deps;
  const { onDealCancelled, onDealStateChange } = deps;

  /**
   * Per-deal promise chain used to serialize persistence writes. Without this,
   * three rapid NP-0 transitions (PROPOSED → ACCEPTED → EXECUTING) schedule
   * three concurrent onDealStateChange invocations with no guaranteed completion
   * order — the atomic rename in saveDeal can land in the wrong order and
   * leave stale state on disk. On restart, the reconciliation pass reads that
   * stale state and cancels a deal whose SDK-level swap is still live (F1).
   */
  const persistChains = new Map<string, Promise<void>>();

  /**
   * Serialized deal persistence. Errors are logged but do not abort the
   * state transition — persistence is best-effort; the in-memory state remains
   * authoritative during the agent's lifetime. Each deal has its own promise
   * chain so writes for different deals still run in parallel, while writes
   * for the same deal are strictly ordered.
   */
  async function persistDeal(deal: DealRecord): Promise<void> {
    if (!onDealStateChange) return;
    const dealId = deal.terms.deal_id;
    const prev = persistChains.get(dealId) ?? Promise.resolve();
    // F4: wrap the persistence callback in a 5s timeout so a stuck
    // onDealStateChange (e.g. disk I/O hang) cannot block all future
    // transitions for this deal. Persistence is best-effort; in-memory
    // state remains authoritative even if the write times out.
    //
    // Round-13 F5: capture the timeout handle and clear it when the
    // persistence call resolves (success OR failure). Previously the
    // setTimeout handle was created inside the Promise constructor and
    // never cleared — on success the timer would leak until it fired
    // ~5s later (delaying a clean process exit and waking the event loop
    // unnecessarily). The finally-block clearTimeout keeps the event
    // loop clean even when every deal persists successfully.
    const PERSIST_TIMEOUT_MS = 5_000;
    const next = prev.then(async () => {
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          onDealStateChange(deal),
          new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(
              () => reject(new Error('persistDeal timeout')),
              PERSIST_TIMEOUT_MS,
            );
          }),
        ]);
      } finally {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      }
    }).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('deal_persist_failed', { deal_id: dealId, error: message });
    });
    persistChains.set(dealId, next);
    // Cleanup when the chain resolves to avoid unbounded memory growth.
    // Only drop the entry if it still points at this chain — a concurrent
    // call for the same deal may have replaced it already.
    void next.finally(() => {
      if (persistChains.get(dealId) === next) {
        persistChains.delete(dealId);
      }
    });
    await next;
  }

  // In-memory deal store: deal_id → DealRecord
  const deals = new Map<string, DealRecord>();

  // Timeout timers: deal_id → NodeJS.Timeout
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  // F6: periodic sweep timer for evicting terminal deals after a retention
  // window. Without this, the `deals` map grows unbounded over the agent's
  // lifetime because completed / failed / cancelled deals are never removed.
  //
  // Round-13 F2: TERMINAL_RETENTION_MS must be >= DEDUP_WINDOW_MS. Previously
  // retention (5 min) was shorter than the dedup window (10 min). Between T+5
  // and T+10 after a deal reached a terminal state, the in-memory record was
  // swept, but a fresh-msg_id retry from the counterparty would still pass
  // the dedup check AND the existing-deal guard, creating a NEW PROPOSED deal
  // for a deal we had already decided was terminal. Making retention outlive
  // the dedup window (with a 1-minute safety margin) ensures the terminal-
  // state guard in handleProposeDeal / handleAcceptDeal / handleRejectDeal
  // catches every retry before it can resurrect the deal.
  const TERMINAL_SWEEP_INTERVAL_MS = 60 * 1000; // 60 s
  const TERMINAL_RETENTION_MS = DEDUP_WINDOW_MS + 60_000; // dedup window + 60s safety margin
  let sweepTimer: ReturnType<typeof setInterval> | undefined;

  // Message deduplication: msg_id → ts_ms
  const dedupWindow = new Map<string, number>();

  // Per-counterparty rate limiting: pubkey → timestamps[]
  const rateLimits = new Map<string, number[]>();

  // GLOBAL inbound propose_deal rate-limit (sybil-flood defense).
  //
  // The per-counterparty `rateLimits` Map prevents one peer from spamming us,
  // but does NOT bound a flood of N distinct sybil identities each sending
  // 1 propose_deal/minute (under the per-peer cap). At N=600+ pubkeys this
  // saturates ECDSA verification CPU and bloats the DealRecord map.
  //
  // Defense: ring-buffer of recent inbound propose_deal arrival timestamps;
  // before per-peer check, drop the message silently if we've already
  // accepted MAX_INBOUND_PROPOSALS_PER_MIN in the trailing 60s window.
  // 600/min = 10/sec — comfortably above any legitimate use (a busy trader
  // with 10 active intents × 50 candidates × scan-interval-30s would see
  // ~17/sec inbound; this cap is 60% above that worst-case legitimate
  // scenario, with headroom for bursts).
  const globalProposalTimestamps: number[] = [];
  const MAX_INBOUND_PROPOSALS_PER_MIN = 600;
  const GLOBAL_PROPOSAL_WINDOW_MS = 60_000;
  let globalDropCount = 0;
  function isGloballyRateLimited(): boolean {
    const now = Date.now();
    // Trim entries older than the window. Insertion order is ascending
    // by arrival, so we can pop from the front.
    while (globalProposalTimestamps.length > 0 && globalProposalTimestamps[0]! < now - GLOBAL_PROPOSAL_WINDOW_MS) {
      globalProposalTimestamps.shift();
    }
    return globalProposalTimestamps.length >= MAX_INBOUND_PROPOSALS_PER_MIN;
  }
  function recordGlobalProposal(): void {
    globalProposalTimestamps.push(Date.now());
  }

  // Round-13 F6: cap the number of reject DMs we send per deal_id. Without a
  // cap, a malicious counterparty can retry np.propose/accept/reject against
  // a CANCELLED deal many times and we'd send one reject DM per request — a
  // 1:1 amplification vector. Bounded to MAX_REJECTS_PER_DEAL; beyond that we
  // silently drop the inbound message.
  //
  // Round-17 F2: rejectCounts entries added via the UNKNOWN_INTENT /
  // AGENT_BUSY paths never enter `deals`, so the old
  // sweepTerminalDeals-driven cleanup (which iterated `deals`) could not
  // reach them — the map grew unbounded with attacker-rotated deal_ids.
  // Fix: store a timestamp with each entry, sweep by age on the same
  // terminal-sweep timer, and cap total entries with insertion-order
  // eviction (LRU-ish) so a flood of distinct deal_ids can't OOM us.
  const rejectCounts = new Map<string, { count: number; lastSeen: number }>();
  const MAX_REJECTS_PER_DEAL = 3;
  // Retention window for rejectCounts entries. Aligned with the DEDUP_WINDOW
  // so an attacker who rotates deal_ids fast enough to outlive the dedup
  // window cannot also exploit the rejectCounts cap — by the time the dedup
  // window releases, the rejectCounts sweep has already forgotten them.
  const REJECT_COUNT_RETENTION_MS = DEDUP_WINDOW_MS; // 10 min
  // Hard cap on the rejectCounts map size. When exceeded on insert, the
  // oldest (insertion-order) entry is evicted. Map iteration order in JS
  // is insertion order, so `keys().next()` yields the earliest key.
  const MAX_REJECT_COUNT_ENTRIES = 10_000;

  /**
   * Returns `true` if we're allowed to send another reject DM for this deal,
   * and bumps the counter. Returns `false` when the cap has been reached —
   * caller must drop the reject silently.
   *
   * Round-17 F2: each entry carries a `lastSeen` timestamp so
   * sweepTerminalDeals can age them out even when the deal never entered
   * `deals` (UNKNOWN_INTENT / AGENT_BUSY paths). A hard cap with
   * insertion-order eviction defends against an attacker who rotates
   * deal_ids faster than the retention window drains.
   */
  function tryIncrementRejectCount(dealId: string): boolean {
    const now = Date.now();
    const entry = rejectCounts.get(dealId);
    if (!entry) {
      // Enforce the hard cap before inserting a NEW entry so a flood of
      // distinct deal_ids can't push us past MAX_REJECT_COUNT_ENTRIES.
      if (rejectCounts.size >= MAX_REJECT_COUNT_ENTRIES) {
        const oldestKey = rejectCounts.keys().next().value;
        if (oldestKey !== undefined) {
          rejectCounts.delete(oldestKey);
        }
      }
      rejectCounts.set(dealId, { count: 1, lastSeen: now });
      return true;
    }
    // Always refresh lastSeen on every observation so a sustained attack
    // keeps the entry (bounded by MAX_REJECTS_PER_DEAL) alive instead of
    // letting it age out and reopen the 1:1 amplifier window.
    entry.lastSeen = now;
    if (entry.count >= MAX_REJECTS_PER_DEAL) {
      // Round-19 F8: still move to LRU tail on a sustained-hit observation
      // even when the cap has been reached. Without this, once the entry
      // is blocked the original insertion-order position remains fixed
      // and a flood of DIFFERENT deal_ids could evict this still-active
      // sentinel — reopening the 1:1 amplifier window for the SAME
      // attacker against the SAME deal_id. delete+set refreshes the
      // Map's insertion order (JS Maps iterate insertion-order), so the
      // cap-hit sentinel moves to the end and outlives fresh entries.
      rejectCounts.delete(dealId);
      rejectCounts.set(dealId, entry);
      return false;
    }
    entry.count++;
    // Round-19 F8: refresh insertion order (true LRU) on every successful
    // increment. Map iteration order is insertion order; delete + set
    // moves the entry to the tail so the eviction path at the top of
    // this function always drops the least-recently-hit entry, not the
    // first-inserted-ever one.
    rejectCounts.delete(dealId);
    rejectCounts.set(dealId, entry);
    return true;
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  function sha256hex(data: string): string {
    return createHash('sha256').update(data).digest('hex');
  }

  function computeDealId(terms: DealTerms): string {
    // Intentionally exclude deal_id — it is the output of this hash.
    // Only the actual DealTerms fields that define the deal are included.
    const obj = {
      acceptor_intent_id: terms.acceptor_intent_id,
      acceptor_pubkey: terms.acceptor_pubkey,
      base_asset: terms.base_asset,
      created_ms: terms.created_ms,
      deposit_timeout_sec: terms.deposit_timeout_sec,
      escrow_address: terms.escrow_address,
      proposer_address: terms.proposer_address,
      acceptor_address: terms.acceptor_address,
      proposer_direction: terms.proposer_direction,
      proposer_intent_id: terms.proposer_intent_id,
      proposer_pubkey: terms.proposer_pubkey,
      quote_asset: terms.quote_asset,
      rate: terms.rate,
      volume: terms.volume,
    };
    return sha256hex(canonicalJson(obj));
  }

  /**
   * Compute the signature input for an NP message. The signature covers
   * the SHA-256 of the canonical JSON of the full envelope minus the
   * `signature` field — this binds signer's commitment to every field
   * (deal_id, msg_id, type, ts_ms, payload) so a MITM cannot tamper with
   * payload contents like `proposer_swap_address` while keeping the
   * original signature valid (C13).
   */
  function computeSignatureInput(envelope: Omit<NpMessage, 'signature'>): string {
    return sha256hex(canonicalJson(envelope));
  }

  function buildNpMessage(
    dealId: string,
    type: NpMessageType,
    payload: Record<string, unknown>,
  ): NpMessage {
    const envelope: Omit<NpMessage, 'signature'> = {
      np_version: NP_VERSION,
      msg_id: uuidv4(),
      deal_id: dealId,
      sender_pubkey: agentPubkey,
      type,
      ts_ms: Date.now(),
      payload,
    };
    const sigInput = computeSignatureInput(envelope);
    const signature = signMessage(sigInput);

    return {
      ...envelope,
      signature,
    };
  }

  function isValidTransition(from: DealState, to: DealState): boolean {
    const allowed = VALID_DEAL_TRANSITIONS[from];
    return (allowed as readonly string[]).includes(to);
  }

  async function transitionDeal(
    dealId: string,
    newState: DealState,
    options?: { errorCode?: string },
  ): Promise<DealRecord | null> {
    const deal = deals.get(dealId);
    if (!deal) return null;
    if (!isValidTransition(deal.state, newState)) {
      logger.warn('invalid_deal_transition', {
        deal_id: dealId,
        from: deal.state,
        to: newState,
      });
      return null;
    }
    const updated: DealRecord = {
      ...deal,
      state: newState,
      updated_at: Date.now(),
      // Persist the failure reason ONLY on FAILED transitions. Other
      // terminal states (CANCELLED, COMPLETED) carry their own
      // counterparty-signed payloads (np.reject_deal / np.accept_deal +
      // payout) which already encode the outcome; an error_code there
      // would be redundant and possibly contradictory.
      ...(newState === 'FAILED' && options?.errorCode !== undefined
        ? { error_code: options.errorCode }
        : {}),
    };
    deals.set(dealId, updated);

    // Persist on every state transition (C14). If the agent restarts mid-flight,
    // the counterparty's np.accept_deal can still be matched to the deal record.
    // Await the serialized write (F1) so subsequent transitions queue behind
    // this one at the persistence layer.
    await persistDeal(updated);

    // Notify when a deal is cancelled (e.g. proposal timeout) so the intent
    // can be restored to ACTIVE and retried with a different counterparty.
    // Skip the callback for sibling cancellations — a winning deal already
    // exists for this intent, so the intent should NOT be restored to ACTIVE.
    if (newState === 'CANCELLED') {
      // Only fire if no sibling deal for the same intent is ACCEPTED or beyond
      const intentId = updated.terms.proposer_intent_id;
      const hasSiblingAccepted = [...deals.values()].some(
        (d) => d.terms.proposer_intent_id === intentId &&
               d.terms.deal_id !== dealId &&
               (d.state === 'ACCEPTED' || d.state === 'EXECUTING'),
      );
      if (!hasSiblingAccepted) {
        try {
          onDealCancelled(updated);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error('on_deal_cancelled_callback_failed', { deal_id: dealId, error: message });
        }
      }
    }

    return updated;
  }

  function clearTimer(dealId: string): void {
    const timer = timers.get(dealId);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(dealId);
    }
  }

  function startTimer(dealId: string, timeoutMs: number): void {
    clearTimer(dealId);
    const timer = setTimeout(() => {
      timers.delete(dealId);
      const deal = deals.get(dealId);
      if (!deal) return;
      if ((TERMINAL_DEAL_STATES as readonly string[]).includes(deal.state)) return;

      logger.info('deal_timeout', { deal_id: dealId, state: deal.state, timeout_ms: timeoutMs });
      // Fire-and-forget: the timer callback is synchronous but transitionDeal
      // is now async. Errors are handled inside persistDeal; any uncaught
      // rejection here is logged so the process doesn't die from an
      // unhandled rejection during background deal expiry.
      transitionDeal(dealId, 'CANCELLED').catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn('deal_timeout_transition_failed', { deal_id: dealId, error: message });
      });
    }, timeoutMs);
    // Allow the process to exit even if timer is pending
    if (typeof timer === 'object' && 'unref' in timer) {
      timer.unref();
    }
    timers.set(dealId, timer);
  }

  // -----------------------------------------------------------------------
  // Deduplication
  // -----------------------------------------------------------------------

  function isDuplicate(msgId: string): boolean {
    return dedupWindow.has(msgId);
  }

  function recordMessage(msgId: string, _tsMs: number): void {
    // Use arrival time (Date.now()) rather than the sender's claimed ts_ms
    // for dedup bookkeeping. Otherwise an attacker can set ts_ms=0 and cause
    // their entry to be evicted on the next eviction pass, enabling replay.
    // The ts_ms parameter is still passed in by callers for clock-skew checks
    // but must NOT be used as the dedup timestamp (warning fix).
    void _tsMs;
    const now = Date.now();
    const cutoff = now - DEDUP_WINDOW_MS;
    if (dedupWindow.size >= DEDUP_MAX_ENTRIES) {
      for (const [id, ts] of dedupWindow) {
        if (ts < cutoff) {
          dedupWindow.delete(id);
        }
      }
    }
    // If still at capacity after eviction, remove oldest
    if (dedupWindow.size >= DEDUP_MAX_ENTRIES) {
      let oldestId: string | null = null;
      let oldestTs = Infinity;
      for (const [id, ts] of dedupWindow) {
        if (ts < oldestTs) {
          oldestTs = ts;
          oldestId = id;
        }
      }
      if (oldestId !== null) {
        dedupWindow.delete(oldestId);
      }
    }
    dedupWindow.set(msgId, now);
  }

  // -----------------------------------------------------------------------
  // Rate limiting
  // -----------------------------------------------------------------------

  // Map.get/set use SameValueZero (===) internally. Without canonicalization,
  // the same adversary sending via two transport paths (e.g. Nostr x-only vs
  // compressed direct) would create TWO independent buckets and effectively
  // double their rate budget. Canonicalize to x-only so one identity = one bucket.

  function isRateLimited(pubkey: string): boolean {
    const key = canonicalPubkeyKey(pubkey);
    const now = Date.now();
    const cutoff = now - RATE_LIMIT_WINDOW_MS;
    let timestamps = rateLimits.get(key);
    if (!timestamps) return false;
    timestamps = timestamps.filter((t) => t > cutoff);
    rateLimits.set(key, timestamps);
    return timestamps.length >= RATE_LIMIT_MAX;
  }

  function recordProposal(pubkey: string): void {
    const key = canonicalPubkeyKey(pubkey);
    const now = Date.now();
    const cutoff = now - RATE_LIMIT_WINDOW_MS;
    let timestamps = rateLimits.get(key);
    const isNewBucket = !timestamps;
    if (!timestamps) {
      timestamps = [];
    } else {
      timestamps = timestamps.filter((t) => t > cutoff);
    }
    timestamps.push(now);

    // Enforce the MAX_RATE_LIMIT_ENTRIES cap before inserting a new bucket
    // so that a flood of distinct attacker pubkeys can't OOM us.
    if (isNewBucket && rateLimits.size >= MAX_RATE_LIMIT_ENTRIES) {
      const oldestKey = rateLimits.keys().next().value;
      if (oldestKey !== undefined) {
        rateLimits.delete(oldestKey);
      }
    }
    rateLimits.set(key, timestamps);
  }

  // -----------------------------------------------------------------------
  // NP message validation
  // -----------------------------------------------------------------------

  function isValidNpMessageType(t: unknown): t is NpMessageType {
    return typeof t === 'string' && (NP_MESSAGE_TYPES as readonly string[]).includes(t);
  }

  function validateNpEnvelope(data: unknown): NpMessage | string {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      return 'invalid message shape';
    }

    const obj = data as Record<string, unknown>;

    if (obj['np_version'] !== NP_VERSION) {
      return `unsupported np_version: ${String(obj['np_version'])}`;
    }
    if (typeof obj['msg_id'] !== 'string' || !UUID_V4_RE.test(obj['msg_id'])) {
      return 'invalid msg_id';
    }
    if (typeof obj['deal_id'] !== 'string' || !DEAL_ID_RE.test(obj['deal_id'])) {
      return 'invalid deal_id';
    }
    if (typeof obj['sender_pubkey'] !== 'string' || !isValidPubkey(obj['sender_pubkey'])) {
      return 'invalid sender_pubkey';
    }
    if (!isValidNpMessageType(obj['type'])) {
      return 'invalid message type';
    }
    if (typeof obj['ts_ms'] !== 'number' || !Number.isFinite(obj['ts_ms'])) {
      return 'invalid ts_ms';
    }
    if (typeof obj['payload'] !== 'object' || obj['payload'] === null || Array.isArray(obj['payload'])) {
      return 'invalid payload';
    }
    if (typeof obj['signature'] !== 'string') {
      return 'missing signature';
    }

    return obj as unknown as NpMessage;
  }

  function verifyNpSignature(msg: NpMessage): boolean {
    // Build the envelope-minus-signature from the received message and
    // hash its canonical JSON. If any field was tampered with in transit,
    // the recomputed hash differs and the signature fails to verify.
    const { signature: _sig, ...rest } = msg;
    void _sig; // only the hash of `rest` is signed
    const sigInput = computeSignatureInput(rest);
    return verifySignature(msg.signature, sigInput, msg.sender_pubkey);
  }

  // -----------------------------------------------------------------------
  // Duplicate deal guard (spec Section 5.7)
  // -----------------------------------------------------------------------

  // Check either role — the same intent must not participate in two concurrent
  // non-terminal deals regardless of whether we are proposer or acceptor.
  function hasActiveDealForIntent(ownIntentId: string): boolean {
    for (const deal of deals.values()) {
      if (
        (deal.terms.acceptor_intent_id === ownIntentId ||
         deal.terms.proposer_intent_id === ownIntentId) &&
        !(TERMINAL_DEAL_STATES as readonly string[]).includes(deal.state)
      ) {
        return true;
      }
    }
    return false;
  }

  // -----------------------------------------------------------------------
  // Incoming message handlers
  // -----------------------------------------------------------------------

  async function handleProposeDeal(
    msg: NpMessage,
    senderAddress: string,
  ): Promise<void> {
    const payload = msg.payload as Record<string, unknown>;
    const termsRaw = payload['terms'] as Record<string, unknown> | undefined;

    if (!termsRaw || typeof termsRaw !== 'object') {
      logger.warn('np_propose_deal_invalid_terms', { deal_id: msg.deal_id });
      return;
    }

    // Convert rate/volume to bigint if they arrive as strings (wire format)
    let rate: bigint;
    let volume: bigint;
    try {
      rate = BigInt(String(termsRaw['rate'] ?? '0'));
      volume = BigInt(String(termsRaw['volume'] ?? '0'));
    } catch {
      logger.warn('np_propose_deal_invalid_bigint', {
        deal_id: msg.deal_id,
        rate: String(termsRaw['rate'] ?? ''),
        volume: String(termsRaw['volume'] ?? ''),
      });
      return;
    }

    // Extract proposer_direction from wire format; default to 'sell' for backward compat
    const rawDirection = String(termsRaw['proposer_direction'] ?? 'sell');
    const proposerDirection: 'buy' | 'sell' = rawDirection === 'buy' ? 'buy' : 'sell';

    const terms: DealTerms = {
      deal_id: String(termsRaw['deal_id'] ?? ''),
      proposer_intent_id: String(termsRaw['proposer_intent_id'] ?? ''),
      acceptor_intent_id: String(termsRaw['acceptor_intent_id'] ?? ''),
      proposer_pubkey: String(termsRaw['proposer_pubkey'] ?? ''),
      acceptor_pubkey: String(termsRaw['acceptor_pubkey'] ?? ''),
      proposer_address: String(termsRaw['proposer_address'] ?? ''),
      acceptor_address: String(termsRaw['acceptor_address'] ?? ''),
      base_asset: String(termsRaw['base_asset'] ?? ''),
      quote_asset: String(termsRaw['quote_asset'] ?? ''),
      rate,
      volume,
      proposer_direction: proposerDirection,
      escrow_address: String(termsRaw['escrow_address'] ?? ''),
      deposit_timeout_sec: Number(termsRaw['deposit_timeout_sec'] ?? 0),
      created_ms: Number(termsRaw['created_ms'] ?? 0),
    };

    // Validate sender is the proposer
    if (!pubkeysEqual(msg.sender_pubkey, terms.proposer_pubkey)) {
      logger.warn('np_propose_deal_sender_mismatch', {
        deal_id: msg.deal_id,
        sender: msg.sender_pubkey,
        proposer: terms.proposer_pubkey,
      });
      return;
    }

    // Validate we are the acceptor
    if (!pubkeysEqual(agentPubkey, terms.acceptor_pubkey)) {
      logger.warn('np_propose_deal_not_acceptor', {
        deal_id: msg.deal_id,
        our_pubkey: agentPubkey,
        acceptor: terms.acceptor_pubkey,
      });
      return;
    }

    // Validate terms
    const termsError = validateDealTerms(terms);
    if (termsError !== null) {
      logger.warn('np_propose_deal_invalid_terms', { deal_id: msg.deal_id, error: termsError });
      return;
    }

    // GLOBAL sybil-flood gate (2026-04-29 fix): drop silently when the
    // 60s rolling window has already accepted MAX_INBOUND_PROPOSALS_PER_MIN
    // inbound proposals. Goes BEFORE the per-peer rate-limit so sybil
    // pubkeys aren't recorded into the per-peer Map (which would consume
    // memory under attack). Log every Nth drop to bound log volume.
    if (isGloballyRateLimited()) {
      globalDropCount++;
      // Log every 50th drop, plus the first one in any sustained burst,
      // to give operators a signal without flooding logs themselves.
      if (globalDropCount === 1 || globalDropCount % 50 === 0) {
        logger.warn('np_propose_deal_global_rate_limited', {
          drop_count: globalDropCount,
          window_ms: GLOBAL_PROPOSAL_WINDOW_MS,
          cap: MAX_INBOUND_PROPOSALS_PER_MIN,
          deal_id: msg.deal_id,
          sender: msg.sender_pubkey,
          note: 'global cap reached — sybil-flood defense triggered',
        });
      }
      return;
    }

    // F5: Rate-limit check FIRST, before any outbound response path (including
    // the UNKNOWN_INTENT reject DM below). Previously, a rate-limited attacker
    // could still trigger 1 inbound → 1 outbound amplification by supplying a
    // bogus acceptor_intent_id, because the intent-lookup-miss reject was
    // emitted before the rate-limit gate. Drop silently when rate-limited
    // to remove the 1:1 amplification vector entirely.
    if (isRateLimited(msg.sender_pubkey)) {
      logger.warn('np_propose_deal_rate_limited', {
        deal_id: msg.deal_id,
        sender: msg.sender_pubkey,
      });
      // Drop silently — no outbound reject DM. An attacker who exhausts the
      // rate limit cannot use this handler as an amplifier.
      return;
    }
    recordProposal(msg.sender_pubkey);
    recordGlobalProposal();
    // Reset the global drop counter on a successful accept — separates
    // bursts from sustained attacks in the operator-visible log.
    if (globalDropCount > 0) {
      logger.info('np_propose_deal_global_rate_recovered', {
        total_dropped: globalDropCount,
      });
      globalDropCount = 0;
    }

    // Verify deal_id matches canonical JSON of terms
    const computedId = computeDealId(terms);
    if (computedId !== msg.deal_id) {
      logger.warn('np_propose_deal_id_mismatch', {
        deal_id: msg.deal_id,
        computed: computedId,
      });
      return;
    }

    // Validate proposed terms against the acceptor's own intent (C12).
    // If we have a getIntent resolver, we MUST be able to find our intent
    // before validating any terms. Otherwise an attacker can send a bogus
    // acceptor_intent_id and propose arbitrary terms — skipping validation
    // here is a financial-security bug.
    if (deps.getIntent) {
      const acceptorIntent = deps.getIntent(terms.acceptor_intent_id);
      if (!acceptorIntent) {
        // Cannot validate proposed terms without our own intent record —
        // reject the proposal rather than accepting on blind trust.
        logger.warn('np_propose_deal_unknown_intent', {
          deal_id: msg.deal_id,
          acceptor_intent_id: terms.acceptor_intent_id,
        });
        // Round-15 F2: bound outbound UNKNOWN_INTENT rejects per deal_id.
        // Previously this path emitted one outbound reject DM per inbound
        // propose, letting an attacker rotate msg.deal_id values to extract
        // up to three rejects per 60s (rate-limit window) — a 1:1 amplifier
        // still present after the terminal-state guard was bounded.
        if (tryIncrementRejectCount(msg.deal_id)) {
          const rejectMsg = buildNpMessage(msg.deal_id, 'np.reject_deal', {
            reason_code: 'UNKNOWN_INTENT',
            message: 'Acceptor intent not found or not active',
          });
          // Round-17 F3: wrap in try/catch so a dead counterparty or relay
          // failure doesn't surface an unhandled rejection here. Consistent
          // with every other sendDm call site in this file.
          try {
            await sendDm(senderAddress, JSON.stringify(rejectMsg));
          } catch (err: unknown) {
            // Round-19 F7: include sender and recipient so operators can
            // correlate send failures with specific counterparties
            // without grep-digging adjacent logs. Previously only
            // deal_id+error were logged.
            logger.warn('np_propose_unknown_intent_reject_send_failed', {
              deal_id: msg.deal_id,
              sender: msg.sender_pubkey,
              recipient: senderAddress,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        } else {
          logger.debug('np_propose_unknown_intent_reject_capped', {
            deal_id: msg.deal_id,
          });
        }
        return;
      }

      // Verify assets match
      if (terms.base_asset !== acceptorIntent.base_asset || terms.quote_asset !== acceptorIntent.quote_asset) {
        logger.warn('np_propose_deal_asset_mismatch', {
          deal_id: msg.deal_id,
          expected_base: acceptorIntent.base_asset,
          got_base: terms.base_asset,
          expected_quote: acceptorIntent.quote_asset,
          got_quote: terms.quote_asset,
        });
        return;
      }

      // Verify rate is within acceptor's range
      if (terms.rate < acceptorIntent.rate_min || terms.rate > acceptorIntent.rate_max) {
        logger.warn('np_propose_deal_rate_out_of_range', {
          deal_id: msg.deal_id,
          rate: terms.rate.toString(),
          rate_min: acceptorIntent.rate_min.toString(),
          rate_max: acceptorIntent.rate_max.toString(),
        });
        return;
      }

      // Verify volume is within acceptor's range
      if (terms.volume < acceptorIntent.volume_min || terms.volume > acceptorIntent.volume_max) {
        logger.warn('np_propose_deal_volume_out_of_range', {
          deal_id: msg.deal_id,
          volume: terms.volume.toString(),
          volume_min: acceptorIntent.volume_min.toString(),
          volume_max: acceptorIntent.volume_max.toString(),
        });
        return;
      }

      // Verify proposer_direction is opposite of acceptor's direction (Critical 2)
      const expectedProposerDirection = acceptorIntent.direction === 'buy' ? 'sell' : 'buy';
      if (terms.proposer_direction !== expectedProposerDirection) {
        logger.warn('np_propose_deal_direction_mismatch', {
          deal_id: msg.deal_id,
          proposer_direction: terms.proposer_direction,
          acceptor_direction: acceptorIntent.direction,
          expected_proposer_direction: expectedProposerDirection,
        });
        return;
      }
    }

    // Verify escrow_address is in trusted_escrows list — ALWAYS check,
    // regardless of whether the intent lookup succeeded. This prevents a
    // malicious proposer from bypassing the escrow trust check by using
    // a random acceptor_intent_id that doesn't match any known intent.
    if (deps.getTrustedEscrows) {
      const trustedEscrows = deps.getTrustedEscrows();
      if (!trustedEscrows.includes('any') && !trustedEscrows.includes(terms.escrow_address)) {
        logger.warn('np_propose_deal_untrusted_escrow', {
          deal_id: msg.deal_id,
          escrow_address: terms.escrow_address,
        });
        return;
      }
    }

    // F5: rate-limit gate was moved to the top of handleProposeDeal so it
    // applies BEFORE any outbound reject DM can be emitted. Nothing to do here.

    // Duplicate deal guard (spec 5.7) — reject if our intent is already live in any role
    if (hasActiveDealForIntent(terms.acceptor_intent_id)) {
      logger.info('np_propose_deal_duplicate_guard', {
        deal_id: msg.deal_id,
        acceptor_intent_id: terms.acceptor_intent_id,
      });
      // Round-15 F2: bound outbound AGENT_BUSY rejects per deal_id to
      // remove the 1:1 amplification vector that remains even after the
      // terminal-state guard was bounded. Attackers rotating msg.deal_id
      // would otherwise extract one outbound reject per inbound propose
      // until the per-sender rate limit kicks in.
      if (tryIncrementRejectCount(msg.deal_id)) {
        const rejectMsg = buildNpMessage(msg.deal_id, 'np.reject_deal', {
          reason_code: 'AGENT_BUSY',
          message: 'Already have an active deal for this intent',
        });
        // Round-17 F3: wrap in try/catch so a dead counterparty or relay
        // failure doesn't surface an unhandled rejection here. Consistent
        // with every other sendDm call site in this file.
        try {
          await sendDm(senderAddress, JSON.stringify(rejectMsg));
        } catch (err: unknown) {
          // Round-19 F7: include sender and recipient so operators can
          // correlate send failures with specific counterparties.
          logger.warn('np_propose_agent_busy_reject_send_failed', {
            deal_id: msg.deal_id,
            sender: msg.sender_pubkey,
            recipient: senderAddress,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        logger.debug('np_propose_agent_busy_reject_capped', {
          deal_id: msg.deal_id,
        });
      }
      return;
    }

    // Check if deal already exists
    const existing = deals.get(msg.deal_id);
    if (existing) {
      // F1 / round-13 F4: terminal-state guard. If the deal is already in ANY
      // terminal state (CANCELLED, COMPLETED, or FAILED — e.g. from startup
      // reconciliation of a pre-restart PROPOSED/ACCEPTED deal, from a swap
      // that already completed, or from a swap that failed), send a one-shot
      // np.reject_deal and return without any state transition. Previously
      // this only handled CANCELLED and COMPLETED/FAILED deals would fall
      // through and silently drop, confusing the counterparty.
      //
      // Round-13 F6: bound the number of outbound rejects per deal_id so a
      // malicious counterparty cannot use us as a 1:1 amplifier by spamming
      // np.propose_deal against a terminal deal.
      if ((TERMINAL_DEAL_STATES as readonly string[]).includes(existing.state)) {
        if (tryIncrementRejectCount(msg.deal_id)) {
          const rejectMsg = buildNpMessage(msg.deal_id, 'np.reject_deal', {
            reason_code: existing.state,
            message: `Deal is in terminal state ${existing.state}`,
          });
          try {
            await sendDm(senderAddress, JSON.stringify(rejectMsg));
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            logger.warn('np_propose_terminal_reject_send_failed', {
              deal_id: msg.deal_id,
              terminal_state: existing.state,
              error: message,
            });
          }
        } else {
          logger.debug('np_propose_terminal_reject_capped', {
            deal_id: msg.deal_id,
            terminal_state: existing.state,
          });
        }
        logger.info('np_propose_deal_already_terminal', {
          deal_id: msg.deal_id,
          terminal_state: existing.state,
        });
        return;
      }
      logger.warn('np_propose_deal_already_exists', { deal_id: msg.deal_id });
      return;
    }

    // Create the deal in PROPOSED state first, then transition to ACCEPTED
    // to formally honor the state machine (PROPOSED -> ACCEPTED).
    //
    // Round-17 F1: persist the received `np.propose_deal` envelope as
    // `counterparty_envelope`. On a future restart, hydrateDeal verifies
    // this envelope's signature and terms-hash before trusting the
    // persisted record — an attacker with disk-write access cannot forge
    // the proposer's secp256k1 signature, so a crafted DealRecord naming
    // us as acceptor is rejected at hydration.
    const proposedRecord: DealRecord = {
      terms,
      state: 'PROPOSED',
      swap_id: null,
      acceptor_swap_address: null,
      updated_at: Date.now(),
      counterparty_envelope: msg,
    };
    deals.set(msg.deal_id, proposedRecord);
    // Persist the PROPOSED record so a restart mid-handshake can still match
    // incoming np.accept_deal (C14 pairing). Await (F1) so the subsequent
    // ACCEPTED write queues behind this one at the persistence layer.
    await persistDeal(proposedRecord);

    // C15: Send the acceptance DM FIRST — before transitioning the deal to
    // ACCEPTED and launching swap execution. If the DM send fails, the
    // proposer never learns of acceptance and would otherwise have no swap
    // proposal in-flight on their side while our side has one in-flight.
    // Ordering: send -> transition -> onDealAccepted.
    const acceptMsg = buildNpMessage(msg.deal_id, 'np.accept_deal', {
      acceptor_swap_address: agentAddress,
      message: '',
    });
    try {
      await sendDm(senderAddress, JSON.stringify(acceptMsg));
    } catch (err: unknown) {
      // F3: Acceptance DM send failed — but the relay may have already fanned
      // it out to the counterparty before throwing. If the counterparty saw
      // the acceptance, they will proceed to proposeSwap, so we MUST enter a
      // durable terminal state (FAILED) that the swap auto-accept gate in
      // main.ts checks against. CANCELLED was previously used but FAILED is
      // a stronger signal of "we are no longer ready to execute this deal".
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('np_accept_dm_send_failed', {
        deal_id: msg.deal_id,
        recipient: senderAddress,
        error: message,
        reason_code: 'ACCEPT_DM_SEND_FAILED',
      });
      // Transition PROPOSED -> CANCELLED first (ACCEPT_DM_SEND_FAILED is
      // semantically a fail-stop; the deal never reached ACCEPTED on our
      // side). CANCELLED is the valid transition from PROPOSED; FAILED is
      // only reachable from ACCEPTED/EXECUTING per the state machine.
      // The auto-accept gate treats anything not-in-ACCEPTED-or-EXECUTING
      // as "blocked", so CANCELLED is sufficient protection.
      await transitionDeal(msg.deal_id, 'CANCELLED');
      return;
    }

    // DM sent successfully — transition PROPOSED -> ACCEPTED.
    const dealRecord = await transitionDeal(msg.deal_id, 'ACCEPTED');
    if (!dealRecord) {
      logger.error('np_propose_deal_transition_failed', { deal_id: msg.deal_id });
      return;
    }

    // No accept timeout — the SwapExecutor manages execution timeouts.
    // The swap proposal DM may take time to arrive via fetchPendingEvents.

    logger.info('np_deal_accepted', {
      deal_id: msg.deal_id,
      proposer: terms.proposer_pubkey,
      rate: terms.rate.toString(),
      volume: terms.volume.toString(),
    });

    // Only after the counterparty has been notified do we launch swap
    // execution. This matches C15: onDealAccepted fires the proposeSwap
    // path, which is safe only once the peer knows we accepted.
    await onDealAccepted(dealRecord);
  }

  async function handleAcceptDeal(msg: NpMessage, senderAddress: string): Promise<void> {
    const deal = deals.get(msg.deal_id);
    if (!deal) {
      logger.warn('np_accept_deal_unknown', { deal_id: msg.deal_id });
      return;
    }

    // Sender must be acceptor
    if (!pubkeysEqual(msg.sender_pubkey, deal.terms.acceptor_pubkey)) {
      logger.warn('np_accept_deal_sender_mismatch', {
        deal_id: msg.deal_id,
        sender: msg.sender_pubkey,
        expected: deal.terms.acceptor_pubkey,
      });
      return;
    }

    // F1 / round-13 F4: terminal-state guard. If the deal is already in ANY
    // terminal state (CANCELLED, COMPLETED, or FAILED — e.g. from startup
    // reconciliation of a pre-restart PROPOSED deal, from a completed swap,
    // or from a failed swap), send a one-shot np.reject_deal and return
    // without any state transition. Previously this only handled CANCELLED
    // so a late np.accept_deal landing on a COMPLETED/FAILED deal was
    // silently dropped, leaving the counterparty uncertain.
    //
    // Round-13 F6: bound outbound rejects per deal_id to prevent a 1:1
    // amplification vector.
    if ((TERMINAL_DEAL_STATES as readonly string[]).includes(deal.state)) {
      clearTimer(msg.deal_id);
      if (tryIncrementRejectCount(msg.deal_id)) {
        const rejectMsg = buildNpMessage(msg.deal_id, 'np.reject_deal', {
          reason_code: deal.state,
          message: `Deal is in terminal state ${deal.state}`,
        });
        try {
          await sendDm(senderAddress, JSON.stringify(rejectMsg));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn('np_accept_terminal_reject_send_failed', {
            deal_id: msg.deal_id,
            terminal_state: deal.state,
            error: message,
          });
        }
      } else {
        logger.debug('np_accept_terminal_reject_capped', {
          deal_id: msg.deal_id,
          terminal_state: deal.state,
        });
      }
      logger.info('np_accept_deal_already_terminal', {
        deal_id: msg.deal_id,
        terminal_state: deal.state,
      });
      return;
    }

    // Clear timer BEFORE state check to prevent timer-fired CANCELLED from racing
    // with this acceptance (steelman #4).
    clearTimer(msg.deal_id);

    // Must be in PROPOSED state
    if (deal.state !== 'PROPOSED') {
      logger.warn('np_accept_deal_wrong_state', {
        deal_id: msg.deal_id,
        state: deal.state,
      });
      return;
    }

    // Guard against double-acceptance TOCTOU race (steelman #1): if any sibling
    // deal for the same intent is already ACCEPTED or beyond, reject this one.
    const intentId = deal.terms.proposer_intent_id;
    for (const [otherId, otherDeal] of deals) {
      if (
        otherId !== msg.deal_id &&
        otherDeal.terms.proposer_intent_id === intentId &&
        (otherDeal.state === 'ACCEPTED' || otherDeal.state === 'EXECUTING')
      ) {
        logger.warn('np_accept_deal_sibling_already_accepted', {
          deal_id: msg.deal_id,
          winning_deal_id: otherId,
        });
        await transitionDeal(msg.deal_id, 'CANCELLED');
        return;
      }
    }

    // Round-19 F1: build and persist the ACCEPTED record with the
    // counterparty-signed `np.accept_deal` envelope attached in the SAME
    // write. Previously we called transitionDeal(ACCEPTED) first (which
    // persisted WITHOUT the envelope) and attached the envelope in a
    // second persist — a crash between those two awaits left a legitimate
    // ACCEPTED deal that hydrateDeal could not verify (envelope missing).
    // The envelope is our only unforgeable proof the deal was genuinely
    // negotiated, so it MUST land on disk atomically with the state
    // change.
    //
    // Round-21 F2: the PROPOSED->ACCEPTED transition is guaranteed valid
    // here — state is verified PROPOSED at line 1126 above, and
    // VALID_DEAL_TRANSITIONS['PROPOSED'] includes 'ACCEPTED'. The former
    // isValidTransition re-check was dead code (unreachable) and has
    // been removed.

    // Extract acceptor swap address from payload
    const payload = msg.payload as Record<string, unknown>;
    const acceptorSwapAddress = typeof payload['acceptor_swap_address'] === 'string'
      ? payload['acceptor_swap_address']
      : null;

    // Build the ACCEPTED record (state verified PROPOSED at line 1126)
    // with envelope attached BEFORE any persist.
    // Mirrors the pattern in handleProposeDeal where `proposedRecord`
    // already carries `counterparty_envelope: msg` before the first
    // persist — so a crash during the first write still leaves a
    // verifiable record (or no record at all), never a half-updated one.
    const withEnvelope: DealRecord = {
      ...deal,
      state: 'ACCEPTED',
      updated_at: Date.now(),
      counterparty_envelope: msg,
      ...(acceptorSwapAddress !== null ? { acceptor_swap_address: acceptorSwapAddress } : {}),
    };
    deals.set(msg.deal_id, withEnvelope);
    await persistDeal(withEnvelope);

    // Cancel all other PROPOSED deals for the same intent — first acceptance wins.
    for (const [otherId, otherDeal] of deals) {
      if (
        otherId !== msg.deal_id &&
        otherDeal.state === 'PROPOSED' &&
        otherDeal.terms.proposer_intent_id === intentId
      ) {
        clearTimer(otherId);
        await transitionDeal(otherId, 'CANCELLED');
        logger.info('sibling_proposal_cancelled', {
          cancelled_deal_id: otherId,
          winning_deal_id: msg.deal_id,
        });
      }
    }

    // No acceptance timeout here — the SwapExecutor manages its own execution
    // timeouts (deposit_timeout_sec + 60s) after onDealAccepted hands off the deal.
    // A 60s timer here was too aggressive and cancelled deals mid-escrow-handshake.

    logger.info('np_deal_accepted_by_counterparty', {
      deal_id: msg.deal_id,
      acceptor: msg.sender_pubkey,
    });

    // Round-19 F1: invoke onDealAccepted explicitly. Previously this
    // callback chain was triggered as a side effect of transitionDeal
    // (via the final `deals.get` read), but with the transitionDeal call
    // removed in the envelope-first rewrite above, we must invoke
    // onDealAccepted directly. The intent-engine side effects
    // (reservation, proposeSwap) are critical — skipping them would
    // strand the accepted deal without SDK-level progress.
    await onDealAccepted(withEnvelope);
  }

  async function handleRejectDeal(msg: NpMessage, senderAddress: string): Promise<void> {
    const deal = deals.get(msg.deal_id);
    if (!deal) {
      logger.warn('np_reject_deal_unknown', { deal_id: msg.deal_id });
      return;
    }

    // Sender must be a participant
    const isProposer = pubkeysEqual(msg.sender_pubkey, deal.terms.proposer_pubkey);
    const isAcceptor = pubkeysEqual(msg.sender_pubkey, deal.terms.acceptor_pubkey);
    if (!isProposer && !isAcceptor) {
      logger.warn('np_reject_deal_sender_not_participant', {
        deal_id: msg.deal_id,
        sender: msg.sender_pubkey,
      });
      return;
    }

    // F1 / round-13 F4: terminal-state guard. If the deal is already in ANY
    // terminal state (CANCELLED, COMPLETED, or FAILED), the counterparty's
    // reject is informational — send them a one-shot np.reject_deal of our
    // own so both sides converge on the same terminal view, and skip the
    // transition (our local terminal write must not be reversed).
    // Previously only CANCELLED was handled; a reject landing on a
    // COMPLETED/FAILED deal was silently dropped.
    //
    // Round-13 F6: bound outbound rejects per deal_id.
    if ((TERMINAL_DEAL_STATES as readonly string[]).includes(deal.state)) {
      clearTimer(msg.deal_id);
      if (tryIncrementRejectCount(msg.deal_id)) {
        const rejectMsg = buildNpMessage(msg.deal_id, 'np.reject_deal', {
          reason_code: deal.state,
          message: `Deal is in terminal state ${deal.state}`,
        });
        try {
          await sendDm(senderAddress, JSON.stringify(rejectMsg));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn('np_reject_terminal_reject_send_failed', {
            deal_id: msg.deal_id,
            terminal_state: deal.state,
            error: message,
          });
        }
      } else {
        logger.debug('np_reject_terminal_reject_capped', {
          deal_id: msg.deal_id,
          terminal_state: deal.state,
        });
      }
      logger.info('np_reject_deal_already_terminal', {
        deal_id: msg.deal_id,
        terminal_state: deal.state,
      });
      return;
    }

    // Must be in PROPOSED or ACCEPTED state
    if (deal.state !== 'PROPOSED' && deal.state !== 'ACCEPTED') {
      logger.warn('np_reject_deal_wrong_state', {
        deal_id: msg.deal_id,
        state: deal.state,
      });
      return;
    }

    clearTimer(msg.deal_id);
    await transitionDeal(msg.deal_id, 'CANCELLED');

    const payload = msg.payload as Record<string, unknown>;
    logger.info('np_deal_rejected', {
      deal_id: msg.deal_id,
      sender: msg.sender_pubkey,
      reason_code: String(payload['reason_code'] ?? 'UNKNOWN'),
      message: String(payload['message'] ?? ''),
    });
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  async function proposeDeal(
    ownIntent: IntentRecord,
    counterparty: MarketSearchResult,
    agreedRate: bigint,
    agreedVolume: bigint,
    escrowAddress: string,
  ): Promise<DealRecord> {
    const now = Date.now();

    const terms: DealTerms = {
      deal_id: '', // placeholder, computed below
      proposer_intent_id: ownIntent.intent.market_intent_id,
      acceptor_intent_id: counterparty.id,
      proposer_pubkey: agentPubkey,
      acceptor_pubkey: counterparty.agentPublicKey,
      proposer_address: agentAddress,
      acceptor_address: counterparty.contactHandle ?? '',
      base_asset: ownIntent.intent.base_asset,
      quote_asset: ownIntent.intent.quote_asset,
      rate: agreedRate,
      volume: agreedVolume,
      proposer_direction: ownIntent.intent.direction,
      escrow_address: escrowAddress,
      deposit_timeout_sec: ownIntent.intent.deposit_timeout_sec,
      created_ms: now,
    };

    // Compute deal_id from canonical JSON of terms (without deal_id itself)
    const dealId = computeDealId(terms);
    const finalTerms: DealTerms = { ...terms, deal_id: dealId };

    const dealRecord: DealRecord = {
      terms: finalTerms,
      state: 'PROPOSED',
      swap_id: null,
      acceptor_swap_address: null,
      updated_at: now,
    };
    deals.set(dealId, dealRecord);
    // Persist the PROPOSED record so a restart mid-propose can still match
    // incoming np.accept_deal from the counterparty (C14). Await (F1) so the
    // write completes before any subsequent transition queues behind it.
    await persistDeal(dealRecord);

    // Build and send np.propose_deal
    const npMsg = buildNpMessage(dealId, 'np.propose_deal', {
      terms: {
        ...finalTerms,
        rate: finalTerms.rate.toString(),
        volume: finalTerms.volume.toString(),
      },
      proposer_swap_address: agentAddress,
      message: '',
    });

    // Start 30s timeout BEFORE sending — if sendDm hangs (e.g. dead counterparty,
    // unresolvable address), the timer still fires and cancels the deal.
    startTimer(dealId, PROPOSE_TIMEOUT_MS);

    const recipientAddress = counterparty.contactHandle ?? '';
    // Race sendDm against a 10s send timeout. If the DM send hangs (address
    // resolution for a dead counterparty), we don't block the scan loop forever.
    const DM_SEND_TIMEOUT_MS = 10_000;
    let sendTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        sendDm(recipientAddress, JSON.stringify(npMsg)),
        new Promise<never>((_, reject) => {
          sendTimer = setTimeout(() => reject(new Error('sendDm timed out')), DM_SEND_TIMEOUT_MS);
        }),
      ]);
    } catch (err: unknown) {
      // DM send failed or timed out — cancel the deal immediately
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('np_propose_send_failed', {
        deal_id: dealId,
        recipient: recipientAddress,
        error: message,
      });
      clearTimer(dealId);
      await transitionDeal(dealId, 'CANCELLED');
      throw err;
    } finally {
      // Always clear the send timeout to prevent timer leak (steelman #3)
      if (sendTimer !== undefined) clearTimeout(sendTimer);
    }

    logger.info('np_deal_proposed', {
      deal_id: dealId,
      acceptor: counterparty.agentPublicKey,
      rate: agreedRate.toString(),
      volume: agreedVolume.toString(),
    });

    return dealRecord;
  }

  async function handleIncomingDm(
    senderPubkey: string,
    senderAddress: string,
    content: string,
  ): Promise<void> {
    // Size check (64 KiB)
    if (content.length > MAX_MESSAGE_SIZE) {
      logger.warn('np_message_too_large', {
        sender: senderPubkey,
        size: content.length,
      });
      return;
    }

    // Parse JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      logger.debug('np_message_not_json', { sender: senderPubkey });
      return;
    }

    // Dangerous keys check
    if (hasDangerousKeys(parsed)) {
      logger.warn('np_message_dangerous_keys', { sender: senderPubkey });
      return;
    }

    // Validate NP envelope
    const result = validateNpEnvelope(parsed);
    if (typeof result === 'string') {
      logger.debug('np_message_invalid_envelope', { sender: senderPubkey, error: result });
      return;
    }

    const msg = result;

    // Verify sender_pubkey matches the DM sender
    if (!pubkeysEqual(msg.sender_pubkey, senderPubkey)) {
      logger.warn('np_message_pubkey_mismatch', {
        deal_id: msg.deal_id,
        envelope_sender: msg.sender_pubkey,
        dm_sender: senderPubkey,
      });
      return;
    }

    // Verify signature
    if (!verifyNpSignature(msg)) {
      logger.warn('np_message_signature_invalid', {
        deal_id: msg.deal_id,
        sender: msg.sender_pubkey,
      });
      return;
    }

    // Check sender is a deal participant (for existing deals)
    if (msg.type !== 'np.propose_deal') {
      const deal = deals.get(msg.deal_id);
      if (deal) {
        const isProposer = pubkeysEqual(msg.sender_pubkey, deal.terms.proposer_pubkey);
        const isAcceptor = pubkeysEqual(msg.sender_pubkey, deal.terms.acceptor_pubkey);
        if (!isProposer && !isAcceptor) {
          logger.warn('np_message_sender_not_participant', {
            deal_id: msg.deal_id,
            sender: msg.sender_pubkey,
          });
          return;
        }
      }
    }

    // Deduplication check
    if (isDuplicate(msg.msg_id)) {
      logger.debug('np_message_duplicate', { msg_id: msg.msg_id, deal_id: msg.deal_id });
      return;
    }

    // Clock skew check
    const now = Date.now();
    const drift = Math.abs(now - msg.ts_ms);
    if (drift > CLOCK_SKEW_TOLERANCE_MS) {
      logger.warn('np_message_clock_skew', {
        deal_id: msg.deal_id,
        ts_ms: msg.ts_ms,
        drift_ms: drift,
      });
      return;
    }

    // Record for dedup
    recordMessage(msg.msg_id, msg.ts_ms);

    // Validate message field length in payload
    const payload = msg.payload as Record<string, unknown>;
    if (typeof payload['message'] === 'string' && payload['message'].length > MAX_MESSAGE_FIELD_LEN) {
      logger.warn('np_message_field_too_long', {
        deal_id: msg.deal_id,
        field: 'message',
        length: (payload['message'] as string).length,
      });
      return;
    }

    // Dispatch by type
    switch (msg.type) {
      case 'np.propose_deal':
        await handleProposeDeal(msg, senderAddress);
        break;
      case 'np.accept_deal':
        await handleAcceptDeal(msg, senderAddress);
        break;
      case 'np.reject_deal':
        await handleRejectDeal(msg, senderAddress);
        break;
      default:
        logger.warn('np_message_unknown_type', { deal_id: msg.deal_id, type: msg.type });
    }
  }

  function getDeal(dealId: string): DealRecord | null {
    return deals.get(dealId) ?? null;
  }

  async function listDeals(filter?: { state?: DealState | DealState[] }): Promise<DealRecord[]> {
    const results: DealRecord[] = [];
    for (const deal of deals.values()) {
      if (filter?.state !== undefined) {
        const states = Array.isArray(filter.state) ? filter.state : [filter.state];
        if (!states.includes(deal.state)) continue;
      }
      results.push(deal);
    }
    return results;
  }

  function cancelPending(): void {
    // Fire-and-forget: transitionDeal is now async (F1), but cancelPending
    // is called from synchronous shutdown paths. The persistence chain
    // handles ordering; we tolerate fractional persistence loss on shutdown
    // because the reconciliation pass on the next startup restores sanity.
    //
    // F3 (round-23): callers that need the scheduled CANCELLED writes to
    // land on disk before process exit MUST `await drainPersistChains()`
    // after this returns. Without the drain, rapid shutdown can abandon
    // the persist writes mid-flight — leaving deals on disk in their
    // pre-cancel state (PROPOSED / ACCEPTED) that the next startup will
    // try to re-cancel and re-notify the counterparty for.
    for (const [dealId, deal] of deals) {
      if (!(TERMINAL_DEAL_STATES as readonly string[]).includes(deal.state)) {
        clearTimer(dealId);
        transitionDeal(dealId, 'CANCELLED').catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn('cancel_pending_transition_failed', { deal_id: dealId, error: message });
        });
        logger.info('np_deal_cancelled_shutdown', { deal_id: dealId, prev_state: deal.state });
      }
    }
  }

  /**
   * F3 (round-23): wait for all in-flight per-deal persistence chains to
   * settle. Snapshots the chain Map so chains added after we snapshot
   * (e.g. a late inbound np.accept_deal that won't happen because we
   * cancelled, but defensively) don't extend the wait. Uses
   * `Promise.allSettled` because any individual chain may have been
   * rejected — we just want to know they've all finished, not to
   * propagate their failures (those are already logged inside
   * `persistDeal`).
   */
  async function drainPersistChains(): Promise<void> {
    if (persistChains.size === 0) return;
    const snapshot = Array.from(persistChains.values());
    await Promise.allSettled(snapshot);
  }

  /**
   * F6: Evict terminal deals (COMPLETED / FAILED / CANCELLED) older than
   * the retention window. Prevents the in-memory `deals` map from growing
   * unbounded over the agent's lifetime. Called periodically from the
   * sweep timer initialized in the factory.
   */
  function sweepTerminalDeals(): void {
    const now = Date.now();
    const terminal = new Set<DealState>(['COMPLETED', 'FAILED', 'CANCELLED']);
    for (const [id, deal] of deals) {
      if (terminal.has(deal.state) && (now - deal.updated_at) > TERMINAL_RETENTION_MS) {
        deals.delete(id);
        // Round-13 F7: do NOT delete persistChains here. A persistence
        // chain for this deal may still be in flight (we don't await
        // pending writes before sweeping). persistDeal's own finally-
        // handler cleans up the entry when the chain settles (conditioned
        // on the map still pointing at that chain), so deleting here is
        // redundant and risks wiping a live chain that a late retry might
        // want to queue behind — causing silent write reordering.
        // Round-13 F6: clean up the rejectCounts entry alongside the deal
        // so a future deal_id collision (astronomically rare but
        // theoretically possible) starts with a fresh counter.
        rejectCounts.delete(id);
      }
    }
    // Round-17 F2: age out rejectCounts entries that never made it into
    // `deals` (UNKNOWN_INTENT / AGENT_BUSY paths). Without this, a flood
    // of attacker-rotated deal_ids would accumulate forever (capped only
    // by MAX_REJECT_COUNT_ENTRIES). Sweep by lastSeen age so legitimate
    // activity on an active deal keeps the entry alive.
    for (const [id, entry] of rejectCounts) {
      if (now - entry.lastSeen > REJECT_COUNT_RETENTION_MS) {
        rejectCounts.delete(id);
      }
    }
    // F4 (round-23): sweep aged-out rateLimits buckets. Without this,
    // even with the MAX_RATE_LIMIT_ENTRIES cap, legitimate long-lived
    // peer buckets accumulate forever — their timestamps silently go
    // stale because `isRateLimited` / `recordProposal` only prune
    // on-demand. Over weeks of operation the map grows to the cap and
    // starts evicting active peers via the insertion-order fallback,
    // potentially letting a rate-limited attacker's bucket leapfrog an
    // active peer out of the cap. Piggyback on this sweep timer to
    // drop buckets whose timestamps have all aged out of the window.
    const rateLimitCutoff = now - RATE_LIMIT_WINDOW_MS;
    for (const [pubkey, timestamps] of rateLimits) {
      const fresh = timestamps.filter((ts) => ts > rateLimitCutoff);
      if (fresh.length === 0) {
        rateLimits.delete(pubkey);
      } else if (fresh.length !== timestamps.length) {
        rateLimits.set(pubkey, fresh);
      }
    }
  }

  /**
   * Round-21 F1: hydrate a persisted deal with a discriminated result.
   * See the HydrateResult docblock for the taxonomy.
   *
   * F5 (round-21): cross-check `deal.updated_at >= env.ts_ms - CLOCK_SKEW_TOLERANCE_MS`.
   * An attacker with disk-write access might stamp `updated_at` to a
   * recent value (to beat any staleness logic applied to the record as
   * a whole) while attaching an ancient, already-valid envelope. The
   * invariant `updated_at >= ts_ms - tolerance` holds for legitimate
   * records (the envelope arrives, then we persist — updated_at is
   * always >= ts_ms, modulo clock skew). Violating it means the record
   * was constructed out-of-band.
   */
  function hydrateDealAttempt(deal: DealRecord): HydrateResult {
    const termsError = validateDealTerms(deal.terms);
    if (termsError !== null) {
      logger.warn('hydrate_deal_invalid_terms', {
        deal_id: deal.terms.deal_id,
        error: termsError,
      });
      return { ok: false, reason: 'invalid_shape', record: deal };
    }
    const recomputedId = computeDealId(deal.terms);
    if (recomputedId !== deal.terms.deal_id) {
      logger.warn('hydrate_deal_id_mismatch', {
        deal_id: deal.terms.deal_id,
        computed: recomputedId,
      });
      return { ok: false, reason: 'invalid_shape', record: deal };
    }
    // Round-15 F1: verify our agent is actually a participant in this deal.
    // Without this check, an attacker with disk-write access could craft a
    // persisted DealRecord where proposer_pubkey/acceptor_pubkey reference
    // an attacker-controlled key pair PLUS our pubkey, with a matching
    // sha256(canonicalJson(terms)) deal_id (easy — they control every
    // input). On next startup, reconciliation would treat us as
    // proposer/acceptor, sign an np.reject_deal with our key, and send
    // it to the attacker-chosen counterparty_address — yielding a
    // signature over an arbitrary attacker-chosen deal_id / envelope.
    // Require at least one of the participant pubkeys to equal our own.
    const weAreProposer = pubkeysEqual(agentPubkey, deal.terms.proposer_pubkey);
    const weAreAcceptor = pubkeysEqual(agentPubkey, deal.terms.acceptor_pubkey);
    if (!weAreProposer && !weAreAcceptor) {
      logger.warn('hydrate_deal_non_participant_rejected', {
        deal_id: deal.terms.deal_id,
        proposer: deal.terms.proposer_pubkey,
        acceptor: deal.terms.acceptor_pubkey,
      });
      return { ok: false, reason: 'non_participant', record: deal };
    }

    // Round-17 F1: participant check alone is insufficient defense against
    // a disk-write attacker. The attacker can craft a record where the
    // proposer is themselves and the acceptor is us (satisfying the
    // participant check) with a matching sha256(canonicalJson(terms))
    // deal_id — they control every input and can compute the hash locally.
    // Reconciliation would then sign np.reject_deal for an attacker-chosen
    // deal_id to an attacker-chosen address.
    //
    // Defense: verify the `counterparty_envelope` that was persisted
    // alongside the DealRecord. This envelope is either the
    // np.propose_deal we received (we=acceptor) or the np.accept_deal we
    // received (we=proposer). It carries the counterparty's secp256k1
    // signature over the terms-hash — attackers cannot forge it because
    // the counterparty's private key is not on disk.
    const env = deal.counterparty_envelope;
    if (!env) {
      // Round-21 F1: distinguish the two kinds of missing-envelope records.
      //
      // (a) We are the PROPOSER. This is a legitimate proposer-side
      //     crash during the 30s PROPOSED→ACCEPTED window —
      //     `proposeDeal` intentionally persists the record with no
      //     counterparty envelope because the acceptor's
      //     `np.accept_deal` has not arrived yet.
      //
      //     The terms are ones WE originated (we're the proposer), so
      //     reconciliation can safely self-sign an np.reject_deal for
      //     them. The narrow threat surface: a disk-write attacker can
      //     still craft a record where they nominate US as proposer
      //     with their address as counterparty, extracting ONE signed
      //     reject per fabricated record. We accept this tradeoff
      //     because the alternative (leaking reservations forever
      //     across restarts for every legitimate proposer-crash
      //     record) is strictly worse — and an attacker with disk-
      //     write access to our wallet directory can typically read
      //     the signing key anyway, making this oracle moot in the
      //     real-world threat model.
      //
      //     Round-23 F4: we install the record AS CANCELLED (not with
      //     the caller-passed state) so the terminal-state guard in
      //     handleAcceptDeal catches any late np.accept_deal from the
      //     counterparty independently of what the caller does next.
      //     Previously we installed the caller-passed state (typically
      //     PROPOSED), and the production caller in trader-main.ts had
      //     to re-hydrate a SECOND time with a CANCELLED copy to flip
      //     the in-memory state — but an error path could skip that
      //     second hydrate and leave the map with a PROPOSED copy that
      //     would erroneously transition to ACCEPTED on a late
      //     counterparty DM. Forcing CANCELLED here closes the race.
      //     The returned `record` is the CANCELLED copy the caller
      //     should use for its disk write.
      //
      // (b) We are the ACCEPTOR. Acceptor-side records ALWAYS attach
      //     the envelope in the same atomic write that creates them
      //     (handleProposeDeal / handleAcceptDeal). A missing envelope
      //     on our acceptor-side record means either a pre-round-17
      //     legacy record OR an attacker-crafted record. Either way,
      //     we must NOT touch disk — operator triage only.
      if (weAreProposer) {
        logger.info('hydrate_deal_proposer_propose_crash', {
          deal_id: deal.terms.deal_id,
          state: deal.state,
        });
        // Round-23 F4: install the CANCELLED copy (not the caller-
        // passed state) so a late np.accept_deal hits the terminal-
        // state guard. Return the CANCELLED record so the caller's
        // disk write stays in sync with the in-memory state.
        const cancelledRecord: DealRecord = {
          ...deal,
          state: 'CANCELLED',
          updated_at: Date.now(),
        };
        deals.set(deal.terms.deal_id, cancelledRecord);
        return {
          ok: false,
          reason: 'no_envelope_proposer_record',
          record: cancelledRecord,
        };
      }
      logger.warn('hydrate_deal_missing_envelope_legacy_record', {
        deal_id: deal.terms.deal_id,
        state: deal.state,
      });
      return { ok: false, reason: 'no_envelope_acceptor_record', record: deal };
    }

    // Round-19 F5 / Round-21 F4: cap serialized envelope size BEFORE any
    // further work (signature verification, canonicalJson) so a disk-
    // write attacker who inflated the envelope to hundreds of MB can't
    // OOM us during startup reconciliation. Must precede
    // verifyNpSignature because that path canonicalizes the envelope
    // (another allocation). The cap is measured in UTF-16 code units
    // (see MAX_HYDRATE_ENVELOPE_SIZE_CODEUNITS docblock).
    const envSerialized = JSON.stringify(env);
    if (envSerialized.length > MAX_HYDRATE_ENVELOPE_SIZE_CODEUNITS) {
      logger.warn('hydrate_deal_envelope_oversized', {
        deal_id: deal.terms.deal_id,
        size_codeunits: envSerialized.length,
      });
      return { ok: false, reason: 'oversized', record: deal };
    }

    // Round-19 F4: bound envelope age so a captured past-valid envelope
    // cannot force us to emit signed rejects indefinitely. Check after
    // the size cap (cheap after we already serialized) but before the
    // signature verification (signature verify is the more expensive
    // EC op — short-circuit on age first). Uses absolute value so a
    // clock skew in either direction triggers the guard.
    const nowForAge = Date.now();
    if (Math.abs(nowForAge - env.ts_ms) > MAX_HYDRATE_ENVELOPE_AGE_MS) {
      logger.warn('hydrate_deal_envelope_stale', {
        deal_id: deal.terms.deal_id,
        env_ts_ms: env.ts_ms,
        age_ms: nowForAge - env.ts_ms,
      });
      return { ok: false, reason: 'stale_envelope', record: deal };
    }

    // Round-21 F5: cross-check deal.updated_at against env.ts_ms. An
    // attacker-crafted record can pair a recent `updated_at` (to look
    // freshly-updated) with an older captured envelope. For legitimate
    // records, the envelope ALWAYS precedes the record update (we
    // receive the envelope, then persist the record carrying it), so
    // `updated_at >= ts_ms - CLOCK_SKEW_TOLERANCE_MS` must hold.
    // Violation means the record was assembled out-of-band. The
    // tolerance matches the clock-skew budget used elsewhere in this
    // handler (CLOCK_SKEW_TOLERANCE_MS) so legitimate records whose
    // host clocks drifted still pass.
    if (deal.updated_at < env.ts_ms - CLOCK_SKEW_TOLERANCE_MS) {
      logger.warn('hydrate_deal_updated_at_precedes_envelope', {
        deal_id: deal.terms.deal_id,
        updated_at: deal.updated_at,
        env_ts_ms: env.ts_ms,
        tolerance_ms: CLOCK_SKEW_TOLERANCE_MS,
      });
      return { ok: false, reason: 'stale_envelope', record: deal };
    }

    const expectedCounterparty = weAreProposer
      ? deal.terms.acceptor_pubkey
      : deal.terms.proposer_pubkey;

    if (!pubkeysEqual(env.sender_pubkey, expectedCounterparty)) {
      logger.warn('hydrate_deal_envelope_wrong_sender', {
        deal_id: deal.terms.deal_id,
        env_sender: env.sender_pubkey,
        expected: expectedCounterparty,
      });
      return { ok: false, reason: 'bad_signature', record: deal };
    }

    if (!verifyNpSignature(env)) {
      logger.warn('hydrate_deal_envelope_bad_signature', {
        deal_id: deal.terms.deal_id,
      });
      return { ok: false, reason: 'bad_signature', record: deal };
    }

    const envPayload = env.payload as { terms?: Record<string, unknown> };
    if (envPayload.terms && typeof envPayload.terms === 'object' && !Array.isArray(envPayload.terms)) {
      // np.propose_deal path — envelope embeds the full terms. Rebuild
      // a DealTerms object from the wire-format record and hash it.
      const raw = envPayload.terms;
      let envTerms: DealTerms;
      try {
        envTerms = {
          deal_id: String(raw['deal_id'] ?? ''),
          proposer_intent_id: String(raw['proposer_intent_id'] ?? ''),
          acceptor_intent_id: String(raw['acceptor_intent_id'] ?? ''),
          proposer_pubkey: String(raw['proposer_pubkey'] ?? ''),
          acceptor_pubkey: String(raw['acceptor_pubkey'] ?? ''),
          proposer_address: String(raw['proposer_address'] ?? ''),
          acceptor_address: String(raw['acceptor_address'] ?? ''),
          base_asset: String(raw['base_asset'] ?? ''),
          quote_asset: String(raw['quote_asset'] ?? ''),
          rate: BigInt(String(raw['rate'] ?? '0')),
          volume: BigInt(String(raw['volume'] ?? '0')),
          proposer_direction: String(raw['proposer_direction'] ?? 'sell') === 'buy' ? 'buy' : 'sell',
          escrow_address: String(raw['escrow_address'] ?? ''),
          deposit_timeout_sec: Number(raw['deposit_timeout_sec'] ?? 0),
          created_ms: Number(raw['created_ms'] ?? 0),
        };
      } catch {
        logger.warn('hydrate_deal_envelope_terms_parse_failed', {
          deal_id: deal.terms.deal_id,
        });
        return { ok: false, reason: 'terms_mismatch', record: deal };
      }
      if (computeDealId(envTerms) !== deal.terms.deal_id) {
        logger.warn('hydrate_deal_envelope_terms_mismatch', {
          deal_id: deal.terms.deal_id,
        });
        return { ok: false, reason: 'terms_mismatch', record: deal };
      }
    } else {
      // np.accept_deal path — no terms in payload, but the envelope
      // deal_id is part of the signature input, so a matching env.deal_id
      // is also unforgeable.
      if (env.deal_id !== deal.terms.deal_id) {
        logger.warn('hydrate_deal_envelope_deal_id_mismatch', {
          deal_id: deal.terms.deal_id,
          env_deal_id: env.deal_id,
        });
        return { ok: false, reason: 'terms_mismatch', record: deal };
      }
    }

    deals.set(deal.terms.deal_id, deal);
    logger.debug('deal_hydrated', {
      deal_id: deal.terms.deal_id,
      state: deal.state,
    });
    return { ok: true };
  }

  // Kick off the periodic sweep. The interval is unref'd so it won't keep
  // the process alive on its own; stop() below explicitly clears it.
  sweepTimer = setInterval(sweepTerminalDeals, TERMINAL_SWEEP_INTERVAL_MS);
  if (typeof sweepTimer === 'object' && 'unref' in sweepTimer) {
    sweepTimer.unref();
  }

  function stopAll(): void {
    for (const [dealId] of timers) {
      clearTimer(dealId);
    }
    timers.clear();
    if (sweepTimer !== undefined) {
      clearInterval(sweepTimer);
      sweepTimer = undefined;
    }
  }

  return {
    proposeDeal,
    handleIncomingDm,
    // Keep the public interface synchronous (void) to preserve backwards
    // compatibility with callers. The transition is queued through the
    // per-deal persistence chain (F1), so ordering across
    // PROPOSED -> ACCEPTED -> EXECUTING -> COMPLETED/FAILED is preserved
    // even though this returns immediately.
    completeDeal(dealId: string): void {
      transitionDeal(dealId, 'COMPLETED').catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn('complete_deal_transition_failed', { deal_id: dealId, error: message });
      });
    },
    failDeal(dealId: string, errorCode?: string): void {
      transitionDeal(dealId, 'FAILED', errorCode !== undefined ? { errorCode } : undefined).catch(
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn('fail_deal_transition_failed', { deal_id: dealId, error: message });
        },
      );
    },
    hydrateDeal(deal: DealRecord): void {
      // Round-21 F1: thin wrapper over hydrateDealAttempt for backwards
      // compatibility. Callers that need to distinguish legitimate
      // proposer-crash records from attacker-crafted records should use
      // hydrateDealAttempt directly.
      //
      // Behavior parity: this wrapper installs the record in the in-
      // memory map when hydrateDealAttempt returns ok=true. For the
      // `no_envelope_proposer_record` branch, hydrateDealAttempt itself
      // installs the record — as CANCELLED since round-23 F4 (previously
      // it installed the caller-passed state, typically PROPOSED). The
      // in-memory map still reflects the record for callers that check
      // `getDeal(id) !== null`, but a late np.accept_deal now lands on a
      // CANCELLED state and is caught by the terminal-state guard. Code
      // that needs to distinguish the two branches MUST use
      // hydrateDealAttempt directly to see the discriminator.
      hydrateDealAttempt(deal);
    },
    hydrateDealAttempt,
    buildRejectDealMessage(
      dealId: string,
      reasonCode: string,
      messageText: string,
      participants?: { proposer_pubkey: string; acceptor_pubkey: string },
    ): string | null {
      // F4: Build a signed np.reject_deal so the startup reconciliation path
      // can notify the counterparty before cancelling locally.
      //
      // Round-13 F3: no longer require the deal to be tracked in-memory —
      // the reconciliation path needs to send rejects even for persisted
      // deals whose hydrateDeal() call failed (invalid terms on disk, or
      // deal_id mismatch). Those deals never enter `deals`, but we still
      // want the counterparty to stop proceeding toward proposeSwap.
      //
      // Security: validate deal_id syntax before signing. Attacker-controlled
      // persisted state could otherwise coerce us into publishing our
      // signature over arbitrary attacker-chosen deal_id values.
      if (!DEAL_ID_RE.test(dealId)) {
        logger.warn('build_reject_deal_invalid_id', { deal_id: dealId });
        return null;
      }
      // Round-15 F1: when callers provide participant pubkeys (e.g. from a
      // persisted DealRecord that may have been crafted by an attacker with
      // disk-write access), verify our agent pubkey is one of them before
      // signing. Without this check, an attacker could set
      // proposer_pubkey=ourPubkey, acceptor_pubkey=attackerPubkey,
      // acceptor_address=attackerAddress, deal_id=sha256(canonicalJson(terms))
      // and have our startup reconciliation sign an np.reject_deal for a
      // deal we never negotiated, delivered to an attacker-chosen address.
      if (participants !== undefined) {
        if (
          !pubkeysEqual(agentPubkey, participants.proposer_pubkey) &&
          !pubkeysEqual(agentPubkey, participants.acceptor_pubkey)
        ) {
          logger.warn('build_reject_deal_non_participant_rejected', {
            deal_id: dealId,
            proposer: participants.proposer_pubkey,
            acceptor: participants.acceptor_pubkey,
          });
          return null;
        }
      }
      const rejectMsg = buildNpMessage(dealId, 'np.reject_deal', {
        reason_code: reasonCode,
        message: messageText,
      });
      return JSON.stringify(rejectMsg);
    },
    getDeal,
    listDeals,
    cancelPending,
    drainPersistChains,
    stop: stopAll,
  };
}
