import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withTimeout } from './with-timeout.js';
import type { TimeoutLogger } from './with-timeout.js';

function createCapturingLogger(): TimeoutLogger & { calls: Array<{ event: string; details?: Record<string, unknown> }> } {
  const calls: Array<{ event: string; details?: Record<string, unknown> }> = [];
  return {
    calls,
    warn(event: string, details?: Record<string, unknown>) {
      calls.push({ event, ...(details ? { details } : {}) });
    },
  };
}

describe('withTimeout (shared)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns { timedOut: false, value } when op resolves before timeout', async () => {
    const logger = createCapturingLogger();
    const promise = withTimeout('op', 1_000, logger, async () => 'result');
    await vi.advanceTimersByTimeAsync(0);
    const r = await promise;
    expect(r.timedOut).toBe(false);
    if (!r.timedOut) expect(r.value).toBe('result');
    // No late-rejection warning should fire on a clean success
    expect(logger.calls).toHaveLength(0);
  });

  it('returns { timedOut: true } when op is still pending after timeout', async () => {
    const logger = createCapturingLogger();
    // Never-settling op
    const promise = withTimeout('stuck', 1_000, logger, () => new Promise<never>(() => {}));
    await vi.advanceTimersByTimeAsync(1_500);
    const r = await promise;
    expect(r.timedOut).toBe(true);
    // No late rejection yet — the op never rejects
    expect(logger.calls.find((c) => c.event === 'late_rejection_after_timeout')).toBeUndefined();
  });

  it('propagates in-time rejection as a thrown error (not a late-rejection log)', async () => {
    const logger = createCapturingLogger();
    // F4 regression — previously the trader/tenant copies lacked the
    // `settled` gate, so an in-time rejection was spuriously logged as
    // "late_rejection_after_timeout" in addition to surfacing up the stack.
    //
    // Attach `.catch` to the returned promise inline to avoid an
    // intermediate unhandled-rejection tick (Node emits a
    // PromiseRejectionHandledWarning when a rejection is picked up
    // asynchronously). The test still verifies the error surfaces; we just
    // don't leave it dangling for a macrotask.
    let caught: unknown = null;
    await withTimeout('in-time-reject', 1_000, logger, async () => {
      throw new Error('in-time failure');
    }).catch((err: unknown) => { caught = err; });

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('in-time failure');
    // Give the .catch handler a chance to run after settled is true — if a
    // spurious "late_rejection_after_timeout" were going to fire, it would
    // fire during the same microtask turn. Verify it doesn't.
    await vi.advanceTimersByTimeAsync(0);
    expect(logger.calls.find((c) => c.event === 'late_rejection_after_timeout')).toBeUndefined();
  });

  it('logs late_rejection_after_timeout when op rejects AFTER the timeout has fired', async () => {
    const logger = createCapturingLogger();
    // A promise that resolves... er, rejects... 200ms after the timeout.
    let rejectLate!: (err: Error) => void;
    const pendingOp = new Promise<never>((_res, rej) => { rejectLate = rej; });
    const promise = withTimeout('late', 1_000, logger, () => pendingOp);

    // Fire the timeout first
    await vi.advanceTimersByTimeAsync(1_100);
    const r = await promise;
    expect(r.timedOut).toBe(true);

    // Now reject the op — this should be logged as a late rejection
    rejectLate(new Error('too slow'));
    // Let microtasks run so the .catch handler fires
    await vi.advanceTimersByTimeAsync(0);
    const late = logger.calls.find((c) => c.event === 'late_rejection_after_timeout');
    expect(late).toBeDefined();
    expect(late?.details?.['label']).toBe('late');
    expect(late?.details?.['error']).toBe('too slow');
  });

  it('falls back to console when logger is null', async () => {
    // eslint-disable-next-line no-console
    const origError = console.error;
    const captured: unknown[][] = [];
    // eslint-disable-next-line no-console
    console.error = (...args: unknown[]) => { captured.push(args); };
    try {
      let rejectLate!: (err: Error) => void;
      const pendingOp = new Promise<never>((_res, rej) => { rejectLate = rej; });
      const promise = withTimeout('no-logger', 500, null, () => pendingOp);

      await vi.advanceTimersByTimeAsync(600);
      const r = await promise;
      expect(r.timedOut).toBe(true);

      rejectLate(new Error('silent fail'));
      await vi.advanceTimersByTimeAsync(0);

      // Console.error should have been called with a recognizable prefix
      const hit = captured.find((args) => typeof args[0] === 'string' && (args[0] as string).includes('[withTimeout:no-logger]'));
      expect(hit).toBeDefined();
    } finally {
      // eslint-disable-next-line no-console
      console.error = origError;
    }
  });

  it('round-23 F2: surfaces a synchronous throw from op as a rejected promise (not a raw throw)', async () => {
    // Before round-23 F2, `const p = op()` would let a synchronous throw
    // from op propagate out of withTimeout BEFORE the `.catch` handler was
    // wired and BEFORE the `finally` cleared the timer. The fix catches the
    // sync throw and converts it to a rejected promise so the helper's
    // contract (uniform throw-out-of-withTimeout behavior for in-time
    // rejections, plus timer cleanup) is consistent.
    const logger = createCapturingLogger();
    let caught: unknown = null;
    await withTimeout('sync-throw', 1_000, logger, () => {
      throw new Error('sync failure from op');
    }).catch((err: unknown) => { caught = err; });

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('sync failure from op');

    // Sync throw is an IN-TIME rejection — no late-rejection log should fire
    await vi.advanceTimersByTimeAsync(0);
    expect(logger.calls.find((c) => c.event === 'late_rejection_after_timeout')).toBeUndefined();

    // Advance past the original timeout — timer should have been cleared
    // by the finally block, so still no logs.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(logger.calls).toHaveLength(0);
  });

  it('round-23 F3: logger.warn throwing from the late-rejection path does not crash', async () => {
    // A buggy logger (full buffer, misconfigured transport, whatever) that
    // throws from `.warn()` used to produce an unhandled exception on the
    // already-late error path. The fix wraps the log call in try/catch with
    // a console fallback.
    const thrownByLogger: Error[] = [];
    const throwingLogger: TimeoutLogger = {
      warn(_event: string, _details?: Record<string, unknown>) {
        const e = new Error('logger-is-broken');
        thrownByLogger.push(e);
        throw e;
      },
    };

    // Capture console.error so we can verify the fallback fired
    // eslint-disable-next-line no-console
    const origError = console.error;
    const captured: unknown[][] = [];
    // eslint-disable-next-line no-console
    console.error = (...args: unknown[]) => { captured.push(args); };
    try {
      let rejectLate!: (err: Error) => void;
      const pendingOp = new Promise<never>((_res, rej) => { rejectLate = rej; });
      const promise = withTimeout('bad-logger', 500, throwingLogger, () => pendingOp);

      await vi.advanceTimersByTimeAsync(600);
      const r = await promise;
      expect(r.timedOut).toBe(true);

      // Late rejection — logger will throw inside the .catch handler.
      rejectLate(new Error('op failure'));
      // Flush microtasks; if the fix is missing, this would produce an
      // unhandled rejection (test runner would flag).
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();

      // The logger's throw was captured (fix's try/catch swallowed it)
      expect(thrownByLogger).toHaveLength(1);
      expect(thrownByLogger[0]?.message).toBe('logger-is-broken');

      // The console.error fallback should have been invoked with a
      // recognizable prefix mentioning the logger threw
      const hit = captured.find((args) =>
        typeof args[0] === 'string' &&
        (args[0] as string).includes('[withTimeout:bad-logger]') &&
        (args[0] as string).includes('logger_threw_on_late_rejection'),
      );
      expect(hit).toBeDefined();
    } finally {
      // eslint-disable-next-line no-console
      console.error = origError;
    }
  });

  it('clears its timer on success so the event loop drains', async () => {
    // Regression check — a leaked timer can hold the event loop open.
    // Vitest's fake timers don't directly expose "pending timers" in a
    // stable way across versions, but we CAN verify that after a clean
    // success no timer callback still fires.
    const logger = createCapturingLogger();
    const promise = withTimeout('fast', 5_000, logger, async () => 42);
    await vi.advanceTimersByTimeAsync(0);
    const r = await promise;
    expect(r.timedOut).toBe(false);

    // Advance past the original timeout — nothing should happen
    await vi.advanceTimersByTimeAsync(10_000);
    // Still no log entries
    expect(logger.calls).toHaveLength(0);
  });
});
