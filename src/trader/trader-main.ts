/**
 * Trader Agent Template — entry point.
 *
 * Startup: wire components → load persisted state → start AcpListener →
 *          subscribe to swap events → start IntentEngine scan loop.
 * Shutdown: stop IntentEngine → cancel negotiations → stop SwapExecutor →
 *           persist state → stop AcpListener.
 *
 * Since the actual Sphere SDK is not available in this repo, the main
 * function accepts pre-initialized SDK modules via dependency injection.
 */

import { join } from 'node:path';

import { pubkeysEqual } from '../shared/crypto.js';
import { withTimeout } from '../shared/with-timeout.js';
import type { Logger } from '../shared/logger.js';
import type { TenantConfig } from '../shared/types.js';
import type { SphereDmSender, SphereDmReceiver } from '../tenant/types.js';
import { createAcpListener } from '../tenant/acp-listener.js';
import type { AcpListener } from '../tenant/acp-listener.js';
import { createCommandHandler } from '../tenant/command-handler.js';
import type { CommandHandler } from '../tenant/command-handler.js';

import type {
  PaymentsAdapter,
  MarketAdapter,
  MarketSearchResult,
  TraderStrategy,
  DealRecord,
  OnMatchFound,
  OnDealAccepted,
  OnSwapCompleted,
  OnSwapFailed,
} from './types.js';
import { DEFAULT_STRATEGY } from './types.js';
import type { SwapAdapter } from './swap-executor.js';
import type { IntentEngine } from './intent-engine.js';
import type { NegotiationHandler } from './negotiation-handler.js';
import type { SwapExecutor } from './swap-executor.js';
import type { VolumeReservationLedger } from './volume-reservation-ledger.js';
import type { TraderStateStore } from './trader-state-store.js';
import type { WithdrawTokenParams } from './acp-types.js';

import { parseDescription } from './utils.js';
import { createIntentEngine } from './intent-engine.js';
import { createNegotiationHandler } from './negotiation-handler.js';
import { createSwapExecutor } from './swap-executor.js';
import { createVolumeReservationLedger, loadVolumeReservationLedger } from './volume-reservation-ledger.js';
import { createFsTraderStateStore } from './trader-state-store.js';
import { createTraderCommandHandler } from './trader-command-handler.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface TraderMainDeps {
  // SDK adapters
  readonly payments: PaymentsAdapter;
  readonly market: MarketAdapter;
  readonly swap: SwapAdapter;
  readonly comms: { sendDm: (to: string, content: string) => Promise<void> };

  // Sphere instance controls
  readonly subscribeEvent: (eventType: string, handler: (...args: unknown[]) => void) => () => void;
  readonly signMessage: (message: string) => string;
  readonly verifySignature: (signature: string, message: string, pubkey: string) => boolean;

  // Tenant config
  readonly config: TenantConfig;
  readonly agentPubkey: string;
  readonly agentAddress: string;
  /** Direct address (DIRECT://...) for swap proposals — avoids nametag timing issues. */
  readonly swapDirectAddress?: string;
  readonly agentNametag?: string | null;
  readonly managerAddress: string;

  // Infrastructure
  readonly sender: SphereDmSender;
  readonly receiver: SphereDmReceiver;
  readonly logger: Logger;
  readonly dataDir: string;

  // SDK introspection for diagnostics and swap progress tracking
  readonly debugResolve?: (address: string) => Promise<{ directAddress?: string; chainPubkey?: string } | null>;
  readonly debugGetActiveAddresses?: () => Array<{ directAddress: string; chainPubkey: string }>;
  readonly getSwapProgress?: () => Promise<Array<{ swapId: string; progress: string; payoutVerified?: boolean }>>;
}

export interface TraderAgent {
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Register an SDK swapId with the deal tracker (acceptor path). When
   * `match` is provided, the tracker uses asset/amount/counterparty fields
   * to disambiguate concurrent acceptor deals (C16).
   *
   * F3: Returns `true` if the swap was bound to a LIVE NP-0 deal
   * (ACCEPTED/EXECUTING). Returns `false` when the gate blocks the
   * auto-accept path (no live deal, ambiguous match, or NP-0 state is not
   * LIVE). The caller must reject the swap via the SDK when this returns
   * false — otherwise the SDK's auto-accept could move funds on a deal we
   * no longer honor (e.g., a deal whose accept-DM send failed).
   */
  registerSwapId(swapId: string, match?: import('./swap-executor.js').SwapProposalMatchInfo): boolean;
  /** Notify the deal tracker of swap completion. */
  handleSwapCompleted(swapId: string, payoutVerified: boolean): void;
  /** Notify the deal tracker of swap failure. */
  handleSwapFailed(swapId: string, reason: string): void;
  /** Get the current trading strategy. */
  getStrategy(): TraderStrategy;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTraderAgent(deps: TraderMainDeps): TraderAgent {
  const {
    payments,
    market,
    swap,
    comms,
    // subscribeEvent is available but unused — all swap events are handled
    // by direct sphere.on() listeners in main.ts, not via this bridge.
    signMessage,
    verifySignature,
    config,
    agentPubkey,
    agentAddress,
    managerAddress,
    sender,
    receiver,
    logger,
    dataDir,
  } = deps;

  // Lazily initialized during start()
  let stateStore: TraderStateStore | null = null;
  let strategy: TraderStrategy = { ...DEFAULT_STRATEGY };
  let ledger: VolumeReservationLedger | null = null;
  let intentEngine: IntentEngine | null = null;
  let negotiationHandler: NegotiationHandler | null = null;
  let swapExecutor: SwapExecutor | null = null;
  let acpListener: AcpListener | null = null;

  // Event unsubscribers collected during start()
  const unsubscribers: Array<() => void> = [];

  let started = false;

  // ----- withdraw helper -----

  /**
   * Forward a withdrawal request to PaymentsModule.send via the
   * PaymentsAdapter. The adapter is wired in trader/main.ts to call
   * `sphere.payments.send(...)` for real bootstraps, and to a recording stub
   * in tests. The returned `transfer_id` is the SDK-issued TransferResult.id
   * so callers can correlate settlement with on-chain history.
   *
   * Errors propagate to the caller (TraderCommandHandler) which maps them
   * onto `acp.error` responses. We do NOT swallow — a withdrawal failure
   * must surface so the controller can retry or escalate.
   */
  async function withdraw(
    params: WithdrawTokenParams,
  ): Promise<{ transfer_id: string; remaining_balance: bigint }> {
    const sendResult = await payments.send({
      coinId: params.asset,
      amount: params.amount,
      recipient: params.to_address,
    });
    if (sendResult.error !== undefined && sendResult.error !== '') {
      logger.warn('withdraw_send_returned_error', {
        asset: params.asset,
        amount: params.amount,
        to_address: params.to_address,
        transfer_id: sendResult.transferId,
        status: sendResult.status,
        error: sendResult.error,
      });
      throw new Error(`PaymentsModule.send failed: ${sendResult.error}`);
    }
    logger.info('withdraw_sent', {
      asset: params.asset,
      amount: params.amount,
      to_address: params.to_address,
      transfer_id: sendResult.transferId,
      status: sendResult.status,
    });
    const remaining = payments.getConfirmedBalance(params.asset) - BigInt(params.amount);
    return {
      transfer_id: sendResult.transferId,
      remaining_balance: remaining < 0n ? 0n : remaining,
    };
  }

  return {
    async start(): Promise<void> {
      if (started) return;
      started = true;

      const traderDir = join(dataDir, 'trader');

      // 1. Create state store
      stateStore = createFsTraderStateStore(traderDir);

      // 2. Load strategy (fall back to DEFAULT_STRATEGY) and overlay
      //    operator overrides from the optional config file +
      //    UNICITY_TRUSTED_ESCROWS env var. Precedence (later wins):
      //      DEFAULT_STRATEGY → persisted (state-store) → file override → env override.
      //
      //    File override path: ${dataDir}/config/trader-strategy.json. The
      //    file is read non-fatally — a malformed JSON or a permissions
      //    error logs a warning and is otherwise ignored so a typo cannot
      //    keep the trader from booting.
      const persisted = await stateStore.loadStrategy();
      strategy = persisted ?? { ...DEFAULT_STRATEGY };

      try {
        const fsModule = await import('node:fs');
        const overrideFile = join(dataDir, 'config', 'trader-strategy.json');
        if (fsModule.existsSync(overrideFile)) {
          const raw = fsModule.readFileSync(overrideFile, 'utf-8');
          const parsed: unknown = JSON.parse(raw);
          if (parsed !== null && typeof parsed === 'object') {
            const overrides = parsed as Record<string, unknown>;
            // Build the next strategy as a fresh literal so the readonly
            // fields on TraderStrategy are correctly typed without mutating
            // a frozen value. Only the well-known keys are copied across —
            // everything else is silently dropped to avoid a malicious file
            // injecting unintended fields onto the strategy record.
            let trustedEscrows: readonly string[] = strategy.trusted_escrows;
            if (Array.isArray(overrides['trusted_escrows'])) {
              trustedEscrows = (overrides['trusted_escrows'] as unknown[])
                .filter((s): s is string => typeof s === 'string' && s !== '');
            }
            strategy = { ...strategy, ...overrides, trusted_escrows: trustedEscrows } as TraderStrategy;
            logger.info('strategy_override_file_applied', { path: overrideFile });
          }
        }
      } catch (err) {
        logger.warn('strategy_override_file_load_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const envEscrows = process.env['UNICITY_TRUSTED_ESCROWS'];
      if (envEscrows !== undefined && envEscrows !== '') {
        const list = envEscrows.split(',').map((s) => s.trim()).filter((s) => s !== '');
        if (list.length > 0) {
          strategy = { ...strategy, trusted_escrows: list };
          logger.info('trusted_escrows_env_applied', { count: list.length });
        }
      }

      // 3. Create VolumeReservationLedger, restoring persisted reservations
      const getBalance = (coinId: string): bigint => payments.getConfirmedBalance(coinId);
      const serializedReservations = await stateStore.loadReservations();
      if (serializedReservations !== null) {
        try {
          ledger = loadVolumeReservationLedger(getBalance, serializedReservations);
          logger.info('reservations_restored');
        } catch {
          logger.warn('reservations_restore_failed_starting_fresh');
          ledger = createVolumeReservationLedger(getBalance);
        }
      } else {
        ledger = createVolumeReservationLedger(getBalance);
      }

      // 4. Wire callbacks between components
      //    The callbacks form a cycle that is resolved by lazy references:
      //    onMatchFound -> negotiationHandler.proposeDeal
      //    onDealAccepted -> swapExecutor.executeDeal
      //    onSwapCompleted -> update intent + release reservation
      //    onSwapFailed -> release reservation + resume matching

      const onMatchFound: OnMatchFound = async (ownIntent, counterparty) => {
        if (!negotiationHandler) return;

        // Parse the counterparty's rate range from their description
        const parsed = parseDescription(counterparty.description);
        if (!parsed) {
          logger.warn('match_found_unparseable_description', {
            intent_id: ownIntent.intent.intent_id,
            counterparty: counterparty.agentPublicKey,
          });
          return;
        }

        // Compute midpoint of the overlap range (spec Section 5)
        const overlapMin = ownIntent.intent.rate_min > parsed.rate_min
          ? ownIntent.intent.rate_min : parsed.rate_min;
        const overlapMax = ownIntent.intent.rate_max < parsed.rate_max
          ? ownIntent.intent.rate_max : parsed.rate_max;
        const midRate = (overlapMin + overlapMax) / 2n;

        // Fan-out safety (W): when the intent-engine fans out to N candidates,
        // each receives remainingVolume/N instead of the full remainingVolume
        // so that two concurrent accepts cannot exceed volume_max. The per-
        // candidate volume is attached to the MarketSearchResult by the
        // intent engine as `__perCandidateVolume` (internal field).
        const withPerCandidate = counterparty as MarketSearchResult & { __perCandidateVolume?: bigint };
        const remainingVolume = ownIntent.intent.volume_max - ownIntent.intent.volume_filled;
        const proposalVolume = withPerCandidate.__perCandidateVolume ?? remainingVolume;
        if (proposalVolume <= 0n) {
          logger.info('match_found_zero_volume_for_candidate', {
            intent_id: ownIntent.intent.intent_id,
            counterparty: counterparty.agentPublicKey,
            remaining_volume: remainingVolume.toString(),
          });
          return;
        }
        const escrow = ownIntent.intent.escrow_address;
        await negotiationHandler.proposeDeal(
          ownIntent,
          counterparty,
          midRate,
          proposalVolume,
          escrow,
        );
      };

      const onDealAccepted: OnDealAccepted = async (deal: DealRecord) => {
        if (!swapExecutor || !ledger || !stateStore) return;

        // Warning fix — volume reservation failure must ABORT the deal rather
        // than proceed. Previously a failed reserve logged a warning and fell
        // through to proposeSwap, potentially over-committing volume across
        // concurrent deals. Now we cancel/fail the deal and release the intent.
        let reserved = false;
        try {
          reserved = await ledger.reserve(deal.terms.base_asset, deal.terms.volume, deal.terms.deal_id);
          if (reserved) {
            await stateStore.saveReservations(ledger.serialize());
          }
        } catch (err: unknown) {
          logger.error('deal_volume_reservation_error', {
            deal_id: deal.terms.deal_id,
            error: err instanceof Error ? err.message : String(err),
          });
          reserved = false;
        }

        if (!reserved) {
          logger.error('deal_volume_reservation_failed_aborting', {
            deal_id: deal.terms.deal_id,
            base_asset: deal.terms.base_asset,
            volume: deal.terms.volume.toString(),
          });
          // Fail the NP-0 deal so the counterparty sees it go terminal and the
          // intent is restored to ACTIVE rather than parked in MATCHING.
          if (negotiationHandler) {
            negotiationHandler.failDeal(deal.terms.deal_id);
          }
          if (intentEngine) {
            intentEngine.restoreToActive(deal.terms.proposer_intent_id);
          }
          return;
        }

        // Track the deal in the SwapExecutor for LIST_SWAPS / DEBUG_SWAP_EXEC.
        // For the proposer, this also calls swap.proposeSwap() directly.
        // For the acceptor, the SDK handles acceptance via sphere.on('swap:proposal_received')
        // in main.ts — the executor just tracks the deal state.
        try {
          await swapExecutor.executeDeal(deal);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error('execute_deal_failed', {
            deal_id: deal.terms.deal_id,
            error: msg,
            stack: err instanceof Error ? err.stack?.split('\n').slice(0, 3).join(' | ') : undefined,
          });
          // executeDeal threw — release reservation, fail the NP-0 deal,
          // AND restore the intent to ACTIVE. F2: failDeal transitions to
          // FAILED (not CANCELLED), so the NegotiationHandler's
          // onDealCancelled → restoreToActive path never fires. Without the
          // explicit restore below, the intent is parked in MATCHING forever.
          // Match the pattern from the reservation-failure branch above.
          ledger.release(deal.terms.deal_id);
          // F7 (round-23): surface persistence failures rather than
          // swallowing them. A silent catch hides the reason a stranded
          // reservation persists across restarts — operators see the
          // leaked reservation but no signal about which write failed.
          await stateStore.saveReservations(ledger.serialize()).catch((err: unknown) =>
            logger.warn('reservations_persist_failed', {
              deal_id: deal.terms.deal_id,
              context: 'execute_deal_failed_release',
              error: err instanceof Error ? err.message : String(err),
            }),
          );
          if (negotiationHandler) {
            negotiationHandler.failDeal(deal.terms.deal_id);
          }
          if (intentEngine) {
            intentEngine.restoreToActive(deal.terms.proposer_intent_id);
          }
        }
      };

      const onSwapCompleted: OnSwapCompleted = async (deal: DealRecord, payoutVerified: boolean) => {
        if (!ledger || !stateStore) return;

        // Warning fix — payoutVerified === false must NOT be treated as a
        // successful COMPLETED deal. We sent our tokens but the payout
        // invoice didn't validate; this is a FAILED outcome flagged for
        // manual reconciliation. The reservation is still released so we
        // don't leak volume, but the intent is restored and no fill is
        // recorded on the intent.
        if (!payoutVerified) {
          logger.error('swap_completed_payout_unverified', {
            deal_id: deal.terms.deal_id,
            swap_id: deal.swap_id,
            note: 'Manual reconciliation required — payout invoice failed verification',
            failure_reason: 'PAYOUT_UNVERIFIED',
          });
          ledger.release(deal.terms.deal_id);
          // F7 (round-23): surface persistence failures. Silently
          // swallowing here hides the cause of a leaked reservation from
          // operators trying to diagnose why a cancelled PAYOUT_UNVERIFIED
          // deal's funds are still reserved across restarts.
          await stateStore.saveReservations(ledger.serialize()).catch((err: unknown) =>
            logger.warn('reservations_persist_failed', {
              deal_id: deal.terms.deal_id,
              context: 'payout_unverified_release',
              error: err instanceof Error ? err.message : String(err),
            }),
          );
          // Restore the intent so we can retry. Don't record the fill.
          if (intentEngine) {
            intentEngine.restoreToActive(deal.terms.proposer_intent_id);
          }
          if (negotiationHandler) {
            negotiationHandler.failDeal(deal.terms.deal_id);
          }
          return;
        }

        ledger.release(deal.terms.deal_id);
        await stateStore.saveReservations(ledger.serialize());

        if (intentEngine) {
          intentEngine.recordFill(deal.terms.proposer_intent_id, deal.terms.volume);
        }
        // Transition the NP-0 deal to COMPLETED so LIST_SWAPS reflects it
        if (negotiationHandler) {
          negotiationHandler.completeDeal(deal.terms.deal_id);
        }
        logger.info('swap_completed_reservation_released', {
          deal_id: deal.terms.deal_id,
          payout_verified: payoutVerified,
        });
      };

      const onSwapFailed: OnSwapFailed = async (deal: DealRecord, reason: string) => {
        if (!ledger || !stateStore) return;
        ledger.release(deal.terms.deal_id);
        await stateStore.saveReservations(ledger.serialize());

        // Restore the intent to ACTIVE so it can be matched again
        if (intentEngine) {
          intentEngine.restoreToActive(deal.terms.proposer_intent_id);
        }
        // Transition the NP-0 deal to FAILED so LIST_SWAPS reflects it
        if (negotiationHandler) {
          negotiationHandler.failDeal(deal.terms.deal_id);
        }
        logger.warn('swap_failed_reservation_released', { deal_id: deal.terms.deal_id, reason });
      };

      // 5. Create IntentEngine
      intentEngine = createIntentEngine({
        market,
        ledger,
        strategy,
        agentPubkey,
        agentAddress,
        agentNametag: deps.agentNametag,
        signMessage,
        onMatchFound,
        logger: logger.child({ component: 'intent-engine' }),
      });

      // 6. Create NegotiationHandler
      const capturedStateStoreForDeals = stateStore;
      negotiationHandler = createNegotiationHandler({
        sendDm: comms.sendDm,
        signMessage,
        verifySignature,
        onDealAccepted,
        // C14 — persist every deal state transition so a restart mid-handshake
        // can still process incoming np.accept_deal for our PROPOSED deals.
        onDealStateChange: async (deal: DealRecord) => {
          await capturedStateStoreForDeals.saveDeal(deal);
        },
        getIntent: (intentId: string) => {
          if (!intentEngine) return null;
          // Try by internal intent_id first
          const record = intentEngine.getIntent(intentId);
          if (record) {
            return {
              direction: record.intent.direction,
              base_asset: record.intent.base_asset,
              quote_asset: record.intent.quote_asset,
              rate_min: record.intent.rate_min,
              rate_max: record.intent.rate_max,
              volume_min: record.intent.volume_min,
              volume_max: record.intent.volume_max,
            };
          }
          // Proposer sets acceptor_intent_id from MarketModule search result ID
          // (market_intent_id), not the internal intent_id. Scan by market ID.
          const byMarketId = intentEngine.getIntentByMarketId?.(intentId);
          if (byMarketId) {
            return {
              direction: byMarketId.intent.direction,
              base_asset: byMarketId.intent.base_asset,
              quote_asset: byMarketId.intent.quote_asset,
              rate_min: byMarketId.intent.rate_min,
              rate_max: byMarketId.intent.rate_max,
              volume_min: byMarketId.intent.volume_min,
              volume_max: byMarketId.intent.volume_max,
            };
          }
          return null;
        },
        getTrustedEscrows: () => strategy.trusted_escrows,
        onDealCancelled: (deal) => {
          // When a deal is cancelled (e.g. proposal timeout to a dead counterparty),
          // mark the counterparty as failed so the engine skips it on the next scan,
          // then restore the intent to ACTIVE to try a different match.
          // Detect which side we are to use the correct intent ID (steelman #5).
          if (!intentEngine) return;
          // pubkeysEqual (not ===) because terms.*_pubkey may be in wire format
          // (x-only from Nostr) while agentPubkey is SDK-canonical (compressed).
          // A naive === misclassifies us as "unknown role" and the intent is
          // never restored to ACTIVE — silent failure.
          const weAreProposer = pubkeysEqual(deal.terms.proposer_pubkey, agentPubkey);
          const weAreAcceptor = pubkeysEqual(deal.terms.acceptor_pubkey, agentPubkey);
          if (!weAreProposer && !weAreAcceptor) {
            logger.error('on_deal_cancelled_unknown_role', {
              deal_id: deal.terms.deal_id,
              our_pubkey: agentPubkey,
              proposer: deal.terms.proposer_pubkey,
              acceptor: deal.terms.acceptor_pubkey,
            });
            return;
          }
          const ourIntentId = weAreProposer
            ? deal.terms.proposer_intent_id
            : deal.terms.acceptor_intent_id;
          const theirPubkey = weAreProposer
            ? deal.terms.acceptor_pubkey
            : deal.terms.proposer_pubkey;
          intentEngine.markCounterpartyFailed(ourIntentId, theirPubkey);
          intentEngine.restoreToActive(ourIntentId);
        },
        agentPubkey,
        agentAddress,
        logger: logger.child({ component: 'negotiation-handler' }),
      });

      // 7. Create SwapExecutor
      swapExecutor = createSwapExecutor({
        swap,
        strategy,
        onSwapCompleted,
        onSwapFailed,
        agentPubkey,
        agentAddress,
        swapDirectAddress: deps.swapDirectAddress ?? agentAddress,
        payments: { receive: () => payments.refresh() },
        logger: logger.child({ component: 'swap-executor' }),
      });

      // 8a. C14 + F4 — reconcile persisted in-flight deals.
      //     On startup, any deal persisted as PROPOSED or ACCEPTED belongs to
      //     a negotiation window that has already passed (the counterparty's
      //     retry clock is way beyond our 30s timer). We must:
      //       (1) Hydrate the deal into the NegotiationHandler BEFORE
      //           attaching the DM listener, so late np.accept_deal or
      //           np.reject_deal messages from the counterparty find a
      //           known deal record (otherwise the handler drops them with
      //           "np_accept_deal_unknown" and cannot properly react).
      //       (2) Notify the counterparty via np.reject_deal with reason
      //           'AGENT_RESTARTED' so they proactively abandon the deal
      //           (best-effort; the send may fail for a dead counterparty
      //           but that's no worse than before).
      //       (3) Mark CANCELLED on disk and release reservations.
      //     This closes the gap where a counterparty whose np.accept_deal
      //     arrives post-restart would otherwise proceed to proposeSwap —
      //     the auto-accept gate in main.ts (F3) then rejects the swap
      //     because the reconciled NP-0 deal is CANCELLED, not LIVE.
      // Only the outer loadDeals is inside the top-level try. Each iteration
      // body gets its own try/catch so a single deal's failure (saveDeal
      // error, sendDm throw, ledger.release exception) does NOT abort
      // reconciliation for the remaining deals — round-13 F1.
      let persistedDeals: DealRecord[] = [];
      try {
        persistedDeals = await stateStore.loadDeals({ state: ['PROPOSED', 'ACCEPTED'] });
      } catch (err: unknown) {
        logger.warn('persisted_deal_load_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const RECONCILE_DM_TIMEOUT_MS = 10_000;
      // Round-17 F4: abandon a poisoned persisted deal after this many
      // failed reconciliation attempts. Each failed saveDeal bumps the
      // counter; a successful save resets it. Beyond the threshold we
      // log at ERROR and skip without sending a reject DM — operator
      // intervention required.
      const RECONCILIATION_MAX_ATTEMPTS = 10;

      // Round-19 F9: in-memory fallback counter for cases where the bumped
      // counter save ALSO fails. Without this, a poisoned record whose
      // counter-write itself keeps failing would be retried forever on
      // every restart (reconciliation_attempts stays at 0 on disk because
      // the bump never lands). Tracked per-deal in this Map, reset when
      // the outer loop is re-entered on a subsequent agent start only
      // (process-lifetime scope). An attacker who repeatedly restarts us
      // could still hit this in each restart, but the per-deal 10-attempt
      // cap within a single process lifetime bounds the outbound reject
      // amplification at 10 rejects per deal per restart.
      const inMemoryReconciliationFailures = new Map<string, number>();

      for (const persisted of persistedDeals) {
        // Round-13 F1: isolate each iteration. A throw from any step —
        // saveDeal, ledger.release, buildRejectDealMessage, or sendDm —
        // used to fall through to the outer try/catch and abandon every
        // remaining deal in the list. That left counterparties waiting
        // on deals this agent had quietly given up on. Per-iteration
        // try/catch makes reconciliation per-deal best-effort.
        try {
          // Round-17 F4 + Round-19 F9: bail out if this record has
          // already failed reconciliation too many times. We consider
          // BOTH the persisted counter (successful bumps across
          // restarts) and the in-memory counter (current-process bumps
          // whose persisted save may itself have failed). Max() gives
          // the worst-case view so a poisoned record gets abandoned
          // even when the bump-write path is also broken.
          const priorAttempts = persisted.reconciliation_attempts ?? 0;
          const inMemAttempts = inMemoryReconciliationFailures.get(persisted.terms.deal_id) ?? 0;
          const effectiveAttempts = Math.max(priorAttempts, inMemAttempts);
          if (effectiveAttempts >= RECONCILIATION_MAX_ATTEMPTS) {
            logger.error('reconciliation_giving_up_deal_poisoned', {
              deal_id: persisted.terms.deal_id,
              previous_state: persisted.state,
              attempts: priorAttempts,
              in_memory_attempts: inMemAttempts,
              note: 'Manual cleanup of the persisted deal record required.',
            });

            // Round-19 F2: release the stranded reservation and delete
            // the poisoned deal record so the leaked volume becomes
            // available for future deals and the poisoned record stops
            // appearing in every future reconciliation pass. Previously
            // the early `continue` bypassed ledger.release and
            // saveReservations entirely — a legitimate 1000-BASE
            // reservation could be stuck forever, blocking all further
            // trading for that asset. Best-effort: each step swallows
            // its own error so a failure in one doesn't skip the others.
            try {
              if (ledger) ledger.release(persisted.terms.deal_id);
              if (ledger) {
                await stateStore.saveReservations(ledger.serialize()).catch((err: unknown) => {
                  logger.warn('reconciliation_reservation_release_save_failed', {
                    deal_id: persisted.terms.deal_id,
                    error: err instanceof Error ? err.message : String(err),
                  });
                });
              }
              await stateStore.deleteDeal(persisted.terms.deal_id).catch((err: unknown) => {
                logger.warn('reconciliation_poisoned_deal_delete_failed', {
                  deal_id: persisted.terms.deal_id,
                  error: err instanceof Error ? err.message : String(err),
                });
              });
            } catch (err: unknown) {
              logger.warn('reconciliation_poisoned_cleanup_failed', {
                deal_id: persisted.terms.deal_id,
                error: err instanceof Error ? err.message : String(err),
              });
            }
            continue;
          }

          // F5 (round-23): hydrate the PERSISTED record FIRST (with its
          // original `updated_at`), so the handler's `updated_at >=
          // env.ts_ms - CLOCK_SKEW_TOLERANCE_MS` cross-check actually
          // exercises the disk value. Previously we built `cancelled`
          // with `updated_at: Date.now()` and passed that to
          // `hydrateDealAttempt`, which made the cross-check
          // automatically pass — defeating its purpose for disk-write
          // attackers who pair a recent `updated_at` with an ancient
          // captured envelope. Only after hydrate returns ok do we
          // construct the CANCELLED copy that gets written back to disk.
          //
          // Round-17 F1 / Round-21 F1: hydrateDealAttempt returns a
          // DISCRIMINATED result. The three paths we care about:
          //
          //   (a) ok=true                             — record verified, side-effect chain runs.
          //   (b) no_envelope_proposer_record         — OUR proposer-side PROPOSED
          //                                             record whose counterparty
          //                                             never ack'd before we crashed.
          //                                             Legitimate. We own the signing
          //                                             key for these terms (we're the
          //                                             proposer), so we can self-sign a
          //                                             reject, release reservation, and
          //                                             DELETE the on-disk record.
          //   (c) anything else                       — suspicious / legacy / attacker-
          //                                             crafted. Leave disk untouched,
          //                                             WARN for operator triage.
          //
          // Previously `hydrateDeal` lumped (b) and (c) together and
          // `continue` left PROPOSED records on disk forever with
          // their reservations stuck, accumulating across restarts.
          let hydrateResult: ReturnType<typeof negotiationHandler.hydrateDealAttempt>;
          try {
            hydrateResult = negotiationHandler.hydrateDealAttempt(persisted);
          } catch (err: unknown) {
            logger.warn('persisted_deal_hydrate_failed', {
              deal_id: persisted.terms.deal_id,
              error: err instanceof Error ? err.message : String(err),
            });
            // Treat an unexpected throw as a suspicious record.
            hydrateResult = { ok: false, reason: 'invalid_shape', record: persisted };
          }

          // Round-21 F1: Legitimate proposer-side crash during the
          // PROPOSED→ACCEPTED window. We need to:
          //
          //   1. Self-sign an np.reject_deal for the counterparty (we own
          //      the signing key for these terms — we authored them).
          //      buildRejectDealMessage with `participants` verifies we're
          //      a participant, which we are (proposer), so it signs
          //      cleanly.
          //   2. Release the stranded reservation.
          //   3. Delete the on-disk record so it doesn't re-appear on the
          //      next startup and leak reservations forever.
          //
          // Best-effort throughout: each step's failure is logged and
          // swallowed so partial progress is always better than none.
          if (!hydrateResult.ok && hydrateResult.reason === 'no_envelope_proposer_record') {
            logger.info('reconciliation_proposer_propose_crash_abandoned', {
              deal_id: persisted.terms.deal_id,
              state: persisted.state,
            });

            // F5 (round-23): we hydrated with the PERSISTED record (state
            // PROPOSED) so the env cross-check saw the real updated_at.
            // Round-23 F4: `hydrateDealAttempt` now installs the record
            // in memory AS CANCELLED (not PROPOSED) for the
            // `no_envelope_proposer_record` branch, so a late
            // np.accept_deal from the counterparty hits the terminal-
            // state guard in handleAcceptDeal directly — no second
            // hydrate needed. The previous double-hydrate was fragile:
            // an error path that skipped the second call left the map
            // with a PROPOSED copy that would erroneously transition to
            // ACCEPTED on a late counterparty DM. Trusting the handler
            // to install terminal state closes the race.

            // Self-signed reject (we ARE the proposer; passing participant
            // pubkeys satisfies the in-handler participant check).
            const rejectJson = negotiationHandler.buildRejectDealMessage(
              persisted.terms.deal_id,
              'AGENT_RESTARTED',
              'Agent restarted — propose uncommitted, deal abandoned',
              {
                proposer_pubkey: persisted.terms.proposer_pubkey,
                acceptor_pubkey: persisted.terms.acceptor_pubkey,
              },
            );
            if (rejectJson) {
              // F9 (round-23): use the shared `withTimeout` helper rather
              // than a hand-rolled Promise.race. The bespoke race leaked a
              // setTimeout into the event loop whenever sendDm resolved
              // first — the timer wasn't cleared in either branch, so on a
              // fast shutdown the uncleared timers could keep the event
              // loop open past the intended teardown budget. `withTimeout`
              // clears the timer in a finally block.
              const r = await withTimeout(
                'reconcile_proposer_crash_reject_send',
                RECONCILE_DM_TIMEOUT_MS,
                logger,
                () => comms.sendDm(persisted.terms.acceptor_address, rejectJson),
              ).catch((err: unknown) => {
                logger.warn('proposer_propose_crash_reject_send_failed', {
                  deal_id: persisted.terms.deal_id,
                  counterparty: persisted.terms.acceptor_address,
                  error: err instanceof Error ? err.message : String(err),
                });
                return { timedOut: true as const };
              });
              if (r.timedOut) {
                logger.warn('proposer_propose_crash_reject_send_timeout', {
                  deal_id: persisted.terms.deal_id,
                  counterparty: persisted.terms.acceptor_address,
                });
              } else {
                logger.info('proposer_propose_crash_reject_dm_sent', {
                  deal_id: persisted.terms.deal_id,
                  counterparty: persisted.terms.acceptor_address,
                });
              }
            }

            // Release reservation + delete record.
            ledger.release(persisted.terms.deal_id);
            await stateStore.saveReservations(ledger.serialize()).catch((err: unknown) => {
              logger.warn('proposer_propose_crash_reservation_save_failed', {
                deal_id: persisted.terms.deal_id,
                error: err instanceof Error ? err.message : String(err),
              });
            });
            await stateStore.deleteDeal(persisted.terms.deal_id).catch((err: unknown) => {
              logger.warn('proposer_propose_crash_delete_failed', {
                deal_id: persisted.terms.deal_id,
                error: err instanceof Error ? err.message : String(err),
              });
            });
            continue;
          }

          // Round-19 F3 / Round-21 F1: gate the ENTIRE side-effect chain
          // on hydrate success. For any other non-ok result (bad
          // signature, stale envelope, oversized envelope, invalid shape,
          // terms-mismatch, non-participant, acceptor-side missing
          // envelope), leave the record on disk — operator must triage.
          // Legitimate proposer-crash records are handled above with a
          // safe, deterministic cleanup; everything else might be an
          // attacker trying to extract a signed reject for a deal_id
          // they chose.
          if (!hydrateResult.ok) {
            logger.warn('reconciliation_skipped_unhydrateable_record', {
              deal_id: persisted.terms.deal_id,
              previous_state: persisted.state,
              reason: hydrateResult.reason,
              note: 'Operator triage required: legacy pre-round-17 record, or attacker-crafted disk state.',
            });
            continue;
          }

          // F5 (round-23): hydrate succeeded — the envelope cross-check
          // passed on the PERSISTED record's real updated_at. NOW build
          // the CANCELLED copy that gets written back to disk and
          // overwrite the in-memory entry so a late np.accept_deal hits
          // the terminal-state guard in handleAcceptDeal (previously
          // this was done as part of hydrate's input, but that made the
          // updated_at cross-check a no-op because we always stamped
          // `Date.now()`).
          const cancelled: DealRecord = {
            ...persisted,
            state: 'CANCELLED',
            updated_at: Date.now(),
            reconciliation_attempts: 0,
          };
          try {
            negotiationHandler.hydrateDealAttempt(cancelled);
          } catch (err: unknown) {
            logger.warn('reconciliation_cancel_inmemory_refresh_failed', {
              deal_id: persisted.terms.deal_id,
              error: err instanceof Error ? err.message : String(err),
            });
            // The cross-check has already passed; fall through and save
            // the CANCELLED copy to disk. The in-memory state remains
            // whatever the first hydrate installed — a late DM would be
            // handled against that state.
          }

          // (2) F3 — Persist CANCELLED FIRST, then send the reject DM.
          //     If we send first and crash before persisting, the next startup
          //     would re-send the reject (and would still see the deal as
          //     PROPOSED/ACCEPTED). Persisting first guarantees the disk
          //     state is correct even if the DM send fails (F2) or the
          //     process dies before the send completes.
          //
          // Round-15 F3: wrap saveDeal in its own try/catch so a persistence
          // failure is visible as a distinct log event and the counterparty
          // reject DM is SKIPPED (rather than sent). Without this, a saveDeal
          // throw fell through to the outer per-iteration catch, which logged
          // a generic `deal_reconciliation_failed` and also prevented the
          // reject DM from being sent — but the failure mode was opaque
          // (operators couldn't tell that persistence, not a DM issue, was
          // the problem). Skipping the reject when the persist fails is
          // intentional: if disk state can't be updated to CANCELLED, we
          // don't want to send a signed reject DM whose post-condition on
          // disk is still PROPOSED/ACCEPTED — a future restart would re-send
          // the reject for a deal the counterparty has already abandoned.
          try {
            await stateStore.saveDeal(cancelled);
            // Successful save resets the in-memory failure counter so a
            // transient I/O hiccup doesn't poison subsequent attempts
            // within the same process lifetime.
            inMemoryReconciliationFailures.delete(persisted.terms.deal_id);
          } catch (saveErr: unknown) {
            logger.warn('reconciliation_save_failed_skipping_reject', {
              deal_id: persisted.terms.deal_id,
              previous_state: persisted.state,
              error: saveErr instanceof Error ? saveErr.message : String(saveErr),
            });
            // Round-17 F4: bump the reconciliation_attempts counter so
            // poisoned records eventually get abandoned rather than
            // retried indefinitely across restarts. Best-effort: write
            // the bumped counter back to the PROPOSED/ACCEPTED record
            // (not the CANCELLED in-memory copy); that's the record that
            // will be reloaded on the next startup.
            //
            // Round-19 F9: ALSO bump the in-memory counter so if the
            // persisted-counter save itself fails (likely when the
            // underlying save path is broken for everything), we still
            // converge on the RECONCILIATION_MAX_ATTEMPTS cap within
            // this process lifetime. Without this, a bum save path led
            // to infinite retries (priorAttempts stuck at 0 on disk) and
            // the counterparty got flooded with signed rejects.
            inMemoryReconciliationFailures.set(
              persisted.terms.deal_id,
              inMemAttempts + 1,
            );
            const withBumpedCounter: DealRecord = {
              ...persisted,
              reconciliation_attempts: priorAttempts + 1,
            };
            await stateStore.saveDeal(withBumpedCounter).catch((innerErr: unknown) => {
              logger.warn('reconciliation_attempt_counter_save_failed', {
                deal_id: persisted.terms.deal_id,
                error: innerErr instanceof Error ? innerErr.message : String(innerErr),
              });
            });
            continue;
          }
          logger.warn('persisted_deal_cancelled_on_startup', {
            deal_id: persisted.terms.deal_id,
            previous_state: persisted.state,
          });
          // Release any volume reservation tied to this deal.
          ledger.release(persisted.terms.deal_id);

          // (3) Best-effort: notify the counterparty with np.reject_deal so
          //     they don't proceed to proposeSwap. Determine the counterparty
          //     address by inspecting which side we are (pubkeysEqual handles
          //     wire-format vs canonical-format drift).
          //
          //     Round-17 F1 / Round-19 F3: hydrated gate has already been
          //     applied above; we only reach this code path for records
          //     with a cryptographically-verified counterparty envelope.

          const weAreProposer = pubkeysEqual(persisted.terms.proposer_pubkey, agentPubkey);
          const weAreAcceptor = pubkeysEqual(persisted.terms.acceptor_pubkey, agentPubkey);
          const counterpartyAddress = weAreProposer
            ? persisted.terms.acceptor_address
            : weAreAcceptor
              ? persisted.terms.proposer_address
              : '';
          if (counterpartyAddress) {
            // Round-15 F1: pass participant pubkeys so buildRejectDealMessage
            // rejects the request if our agent pubkey is not among them.
            // Closes the attack where a persisted DealRecord crafted by an
            // adversary with disk-write access could coerce us into signing
            // np.reject_deal for an arbitrary attacker-chosen deal_id and
            // delivering it to an attacker-chosen address.
            const rejectJson = negotiationHandler.buildRejectDealMessage(
              persisted.terms.deal_id,
              'AGENT_RESTARTED',
              'Agent restarted — deal cannot be honored',
              {
                proposer_pubkey: persisted.terms.proposer_pubkey,
                acceptor_pubkey: persisted.terms.acceptor_pubkey,
              },
            );
            if (rejectJson) {
              // F2 — race sendDm against a 10s timeout so a dead counterparty
              // or stuck relay can't stall reconciliation indefinitely. A
              // timeout/error must NOT abort the whole reconciliation loop —
              // the outer per-iteration try/catch (round-13 F1) absorbs any
              // thrown error and continues to the next deal.
              //
              // F9 (round-23): use the shared `withTimeout` helper. The
              // hand-rolled Promise.race above left the setTimeout live
              // even when sendDm resolved first — event-loop leak that
              // delayed clean shutdown. `withTimeout` clears the timer in
              // a finally block regardless of which branch wins.
              const r = await withTimeout(
                'reconcile_reject_send',
                RECONCILE_DM_TIMEOUT_MS,
                logger,
                () => comms.sendDm(counterpartyAddress, rejectJson),
              ).catch((err: unknown) => {
                // Counterparty may be dead; tolerable. Disk state is already
                // CANCELLED (F3), and the auto-accept gate still protects
                // us if they return and propose a swap.
                logger.warn('reconciliation_reject_send_failed', {
                  deal_id: persisted.terms.deal_id,
                  counterparty: counterpartyAddress,
                  error: err instanceof Error ? err.message : String(err),
                });
                return { timedOut: true as const };
              });
              if (r.timedOut) {
                logger.warn('reconciliation_reject_send_timeout', {
                  deal_id: persisted.terms.deal_id,
                  counterparty: counterpartyAddress,
                });
              } else {
                logger.info('persisted_deal_reject_dm_sent', {
                  deal_id: persisted.terms.deal_id,
                  counterparty: counterpartyAddress,
                });
              }
            } else {
              // Round-13 F3: buildRejectDealMessage returned null — this
              // now only happens when the persisted deal_id is
              // syntactically invalid (failed the DEAL_ID_RE regex),
              // meaning the on-disk record is corrupted. Surface this at
              // WARN so operators see that reconciliation skipped
              // counterparty notification for a corrupt record. No DM was
              // sent; the counterparty will rely on their own propose-
              // timeout to abandon the deal.
              logger.warn('reconciliation_hydrate_failed_no_reject_sent', {
                deal_id: persisted.terms.deal_id,
                counterparty: counterpartyAddress,
              });
            }
          } else {
            logger.warn('persisted_deal_unknown_role', {
              deal_id: persisted.terms.deal_id,
              our_pubkey: agentPubkey,
            });
          }
        } catch (err: unknown) {
          // Per-iteration failure isolation (round-13 F1). Logged at WARN
          // so it's visible without aborting reconciliation of remaining
          // deals. The in-memory hydrate may or may not have succeeded
          // depending on where in the iteration body the throw came from;
          // we tolerate that — the auto-accept gate in main.ts still
          // protects us (a missing in-memory record → no LIVE deal → swap
          // auto-accept refuses).
          logger.warn('deal_reconciliation_failed', {
            deal_id: persisted.terms.deal_id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (persistedDeals.length > 0) {
        // F7 (round-23): surface persistence failures. Silently swallowing
        // a reservation-save error at startup reconciliation hid any bug
        // in the persistence layer and left operators puzzled when
        // post-restart reservations didn't match released-on-disk deals.
        await stateStore.saveReservations(ledger.serialize()).catch((err: unknown) =>
          logger.warn('reservations_persist_failed', {
            context: 'reconciliation_final_save',
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }

      // 8. Create TraderCommandHandler wired into AcpListener
      const capturedIntentEngine = intentEngine;
      const capturedNegotiationHandler = negotiationHandler;
      const capturedSwapExecutor = swapExecutor;
      const capturedLedger = ledger;
      const capturedStrategy = strategy;
      const capturedStateStore = stateStore;

      const commandHandlerFactory = (
        instanceId: string,
        instanceName: string,
        startedAt: number,
        cmdLogger: Logger,
      ): CommandHandler => {
        const baseHandler = createCommandHandler(
          instanceId,
          instanceName,
          startedAt,
          cmdLogger,
        );

        return createTraderCommandHandler({
          baseHandler,
          intentEngine: capturedIntentEngine,
          negotiationHandler: capturedNegotiationHandler,
          swapExecutor: capturedSwapExecutor,
          ledger: capturedLedger,
          payments,
          market: deps.market,
          strategy: capturedStrategy,
          agentPubkey,
          agentAddress,
          // NOTE: Strategy mutation limitation — updating `strategy` here only
          // affects the TraderCommandHandler's local copy and the persisted state.
          // The IntentEngine and SwapExecutor capture the strategy reference at
          // creation time and will NOT see runtime changes. An updateStrategy()
          // method on IntentEngine/SwapExecutor would be needed for full propagation.
          // This is out of scope for now but should be addressed in a future iteration.
          saveStrategy: async (s: TraderStrategy) => {
            strategy = s;
            await capturedStateStore.saveStrategy(s);
          },
          withdraw,
          debugResolve: deps.debugResolve,
          debugGetActiveAddresses: deps.debugGetActiveAddresses,
          getSwapProgress: deps.getSwapProgress,
          logger: cmdLogger,
        });
      };

      // 9. Create and start AcpListener
      acpListener = createAcpListener({
        sender,
        receiver,
        config,
        tenantPubkey: agentPubkey,
        tenantDirectAddress: agentAddress,
        tenantNametag: deps.agentNametag ?? null,
        managerAddress,
        logger: logger.child({ component: 'acp-listener' }),
        commandHandlerFactory,
      });
      await acpListener.start();

      // 10. Route external DMs through NegotiationHandler
      //     The AcpListener routes non-manager DMs to its internal
      //     messageHandler. For the trader, we also subscribe at the
      //     raw receiver level so that NP-0 messages are dispatched
      //     to the negotiation handler.
      const dmSub = receiver.subscribeDm();
      dmSub.onMessage((senderPubkey: string, senderAddr: string, content: string) => {
        // Skip messages from the manager — AcpListener handles those.
        // Use pubkeysEqual (not ===) because Nostr delivers x-only while the
        // configured manager_pubkey may be compressed (02/03 prefix). A naive
        // === would let manager DMs fall through to the NP-0 handler.
        if (pubkeysEqual(senderPubkey, config.manager_pubkey)) return;
        capturedNegotiationHandler.handleIncomingDm(senderPubkey, senderAddr, content).catch(
          (err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error('negotiation_dm_handler_failed', { error: msg });
          },
        );
      });
      unsubscribers.push(() => dmSub.unsubscribe());

      // 11. Swap events — ALL handled by direct sphere.on() in main.ts.
      //     No event bridge needed. The SDK's SwapModule handles the full
      //     lifecycle (accept, deposit, payout, completion) and main.ts
      //     wires the sphere.on() listeners directly.

      // 12. Close stale intents from previous runs on the MarketModule.
      //     When a container crashes or is killed without graceful shutdown,
      //     its listings persist in the vector DB. Close them before starting
      //     the scan loop so they don't pollute search results.
      try {
        const myOldIntents = await market.getMyIntents();
        for (const old of myOldIntents) {
          if (old.status === 'active') {
            await market.closeIntent(old.id);
            logger.info('stale_intent_closed_on_startup', { market_intent_id: old.id });
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn('stale_intent_cleanup_failed', { error: msg });
      }

      // 13. Start IntentEngine scan loop
      intentEngine.start();

      logger.info('trader_agent_started', {
        agent_pubkey: agentPubkey,
        agent_address: agentAddress,
        strategy_auto_match: strategy.auto_match,
        strategy_auto_negotiate: strategy.auto_negotiate,
      });
    },

    async stop(): Promise<void> {
      if (!started) return;
      started = false;

      // 1. Stop IntentEngine (timers, feed subscription)
      if (intentEngine) {
        await intentEngine.stop();
      }

      // 2. Cancel pending negotiations
      //    F3 (round-23): cancelPending() fires transitionDeal(id, 'CANCELLED')
      //    per active deal; each schedules an onDealStateChange write through
      //    the NegotiationHandler's per-deal persistChains. Calling stop()
      //    immediately after cancelPending() clears timers but does NOT
      //    wait for those persist writes — if the process exits before they
      //    complete (e.g. tight shutdown budget, process.exit() from a
      //    higher-level handler), the CANCELLED state never lands on disk
      //    and next startup's reconciliation re-sends reject DMs for deals
      //    the counterparty has already abandoned. Drain the chains between
      //    cancelPending and stop, bounded by a 3s budget so a stuck disk
      //    can't hold shutdown hostage.
      if (negotiationHandler) {
        const handlerRef = negotiationHandler;
        handlerRef.cancelPending();
        const drainResult = await withTimeout(
          'shutdown_negotiation_drain_persist',
          3_000,
          logger,
          () => handlerRef.drainPersistChains(),
        ).catch((err: unknown) => {
          logger.warn('negotiation_drain_persist_error', {
            error: err instanceof Error ? err.message : String(err),
          });
          return { timedOut: true as const };
        });
        if (drainResult.timedOut) {
          logger.warn('negotiation_drain_persist_timeout');
        }
        handlerRef.stop();
      }

      // 3. Stop SwapExecutor timers
      if (swapExecutor) {
        swapExecutor.stop();
      }

      // 4. Unsubscribe all event listeners
      for (const unsub of unsubscribers) {
        try {
          unsub();
        } catch {
          // best effort
        }
      }
      unsubscribers.length = 0;

      // 5. Persist strategy + reservations
      if (stateStore) {
        try {
          await stateStore.saveStrategy(strategy);
        } catch {
          logger.warn('strategy_persist_failed_on_shutdown');
        }
        if (ledger) {
          try {
            await stateStore.saveReservations(ledger.serialize());
          } catch {
            logger.warn('reservations_persist_failed_on_shutdown');
          }
        }
      }

      // 6. Stop AcpListener
      if (acpListener) {
        await acpListener.stop();
      }

      logger.info('trader_agent_stopped');
    },

    registerSwapId(swapId: string, match?: import('./swap-executor.js').SwapProposalMatchInfo): boolean {
      // F3: Propagate the gate decision to the caller. When no swap executor
      // is wired (pre-start), return false — the agent isn't ready to accept
      // swaps yet, so the caller should reject the incoming proposal.
      if (!swapExecutor) return false;
      return swapExecutor.registerSwapId(swapId, match);
    },

    handleSwapCompleted(swapId: string, payoutVerified: boolean): void {
      if (swapExecutor) swapExecutor.handleSwapCompleted(swapId, payoutVerified);
    },

    handleSwapFailed(swapId: string, reason: string): void {
      if (swapExecutor) swapExecutor.handleSwapFailed(swapId, reason);
    },

    getStrategy(): TraderStrategy {
      return { ...strategy };
    },
  };
}
