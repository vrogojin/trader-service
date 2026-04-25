/**
 * Shared timeout helper — consolidated from duplicated copies that previously
 * lived in host-manager/main.ts, trader/main.ts, and tenant/main.ts. Having a
 * single source of truth here eliminates drift hazard: prior to this
 * consolidation the host-manager copy had a `settled` flag that correctly
 * distinguished in-time rejections (surface via Promise.race) from late
 * rejections (log via warn), while the trader/tenant copies did NOT — those
 * two versions spuriously labeled in-time rejections as
 * "late_rejection_after_timeout". The consolidated helper always gates the
 * late-rejection log behind `settled`.
 *
 * Contract:
 *
 *   - `op()` is invoked immediately. If `op()` throws SYNCHRONOUSLY (not a
 *     returned rejected promise, but an actual `throw` during invocation),
 *     `withTimeout` rejects with the same error — callers that don't want
 *     any thrown-out-of-withTimeout surface should wrap their op in a
 *     `() => Promise.resolve().then(() => realOp())` adapter. The round-23
 *     F2 fix converts such synchronous throws into asynchronous rejections
 *     so they flow through the same `.catch` handler that handles in-time
 *     rejections — otherwise a sync throw from op would bypass the helper
 *     entirely and the late-rejection logger wouldn't even be attached.
 *   - The returned promise is raced against a setTimeout.
 *   - On success, resolves with `{ timedOut: false, value }`.
 *   - On timeout, resolves with `{ timedOut: true }`. The caller branches on
 *     this sentinel rather than relying on `undefined`, so we don't conflate
 *     "operation returned nothing" with "operation timed out".
 *   - On in-time rejection (op() rejects BEFORE the timer fires), the
 *     returned promise is rejected with the same error — callers handle it
 *     via try/catch or a `.catch()` chain. This matches the prior
 *     host-manager behavior. The `.catch` handler attached to `p` is a no-op
 *     in this case (it sees `settled === false` and returns early), so in-
 *     time rejections are NOT mislabeled as "late_rejection_after_timeout".
 *   - On late rejection (op() rejects AFTER the timer already won the race),
 *     the rejection would otherwise be an unhandled rejection. We attach a
 *     `.catch` handler that logs via `logger.warn('late_rejection_after_timeout', ...)`
 *     if a logger is provided, or `console.error` otherwise — preserving
 *     diagnostic signal without crashing the process. Round-23 F3: the log
 *     call itself is wrapped in try/catch so a buggy logger that throws
 *     from `.warn()` does not re-throw on an already-late error path.
 *
 * The `settled` flag is set inside a `finally` block after `Promise.race`
 * resolves (success or timeout) OR throws (in-time rejection). Since handlers
 * on a rejected promise run in registration order, and `.catch` is registered
 * on `p` BEFORE `p.then(...)` inside Promise.race, an in-time rejection
 * triggers `.catch` first with `settled === false` — correct behavior. Any
 * subsequent rejection of `p` after the `finally` hits `.catch` with
 * `settled === true` and logs.
 *
 * Callers requiring a never-throwing API (discriminated union ALL the way
 * down) should wrap op() in their own try/catch that returns a rejected
 * `TimeoutResult`-shaped sentinel — but this helper deliberately surfaces
 * op() errors by throwing, so the caller sees the original stack trace
 * rather than a synthesized error.
 */

/** Result of a withTimeout call. Distinguishes timeout from ordinary success. */
export type TimeoutResult<T> = { timedOut: true } | { timedOut: false; value: T };

/**
 * Minimal logger surface consumed by withTimeout. Any object with a
 * `warn(event, details?)` method satisfies the contract — Logger from
 * src/shared/logger.ts matches. Pass `null` to fall back to `console.error`.
 */
export interface TimeoutLogger {
  warn(event: string, details?: Record<string, unknown>): void;
}

export async function withTimeout<T>(
  label: string,
  timeoutMs: number,
  logger: TimeoutLogger | null,
  op: () => Promise<T>,
): Promise<TimeoutResult<T>> {
  // Round-23 F2: wrap op() invocation in try/catch so a synchronous throw
  // from op becomes an in-time rejection of `p`. Without this, a sync throw
  // would bypass withTimeout's `.catch` handler entirely AND skip the
  // `finally` that clears the timer — leaving a live setTimeout hanging
  // and producing an unhandled exception the caller may not expect from a
  // helper whose documented contract is a race. Converting to a rejected
  // promise here preserves the "throw out of withTimeout" contract while
  // ensuring the late-rejection machinery is consistently wired.
  let p: Promise<T>;
  try {
    p = op();
  } catch (err: unknown) {
    // Sync throw from op — adopt the error as an immediate rejection so
    // the rest of this function sees a uniformly-shaped promise. The
    // Promise.race below will surface it via the awaited throw, and the
    // `.catch` handler attached below runs before the race resolves (settled
    // still false), so no spurious late-rejection log is emitted.
    p = Promise.reject(err);
  }
  // `settled` gates the late-rejection log. In-time rejections run `.catch`
  // with settled=false and return without logging — Promise.race will surface
  // them via the awaited throw. Late rejections run `.catch` with
  // settled=true and log via warn. See block-comment at top of file.
  let settled = false;
  p.catch((err: unknown) => {
    if (!settled) return;
    // Round-23 F3: wrap the log call in try/catch. A buggy logger whose
    // `.warn()` throws (misconfigured transport, full buffer, whatever)
    // would otherwise produce an unhandled exception on the already-late
    // error path — we have zero recourse at that point, so swallow it.
    // We prefer logger over console.error if a logger is provided, but on
    // logger throw we fall BACK to console.error for diagnostic visibility.
    try {
      const details = { label, error: err instanceof Error ? err.message : String(err) };
      if (logger) {
        logger.warn('late_rejection_after_timeout', details);
      } else {
        // eslint-disable-next-line no-console
        console.error(`[withTimeout:${label}] late_rejection_after_timeout:`, err);
      }
    } catch (logErr: unknown) {
      // Logger itself threw — best effort fallback via console. If THIS also
      // throws (console redirected to a broken stream) we swallow — we're
      // already on an error path nobody is awaiting.
      try {
        // eslint-disable-next-line no-console
        console.error(
          `[withTimeout:${label}] logger_threw_on_late_rejection:`,
          logErr,
          'original:',
          err,
        );
      } catch { /* nothing more we can do */ }
    }
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<TimeoutResult<T>>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true as const }), timeoutMs);
    // Don't hold the event loop open for a teardown timer. Matches the
    // prior tenant/trader behavior where the timeout was `.unref()`-ed; the
    // host-manager version didn't unref but its timer was always cleared in
    // `finally` before the loop drained anyway, so unref is strictly
    // additive defense.
    if (timer && typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
      (timer as unknown as { unref: () => void }).unref();
    }
  });

  try {
    return await Promise.race<TimeoutResult<T>>([
      p.then((value) => ({ timedOut: false as const, value })),
      timeout,
    ]);
  } finally {
    settled = true;
    if (timer) clearTimeout(timer);
  }
}
