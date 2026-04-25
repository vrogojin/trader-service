/**
 * Shared constants for live E2E tests.
 *
 * Timeouts are generous — real Nostr transport, Docker boot, and testnet
 * operations are slow. All URL constants point to testnet infrastructure.
 */

export const NETWORK = 'testnet';

export const TRUSTBASE_URL =
  'https://raw.githubusercontent.com/unicitynetwork/unicity-ids/refs/heads/main/bft-trustbase.testnet.json';

export { resolveApiKey } from '../../../src/shared/api-key.js';

export const FAUCET_URL = 'https://faucet.unicity.network/api/v1/faucet/request';

export const MARKET_API_URL = 'https://market-api.unicity.network';

export const POLL_INTERVAL_MS = 3_000;
export const HMCP_RESPONSE_TIMEOUT_MS = 30_000;
export const SPAWN_READY_TIMEOUT_MS = 120_000;
export const FAUCET_WAIT_MS = 120_000;
export const TRADE_OP_TIMEOUT_MS = 180_000;
export const RESET_TIMEOUT_MS = 30_000;
