/**
 * Testnet-wide invariants for the e2e-live test harness.
 *
 * URLs are pinned to public Unicity testnet endpoints; relay set is taken
 * from sphere-cli's integration helpers (which is the canonical source for
 * "what relay should test wallets use"). Timeouts are intentionally generous
 * because real Nostr transport, Docker boot, and testnet faucet/aggregator
 * round-trips are slow.
 *
 * All values are exported both as fields on the `TESTNET` aggregate and as
 * individual named constants so callers can pick whichever style is clearer.
 */

import type { TestnetConstants } from './contracts.js';

/** Default sphere-sdk relay set for testnet wallets. */
export const RELAYS: ReadonlyArray<string> = [
  'wss://nostr-relay.testnet.unicity.network',
];

/** Aggregator URL for proofs (matches sphere-cli's `PUBLIC_TESTNET.aggregator`). */
export const AGGREGATOR_URL = 'https://goggregator-test.unicity.network';

/** IPFS gateway for content addressing. */
export const IPFS_GATEWAY = 'https://unicity-ipfs1.dyndns.org';

/**
 * Testnet faucet endpoint. Cross-checked against escrow-service's
 * swap-lifecycle e2e suite — same canonical URL.
 */
export const FAUCET_URL = 'https://faucet.unicity.network/api/v1/faucet/request';

/** Default trader image (matches templates.json shortcut). */
export const TRADER_IMAGE = 'ghcr.io/vrogojin/agentic-hosting/trader:v0.2';

/** Default escrow image. */
export const ESCROW_IMAGE = 'ghcr.io/vrogojin/agentic-hosting/escrow:v0.1';

/** Per-test default timeout (slow because real-network). */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Max wait for a swap to terminal state — 10 minutes. Settlement on testnet
 * involves multiple aggregator round-trips, BFT consensus, and Nostr DMs;
 * 60s is not enough on a bad day.
 */
export const SWAP_TIMEOUT_MS = 600_000;

/**
 * Aggregate constant — implements the `TestnetConstants` contract from
 * `contracts.ts`. Tests can `import { TESTNET }` and grab everything in one go.
 */
export const TESTNET: TestnetConstants = {
  RELAYS,
  AGGREGATOR_URL,
  IPFS_GATEWAY,
  FAUCET_URL,
  TRADER_IMAGE,
  ESCROW_IMAGE,
  DEFAULT_TIMEOUT_MS,
  SWAP_TIMEOUT_MS,
};
