/**
 * Generic wait-for-condition utility for e2e-live tests.
 *
 * Calls `predicate` every `intervalMs` until it returns true or `timeoutMs`
 * elapses. Returns true on success, false on timeout — never throws. The
 * caller decides what to do with a timeout (some tests want assertions,
 * others want graceful fall-throughs).
 *
 * Predicate exceptions are CAUGHT and treated as "not yet" (the most common
 * cause is a transient network error against testnet infra). Set DEBUG=1 to
 * log them so you can tell a flaky relay apart from a stuck condition.
 */

import type { PollUntil } from './contracts.js';

const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function debugLog(message: string): void {
  if (process.env['DEBUG']) {
    console.debug(`[pollUntil] ${message}`);
  }
}

export const pollUntil: PollUntil = async (
  predicate,
  opts,
): Promise<boolean> => {
  const intervalMs = opts?.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const description = opts?.description;
  const tag = description ? `[${description}] ` : '';

  const deadline = Date.now() + timeoutMs;

  // Loop forever until timeout — note we run the predicate first, THEN sleep,
  // so a fast condition resolves without waiting an interval.
  while (true) {
    let result: boolean;
    try {
      result = await predicate();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      debugLog(`${tag}predicate threw, treating as not-yet: ${msg}`);
      result = false;
    }

    if (result) {
      debugLog(`${tag}predicate satisfied`);
      return true;
    }

    if (Date.now() + intervalMs > deadline) {
      // Next sleep would push us past the deadline — give up now.
      debugLog(`${tag}timeout after ${timeoutMs}ms`);
      return false;
    }

    await sleep(intervalMs);
  }
};
