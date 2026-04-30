/**
 * Trader Agent standalone entrypoint — wired to real Sphere SDK.
 *
 * Startup sequence:
 * 1. Parse tenant config from environment variables
 * 2. Download trustbase, initialize Sphere with market + swap + accounting
 * 3. Create SDK adapter wrappers (PaymentsAdapter, MarketAdapter, SwapAdapter)
 * 4. Create TraderAgent via createTraderAgent(deps)
 * 5. Start the agent
 *
 * Shutdown: SIGTERM → agent.stop() → sphere.destroy()
 */

import { Sphere, verifySignedMessage } from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';
import type { DirectMessage, SphereEventType } from '@unicitylabs/sphere-sdk';
import * as fs from 'node:fs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTenantConfig } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';
import { withTimeout } from '../shared/with-timeout.js';
import type { SphereDmSender, SphereDmReceiver, DmSubscription } from '../tenant/types.js';
import type { PaymentsAdapter, MarketAdapter, MarketFeedListing } from './types.js';
import type { SwapAdapter } from './swap-executor.js';
import { createTraderAgent } from './trader-main.js';
import type { TraderAgent } from './trader-main.js';
import { resolveApiKey } from '../shared/api-key.js';

// Install process-wide safety nets as early as possible. An unhandled rejection
// shouldn't crash the container before shutdown() runs; log and continue.
// uncaughtException: trigger a graceful shutdown and force-exit after 10s —
// preempting an in-flight graceful teardown with process.exit(1) can corrupt
// relay state and leak sphere resources.
//
// Module-scope mutable state shared with the handlers below. The handlers
// delegate to `shutdownState.triggerShutdown` which is published VERY EARLY
// in startTrader() (right after shutdownState's fields are populated with
// bootstrap-safe null defaults). As startup progresses, the resource fields
// (sphere, agent) are filled in, and a late-stage rich shutdown function
// takes over. This ensures an uncaughtException during ANY phase of startup
// runs graceful teardown instead of falling through to process.exit(1).
//
// Invariant: only `shutdown()` writes `shuttingDown`. The uncaughtException
// handler previously pre-set the flag before calling triggerShutdown(), which
// made the idempotency guard inside shutdown() return early — fully defeating
// the graceful teardown. Handlers MUST NOT set `shuttingDown`; only call
// triggerShutdown().
interface ShutdownState {
  shuttingDown: boolean;
  triggerShutdown: () => Promise<void>;
  logger: import('../shared/logger.js').Logger | null;
  sphere: Sphere | null;
  agent: TraderAgent | null;
  // Additional resources that must be cleaned up by bootstrap shutdown when
  // an uncaughtException fires AFTER these are allocated but BEFORE the
  // rich shutdown() function replaces triggerShutdown. Without these, a
  // bootstrap shutdown leaves timers firing and subscriptions active during
  // sphere.destroy(), potentially touching a torn-down transport.
  timers: Set<ReturnType<typeof setTimeout>>;
  cancelFns: Array<() => void>;
}
const shutdownState: ShutdownState = {
  shuttingDown: false,
  triggerShutdown: async (): Promise<void> => { process.exit(1); },
  logger: null,
  sphere: null,
  agent: null,
  timers: new Set(),
  cancelFns: [],
};

// Track re-entrant startTrader() invocations. SIGTERM/SIGINT listeners are
// installed inside startTrader() via process.on(); a repeat invocation within
// the same process would attach another set and accumulate — catch that
// explicitly so test bugs surface immediately instead of via the
// MaxListenersExceededWarning much later.
let mainInvocations = 0;

// process.on for uncaughtException: a second uncaught exception during an
// in-flight graceful shutdown must also reach this handler — otherwise Node's
// default handler terminates the process, bypassing any teardown still in
// progress. Listener accumulation across re-invocations is already prevented
// by the `mainInvocations` guard in startTrader() (throws on second call),
// so `.on` is safe and correct here.
function onUncaught(err: Error): void {
  if (shutdownState.logger) {
    shutdownState.logger.error('uncaught_exception', { error: String(err), stack: err.stack });
  } else {
    // eslint-disable-next-line no-console
    console.error('[uncaughtException before logger ready]', err);
  }
  // Don't pre-set shuttingDown — let shutdown() set it so the idempotency
  // guard works correctly on repeat signals.
  //
  // F2 (round-19): triggerShutdown is an async function, so any synchronous
  // throw inside it surfaces as a rejected promise (caught by `.catch` below).
  // The only pathological scenario that could reach this backstop is an
  // infinite synchronous loop BEFORE triggerShutdown returns its first
  // Promise microtask — vanishingly unlikely, but cheap insurance. Shortened
  // from 15s to 11s: matches the intent of a ~1s gap over triggerShutdown's
  // own 10s force-exit timer to absorb event-loop-tick overhead.
  const backstop = setTimeout(() => process.exit(1), 11_000);
  backstop.unref();
  shutdownState.triggerShutdown().catch(() => process.exit(1));
}
process.on('uncaughtException', onUncaught);

// process.on for unhandledRejection: in Node 22, an unhandledRejection with
// the default handler terminates the process. Using `.on` keeps this listener
// active for every stray rejection so the container stays up (logging-only,
// no shutdown trigger — a stray unawaited promise shouldn't tear down the
// container). Listener accumulation is prevented by `mainInvocations`.
function onUnhandled(reason: unknown): void {
  if (shutdownState.logger) {
    shutdownState.logger.error('unhandled_rejection', { reason: String(reason) });
  } else {
    // eslint-disable-next-line no-console
    console.error('[unhandledRejection before logger ready]', reason);
  }
}
process.on('unhandledRejection', onUnhandled);

const TRUSTBASE_URL =
  'https://raw.githubusercontent.com/unicitynetwork/unicity-ids/refs/heads/main/bft-trustbase.testnet.json';

// Round-19 F1 / Round-21 F3: per-step timeout for bootstrap shutdown is
// provided by `../shared/with-timeout.js`. See that file for the full
// contract. Prior to round-21, three separate copies of this helper lived
// in host-manager/main.ts, trader/main.ts, and tenant/main.ts — the
// host-manager copy had a `settled` flag correctly distinguishing in-time
// rejections from late rejections, but the trader/tenant copies did not,
// causing in-time failures here to be spuriously logged as
// "late_rejection_after_timeout". Consolidating to the shared helper fixes
// that drift hazard.

export async function startTrader(): Promise<void> {
  // Fail loudly on re-entrant invocation — .on() listeners below would
  // double-attach, trustbase fetch and Sphere.init would run twice, and
  // both leak resources. startTrader() must be called exactly once per
  // process.
  mainInvocations++;
  if (mainInvocations > 1) {
    throw new Error('startTrader should only be called once per process');
  }

  // Publish a bootstrap-safe shutdown as early as possible — before any await.
  // An uncaughtException during trustbase fetch or Sphere.init would otherwise
  // hit the default stub that just does process.exit(1), skipping resource
  // teardown entirely. This early version null-guards each resource; later
  // startup code populates the fields on shutdownState as they come online,
  // and a richer shutdown() replaces this at the end of startup.
  shutdownState.triggerShutdown = async (): Promise<void> => {
    if (shutdownState.shuttingDown) return;
    shutdownState.shuttingDown = true;

    // F1 (round-18): force-exit timer as the FIRST action in this bootstrap
    // path. Without it, a hung `agent.stop()` or `sphere.destroy()` would
    // block shutdown indefinitely — the outer uncaughtException handler's
    // timer used to provide this, but was removed for cleanliness now that
    // we have per-path timers. Matches the host-manager/main.ts pattern.
    const forceExit = setTimeout(
      () => process.exit(process.exitCode ?? 1),
      10_000,
    );
    forceExit.unref();

    try {
      // Clear timers and run cancel callbacks BEFORE tearing down resources
      // so no timer callback fires against a destroying sphere/agent. The
      // cancelFns typically include: `() => { stopped = true; }`,
      // cancelPendingWaits, offDmDiagnostic, sphere event unsubscribers.
      for (const timer of shutdownState.timers) {
        clearTimeout(timer);
      }
      shutdownState.timers.clear();
      for (const cancel of shutdownState.cancelFns) {
        try { cancel(); } catch { /* best effort */ }
      }
      shutdownState.cancelFns.length = 0;
      // F1 (round-18): wrap each teardown step in `withTimeout` so one
      // stuck step (e.g. agent.stop awaiting a gone peer) doesn't consume
      // the full 10s budget and starve the next step. Capture local
      // references so the arrow bodies don't need `!` assertions
      // (TypeScript doesn't narrow mutable object fields through closures).
      const agent = shutdownState.agent;
      if (agent) {
        const r = await withTimeout(
          'bootstrap_agent_stop',
          5_000,
          shutdownState.logger,
          () => agent.stop().catch(() => { /* best effort */ }),
        );
        if (r.timedOut) {
          shutdownState.logger?.warn('bootstrap_agent_stop_timeout');
        }
      }
      const sphere = shutdownState.sphere;
      if (sphere) {
        const r = await withTimeout(
          'bootstrap_sphere_destroy',
          5_000,
          shutdownState.logger,
          () => sphere.destroy().catch(() => { /* best effort */ }),
        );
        if (r.timedOut) {
          shutdownState.logger?.warn('bootstrap_sphere_destroy_timeout');
        }
      }
    } finally {
      clearTimeout(forceExit);
      process.exit(process.exitCode ?? 1);
    }
  };

  const config = parseTenantConfig();

  const logger = createLogger({
    component: 'trader',
    level: config.log_level,
    instance_id: config.instance_id,
    instance_name: config.instance_name,
  });
  // Publish the logger to the process-wide safety-net handlers ASAP. An
  // uncaughtException during the async startup work below would otherwise
  // only reach console.error and skip structured logging.
  shutdownState.logger = logger;

  // Read manager address from env (injected by host manager at container creation)
  const managerDirectAddress = process.env['UNICITY_MANAGER_DIRECT_ADDRESS'] ?? '';
  if (!managerDirectAddress) {
    logger.error('missing_manager_address', { message: 'UNICITY_MANAGER_DIRECT_ADDRESS not set' });
    throw new Error('UNICITY_MANAGER_DIRECT_ADDRESS environment variable is required');
  }

  // Ensure data directories exist
  mkdirSync(config.data_dir, { recursive: true });
  mkdirSync(config.tokens_dir, { recursive: true });

  // Download trustbase
  logger.info('downloading_trustbase', { url: TRUSTBASE_URL });
  const tbResponse = await fetch(TRUSTBASE_URL, { signal: AbortSignal.timeout(30_000) });
  if (!tbResponse.ok) {
    throw new Error(`Failed to download trustbase: HTTP ${tbResponse.status}`);
  }
  const trustbasePath = join(config.data_dir, 'trustbase.json');
  writeFileSync(trustbasePath, await tbResponse.text());

  // Initialize Sphere wallet with market, swap, and accounting modules
  logger.info('initializing_sphere', { network: config.network, data_dir: config.data_dir });
  const providers = createNodeProviders({
    network: config.network as 'testnet' | 'mainnet' | 'dev',
    dataDir: config.data_dir,
    tokensDir: config.tokens_dir,
    oracle: {
      trustBasePath: trustbasePath,
      apiKey: resolveApiKey(),
    },
  });

  // 2026-04-30 FIX (basic-roundtrip flake investigation): use the FULL
  // sanitized instance_id, not just the first 12 chars. Previously we
  // sliced to 12 → "tradere2e" + 3 hex = only 4096 distinct nametags.
  // Nostr relays persist NIP-17 nametag bindings indefinitely, so test
  // runs accumulated bindings on the relay until a fresh UUID's first 3
  // hex chars happened to match a prior run's binding. The trader's
  // publishNametagBinding then rejected with "already claimed" and the
  // process exited at ~1s — but our test's `waitForReadyAddress` polls
  // for sphere_initialized for 180s, mis-interpreting the early exit as
  // a hang. With the full instance_id (~32 hex chars), the entropy is
  // effectively collision-free.
  const nametag = `t-${config.instance_id.replace(/[^a-z0-9]/g, '')}`;
  logger.info('registering_nametag', { nametag });

  // Enable SDK debug logging for swap diagnostics only when log_level is debug
  if (config.log_level === 'debug') {
    const { logger: sdkLogger } = await import('@unicitylabs/sphere-sdk');
    sdkLogger.setTagDebug('Swap', true);
  }

  const { sphere } = await Sphere.init({
    ...providers,
    autoGenerate: true,
    nametag,
    market: true,
    swap: { debug: config.log_level === 'debug' },
    accounting: true,
  });
  // Publish to shutdownState immediately so an uncaughtException during the
  // rest of startup (nametag verify, adapter wiring, etc.) still runs
  // sphere.destroy() via the bootstrap-safe shutdown.
  shutdownState.sphere = sphere;

  const identity = sphere.identity;
  if (!identity) {
    throw new Error('Sphere wallet initialization failed — no identity');
  }

  const agentPubkey = identity.chainPubkey;
  // The agent's canonical address is @nametag. Nametag binding events on Nostr
  // carry the direct address, chain pubkey, and transport pubkey — the SDK
  // resolves nametags to all of these. Using @nametag everywhere ensures
  // consistent identity resolution across DMs, swap deals, and market listings.
  if (!identity.nametag) {
    throw new Error('Sphere wallet has no nametag — agents require a registered nametag for identity');
  }
  const agentAddress = `@${identity.nametag}`;
  // Use @nametag for swap party addresses — NOT DIRECT:// addresses.
  // The escrow resolves party addresses to send payouts. Nametag resolution
  // always returns the correct transport pubkey. DIRECT:// resolution may
  // fail because the relay can't map predicate-derived addresses to Nostr
  // pubkeys without a nametag binding event.
  const swapDirectAddress = agentAddress; // @nametag

  // Verify nametag is resolvable on the relay before declaring ready.
  // The binding event must have propagated so other agents and the faucet
  // can find us by @nametag. Retry with backoff if not yet visible.
  const MAX_NAMETAG_VERIFY_ATTEMPTS = 10;
  const NAMETAG_VERIFY_DELAY_MS = 2_000;
  for (let attempt = 1; attempt <= MAX_NAMETAG_VERIFY_ATTEMPTS; attempt++) {
    try {
      const resolved = await sphere.resolve(agentAddress);
      if (resolved?.directAddress) {
        logger.info('nametag_verified', {
          nametag: identity.nametag,
          directAddress: resolved.directAddress.slice(0, 30) + '...',
          attempt,
        });
        break;
      }
      logger.warn('nametag_not_yet_resolvable', { nametag: identity.nametag, attempt });
    } catch (err: unknown) {
      logger.warn('nametag_verify_error', {
        nametag: identity.nametag,
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (attempt < MAX_NAMETAG_VERIFY_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, NAMETAG_VERIFY_DELAY_MS * attempt));
    } else {
      logger.error('nametag_verification_failed', {
        nametag: identity.nametag,
        message: 'Nametag not resolvable after all attempts — proceeding anyway',
      });
    }
  }

  logger.info('sphere_initialized', {
    pubkey: agentPubkey.slice(0, 16) + '...',
    nametag: identity.nametag,
    agent_address: agentAddress,
    market: sphere.market !== null,
    swap: sphere.swap !== null,
    accounting: sphere.accounting !== null,
  });

  // ---------------------------------------------------------------------------
  // PaymentsAdapter — wraps sphere.payments
  // ---------------------------------------------------------------------------

  const payments: PaymentsAdapter = {
    getConfirmedBalance(coinId: string): bigint {
      // getBalance(coinId) filters by exact hex coinId, not by symbol.
      // Intent assets ('UCT', 'USDU') are symbols — search all balances.
      const assets = sphere.payments.getBalance();
      const asset = assets.find(a => a.coinId === coinId || a.symbol === coinId);
      return asset ? BigInt(asset.confirmedAmount) : 0n;
    },
    getAllBalances() {
      const assets = sphere.payments.getBalance();
      return assets.map((a) => ({
        coinId: a.coinId,
        symbol: a.symbol,
        confirmedAmount: BigInt(a.confirmedAmount),
        totalAmount: BigInt(a.totalAmount),
      }));
    },
    async refresh() {
      // Sync tokens from IPFS + receive from Nostr — matches the CLI's
      // ensureSync('full') pattern which calls receive() + sync().
      await sphere.payments.receive({ finalize: true });
      await sphere.payments.sync().catch(() => {});
    },
    async send(request) {
      // Forward to PaymentsModule.send. The SDK normalizes recipient
      // (@nametag / DIRECT:// / hex) internally — we pass through unchanged.
      // memo is optional in our adapter contract; pass-through to the SDK.
      const result = await sphere.payments.send({
        coinId: request.coinId,
        amount: request.amount,
        recipient: request.recipient,
        ...(request.memo === undefined ? {} : { memo: request.memo }),
      });
      // The SDK's TransferResult has mutable `status` and optional `error`.
      // Only forward `error` if it is present so the optional field stays
      // unset on success (avoids triggering exactOptionalPropertyTypes).
      return {
        transferId: result.id,
        status: result.status,
        ...(result.error === undefined ? {} : { error: result.error }),
      };
    },
  };

  // Periodic balance refresh — calls receive() to fetch pending Nostr transfers.
  // Without this, tokens deposited after boot (e.g., via faucet) won't appear
  // in getBalance() until the next transport event or manual receive().
  // Periodic sync: receive pending tokens AND fetch pending DM events.
  // The real-time Nostr subscription can go stale (300s timeout),
  // so we explicitly poll for missed events. This is critical for
  // swap protocol DMs (swap_proposal, escrow announce_result, etc.)
  // that must be received promptly for the swap to progress.
  // Self-scheduling sync loop — avoids async overlap from setInterval.
  // Each iteration waits for the previous async work to complete before scheduling the next.
  let syncTimer: ReturnType<typeof setTimeout> | null = null;
  let swapPollTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  // Publish a setter for `stopped` to shutdownState so the bootstrap-safe
  // shutdown can flip the flag when an uncaughtException fires before the
  // rich shutdown() replaces triggerShutdown. The scheduleSyncLoop and
  // scheduleSwapPoll checks on `stopped` then bail immediately instead of
  // scheduling further iterations against a destroying Sphere.
  shutdownState.cancelFns.push(() => { stopped = true; });
  // shuttingDown lives on the module-scope `shutdownState` so the process-wide
  // uncaughtException handler shares a single flag with the graceful shutdown
  // path. See the handler at top of file.
  const SYNC_INTERVAL_MS = 5_000;
  const SWAP_POLL_INTERVAL_MS = 3_000;

  // Track outstanding cancelable sleeps used by the swap:announced retry
  // loop so shutdown() can unblock them immediately instead of waiting up
  // to SWAP_POLL_INTERVAL_MS per active retry.
  const pendingWaits = new Set<{ timer: ReturnType<typeof setTimeout>; resolve: () => void }>();
  function waitCancellable(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (stopped) { resolve(); return; }
      const entry: { timer: ReturnType<typeof setTimeout>; resolve: () => void } = {
        // Initialized below; placeholder keeps the type precise.
        timer: null as unknown as ReturnType<typeof setTimeout>,
        resolve,
      };
      entry.timer = setTimeout(() => {
        pendingWaits.delete(entry);
        resolve();
      }, ms);
      pendingWaits.add(entry);
    });
  }
  function cancelPendingWaits(): void {
    for (const entry of pendingWaits) {
      clearTimeout(entry.timer);
      entry.resolve();
    }
    pendingWaits.clear();
  }
  // Publish cancelPendingWaits so bootstrap shutdown can unblock any in-flight
  // cancellable sleeps when an uncaughtException fires during startup.
  shutdownState.cancelFns.push(cancelPendingWaits);

  // General sync loop — fetch pending Nostr events + receive transfers (15s).
  // Every recursive self-schedule is guarded by `stopped` — otherwise a DM
  // arriving during shutdown could schedule another iteration that outlives
  // teardown and throws on a destroyed Sphere instance.
  function scheduleSyncLoop(): void {
    if (stopped) return;
    // Remove the previous timer from tracked set (it already fired or is
    // being replaced by the next iteration). Only the currently-scheduled
    // timer belongs in shutdownState.timers.
    if (syncTimer) shutdownState.timers.delete(syncTimer);
    syncTimer = setTimeout(async () => {
      if (stopped) return;
      try {
        const receiveResult = await sphere.payments.receive({ finalize: true });
        if (receiveResult.transfers.length > 0) {
          logger.info('sync_receive_transfers', {
            count: receiveResult.transfers.length,
            // DIAGNOSTIC: per-transfer details so we can distinguish
            // invoice-token deliveries from actual payout payments.
            transfers: receiveResult.transfers.map((t) => ({
              id: t.id,
              senderPubkey: t.senderPubkey?.slice(0, 16),
              senderNametag: t.senderNametag,
              memo: t.memo?.slice(0, 80) ?? null,
              receivedAt: t.receivedAt,
              tokens: t.tokens?.map((tok) => ({
                coinId: tok.coinId?.slice(0, 16) ?? null,
                symbol: tok.symbol ?? null,
                amount: tok.amount ?? null,
              })),
            })),
          });
        }
        // IPFS sync — tokens may be published there alongside Nostr
        if (stopped) return;
        await sphere.payments.sync();
      } catch {
        // Transient errors during receive are tolerable
      }
      try {
        if (stopped) return;
        await sphere.fetchPendingEvents();
      } catch (err: unknown) {
        logger.warn('fetch_pending_events_error', { error: err instanceof Error ? err.message : String(err) });
      }
      // C20: re-check `stopped` before scheduling the next iteration. Without
      // this, a late arrival between the async work and the recursive call
      // leaks a timer past shutdown.
      if (stopped) return;
      scheduleSyncLoop();
    }, SYNC_INTERVAL_MS);
    shutdownState.timers.add(syncTimer);
  }
  scheduleSyncLoop();

  // Fast swap polling loop — drives active swaps to completion (3s).
  // Matches the pattern in sphere-sdk's swap-continuous.test.ts: poll
  // getSwapStatus() frequently so the escrow status query → status_result
  // DM path advances the swap state machine.
  // Also pings trusted escrows to pre-resolve their addresses (the working
  // SDK test calls pingEscrow once before any swaps — we do it here because
  // trusted_escrows are set via ACP command after startup).
  const pingedEscrows = new Set<string>();

  // depositInFlight: per-swapId guard against duplicate deposit() calls.
  // Used by BOTH the swap:announced event handler AND the swap-poll loop's
  // fallback path (some SDK paths fire swap:announced only on the proposer
  // side, not the acceptor — observed live 2026-04-29 basic-roundtrip).
  // Hoisted to outer scope so both paths share the same dedup state.
  const depositInFlight = new Set<string>();
  // Track the deposit fallback issuer separately from the event-driven
  // path so the structured-log event identifies which path triggered.
  async function tryDepositForSwap(swapId: string, trigger: 'event' | 'poll'): Promise<void> {
    if (!sphere.swap) {
      logger.warn('swap_deposit_no_swap_module', { swap_id: swapId, trigger });
      return;
    }
    const swapMod = sphere.swap;
    if (depositInFlight.has(swapId)) {
      logger.debug('swap_deposit_already_in_flight', { swap_id: swapId, trigger });
      return;
    }
    depositInFlight.add(swapId);
    let depositSucceeded = false;
    try {
      const isFresh = await agent.markDepositAttempted(swapId);
      if (!isFresh) {
        logger.info('swap_deposit_skipped_already_attempted', {
          swap_id: swapId,
          trigger,
          note: 'persistent record indicates this swap was deposited on a previous lifetime',
        });
        return;
      }
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && !stopped) {
        try {
          await swapMod.deposit(swapId);
          logger.info('swap_deposit_sent', { swap_id: swapId, trigger });
          await sphere.payments.waitForPendingOperations();
          depositSucceeded = true;
          return;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          // 2026-04-30 FIX: extend the retry filter. Empirical observation
          // in basic-roundtrip live e2e — when the SDK's `swap:announced`
          // event fires BEFORE the escrow's invoice_delivery DM arrives
          // (44ms race seen in the wild), the immediate deposit() call
          // throws `Deposit invoice not yet imported into accounting
          // module`. The pre-fix filter only matched "not yet available"
          // / "SWAP_WRONG_STATE" → fell through to "give up" → the
          // persistent markDepositAttempted flag from round-5c prevented
          // future retries. Now we ALSO retry on "not yet imported".
          //
          // Defensive: any "not yet" message indicates the SDK-internal
          // race conditions we care about. Pattern broadened for forward
          // compat.
          if (
            msg.includes('not yet available') ||
            msg.includes('not yet imported') ||
            msg.includes('SWAP_WRONG_STATE')
          ) {
            await waitCancellable(3000);
            if (stopped) return;
            continue;
          }
          logger.error('swap_deposit_failed', { swap_id: swapId, trigger, error: msg });
          return;
        }
      }
    } catch (err: unknown) {
      logger.error('swap_announced_handler_failed', {
        swap_id: swapId,
        trigger,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      depositInFlight.delete(swapId);
      // 2026-04-30 fix: if deposit didn't succeed, ROLL BACK the
      // persistent markDepositAttempted flag. Otherwise a transient
      // failure (or a 60s deadline timeout) would permanently block
      // future deposit attempts via the persistent
      // swap_deposit_skipped_already_attempted gate. Spec 7.9.3
      // idempotency requires "don't double-deposit on restart" — the
      // flag should only persist AFTER a successful deposit, not
      // BEFORE the attempt. This restores the correct semantics.
      if (!depositSucceeded) {
        await agent.clearDepositAttempted(swapId).catch((clearErr: unknown) => {
          logger.warn('swap_deposit_attempted_clear_failed', {
            swap_id: swapId,
            error: clearErr instanceof Error ? clearErr.message : String(clearErr),
          });
        });
      }
    }
  }
  function scheduleSwapPoll(): void {
    if (stopped) return;
    // Remove the previous timer from tracked set (it already fired or is
    // being replaced by the next iteration). Only the currently-scheduled
    // timer belongs in shutdownState.timers.
    if (swapPollTimer) shutdownState.timers.delete(swapPollTimer);
    swapPollTimer = setTimeout(async () => {
      if (stopped) return;
      if (sphere.swap) {
        // Ping trusted escrows that haven't been pinged yet — pre-resolves
        // their transport pubkey so the SDK's isFromExpectedEscrow() works.
        try {
          const strategy = agent.getStrategy();
          if (strategy?.trusted_escrows) {
            for (const escrow of strategy.trusted_escrows) {
              if (escrow && escrow !== 'any' && !pingedEscrows.has(escrow)) {
                try {
                  if (stopped) return;
                  await sphere.swap.pingEscrow(escrow, 15_000);
                  pingedEscrows.add(escrow);
                  logger.info('escrow_pinged', { escrow });
                } catch (err: unknown) {
                  logger.warn('escrow_ping_failed', { escrow, error: String(err) });
                }
              }
            }
          }
        } catch { /* best effort */ }

        // W1 (steelman round-4): the poll-loop deposit branch was dropped.
        // The canonical deposit trigger is the `swap:announced` event
        // handler (see below in this file) which uses the `depositInFlight`
        // Set to dedup against duplicate deliveries. Two parallel paths
        // both calling sphere.swap.deposit() raced under SWAP_WRONG_STATE
        // (SDK guard) but emitted "swap_deposit_sent" twice and could
        // resync waitForPendingOperations() on phantom progress. The poll
        // loop is preserved for status visibility (diag below) and other
        // lifecycle observation; deposit issuance is event-driven only.
        try {
          if (stopped) return;
          const swaps = await sphere.swap.getSwaps();
          for (const s of swaps) {
            if (s.progress === 'completed' || s.progress === 'failed' || s.progress === 'cancelled') continue;
            try {
              if (stopped) return;
              const status = await sphere.swap.getSwapStatus(s.swapId);
              if (status.progress === 'announced') {
                // ROUND-5C FIX (basic-roundtrip flake fix 2026-04-29):
                // also dispatch deposit from the poll path. The SDK's
                // swap:announced event was observed firing only on the
                // proposer side; the acceptor's poll detected
                // progress=='announced' but never deposited. Now both
                // paths call tryDepositForSwap which dedups via
                // depositInFlight + markDepositAttempted (persistent).
                // Fire-and-forget — the gate prevents redundant work.
                void tryDepositForSwap(s.swapId, 'poll').catch((err: unknown) => {
                  logger.warn('swap_deposit_poll_dispatch_failed', {
                    swap_id: s.swapId,
                    error: err instanceof Error ? err.message : String(err),
                  });
                });
                try {
                  const diagInvoice = status.depositInvoiceId && sphere.accounting
                    ? sphere.accounting.getInvoice(status.depositInvoiceId)
                    : null;
                  logger.info('swap_deposit_target_diag', {
                    swap_id: s.swapId,
                    depositInvoiceId: status.depositInvoiceId,
                    escrowDirectAddress: status.escrowDirectAddress,
                    escrowPubkey: status.escrowPubkey,
                    my_role: status.role,
                    manifest_escrow_address: status.manifest?.escrow_address,
                    manifest_party_a_address: status.manifest?.party_a_address,
                    manifest_party_b_address: status.manifest?.party_b_address,
                    manifest_party_a_currency: status.manifest?.party_a_currency_to_change,
                    manifest_party_a_value: status.manifest?.party_a_value_to_change,
                    manifest_party_b_currency: status.manifest?.party_b_currency_to_change,
                    manifest_party_b_value: status.manifest?.party_b_value_to_change,
                    invoice_target_addresses: diagInvoice?.terms?.targets?.map((t) => t.address) ?? null,
                    invoice_target_assets: diagInvoice?.terms?.targets?.[0]?.assets?.map((a) => a.coin) ?? null,
                    invoice_creator: diagInvoice?.terms?.creator,
                  });
                } catch (diagErr) {
                  logger.warn('swap_deposit_target_diag_failed', {
                    swap_id: s.swapId,
                    error: diagErr instanceof Error ? diagErr.message : String(diagErr),
                  });
                }
              }
            } catch { /* swap may have been pruned */ }
          }
        } catch { /* best effort */ }
      }
      // C20: re-check `stopped` before recursively scheduling.
      if (stopped) return;
      scheduleSwapPoll();
    }, SWAP_POLL_INTERVAL_MS);
    shutdownState.timers.add(swapPollTimer);
  }
  scheduleSwapPoll();

  // ---------------------------------------------------------------------------
  // MarketAdapter — wraps sphere.market (with no-op fallback)
  // ---------------------------------------------------------------------------

  const sdkMarket = sphere.market;
  const market: MarketAdapter = sdkMarket
    ? {
        async postIntent(req) {
          return sdkMarket.postIntent(req);
        },
        async search(query, opts) {
          const result = await sdkMarket.search(query, opts);
          // SDK's SearchIntentResult.intentType is the wider IntentType union;
          // cast to our narrower MarketSearchResult which only uses 'buy'|'sell'.
          return result.intents as unknown as import('./types.js').MarketSearchResult[];
        },
        subscribeFeed(listener: (listing: MarketFeedListing) => void): () => void {
          return sdkMarket.subscribeFeed((message) => {
            // SDK FeedListing.type is IntentType; cast to our narrower type
            if (message.type === 'new') {
              listener(message.listing as unknown as MarketFeedListing);
            } else if (message.type === 'initial') {
              for (const listing of message.listings) {
                listener(listing as unknown as MarketFeedListing);
              }
            }
          });
        },
        async getMyIntents() {
          // SDK MarketIntent.intentType is the wider IntentType union; cast to narrower type
          const intents = await sdkMarket.getMyIntents();
          return intents as unknown as import('./types.js').MarketMyIntent[];
        },
        async closeIntent(id) {
          return sdkMarket.closeIntent(id);
        },
        async getRecentListings() {
          // SDK FeedListing.type is IntentType; cast to our narrower type
          const listings = await sdkMarket.getRecentListings();
          return listings as unknown as MarketFeedListing[];
        },
      }
    : {
        async postIntent() {
          logger.warn('market_not_available', { op: 'postIntent' });
          return { intentId: '', message: 'Market module not available', expiresAt: '' };
        },
        async search() {
          return [];
        },
        subscribeFeed() {
          logger.warn('market_not_available', { op: 'subscribeFeed' });
          return () => {};
        },
        async getMyIntents() {
          return [];
        },
        async closeIntent() {
          logger.warn('market_not_available', { op: 'closeIntent' });
        },
        async getRecentListings() {
          return [];
        },
      };

  // ---------------------------------------------------------------------------
  // SwapAdapter — wraps sphere.swap (with no-op fallback)
  // ---------------------------------------------------------------------------

  const sdkSwap = sphere.swap;
  const swap: SwapAdapter = sdkSwap
    ? {
        async proposeSwap(deal) {
          return sdkSwap.proposeSwap(deal);
        },
        async acceptSwap(id) {
          return sdkSwap.acceptSwap(id);
        },
        async rejectSwap(id, reason) {
          return sdkSwap.rejectSwap(id, reason);
        },
        async deposit(id) {
          await sdkSwap.deposit(id);
        },
        async verifyPayout(id) {
          return sdkSwap.verifyPayout(id);
        },
        async waitForPendingOperations() {
          await sphere.payments.waitForPendingOperations();
        },
        async getSwapStatus(id) {
          // EXECUTION_TIMEOUT skip-when-terminal check — see swap-executor.ts.
          // Reads SDK swap progress to avoid transitioning a successfully-
          // completed swap to trader-side FAILED while L3 verifyPayout retries
          // are still legitimately pending.
          try {
            const status = await sdkSwap.getSwapStatus(id);
            return { progress: status?.progress };
          } catch {
            return null;
          }
        },
      }
    : {
        async proposeSwap() {
          throw new Error('SwapModule not available');
        },
        async acceptSwap() {
          throw new Error('SwapModule not available');
        },
        async rejectSwap() {
          throw new Error('SwapModule not available');
        },
        async deposit() {
          throw new Error('SwapModule not available');
        },
        async verifyPayout() {
          throw new Error('SwapModule not available');
        },
      };

  // ---------------------------------------------------------------------------
  // DM sender / receiver — same wiring as tenant/main.ts
  // ---------------------------------------------------------------------------

  // Monitor ALL incoming DMs for diagnostics — especially swap protocol messages.
  // C17: capture the unsubscribe handle so shutdown() can clean up BEFORE
  // sphere.destroy() runs. Otherwise the handler races with destroy() and can
  // fire on a torn-down transport, producing unhandled rejections on exit.
  const offDmDiagnostic = sphere.communications.onDirectMessage((dm: { content: string; senderPubkey: string }) => {
    const isSwap = dm.content.startsWith('swap_proposal:') ||
                   dm.content.startsWith('swap_acceptance:') ||
                   dm.content.startsWith('swap_rejection:');
    if (isSwap) {
      logger.info('swap_dm_received', {
        prefix: dm.content.slice(0, 20),
        sender: dm.senderPubkey.slice(0, 16),
        length: dm.content.length,
      });
      return;
    }
    // Round-5 diag (basic-roundtrip flake investigation 2026-04-29):
    // the escrow's deposit-invoice delivery DM is JSON without a string
    // prefix — `{"type":"invoice_delivery", "invoice_token": {...}, ...}`.
    // Log it explicitly so we can confirm receipt on the trader side
    // when the buyer's invoice_target_addresses stays null in
    // swap_deposit_target_diag. Distinguishes "DM lost in transport"
    // from "DM received but not imported into accounting".
    if (dm.content.startsWith('{') && dm.content.includes('invoice_delivery')) {
      let messageType = 'unknown';
      let swapId: string | undefined;
      let invoiceType: string | undefined;
      let invoiceId: string | undefined;
      try {
        const parsed = JSON.parse(dm.content) as Record<string, unknown>;
        messageType = String(parsed['type'] ?? 'unknown');
        if (parsed['swap_id'] !== undefined) swapId = String(parsed['swap_id']);
        if (parsed['invoice_type'] !== undefined) invoiceType = String(parsed['invoice_type']);
        if (parsed['invoice_id'] !== undefined) invoiceId = String(parsed['invoice_id']);
      } catch {
        /* best-effort */
      }
      logger.info('diag_invoice_delivery_dm_received', {
        message_type: messageType,
        swap_id: swapId !== undefined ? swapId.slice(0, 16) : undefined,
        invoice_type: invoiceType,
        invoice_id: invoiceId !== undefined ? invoiceId.slice(0, 16) : undefined,
        sender: dm.senderPubkey.slice(0, 16),
        length: dm.content.length,
      });
    }
  });
  // Publish the unsubscribe so bootstrap shutdown runs it before sphere.destroy(),
  // preventing the handler from firing against a torn-down transport.
  shutdownState.cancelFns.push(() => { try { offDmDiagnostic(); } catch { /* best effort */ } });

  const sender: SphereDmSender = {
    async sendDm(recipientAddress: string, content: string): Promise<void> {
      await sphere.communications.sendDM(recipientAddress, content);
    },
  };

  const receiver: SphereDmReceiver = {
    subscribeDm(): DmSubscription {
      let handler: ((senderPubkey: string, senderAddress: string, content: string) => void) | null = null;
      let unsubscribe: (() => void) | null = null;

      return {
        onMessage(callback: (senderPubkey: string, senderAddress: string, content: string) => void): void {
          handler = callback;
          unsubscribe = sphere.on('message:dm', (msg: DirectMessage) => {
            if (handler) {
              const senderAddr = msg.senderNametag
                ? `@${msg.senderNametag}`
                : msg.senderPubkey;
              handler(msg.senderPubkey, senderAddr, msg.content);
            }
          });
        },
        unsubscribe(): void {
          handler = null;
          if (unsubscribe) {
            unsubscribe();
            unsubscribe = null;
          }
        },
      };
    },
  };

  // ---------------------------------------------------------------------------
  // Create and start the TraderAgent
  // ---------------------------------------------------------------------------

  const agent = createTraderAgent({
    payments,
    market,
    swap,
    comms: { sendDm: sender.sendDm.bind(sender) },
    // subscribeEvent is retained for interface compatibility but swap events
    // are ALL handled by direct sphere.on() listeners below (lines 418+).
    // This bridge is only needed for non-swap events in the future.
    subscribeEvent: (eventType: string, handler: (...args: unknown[]) => void): (() => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return sphere.on(eventType as SphereEventType, (data: any) => {
        handler(data);
      });
    },
    signMessage: (message: string) => sphere.signMessage(message),
    verifySignature: (signature: string, message: string, pubkey: string) =>
      verifySignedMessage(message, signature, pubkey),
    config,
    agentPubkey,
    agentAddress,
    swapDirectAddress,
    agentNametag: identity.nametag ?? null,
    managerAddress: config.manager_pubkey,
    sender,
    receiver,
    logger,
    dataDir: config.data_dir,
    debugResolve: async (address: string) => {
      return sphere.resolve(address);
    },
    debugGetActiveAddresses: () => {
      return sphere.getActiveAddresses();
    },
    getSwapProgress: sphere.swap ? async () => {
      const swapModule = sphere.swap;
      if (!swapModule) return [];
      const swaps = await swapModule.getSwaps();
      return swaps.map((s) => ({
        swapId: s.swapId,
        progress: s.progress,
        payoutVerified: s.payoutVerified,
      }));
    } : undefined,
  });
  // Publish to shutdownState so the bootstrap-safe shutdown (and later the
  // rich shutdown that replaces it) can stop the agent on uncaughtException
  // before agent.start() has been awaited.
  shutdownState.agent = agent;

  // Wire swap lifecycle using STANDARD SDK event API — trust the SwapModule.
  // The SDK handles everything: propose → accept → announce → deposit → payout → complete.
  // We just log events. The SDK auto-accepts, auto-deposits, and auto-verifies internally.
  const sphereUnsubscribers: Array<() => void> = [];
  // Publish a cancel callback that snapshots-and-drains the sphereUnsubscribers
  // array at shutdown time. Registered here (with reference semantics) so
  // bootstrap shutdown unsubscribes every listener added by this lexical scope
  // before sphere.destroy() runs.
  shutdownState.cancelFns.push(() => {
    for (const unsub of sphereUnsubscribers) {
      try { unsub(); } catch { /* best effort */ }
    }
    sphereUnsubscribers.length = 0;
  });

  // Graceful shutdown on SIGTERM/SIGINT (Docker stop sends SIGTERM).
  // Hard-exit safety net: if agent.stop() or sphere.destroy() hangs (stuck
  // relay close, in-flight token operation, etc.) we exit non-zero after
  // 10s rather than letting Docker send SIGKILL and leave orphaned state.
  //
  // Defined HERE — before `agent.start()` and before any further await — so
  // the process-wide uncaughtException handler (which calls
  // shutdownState.triggerShutdown) can run graceful teardown even if the
  // exception happens during startup. Wiring it after agent.start() would
  // leave a window where an uncaught during swap event registration would
  // fall through to the default handler and skip shutdown.
  const shutdown = async (): Promise<void> => {
    // W: guard against double SIGTERM re-entering shutdown — a second run
    // would double-destroy sphere and likely throw on the second call.
    if (shutdownState.shuttingDown) return;
    shutdownState.shuttingDown = true;

    logger.info('shutdown_signal_received');
    const forceExit = setTimeout(() => {
      logger.error('shutdown_force_exit', { reason: 'graceful shutdown exceeded 10s' });
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    stopped = true;
    // Unblock any sleeps inside retry loops so they can observe `stopped`
    // immediately and bail, rather than waiting out the full interval.
    cancelPendingWaits();
    if (syncTimer) clearTimeout(syncTimer);
    if (swapPollTimer) clearTimeout(swapPollTimer);
    // C17: unsubscribe the diagnostic onDirectMessage handler BEFORE
    // sphere.destroy() so it can't fire on a torn-down transport.
    try { offDmDiagnostic(); } catch { /* best effort */ }
    // Unsubscribe sphere event listeners before stopping agent
    for (const unsub of sphereUnsubscribers) {
      try { unsub(); } catch { /* best effort */ }
    }
    sphereUnsubscribers.length = 0;
    await agent.stop().catch((err: unknown) => {
      logger.error('agent_stop_failed', { error: err instanceof Error ? err.message : String(err) });
    });
    // C19: guard sphere.destroy() — if it throws, process.exit(0) below
    // would be skipped and the forceExit timer becomes the only escape.
    await sphere.destroy().catch((err: unknown) => {
      logger.error('sphere_destroy_failed', { error: err instanceof Error ? err.message : String(err) });
    });
    clearTimeout(forceExit);
    process.exit(0);
  };
  // Use process.on — shutdown() is idempotent via its internal `shuttingDown`
  // check, so repeat signals are safe. Critically, once() would let a second
  // SIGTERM from an impatient operator fall through to Node's default signal
  // handler, which kills the process mid-teardown. Listener accumulation
  // across re-invocations is prevented by the `mainInvocations` guard above.
  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGINT', () => { void shutdown(); });

  // Upgrade the bootstrap-safe triggerShutdown to the full shutdown function
  // that also clears timers, unsubscribes sphere listeners, and cancels
  // pending waits. The bootstrap version already handled the common case
  // (agent/sphere teardown) for exceptions earlier in startup.
  shutdownState.triggerShutdown = shutdown;

  if (sphere.swap) {
    const swapModule = sphere.swap;

    // Auto-accept incoming swap proposals that match our NP-0 deals.
    // We fetch the swap status from the SDK BEFORE accepting so we can
    // match it to the correct tracked deal by asset/amount/counterparty
    // (C16). Picking "the one deal with null swapId" is unsafe when two
    // concurrent acceptor deals are in-flight.
    sphereUnsubscribers.push(sphere.on('swap:proposal_received' as SphereEventType, ((data: { swapId: string }) => {
      logger.info('swap_proposal_received', { swap_id: data.swapId });
      // C18: wrap the entire async handler in try/catch. A synchronous throw
      // during registerSwapId (e.g. state validation) or any rejection the
      // inner try/catch doesn't cover would become an unhandled rejection
      // and crash the process. Top-level catch guarantees no rejection
      // escapes to the runtime from this event listener.
      void (async () => {
        try {
          // F3: registerSwapId returns `false` when there is no LIVE NP-0 deal
          // (ACCEPTED/EXECUTING) matching the incoming swap proposal. That
          // happens when our accept-DM-send failed after partial relay
          // propagation — the counterparty still saw acceptance and proceeded
          // to proposeSwap, but our side tore the deal down to CANCELLED.
          // Without the gate, acceptSwap would move funds on a deal we no
          // longer honor. Reject the swap in that case.
          let registered = false;

          // Best-effort: query the SDK for proposal details. If unavailable,
          // registerSwapId still runs without match info (legacy path), but
          // ambiguous assignment is blocked inside the executor.
          try {
            const status = await swapModule.getSwapStatus(data.swapId);
            // SwapRef has deal.partyACurrency, deal.partyAAmount, etc. and
            // counterpartyPubkey (transport pubkey of the proposer).
            const s = status;

            // SECURITY (spec 7.9.5): reject any swap that isn't on
            // protocolVersion === 2. v1 lacks the mutual-consent signature
            // chain and doesn't bind escrow_address into swap_id, opening
            // a MITM substitution vector.
            //
            // N1 (round-4 audit) — type-drift defense: parse permissively
            // so a future SDK that changes the field's encoding (e.g.
            // string "v2", semver "2.0.0") doesn't silently DoS every
            // proposal. Accepts: number 2, string "2", string "v2",
            // semver "2.x.y". Reject everything else.
            const rawProtocolVersion = (s as unknown as { protocolVersion?: unknown }).protocolVersion;
            const isV2 = (() => {
              if (rawProtocolVersion === 2) return true;
              if (typeof rawProtocolVersion === 'string') {
                if (rawProtocolVersion === '2' || rawProtocolVersion === 'v2') return true;
                // semver "2.x.y" → major version 2
                const match = /^v?(\d+)(?:\.\d+)*$/.exec(rawProtocolVersion);
                if (match && match[1] === '2') return true;
              }
              return false;
            })();
            if (!isV2) {
              logger.warn('swap_proposal_rejected_protocol_version', {
                swap_id: data.swapId,
                protocol_version: rawProtocolVersion ?? 'unspecified',
              });
              try {
                await swapModule.rejectSwap(data.swapId, 'PROTOCOL_VERSION_TOO_OLD');
              } catch (rejErr: unknown) {
                logger.error('swap_reject_failed', {
                  swap_id: data.swapId,
                  error: rejErr instanceof Error ? rejErr.message : String(rejErr),
                });
              }
              return;
            }

            // SECURITY (M1): if BOTH counterpartyPubkey and proposerChainPubkey
            // are undefined (SDK version skew, sandbox build, malformed
            // status), the identity check inside registerSwapId silently
            // skips, leaving currency/amount alone as identity. In a busy
            // testnet that's not enough. Reject explicitly.
            const cpPubkey = s.counterpartyPubkey ?? s.proposerChainPubkey;
            if (cpPubkey === undefined || cpPubkey === '') {
              logger.error('swap_proposal_rejected_missing_counterparty_pubkey', {
                swap_id: data.swapId,
              });
              try {
                await swapModule.rejectSwap(data.swapId, 'MISSING_COUNTERPARTY_PUBKEY');
              } catch (rejErr: unknown) {
                // N5 (round-5 audit): mirror the protocolVersion path —
                // surface rejectSwap failures so an operator can tell
                // when the escrow held funds awaiting a manual reclaim.
                logger.error('swap_reject_failed', {
                  swap_id: data.swapId,
                  reason: 'MISSING_COUNTERPARTY_PUBKEY',
                  error: rejErr instanceof Error ? rejErr.message : String(rejErr),
                });
              }
              return;
            }

            registered = agent.registerSwapId(data.swapId, {
              partyACurrency: s.deal?.partyACurrency,
              partyAAmount: s.deal?.partyAAmount,
              partyBCurrency: s.deal?.partyBCurrency,
              partyBAmount: s.deal?.partyBAmount,
              counterpartyPubkey: cpPubkey,
              // SECURITY (spec 7.9.4 / H1): extend term-binding to escrow
              // address and timeout. registerSwapId compares against the
              // negotiated DealTerms; mismatch → reject (defeats a hostile
              // counterparty proposing v2 with a different escrow at the
              // SDK layer than what was negotiated at NP-0).
              escrowDirectAddress: (s as unknown as { escrowDirectAddress?: string }).escrowDirectAddress,
              escrowPubkey: (s as unknown as { escrowPubkey?: string }).escrowPubkey,
              depositTimeoutSec: (s.deal as unknown as { timeout?: number; depositTimeoutSec?: number })?.depositTimeoutSec
                ?? (s.deal as unknown as { timeout?: number })?.timeout,
            });
          } catch (err: unknown) {
            logger.warn('swap_proposal_status_fetch_failed', {
              swap_id: data.swapId,
              error: err instanceof Error ? err.message : String(err),
            });
            registered = agent.registerSwapId(data.swapId);
          }

          if (!registered) {
            // No live NP-0 deal matches. Reject the swap at the SDK level so
            // the counterparty's deposit isn't held in escrow for the full
            // timeout. Best-effort: if rejectSwap itself fails, the escrow
            // timeout eventually reclaims the funds.
            logger.warn('swap_proposal_rejected_no_live_deal', { swap_id: data.swapId });
            try {
              await swapModule.rejectSwap(data.swapId, 'NO_LIVE_NP0_DEAL');
              logger.info('swap_rejected', { swap_id: data.swapId, reason: 'NO_LIVE_NP0_DEAL' });
            } catch (err: unknown) {
              logger.error('swap_reject_failed', {
                swap_id: data.swapId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
            return;
          }

          try {
            await swapModule.acceptSwap(data.swapId);
            logger.info('swap_accepted', { swap_id: data.swapId });
          } catch (err: unknown) {
            logger.error('swap_accept_failed', { swap_id: data.swapId, error: String(err) });
            agent.handleSwapFailed(data.swapId, `ACCEPT_FAILED: ${String(err)}`);
          }
        } catch (err: unknown) {
          logger.error('swap_proposal_handler_failed', {
            swap_id: data.swapId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
    }) as Parameters<typeof sphere.on>[1]));

    // Auto-deposit when escrow delivers the deposit invoice.
    // Wrapped in try/catch at the outermost async boundary so nothing in the
    // retry loop can escape as an unhandled rejection. Waits are cancelable
    // via the `stopped` flag so SIGTERM doesn't leave a background loop
    // retrying deposit() after the trader is torn down.
    // Fault-injection: when `TRADER_FAULT_SKIP_DEPOSITS=1` is set in the
    // environment, the trader receives swap:announced events normally but
    // does NOT call swapModule.deposit(). The escrow's deposit_timeout_sec
    // counter then expires and the swap fails with EXECUTION_TIMEOUT, which
    // is exactly the "B does not deposit" leg of the negotiation-failures
    // deposit-timeout test. Read once at module init so the gate is
    // immutable for the trader's lifetime — operators can't accidentally
    // toggle this on a live swap.
    const FAULT_SKIP_DEPOSITS_ENV = process.env['TRADER_FAULT_SKIP_DEPOSITS'] === '1';
    // SECURITY (H2): hard-fail at startup if fault injection is enabled on
    // anything other than testnet/dev. Without this, a poisoned config
    // pipeline (k8s ConfigMap drift, .env leak from a CI job, image pulled
    // from a tagged dev branch) can flip the flag on mainnet and silently
    // break every counterparty's swap with EXECUTION_TIMEOUT.
    const NETWORK = process.env['UNICITY_NETWORK'] ?? 'testnet';
    const FAULT_INJECTION_ALLOWED_NETWORKS = new Set(['testnet', 'dev']);
    const FAULT_INJECTION_ALLOWED = process.env['TRADER_FAULT_INJECTION_ALLOWED'] === '1';
    if (FAULT_SKIP_DEPOSITS_ENV) {
      if (!FAULT_INJECTION_ALLOWED_NETWORKS.has(NETWORK) || !FAULT_INJECTION_ALLOWED) {
        const reason = !FAULT_INJECTION_ALLOWED_NETWORKS.has(NETWORK)
          ? `network=${NETWORK} (allowed: testnet, dev)`
          : 'TRADER_FAULT_INJECTION_ALLOWED=1 not set';
        logger.error('fault_inject_production_guard_violation', {
          note: 'TRADER_FAULT_SKIP_DEPOSITS=1 rejected at startup',
          reason,
          network: NETWORK,
        });
        throw new Error(
          `TRADER_FAULT_SKIP_DEPOSITS=1 not permitted in this environment: ${reason}. ` +
            `To enable for testing: set UNICITY_NETWORK=testnet (or dev) AND TRADER_FAULT_INJECTION_ALLOWED=1.`,
        );
      }
    }
    const FAULT_SKIP_DEPOSITS = FAULT_SKIP_DEPOSITS_ENV;
    if (FAULT_SKIP_DEPOSITS) {
      logger.warn('fault_inject_deposit_skip_enabled', {
        note: 'trader will NOT deposit on swap:announced; downstream swaps will EXECUTION_TIMEOUT. Production deployments must NOT set TRADER_FAULT_SKIP_DEPOSITS.',
        network: NETWORK,
      });
    }
    // ROUND-5C: deposit dispatch unified between event + poll paths via
    // tryDepositForSwap (defined earlier in this scope). The swap:announced
    // event fires reliably for the proposer side; the acceptor relies on
    // the poll loop's same dispatch (depositInFlight + markDepositAttempted
    // gate dedups across both paths).
    sphereUnsubscribers.push(sphere.on('swap:announced' as SphereEventType, ((data: { swapId: string }) => {
      logger.info('swap_announced', { swap_id: data.swapId });
      if (FAULT_SKIP_DEPOSITS) {
        logger.warn('fault_inject_deposit_skipped', {
          swap_id: data.swapId,
          note: 'TRADER_FAULT_SKIP_DEPOSITS=1 — deposit() not called; counterparty will time out',
        });
        return;
      }
      void tryDepositForSwap(data.swapId, 'event').catch(() => {
        /* tryDepositForSwap logs internally */
      });
    }) as Parameters<typeof sphere.on>[1]));

    // Log payout received — SDK auto-verifies internally
    sphereUnsubscribers.push(sphere.on('swap:payout_received' as SphereEventType, ((data: { swapId: string }) => {
      logger.info('swap_payout_received', { swap_id: data.swapId });
    }) as Parameters<typeof sphere.on>[1]));

    // Log completion + update deal tracker.
    // Per spec §7.9.2 (Constraint #9): payoutVerified must be true before
    // marking the deal volume_filled. The SDK's first auto-verify can race
    // with payout-invoice token import — getInvoice() returns null before
    // the import completes, causing verifyPayout() to return false. Retry
    // 30s × 10 (5-minute window) before declaring PAYOUT_UNVERIFIED.
    sphereUnsubscribers.push(sphere.on('swap:completed' as SphereEventType, ((data: { swapId: string; payoutVerified: boolean }) => {
      logger.info('swap_completed', { swap_id: data.swapId, payout_verified: data.payoutVerified });
      sphere.payments.receive().catch(() => {});
      // Round-5: clear the persisted deposit-attempted flag so the
      // long-lived persistent set doesn't grow without bound.
      depositInFlight.delete(data.swapId);
      void agent.clearDepositAttempted(data.swapId).catch(() => {});
      if (data.payoutVerified) {
        agent.handleSwapCompleted(data.swapId, true);
        return;
      }
      // Async retry loop — fire-and-forget, gated on stopped flag.
      void (async () => {
        // 30s × 20 = 10-minute window before escalating to FAILED.
        // The SDK's verifyPayout fails closed when payout-invoice tokens
        // are L3-pending. On testnet, aggregator inclusion-proof
        // propagation has been observed to take up to ~7 minutes during
        // peak load — 5 minutes reliably escalated legitimate payouts
        // to PAYOUT_UNVERIFIED. 2026-04-30 observation: even 10 min
        // wasn't enough on a slow day (verifyPayout still allConfirmed=false
        // at attempt 18 = 9 min). 20 min covers the observed worst case
        // with sufficient margin for testnet's ALB-fronted aggregator.
        const MAX_ATTEMPTS = 40;
        const RETRY_INTERVAL_MS = 30_000;
        let verified = false;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          await waitCancellable(RETRY_INTERVAL_MS);
          if (stopped) return;
          // Pull pending tokens before each verify so a late-arriving payout
          // invoice import has a chance to land.
          await sphere.payments.receive({ finalize: true }).catch(() => {});
          if (stopped) return;
          try {
            if (!sphere.swap) {
              logger.warn('swap_verify_payout_module_unavailable', { swap_id: data.swapId, attempt });
              break;
            }
            // DIAGNOSTIC: dump the payout-invoice coverage state to identify which
            // returnFalse() branch in SDK verifyPayout is firing.
            try {
              const swapStatus = await sphere.swap.getSwapStatus(data.swapId);
              const payoutId = swapStatus.payoutInvoiceId;
              if (payoutId && sphere.accounting) {
                const inv = sphere.accounting.getInvoice(payoutId);
                let invStatus: unknown = null;
                try {
                  invStatus = await sphere.accounting.getInvoiceStatus(payoutId);
                } catch (statusErr) {
                  invStatus = `status_threw:${statusErr instanceof Error ? statusErr.message : String(statusErr)}`;
                }
                logger.info('swap_payout_verify_diag', {
                  swap_id: data.swapId,
                  attempt,
                  payoutInvoiceId: payoutId,
                  invoice_imported: inv !== null,
                  invoice_terms: inv ? {
                    creator: inv.terms.creator,
                    targets: inv.terms.targets.map((t) => ({
                      address: t.address,
                      assets: t.assets.map((a) => ({ coin: a.coin })),
                    })),
                  } : null,
                  invoice_status: invStatus,
                });
              }
            } catch (diagErr) {
              logger.warn('swap_payout_verify_diag_failed', {
                swap_id: data.swapId,
                attempt,
                error: diagErr instanceof Error ? diagErr.message : String(diagErr),
              });
            }
            verified = await sphere.swap.verifyPayout(data.swapId);
          } catch (err) {
            // verifyPayout throws on terminal non-completed states. If that
            // happens, the swap has been moved to failed/cancelled by some
            // other code path — no point retrying.
            logger.warn('swap_verify_payout_threw', {
              swap_id: data.swapId,
              attempt,
              error: err instanceof Error ? err.message : String(err),
            });
            break;
          }
          if (verified) {
            logger.info('swap_payout_verified_on_retry', {
              swap_id: data.swapId,
              attempt,
            });
            break;
          }
          logger.info('swap_payout_verify_retry_failed', {
            swap_id: data.swapId,
            attempt,
            remaining: MAX_ATTEMPTS - attempt,
          });
        }
        if (stopped) return;
        agent.handleSwapCompleted(data.swapId, verified);
      })();
    }) as Parameters<typeof sphere.on>[1]));

    sphereUnsubscribers.push(sphere.on('swap:failed' as SphereEventType, ((data: { swapId: string; error: string }) => {
      logger.error('swap_failed', { swap_id: data.swapId, error: data.error });
      depositInFlight.delete(data.swapId);
      void agent.clearDepositAttempted(data.swapId).catch(() => {});
      agent.handleSwapFailed(data.swapId, data.error);
    }) as Parameters<typeof sphere.on>[1]));

    // Round-5: also subscribe swap:cancelled so the deposit-attempted set
    // gets cleared on every terminal state.
    sphereUnsubscribers.push(sphere.on('swap:cancelled' as SphereEventType, ((data: { swapId: string }) => {
      logger.info('swap_cancelled', { swap_id: data.swapId });
      depositInFlight.delete(data.swapId);
      void agent.clearDepositAttempted(data.swapId).catch(() => {});
    }) as Parameters<typeof sphere.on>[1]));
  }

  // ---- TRADER_TEST_FUND: self-mint test coins (replaces faucet HTTP) ----
  //
  // Format: comma-separated `<coinIdHex>:<amount>` tuples.
  //   TRADER_TEST_FUND="455ad8720656...:100000000000000000000,8f0f3d7a...:1000000000"
  // (UCT and USDU coinIds from the public testnet registry.)
  //
  // Production-guarded with the same gate as TRADER_FAULT_SKIP_DEPOSITS:
  // requires UNICITY_NETWORK ∈ {testnet, dev}. Without the network gate
  // a misconfigured prod deployment could mint arbitrary balances. The
  // gate also requires TRADER_FAULT_INJECTION_ALLOWED=1 to make the
  // intent unambiguous. Mint runs BEFORE agent.start() so balances are
  // visible to the intent engine on the first scan cycle.
  const TEST_FUND_RAW = process.env['TRADER_TEST_FUND'];
  if (TEST_FUND_RAW !== undefined && TEST_FUND_RAW !== '') {
    const TEST_FUND_NETWORK = process.env['UNICITY_NETWORK'] ?? 'testnet';
    const TEST_FUND_ALLOWED = process.env['TRADER_FAULT_INJECTION_ALLOWED'] === '1';
    const TEST_FUND_NETWORKS = new Set(['testnet', 'dev']);
    if (!TEST_FUND_NETWORKS.has(TEST_FUND_NETWORK) || !TEST_FUND_ALLOWED) {
      const reason = !TEST_FUND_NETWORKS.has(TEST_FUND_NETWORK)
        ? `network=${TEST_FUND_NETWORK} (allowed: testnet, dev)`
        : 'TRADER_FAULT_INJECTION_ALLOWED=1 not set';
      logger.error('test_fund_production_guard_violation', {
        note: 'TRADER_TEST_FUND rejected at startup',
        reason,
        network: TEST_FUND_NETWORK,
      });
      throw new Error(
        `TRADER_TEST_FUND not permitted in this environment: ${reason}. ` +
          `To enable for testing: set UNICITY_NETWORK=testnet (or dev) AND TRADER_FAULT_INJECTION_ALLOWED=1.`,
      );
    }
    const entries = TEST_FUND_RAW.split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const entry of entries) {
      const [coinIdHex, amountStr] = entry.split(':');
      if (!coinIdHex || !amountStr) {
        logger.warn('test_fund_invalid_entry', { entry });
        continue;
      }
      let amount: bigint;
      try {
        amount = BigInt(amountStr);
      } catch {
        logger.warn('test_fund_invalid_amount', { entry });
        continue;
      }
      const result = await sphere.payments.mintFungibleToken(coinIdHex, amount);
      if (!result.success) {
        logger.error('test_fund_mint_failed', {
          coin_id: coinIdHex.slice(0, 16) + '...',
          amount: amountStr,
          error: result.error,
        });
        throw new Error(`TRADER_TEST_FUND mint failed for ${coinIdHex}: ${result.error}`);
      }
      logger.info('test_fund_mint_succeeded', {
        coin_id: coinIdHex.slice(0, 16) + '...',
        amount: amountStr,
        token_id: result.tokenId.slice(0, 16) + '...',
      });
    }
  }

  await agent.start();

  logger.info('trader_agent_running', {
    pubkey: agentPubkey.slice(0, 16) + '...',
    direct_address: agentAddress,
  });
}

// Auto-start when run as main module. Gate on import.meta.url matching
// argv[1] so tests that `import` this module don't accidentally kick off the
// trader bootstrap — which would try to connect to the real Sphere network.
//
// Docker images typically install the entrypoint as a symlink (e.g.
// /usr/local/bin/trader → /app/dist/trader/main.js). In that case argv[1] is
// the symlink path while fileURLToPath(import.meta.url) resolves to the real
// path — a naive === compare fails and the container silently exits. Resolve
// symlinks on both sides via realpathSync before comparing.
function isMainModule(): boolean {
  try {
    const url = fileURLToPath(import.meta.url);
    const argv1 = process.argv[1];
    if (!argv1) return false;
    const realArgv1 = fs.realpathSync(argv1);
    return url === realArgv1;
  } catch {
    // argv[1] may not exist on disk in some runners (e.g. ts-node REPL) —
    // fall back to endsWith. Backslash-to-forward-slash conversion is only
    // meaningful on Windows; on POSIX, backslashes are legal in filenames
    // and converting them would mangle legitimate paths.
    try {
      const url = fileURLToPath(import.meta.url);
      const raw = process.argv[1] ?? '';
      const argv1 = process.platform === 'win32' ? raw.replace(/\\/g, '/') : raw;
      return url.endsWith(argv1);
    } catch {
      return false;
    }
  }
}

if (isMainModule()) {
  startTrader().catch((err) => {
    const logger = createLogger({ component: 'trader-bootstrap' });
    logger.error('trader_startup_failed', { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}
