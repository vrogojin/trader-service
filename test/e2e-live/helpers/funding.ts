/**
 * Testnet faucet integration — pure HTTP client, no host-manager primitives.
 *
 * The original agentic-hosting funding helper wrapped the faucet call in a
 * host-manager-side fixture (it would `sendCommand` to the tenant to poll
 * GET_PORTFOLIO until the balance arrived). That coupling does not belong in
 * trader-service: the faucet is just a REST endpoint, and balance-polling is
 * the caller's concern. So this module is reduced to a single `fundWallet`
 * that POSTs the request and returns the tx_id.
 *
 * Wire shape (preserved from the original):
 *   POST FAUCET_URL
 *   Content-Type: application/json
 *   { "unicityId": <addr>, "coin": <symbol>, "amount": <string> }
 *   → { "tx_id": "<hex>", ... }
 *
 * Retry policy: 3× exponential backoff on 5xx. 4xx fails immediately (those
 * indicate caller error — bad nametag, bad coin — and retrying won't help).
 */

import { FAUCET_URL } from './constants.js';
import type { FundWallet } from './contracts.js';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const INITIAL_BACKOFF_MS = 1_000;
const DEFAULT_COIN_ID = 'UCT';

interface FaucetResponseBody {
  tx_id?: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  // attempt is 1-indexed; first retry waits INITIAL_BACKOFF_MS, second 2x, etc.
  return INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
}

export const fundWallet: FundWallet = async (
  walletAddress,
  amount,
  coinId,
): Promise<{ tx_id: string }> => {
  const coin = coinId ?? DEFAULT_COIN_ID;
  // bigint isn't JSON-serializable; the original wire shape uses a string.
  const body = JSON.stringify({
    unicityId: walletAddress,
    coin,
    amount: amount.toString(),
  });

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await fetch(FAUCET_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // Network-level failure (DNS, refused, timeout) — treat like 5xx and retry.
      const msg = err instanceof Error ? err.message : String(err);
      lastError = new Error(`Faucet network error: ${msg}`);
      if (attempt === MAX_ATTEMPTS) break;
      await sleep(backoffMs(attempt));
      continue;
    }

    if (response.ok) {
      const text = await response.text();
      let parsed: FaucetResponseBody;
      try {
        parsed = JSON.parse(text) as FaucetResponseBody;
      } catch {
        throw new Error(
          `Faucet returned non-JSON success body: ${text.slice(0, 200)}`,
        );
      }
      const tx_id = parsed.tx_id;
      if (typeof tx_id !== 'string' || tx_id.length === 0) {
        throw new Error(
          `Faucet response missing tx_id: ${text.slice(0, 200)}`,
        );
      }
      return { tx_id };
    }

    // Non-OK: read body once for the error message.
    const errBody = await response.text().catch(() => '');
    const status = response.status;

    if (status >= 400 && status < 500) {
      // Client error — fast-fail, retrying won't help.
      throw new Error(`Faucet returned ${status}: ${errBody.slice(0, 200)}`);
    }

    // 5xx (or unexpected status) — retry with backoff.
    lastError = new Error(`Faucet returned ${status}: ${errBody.slice(0, 200)}`);
    if (attempt === MAX_ATTEMPTS) break;
    await sleep(backoffMs(attempt));
  }

  throw lastError ?? new Error('Faucet request failed after retries');
};
