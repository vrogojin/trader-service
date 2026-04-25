/**
 * Mock SwapAdapter for Trader Agent unit tests.
 *
 * Matches the simplified SwapAdapter interface from swap-executor.ts:
 * proposeSwap, acceptSwap, rejectSwap.
 */

import type { SwapAdapter, SwapDealInput } from '../../src/trader/swap-executor.js';

// ---------------------------------------------------------------------------
// Mock
// ---------------------------------------------------------------------------

export type { SwapDealInput, SwapAdapter };

export interface MockSwapModule extends SwapAdapter {
  proposeSwapCalls: SwapDealInput[];
  acceptSwapCalls: string[];
  rejectSwapCalls: Array<{ swapId: string; reason?: string }>;
  /** Configure the swapId returned by proposeSwap */
  setSwapId(id: string): void;
}

export function createMockSwapModule(): MockSwapModule {
  let nextSwapId = 'mock-swap-1';

  const mock: MockSwapModule = {
    // -- Recorded calls --
    proposeSwapCalls: [],
    acceptSwapCalls: [],
    rejectSwapCalls: [],

    // -- Configuration helpers --
    setSwapId(id: string): void {
      nextSwapId = id;
    },

    // -- SwapAdapter implementation --
    async proposeSwap(input: SwapDealInput): Promise<{ swapId: string }> {
      mock.proposeSwapCalls.push(input);
      return { swapId: nextSwapId };
    },

    async acceptSwap(swapId: string): Promise<void> {
      mock.acceptSwapCalls.push(swapId);
    },

    async rejectSwap(swapId: string, reason?: string): Promise<void> {
      mock.rejectSwapCalls.push({ swapId, reason });
    },

    async deposit(): Promise<void> {
      // no-op in mock — SDK handles deposit internally
    },

    async verifyPayout(): Promise<boolean> {
      return true;
    },
  };

  return mock;
}
