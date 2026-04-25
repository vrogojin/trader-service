/**
 * Trader Agent Template — public API barrel export.
 *
 * Re-exports all public types, interfaces, and factory functions
 * that downstream consumers need to wire and run a trader agent.
 */

// Domain types and state machines
export * from './types.js';

// ACP command parameter and result types
export * from './acp-types.js';

// Core components
export { createIntentEngine } from './intent-engine.js';
export type { IntentEngine, IntentEngineDeps } from './intent-engine.js';

export { createNegotiationHandler } from './negotiation-handler.js';
export type { NegotiationHandler, NegotiationHandlerDeps } from './negotiation-handler.js';

export { createSwapExecutor, buildSwapDealInput } from './swap-executor.js';
export type { SwapExecutor, SwapExecutorDeps, SwapAdapter, SwapDealInput } from './swap-executor.js';

export { createVolumeReservationLedger, loadVolumeReservationLedger } from './volume-reservation-ledger.js';
export type { VolumeReservationLedger } from './volume-reservation-ledger.js';

export { createFsTraderStateStore, createNullTraderStateStore } from './trader-state-store.js';
export type { TraderStateStore } from './trader-state-store.js';

export { createTraderCommandHandler } from './trader-command-handler.js';
export type { TraderCommandHandlerDeps } from './trader-command-handler.js';

// Entry point
export { createTraderAgent } from './trader-main.js';
export type { TraderAgent, TraderMainDeps } from './trader-main.js';

// Utilities
export {
  computeIntentId,
  encodeDescription,
  parseDescription,
  canonicalJson,
  validateIntentParams,
  validateDealTerms,
} from './utils.js';
