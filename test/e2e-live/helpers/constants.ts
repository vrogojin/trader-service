/**
 * constants — STUB.
 *
 * Owns: testnet-wide invariants for e2e-live tests. The full set of values is
 * authored in a peer worktree and may differ; this stub provides defaults that
 * compile against `./contracts.ts:TestnetConstants` so the helpers that import
 * it can build. The integrator replaces the stub during merge.
 */

import type { TestnetConstants } from './contracts.js';

export const RELAYS: TestnetConstants['RELAYS'] = [
  'wss://nostr.unicity.network',
];

export const AGGREGATOR_URL: TestnetConstants['AGGREGATOR_URL'] =
  'https://gateway-test.unicity.network';

export const IPFS_GATEWAY: TestnetConstants['IPFS_GATEWAY'] =
  'https://ipfs.unicity.network';

export const FAUCET_URL: TestnetConstants['FAUCET_URL'] =
  'https://faucet-test.unicity.network';

export const TRADER_IMAGE: TestnetConstants['TRADER_IMAGE'] =
  'ghcr.io/vrogojin/agentic-hosting/trader:0.1';

export const ESCROW_IMAGE: TestnetConstants['ESCROW_IMAGE'] =
  'ghcr.io/vrogojin/agentic-hosting/escrow:0.1';

export const DEFAULT_TIMEOUT_MS: TestnetConstants['DEFAULT_TIMEOUT_MS'] = 60_000;

export const SWAP_TIMEOUT_MS: TestnetConstants['SWAP_TIMEOUT_MS'] = 180_000;
