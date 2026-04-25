/**
 * HeartbeatEmitter — sends periodic ACP heartbeat messages to the manager.
 */

import { createAcpMessage } from '../protocols/acp.js';
import { serializeMessage } from '../protocols/envelope.js';
import type { Logger } from '../shared/logger.js';
import type { SphereDmSender } from './types.js';

export interface HeartbeatEmitter {
  start(intervalMs: number): void;
  stop(): void;
  isRunning(): boolean;
}

/**
 * Minimum heartbeat interval the emitter will accept. A hostile or buggy
 * manager could send `heartbeat_interval_ms: 0` or a negative number in
 * hello_ack; Node would then clamp `setInterval` to 1ms and we would spam
 * the manager (and the relays) at thousands of heartbeats per second.
 *
 * The AcpListener also clamps this at the hello_ack boundary, but keeping
 * the floor here is defense-in-depth: future callers (tests, replacement
 * listener implementations, etc.) can't accidentally slip past it.
 */
const MIN_HEARTBEAT_INTERVAL_MS = 1000;

/** Minimum interval between re-tune INFO-level log lines; repeated re-tunes
 *  within this window drop to DEBUG. Prevents a buggy/compromised manager
 *  that flip-flops heartbeat cadence from saturating the INFO log stream. */
const RETUNE_LOG_WINDOW_MS = 60_000;

export function createHeartbeatEmitter(
  sender: SphereDmSender,
  instanceId: string,
  instanceName: string,
  managerAddress: string,
  logger: Logger,
): HeartbeatEmitter {
  let timer: ReturnType<typeof setInterval> | null = null;
  let startedAt: number | null = null;
  let currentIntervalMs: number | null = null;
  /** Timestamp (ms-since-epoch) of the last re-tune that was logged at INFO
   *  level. Used to throttle repeated re-tune logging under flip-flop
   *  attacks. 0 means "never re-tuned". */
  let lastRetuneAt = 0;

  function sendHeartbeat(): void {
    const uptimeMs = startedAt !== null ? Date.now() - startedAt : 0;
    const msg = createAcpMessage('acp.heartbeat', instanceId, instanceName, {
      status: 'RUNNING',
      uptime_ms: uptimeMs,
      app: {
        mode: 'boilerplate',
        pid: process.pid,
      },
    });
    sender.sendDm(managerAddress, serializeMessage(msg)).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('heartbeat_send_failed', { error: message });
    });
    logger.debug('heartbeat_sent', { uptime_ms: uptimeMs });
  }

  return {
    /**
     * Start (or re-tune) heartbeat emission.
     *
     * Round-18 F4: Previously this was a silent no-op whenever `timer` was
     * set, which meant a second hello_ack with a different cadence (e.g. the
     * manager asking the tenant to slow down for backpressure) was dropped on
     * the floor. Now:
     *
     *   - If already running at the requested interval → no-op (idempotent).
     *   - If already running at a DIFFERENT interval → re-tune: clear the
     *     existing timer and start a new one at the new interval. `startedAt`
     *     is preserved so `uptime_ms` remains monotonic across a re-tune —
     *     we are not restarting the heartbeat conceptually, just adjusting
     *     cadence.
     *   - If not running → start normally.
     *
     * Round-19 F3: `intervalMs` is clamped to MIN_HEARTBEAT_INTERVAL_MS
     * (defense-in-depth against an unclamped caller). Values below the floor,
     * non-finite numbers (NaN, Infinity), or non-numbers fall back to the
     * floor and a `heartbeat_interval_clamped` warning is logged.
     *
     * Round-19 F4: Repeated re-tunes within RETUNE_LOG_WINDOW_MS drop to
     * DEBUG rather than INFO, so a compromised/buggy manager can't flood the
     * INFO log stream by rapidly alternating cadences.
     */
    start(intervalMs: number): void {
      // Round-19 F3: Clamp input before any downstream use. `setInterval(cb, 0)`
      // and `setInterval(cb, -5)` both get clamped by Node to 1ms, producing a
      // heartbeat storm (~1000 DMs/sec) that hammers both the manager and the
      // Nostr relays. Non-finite values (NaN, Infinity) are also rejected.
      const safeInterval = Number.isFinite(intervalMs) && intervalMs >= MIN_HEARTBEAT_INTERVAL_MS
        ? intervalMs
        : MIN_HEARTBEAT_INTERVAL_MS;
      if (safeInterval !== intervalMs) {
        logger.warn('heartbeat_interval_clamped', {
          requested: intervalMs,
          applied: safeInterval,
        });
      }

      if (timer !== null && currentIntervalMs === safeInterval) return;
      if (timer !== null) {
        // Re-tuning an active heartbeat to a new cadence. Clear the old
        // interval but leave `startedAt` intact so uptime keeps accumulating.
        clearInterval(timer);
        timer = null;
        // Round-19 F4 / Round-21 F4: Rate-limit the INFO retune log using a
        // FIXED window, not a sliding window. A compromised or buggy manager
        // sending alternating hello_acks can otherwise generate one INFO
        // line per ACK, drowning out legitimate telemetry.
        //
        // Prior implementation (sliding window): updated `lastRetuneAt` on
        // EVERY retune — INFO or DEBUG. An attacker retuning every 30s (just
        // under the 60s window) would stay at DEBUG forever after the second
        // retune because each attempt kept pushing the window forward.
        // Operators lose the ability to see the flip-flop at default log
        // level.
        //
        // Fixed window fix: only update `lastRetuneAt` when we actually log
        // at INFO. Attacker retuning every 30s now produces:
        //   t=0s    INFO  (elapsed=very-large → ≥60s → INFO, lastRetuneAt:=0)
        //   t=30s   DEBUG (elapsed=30s < 60s → DEBUG, don't update)
        //   t=60s   INFO  (elapsed=60s ≥ 60s → INFO, lastRetuneAt:=60s)
        //   t=90s   DEBUG (elapsed=30s < 60s → DEBUG)
        //   t=120s  INFO  (elapsed=60s ≥ 60s → INFO, lastRetuneAt:=120s)
        // Operator sees ~one INFO per 60s window regardless of attacker rate.
        // With the prior sliding-window code, every retune updated
        // `lastRetuneAt`, so after the t=30s DEBUG retune the tracking would
        // advance to 30s and the t=60s retune would see elapsed=30s<60s →
        // stay DEBUG forever. The attacker wins the silencing.
        const now = Date.now();
        const logPayload = {
          previous_interval_ms: currentIntervalMs,
          new_interval_ms: safeInterval,
        };
        if (now - lastRetuneAt >= RETUNE_LOG_WINDOW_MS) {
          logger.info('heartbeat_retuned', logPayload);
          lastRetuneAt = now; // only update on INFO — fixed-window semantics
        } else {
          logger.debug('heartbeat_retuned', logPayload);
          // Do NOT update lastRetuneAt — attacker can't keep pushing the
          // window forward.
        }
        currentIntervalMs = safeInterval;
        // Don't re-emit an immediate heartbeat here — we already sent one at
        // the original start; a re-tune shouldn't look like a second boot to
        // the manager.
        timer = setInterval(sendHeartbeat, safeInterval);
        return;
      }
      startedAt = Date.now();
      currentIntervalMs = safeInterval;
      sendHeartbeat();
      timer = setInterval(sendHeartbeat, safeInterval);
      logger.info('heartbeat_started', { interval_ms: safeInterval });
    },

    stop(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      startedAt = null;
      currentIntervalMs = null;
      // Reset the retune-log throttle too, so a fresh start() after stop()
      // isn't burdened with stale rate-limit state from the previous run.
      lastRetuneAt = 0;
      logger.info('heartbeat_stopped');
    },

    isRunning(): boolean {
      return timer !== null;
    },
  };
}
