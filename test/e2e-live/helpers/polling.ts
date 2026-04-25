/**
 * Polling helpers for live E2E tests — wait for swap completion,
 * intent state transitions, and trader resets between tests.
 */

import { expect } from 'vitest';
import { sendCommand } from './agent-helpers.js';
import type { LiveTestEnvironment } from './environment.js';
import { DEFAULT_STRATEGY } from '../../../src/trader/types.js';
import {
  POLL_INTERVAL_MS,
  TRADE_OP_TIMEOUT_MS,
  RESET_TIMEOUT_MS,
} from './constants.js';

// ---------------------------------------------------------------------------
// sleep helper
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// waitForSwapComplete
// ---------------------------------------------------------------------------

/**
 * Poll LIST_SWAPS on the given instance until at least one swap reaches
 * COMPLETED state, or until timeout.
 *
 * Returns the first completed swap's summary.
 */
export async function waitForSwapComplete(
  env: LiveTestEnvironment,
  instanceName: string,
  timeoutMs: number = TRADE_OP_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await sendCommand(env, instanceName, 'LIST_SWAPS', {
      filter: 'completed',
    });
    const deals = result['deals'] as Array<Record<string, unknown>> | undefined;
    if (deals && deals.length > 0) {
      return deals[0]!;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `No completed swap found for ${instanceName} within ${timeoutMs}ms`,
  );
}

// ---------------------------------------------------------------------------
// waitForIntentState
// ---------------------------------------------------------------------------

/**
 * Poll LIST_INTENTS on the given instance until the specified intent
 * reaches the expected state, or until timeout.
 */
export async function waitForIntentState(
  env: LiveTestEnvironment,
  instanceName: string,
  intentId: string,
  state: string,
  timeoutMs: number = TRADE_OP_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await sendCommand(env, instanceName, 'LIST_INTENTS', {
      filter: 'all',
    });
    const intents = result['intents'] as Array<Record<string, unknown>> | undefined;
    if (intents) {
      const match = intents.find((i) => i['intent_id'] === intentId);
      if (match && match['state'] === state) {
        return;
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `Intent ${intentId} on ${instanceName} did not reach state ${state} within ${timeoutMs}ms`,
  );
}

// ---------------------------------------------------------------------------
// resetTrader
// ---------------------------------------------------------------------------

/**
 * Reset a trader agent to a clean state between tests:
 * 1. Cancel all active intents.
 * 2. Reset strategy to defaults.
 * 3. Wait for pending_swaps to drain.
 * 4. Verify clean state (0 active intents, 0 pending swaps).
 *
 * Advisory note: pending_swaps may take a few seconds to drain after
 * intent cancellation, so we poll STATUS in a loop.
 */
export async function resetTrader(
  env: LiveTestEnvironment,
  instanceName: string,
): Promise<void> {
  // Step 1: Cancel all active intents
  const intentResult = await sendCommand(env, instanceName, 'LIST_INTENTS', {
    filter: 'active',
  });
  const intents = intentResult['intents'] as Array<Record<string, unknown>> | undefined;
  if (intents) {
    for (const intent of intents) {
      await sendCommand(env, instanceName, 'CANCEL_INTENT', {
        intent_id: intent['intent_id'],
      });
    }
  }

  // Step 2: Reset strategy to defaults
  await sendCommand(env, instanceName, 'SET_STRATEGY', DEFAULT_STRATEGY as unknown as Record<string, unknown>);

  // Step 3: Wait for pending_swaps to drain
  const deadline = Date.now() + RESET_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await sendCommand(env, instanceName, 'STATUS');
    const activeIntents = status['active_intents'] as number | undefined;
    const pendingSwaps = status['pending_swaps'] as number | undefined;

    if ((activeIntents === 0 || activeIntents === undefined) &&
        (pendingSwaps === 0 || pendingSwaps === undefined)) {
      // Step 4: Final verification
      expect(activeIntents ?? 0).toBe(0);
      expect(pendingSwaps ?? 0).toBe(0);
      return;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `Failed to reset trader ${instanceName} within ${RESET_TIMEOUT_MS}ms — active state did not drain`,
  );
}
