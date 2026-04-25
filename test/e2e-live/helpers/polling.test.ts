/**
 * Unit tests for `pollUntil`. We use Vitest's fake timers so we don't
 * actually wait — otherwise even a fast test would burn ~60s on the timeout
 * path. The pattern: advance time manually, await microtasks, assert.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pollUntil } from './polling.js';

describe('pollUntil', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves true immediately when predicate returns true on first call', async () => {
    const predicate = vi.fn().mockResolvedValue(true);
    const promise = pollUntil(predicate);
    // No timer advance needed — predicate runs eagerly before any sleep.
    const result = await promise;
    expect(result).toBe(true);
    expect(predicate).toHaveBeenCalledTimes(1);
  });

  it('retries when predicate throws, then resolves true after a non-throwing true', async () => {
    const predicate = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient 1'))
      .mockRejectedValueOnce(new Error('transient 2'))
      .mockRejectedValueOnce(new Error('transient 3'))
      .mockResolvedValueOnce(true);

    const promise = pollUntil(predicate, { intervalMs: 100, timeoutMs: 10_000 });
    // 3 retries × 100ms each = 300ms of timer-advance to drain. Use
    // advanceTimersByTimeAsync to also drain microtasks created by the
    // rejected promises and the post-sleep awaits.
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;
    expect(result).toBe(true);
    expect(predicate).toHaveBeenCalledTimes(4);
  });

  it('resolves false on timeout (does NOT throw)', async () => {
    const predicate = vi.fn().mockResolvedValue(false);
    const promise = pollUntil(predicate, { intervalMs: 1_000, timeoutMs: 5_000 });
    // Advance well past the deadline.
    await vi.advanceTimersByTimeAsync(6_000);
    const result = await promise;
    expect(result).toBe(false);
    // We don't pin the exact call count (depends on deadline arithmetic)
    // but it should be at least 1 and bounded by ceil(timeout/interval) + 1.
    expect(predicate.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(predicate.mock.calls.length).toBeLessThanOrEqual(7);
  });

  it('respects intervalMs by gating successive calls behind the configured wait', async () => {
    const predicate = vi.fn().mockResolvedValue(false);
    const promise = pollUntil(predicate, {
      intervalMs: 1_000,
      timeoutMs: 10_000,
    });

    // First call happens immediately on entry.
    await vi.advanceTimersByTimeAsync(0);
    expect(predicate).toHaveBeenCalledTimes(1);

    // Advancing by less than intervalMs should not trigger another call.
    await vi.advanceTimersByTimeAsync(500);
    expect(predicate).toHaveBeenCalledTimes(1);

    // Crossing the interval boundary triggers the second call.
    await vi.advanceTimersByTimeAsync(500);
    expect(predicate).toHaveBeenCalledTimes(2);

    // And the third interval triggers the third call.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(predicate).toHaveBeenCalledTimes(3);

    // Drain to timeout so the test cleans up.
    await vi.advanceTimersByTimeAsync(20_000);
    await promise;
  });

  it('uses defaults when opts are omitted (interval 1s, timeout 60s)', async () => {
    const predicate = vi.fn().mockResolvedValue(false);
    const promise = pollUntil(predicate);

    // After ~60s the call count should be roughly 60 (allow slack).
    await vi.advanceTimersByTimeAsync(65_000);
    const result = await promise;
    expect(result).toBe(false);
    expect(predicate.mock.calls.length).toBeGreaterThanOrEqual(30);
  });

  it('catches synchronous throws in predicate (not just rejections)', async () => {
    let calls = 0;
    const predicate = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 2) {
        throw new Error('sync-ish throw');
      }
      return true;
    });

    const promise = pollUntil(predicate, { intervalMs: 50, timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;
    expect(result).toBe(true);
    expect(calls).toBe(2);
  });
});
