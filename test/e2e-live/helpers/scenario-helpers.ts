/**
 * scenario-helpers — reusable building blocks for e2e-live test scenarios.
 *
 * Owns:
 *   - createMatchingIntents(buyer, seller, terms): post a buy + sell with
 *     overlapping rate ranges so both intents match on the market.
 *   - waitForDealInState(tenant, state, timeoutMs?): poll list-deals until a
 *     deal in `state` shows up.
 *
 * These primitives intentionally don't try to be exhaustive — individual test
 * files are free to compose lower-level trader-ctl calls when they need a
 * variant. They exist to remove the "two intents → matched" boilerplate from
 * every test that runs the happy path.
 */

import type {
  ProvisionedTenant,
  MatchingIntents,
  TraderCtlResult,
} from './contracts.js';
import { runTraderCtl } from './trader-ctl-driver.js';
import { pollUntil } from './polling.js';
import { SWAP_TIMEOUT_MS } from './constants.js';

const DEAL_POLL_INTERVAL_MS = 2_000;
const CREATE_INTENT_TIMEOUT_MS = 30_000;
const LIST_DEALS_TIMEOUT_MS = 10_000;

interface MatchingIntentsTerms {
  base_asset: string;
  quote_asset: string;
  rate_min: bigint;
  rate_max: bigint;
  volume_min: bigint;
  volume_total: bigint;
}

/**
 * Build the create-intent argv shared by buyer / seller. Direction differs;
 * everything else is symmetric.
 */
function createIntentArgv(
  direction: 'buy' | 'sell',
  terms: MatchingIntentsTerms,
): ReadonlyArray<string> {
  return [
    '--direction', direction,
    '--base', terms.base_asset,
    '--quote', terms.quote_asset,
    '--rate-min', terms.rate_min.toString(),
    '--rate-max', terms.rate_max.toString(),
    '--volume-min', terms.volume_min.toString(),
    '--volume-total', terms.volume_total.toString(),
  ];
}

/**
 * Extract the intent_id from a trader-ctl JSON response. The CLI emits the
 * AcpResultPayload's `result` field on success, which (for CREATE_INTENT) is
 * shaped `{ ok: true, intent_id, ... }`. Throws on non-ok responses or
 * malformed bodies — these are unrecoverable test setup failures.
 */
function parseIntentId(result: TraderCtlResult, role: 'buyer' | 'seller'): string {
  if (result.exitCode !== 0) {
    throw new Error(
      `createMatchingIntents: ${role} CREATE_INTENT failed with exit ${result.exitCode}: ${result.stderr}`,
    );
  }
  const out = result.output;
  if (!isPlainObject(out)) {
    throw new Error(
      `createMatchingIntents: ${role} CREATE_INTENT returned non-object output: ${JSON.stringify(out)}`,
    );
  }
  // Two possible shapes depending on whether the driver returns the full
  // AcpResultPayload envelope or unwraps the `result` field. Tolerate both.
  const candidate = isPlainObject(out['result']) ? (out['result'] as Record<string, unknown>) : out;

  // ok flag — accept undefined as "ok:true is implied if intent_id present"
  // because the driver may already have unwrapped the envelope.
  if (candidate['ok'] === false) {
    const message = typeof candidate['message'] === 'string' ? candidate['message'] : 'unknown error';
    throw new Error(`createMatchingIntents: ${role} CREATE_INTENT not ok: ${message}`);
  }
  const intentId = candidate['intent_id'];
  if (typeof intentId !== 'string' || intentId === '') {
    throw new Error(
      `createMatchingIntents: ${role} CREATE_INTENT response missing intent_id: ${JSON.stringify(candidate)}`,
    );
  }
  return intentId;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Submit a buy-side intent on `buyer` and a sell-side intent on `seller` with
 * matching terms. Asserts both responses are ok and returns their intent_ids.
 *
 * The asymmetry is intentional: the trader's intent engine matches buys
 * against sells on the same (base, quote) pair when their rate ranges overlap.
 */
export async function createMatchingIntents(
  buyer: ProvisionedTenant,
  seller: ProvisionedTenant,
  terms: MatchingIntentsTerms,
): Promise<MatchingIntents> {
  const buyerArgv = createIntentArgv('buy', terms);
  const sellerArgv = createIntentArgv('sell', terms);

  // Sequential, not Promise.all — we want clear sequencing of the two CLI
  // subprocesses. A failure on the first lets us skip the second cleanly,
  // and the failure messages are simpler to read in test logs.
  const buyerResult = await runTraderCtl('create-intent', buyerArgv, {
    tenant: buyer.address,
    timeoutMs: CREATE_INTENT_TIMEOUT_MS,
    json: true,
  });
  const buyerIntentId = parseIntentId(buyerResult, 'buyer');

  const sellerResult = await runTraderCtl('create-intent', sellerArgv, {
    tenant: seller.address,
    timeoutMs: CREATE_INTENT_TIMEOUT_MS,
    json: true,
  });
  const sellerIntentId = parseIntentId(sellerResult, 'seller');

  return { buyerIntentId, sellerIntentId };
}

type DealState = 'PROPOSED' | 'ACCEPTED' | 'EXECUTING' | 'COMPLETED' | 'FAILED';

/**
 * Inspect `output` and return the first deal whose `state` matches. Tolerates
 * both `{deals: [...]}` and bare-array shapes — the trader-ctl `list-deals`
 * format isn't stamped down yet.
 */
function extractDealsArray(output: unknown): ReadonlyArray<Record<string, unknown>> {
  if (Array.isArray(output)) {
    return output.filter(isPlainObject) as ReadonlyArray<Record<string, unknown>>;
  }
  if (isPlainObject(output)) {
    const inner = output['deals'] ?? output['result'];
    if (Array.isArray(inner)) {
      return inner.filter(isPlainObject) as ReadonlyArray<Record<string, unknown>>;
    }
    if (isPlainObject(inner)) {
      const innerDeals = (inner as Record<string, unknown>)['deals'];
      if (Array.isArray(innerDeals)) {
        return innerDeals.filter(isPlainObject) as ReadonlyArray<Record<string, unknown>>;
      }
    }
  }
  return [];
}

/**
 * Poll trader-ctl `list-deals --json` every 2s until a deal with the given
 * `state` appears, or `timeoutMs` elapses. Returns the matching deal record.
 *
 * Throws on timeout — silent timeout would cascade into a confusing
 * downstream assertion failure on a non-existent deal.
 */
export async function waitForDealInState(
  tenant: ProvisionedTenant,
  state: DealState,
  timeoutMs: number = SWAP_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  let lastMatched: Record<string, unknown> | null = null;

  const found = await pollUntil(
    async () => {
      const result = await runTraderCtl('list-deals', [], {
        tenant: tenant.address,
        timeoutMs: LIST_DEALS_TIMEOUT_MS,
        json: true,
      });
      if (result.exitCode !== 0) return false;
      const deals = extractDealsArray(result.output);
      const matched = deals.find((deal) => deal['state'] === state);
      if (matched !== undefined) {
        lastMatched = matched;
        return true;
      }
      return false;
    },
    {
      timeoutMs,
      intervalMs: DEAL_POLL_INTERVAL_MS,
      description: `deal in state ${state}`,
    },
  );

  if (!found || lastMatched === null) {
    throw new Error(
      `waitForDealInState: no deal reached ${state} on tenant ${tenant.address} within ${timeoutMs}ms`,
    );
  }
  return lastMatched;
}
