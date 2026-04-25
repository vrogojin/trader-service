/**
 * Faucet funding helpers for live E2E tests.
 *
 * Uses the real Unicity testnet faucet to fund agent wallets.
 */

import type { LiveTestEnvironment, SpawnedAgent } from './environment.js';
import { sendCommand } from './agent-helpers.js';
import { FAUCET_URL } from './constants.js';

const FAUCET_MAX_RETRIES = 10;
const FAUCET_INITIAL_BACKOFF_MS = 2_000;
const FAUCET_MAX_BACKOFF_MS = 30_000;
const PORTFOLIO_POLL_INTERVAL_MS = 3_000;
const PORTFOLIO_POLL_TIMEOUT_MS = 120_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// requestFaucet
// ---------------------------------------------------------------------------

/**
 * Request tokens from the testnet faucet.
 *
 * @param unicityId - Registered nametag (without @) of the recipient.
 * @param coin      - Faucet coin name (e.g. 'unicity', 'unicity-usd', 'ethereum').
 * @param amount    - Number of whole tokens to request.
 */
export async function requestFaucet(
  unicityId: string,
  coin: string,
  amount: number,
): Promise<void> {
  if (!unicityId) {
    throw new Error('Cannot fund wallet: no nametag (unicityId) available');
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < FAUCET_MAX_RETRIES; attempt++) {
    let response: Response;
    try {
      response = await fetch(FAUCET_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unicityId, coin, amount }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err: unknown) {
      // Network errors (DNS, connection refused, timeout)
      const msg = err instanceof Error ? err.message : String(err);
      const backoff = Math.min(FAUCET_INITIAL_BACKOFF_MS * Math.pow(2, attempt), FAUCET_MAX_BACKOFF_MS);
      console.log(
        `[requestFaucet] network error (${msg}), retrying in ${backoff}ms (attempt ${attempt + 1}/${FAUCET_MAX_RETRIES})`,
      );
      lastError = new Error(`Faucet network error: ${msg}`);
      await sleep(backoff);
      continue;
    }

    if (response.ok) {
      return;
    }

    const body = await response.text().catch(() => '(no body)');

    // Retry on: rate limits (429), nametag-not-found (400), server errors (5xx)
    const isRetryable =
      response.status === 429 ||
      (response.status === 400 && body.includes('Nametag not found')) ||
      response.status >= 500;
    if (isRetryable) {
      const backoff = Math.min(FAUCET_INITIAL_BACKOFF_MS * Math.pow(2, attempt), FAUCET_MAX_BACKOFF_MS);
      const reason =
        response.status === 429 ? 'rate limited' :
        response.status >= 500 ? 'server error' : 'nametag not found';
      console.log(
        `[requestFaucet] ${reason} (${response.status}), retrying in ${Math.round(backoff / 1000)}s (attempt ${attempt + 1}/${FAUCET_MAX_RETRIES})`,
      );
      lastError = new Error(`Faucet ${reason}: HTTP ${response.status} — ${body}`);
      await sleep(backoff);
      continue;
    }

    throw new Error(`Faucet request failed: HTTP ${response.status} — ${body}`);
  }

  throw lastError ?? new Error('Faucet request failed after retries');
}

// ---------------------------------------------------------------------------
// fundWallet
// ---------------------------------------------------------------------------

/**
 * Fund an agent's wallet via the testnet faucet.
 *
 * For trader agents: polls GET_PORTFOLIO until the balance appears.
 * For base tenants: waits a fixed duration for Nostr delivery.
 *
 * @param env         - Live test environment (for sending commands).
 * @param agent       - The spawned agent to fund.
 * @param coin        - Faucet coin name (e.g. 'unicity', 'ethereum').
 * @param amount      - Number of whole tokens to request.
 * @param coinSymbol  - Expected symbol in GET_PORTFOLIO (e.g. 'UCT', 'ETH').
 *                      If provided, polls GET_PORTFOLIO for confirmation.
 */
export async function fundWallet(
  env: LiveTestEnvironment,
  agent: SpawnedAgent,
  coin: string,
  amount: number,
  coinSymbol?: string,
): Promise<void> {
  const recipient = agent.tenantNametag ?? '';
  if (!recipient) {
    throw new Error(
      `Cannot fund ${agent.instanceName}: no nametag available. ` +
      `Ensure the tenant registers a nametag during Sphere.init().`,
    );
  }

  console.log(
    `[fundWallet] Requesting ${amount} ${coin} for ${agent.instanceName} (@${recipient})`,
  );
  await requestFaucet(recipient, coin, amount);

  if (coinSymbol) {
    // Poll GET_PORTFOLIO until the balance appears
    console.log(
      `[fundWallet] Polling GET_PORTFOLIO for ${coinSymbol} on ${agent.instanceName}...`,
    );
    const deadline = Date.now() + PORTFOLIO_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const result = await sendCommand(env, agent.instanceName, 'GET_PORTFOLIO', {}, 10_000);
        const balances = result['balances'] as Array<Record<string, unknown>> | undefined;
        if (balances) {
          const found = balances.find(
            (b) => b['asset'] === coinSymbol || b['symbol'] === coinSymbol,
          );
          if (found) {
            const total = found['total'] ?? found['totalAmount'] ?? '0';
            if (BigInt(String(total)) > 0n) {
              console.log(`[fundWallet] ${agent.instanceName} received ${coinSymbol}: ${total}`);
              return;
            }
          }
        }
      } catch {
        // GET_PORTFOLIO may fail transiently or not be supported
      }
      await sleep(PORTFOLIO_POLL_INTERVAL_MS);
    }
    console.warn(
      `[fundWallet] ${agent.instanceName} did not confirm ${coinSymbol} balance within timeout — proceeding anyway`,
    );
  }
  // No sleep when coinSymbol is not provided — caller handles batch delivery wait
}
