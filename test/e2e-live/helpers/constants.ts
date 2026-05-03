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

/**
 * Testnet Market API endpoint — the intent database that traders post to
 * and search against for counterparty discovery. Pinned here (rather than
 * relying on the trader image's hard-coded default) so that:
 *   1. Tests can assert which Market API is being exercised, and
 *   2. The infra-probe preflight gate verifies this exact endpoint.
 *
 * Matches `@unicitylabs/sphere-sdk` constants `DEFAULT_MARKET_API_URL`.
 */
export const MARKET_API_URL = 'https://market-api.unicity.network';

/**
 * Canonical CoinId bytes from the public testnet registry
 * (https://raw.githubusercontent.com/unicitynetwork/unicity-ids/refs/heads/main/unicity-ids.testnet.json).
 *
 * Used by selfMintFund to mint tokens the trader recognizes as
 * UCT/USDU via TokenRegistry resolution. There is no cryptographic
 * restriction on which key issues these CoinId bytes — anyone can
 * mint a token with these exact bytes via state-transition-sdk.
 */
export const UCT_COIN_ID = '455ad8720656b08e8dbd5bac1f3c73eeea5431565f6c1c3af742b1aa12d41d89';
export const USDU_COIN_ID = '8f0f3d7a5e7297be0ee98c63b81bcebb2740f43f616566fc290f9823a54f52d7';

/** Default trader image (matches templates.json shortcut). */
export const TRADER_IMAGE = 'ghcr.io/vrogojin/agentic-hosting/trader:v0.2';

/** Default escrow image. */
export const ESCROW_IMAGE = 'ghcr.io/vrogojin/agentic-hosting/escrow:v0.1';

/** Per-test default timeout (slow because real-network). */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Max wait for a swap to terminal state — 25 minutes. Settlement on testnet
 * involves multiple aggregator round-trips, BFT consensus, and Nostr DMs;
 * 60s is not enough on a bad day. 2026-04-30 observation: with the
 * dedup-miss + EXECUTION_TIMEOUT + deposit-retry fixes in place, the
 * end-to-end swap completes — but the trader's verifyPayout retry loop
 * (40 × 30s = 20 min on testnet) needs the test budget to exceed it
 * with margin for provisioning + negotiation overhead.
 */
export const SWAP_TIMEOUT_MS = 1_500_000;

/**
 * Aggregate constant — implements the `TestnetConstants` contract from
 * `contracts.ts`. Tests can `import { TESTNET }` and grab everything in one go.
 */
export const TESTNET: TestnetConstants = {
  RELAYS,
  AGGREGATOR_URL,
  IPFS_GATEWAY,
  FAUCET_URL,
  MARKET_API_URL,
  TRADER_IMAGE,
  ESCROW_IMAGE,
  DEFAULT_TIMEOUT_MS,
  SWAP_TIMEOUT_MS,
};
