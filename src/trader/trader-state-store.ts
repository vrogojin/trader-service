/**
 * Trader state persistence — atomic file-backed store and null (no-op) store.
 *
 * Storage layout under baseDir:
 *   intents/<intent_id>.json   — one file per intent
 *   deals/<deal_id>.json       — one file per deal
 *   strategy.json              — strategy config
 *   reservations.json          — serialized VolumeReservationLedger
 */

import { readFile, mkdir, readdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import type {
  IntentRecord,
  IntentState,
  DealRecord,
  DealState,
  TraderStrategy,
} from './types.js';

// Re-import the const arrays for runtime validation
import {
  INTENT_STATES as INTENT_STATES_ARRAY,
  DEAL_STATES as DEAL_STATES_ARRAY,
  NP_MESSAGE_TYPES as NP_MESSAGE_TYPES_ARRAY,
} from './types.js';
import { hasDangerousKeys } from './utils.js';

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface TraderStateStore {
  // Intents
  saveIntent(record: IntentRecord): Promise<void>;
  loadIntent(intentId: string): Promise<IntentRecord | null>;
  loadIntents(filter?: { state?: IntentState | IntentState[] }): Promise<IntentRecord[]>;
  deleteIntent(intentId: string): Promise<void>;

  // Deals
  saveDeal(record: DealRecord): Promise<void>;
  loadDeal(dealId: string): Promise<DealRecord | null>;
  loadDeals(filter?: { state?: DealState | DealState[] }): Promise<DealRecord[]>;
  deleteDeal(dealId: string): Promise<void>;

  // Strategy
  saveStrategy(strategy: TraderStrategy): Promise<void>;
  loadStrategy(): Promise<TraderStrategy | null>;

  // Volume reservation ledger state
  saveReservations(serialized: string): Promise<void>;
  loadReservations(): Promise<string | null>;

  // Deposit-attempted ledger (spec 7.9.3): swapIds for which we have
  // ALREADY issued sphere.swap.deposit() at least once. Persisted BEFORE
  // the deposit() call, so a crash mid-deposit never causes a retry to
  // re-issue. Loaded at startup to seed the in-memory dedup set so the
  // swap:announced event replay doesn't double-deposit.
  saveDepositAttempted(swapIds: ReadonlyArray<string>): Promise<void>;
  loadDepositAttempted(): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Atomic write helper
// ---------------------------------------------------------------------------

async function atomicWrite(filePath: string, data: string): Promise<void> {
  const dir = filePath.substring(0, filePath.lastIndexOf('/'));
  await mkdir(dir, { recursive: true });
  const temp = `${filePath}.tmp.${randomBytes(4).toString('hex')}`;
  const fd = await open(temp, 'w');
  try {
    await fd.writeFile(data, 'utf-8');
    await fd.sync();
  } finally {
    await fd.close();
  }
  try {
    await rename(temp, filePath);
  } catch (err) {
    try { await unlink(temp); } catch { /* best effort */ }
    throw err;
  }
}

async function safeReadFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

async function safeDelete(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // ENOENT or other — ignore
  }
}

// ---------------------------------------------------------------------------
// JSON bigint serialization helpers
// ---------------------------------------------------------------------------

/**
 * JSON replacer that converts bigint values to tagged strings so they
 * survive a round-trip through JSON.stringify / JSON.parse.
 */
function bigintReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return `__bigint__${value.toString()}`;
  }
  return value;
}

/**
 * JSON reviver that restores tagged bigint strings back to bigint values.
 */
function bigintReviver(_key: string, value: unknown): unknown {
  if (typeof value === 'string' && value.startsWith('__bigint__')) {
    return BigInt(value.slice('__bigint__'.length));
  }
  return value;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isValidIntentState(s: unknown): s is IntentState {
  return typeof s === 'string' && (INTENT_STATES_ARRAY as readonly string[]).includes(s);
}

function isValidDealState(s: unknown): s is DealState {
  return typeof s === 'string' && (DEAL_STATES_ARRAY as readonly string[]).includes(s);
}

function validateIntentRecord(parsed: unknown): IntentRecord | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj['intent'] !== 'object' || obj['intent'] === null) return null;
  if (!isValidIntentState(obj['state'])) return null;
  if (!Array.isArray(obj['deal_ids'])) return null;
  if (typeof obj['updated_at'] !== 'number' || !Number.isFinite(obj['updated_at'])) return null;
  return parsed as IntentRecord;
}

/**
 * Round-19 F6: structural validation of a persisted counterparty_envelope.
 * Catches malformed envelopes at load time so they don't reach
 * hydrateDeal (where `verifyNpSignature` can throw on missing fields).
 * We deliberately keep this check loose (type/shape only) — the
 * cryptographic validation (signature verify, terms-hash match,
 * age/size bounds) remains in hydrateDeal where the agent keys live.
 */
function isValidNpEnvelopeShape(env: unknown): boolean {
  if (typeof env !== 'object' || env === null || Array.isArray(env)) return false;
  const obj = env as Record<string, unknown>;
  if (obj['np_version'] !== '0.1') return false;
  if (typeof obj['msg_id'] !== 'string') return false;
  if (typeof obj['deal_id'] !== 'string') return false;
  if (typeof obj['sender_pubkey'] !== 'string') return false;
  if (typeof obj['type'] !== 'string') return false;
  if (!(NP_MESSAGE_TYPES_ARRAY as readonly string[]).includes(obj['type'])) return false;
  if (typeof obj['ts_ms'] !== 'number' || !Number.isFinite(obj['ts_ms'])) return false;
  if (typeof obj['signature'] !== 'string') return false;
  if (typeof obj['payload'] !== 'object' || obj['payload'] === null || Array.isArray(obj['payload'])) return false;
  return true;
}

function validateDealRecord(parsed: unknown): DealRecord | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  // Round-21 F3: defense-in-depth scan of the ROOT object before any
  // field extraction. JSON.parse in ES2015+ does not install `__proto__`
  // as a prototype pointer when it appears as an object key, but future
  // code paths that spread-copy the parsed record (e.g. `{ ...parsed }`)
  // could still leak prototype pollution. Reject such records at load
  // time so they never reach the hydrate path — the attacker-with-
  // disk-write model covers this surface.
  if (hasDangerousKeys(obj)) return null;

  if (typeof obj['terms'] !== 'object' || obj['terms'] === null) return null;

  // Round-21 F3: scan the nested `terms` object too. A crafted record
  // that places `__proto__` / `constructor` / `prototype` inside terms
  // would bypass the root-level scan once callers re-wrap terms into a
  // new object.
  if (hasDangerousKeys(obj['terms'])) return null;

  if (!isValidDealState(obj['state'])) return null;
  if (typeof obj['updated_at'] !== 'number' || !Number.isFinite(obj['updated_at'])) return null;

  // Round-19 F6: validate the optional counterparty_envelope shape.
  // A malformed envelope previously slipped past this function and
  // surfaced as a runtime throw inside verifyNpSignature (e.g.,
  // signature field missing → canonicalJson walk still proceeds, but
  // the signature reference fails). Rejecting at load time forces the
  // record to be treated as invalid (filtered out by loadDeals); the
  // reconciliation path then handles it via the unhydrateable gate
  // rather than throwing. Also guard against dangerous prototype keys
  // embedded in the envelope payload — a disk-write attacker could
  // otherwise inject `__proto__` pollution through an otherwise
  // well-formed envelope.
  if (obj['counterparty_envelope'] !== undefined) {
    if (!isValidNpEnvelopeShape(obj['counterparty_envelope'])) return null;
    if (hasDangerousKeys(obj['counterparty_envelope'])) return null;
  }

  return parsed as DealRecord;
}

function validateStrategy(parsed: unknown): TraderStrategy | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj['auto_match'] !== 'boolean') return null;
  if (typeof obj['auto_negotiate'] !== 'boolean') return null;
  if (typeof obj['max_concurrent_swaps'] !== 'number') return null;
  if (typeof obj['max_active_intents'] !== 'number') return null;
  if (typeof obj['min_search_score'] !== 'number') return null;
  if (typeof obj['scan_interval_ms'] !== 'number') return null;
  if (typeof obj['market_api_url'] !== 'string') return null;
  if (!Array.isArray(obj['trusted_escrows'])) return null;
  if (!Array.isArray(obj['blocked_counterparties'])) return null;
  return parsed as TraderStrategy;
}

// ---------------------------------------------------------------------------
// Filesystem-backed store
// ---------------------------------------------------------------------------

export function createFsTraderStateStore(baseDir: string): TraderStateStore {
  const intentsDir = join(baseDir, 'intents');
  const dealsDir = join(baseDir, 'deals');
  const strategyPath = join(baseDir, 'strategy.json');
  const reservationsPath = join(baseDir, 'reservations.json');
  const depositAttemptedPath = join(baseDir, 'deposit-attempted.json');

  function intentPath(intentId: string): string {
    return join(intentsDir, `${intentId}.json`);
  }

  function dealPath(dealId: string): string {
    return join(dealsDir, `${dealId}.json`);
  }

  function matchesStateFilter<S extends string>(
    state: S,
    filter: S | S[] | undefined,
  ): boolean {
    if (filter === undefined) return true;
    if (Array.isArray(filter)) return filter.includes(state);
    return state === filter;
  }

  async function listJsonFiles(dir: string): Promise<string[]> {
    try {
      const entries = await readdir(dir);
      return entries.filter((e) => e.endsWith('.json'));
    } catch {
      return [];
    }
  }

  return {
    // ---- Intents ----

    async saveIntent(record: IntentRecord): Promise<void> {
      const data = JSON.stringify(record, bigintReplacer, 2);
      await atomicWrite(intentPath(record.intent.intent_id), data);
    },

    async loadIntent(intentId: string): Promise<IntentRecord | null> {
      const raw = await safeReadFile(intentPath(intentId));
      if (raw === null) return null;
      try {
        const parsed: unknown = JSON.parse(raw, bigintReviver);
        return validateIntentRecord(parsed);
      } catch {
        return null;
      }
    },

    async loadIntents(filter?: { state?: IntentState | IntentState[] }): Promise<IntentRecord[]> {
      const files = await listJsonFiles(intentsDir);
      const results: IntentRecord[] = [];
      for (const file of files) {
        const raw = await safeReadFile(join(intentsDir, file));
        if (raw === null) continue;
        try {
          const parsed: unknown = JSON.parse(raw, bigintReviver);
          const record = validateIntentRecord(parsed);
          if (record !== null && matchesStateFilter(record.state, filter?.state)) {
            results.push(record);
          }
        } catch {
          // skip corrupt files
        }
      }
      return results;
    },

    async deleteIntent(intentId: string): Promise<void> {
      await safeDelete(intentPath(intentId));
    },

    // ---- Deals ----

    async saveDeal(record: DealRecord): Promise<void> {
      const data = JSON.stringify(record, bigintReplacer, 2);
      await atomicWrite(dealPath(record.terms.deal_id), data);
    },

    async loadDeal(dealId: string): Promise<DealRecord | null> {
      const raw = await safeReadFile(dealPath(dealId));
      if (raw === null) return null;
      try {
        const parsed: unknown = JSON.parse(raw, bigintReviver);
        return validateDealRecord(parsed);
      } catch {
        return null;
      }
    },

    async loadDeals(filter?: { state?: DealState | DealState[] }): Promise<DealRecord[]> {
      const files = await listJsonFiles(dealsDir);
      const results: DealRecord[] = [];
      for (const file of files) {
        const raw = await safeReadFile(join(dealsDir, file));
        if (raw === null) continue;
        try {
          const parsed: unknown = JSON.parse(raw, bigintReviver);
          const record = validateDealRecord(parsed);
          if (record !== null && matchesStateFilter(record.state, filter?.state)) {
            results.push(record);
          }
        } catch {
          // skip corrupt files
        }
      }
      return results;
    },

    async deleteDeal(dealId: string): Promise<void> {
      await safeDelete(dealPath(dealId));
    },

    // ---- Strategy ----

    async saveStrategy(strategy: TraderStrategy): Promise<void> {
      const data = JSON.stringify(strategy, null, 2);
      await atomicWrite(strategyPath, data);
    },

    async loadStrategy(): Promise<TraderStrategy | null> {
      const raw = await safeReadFile(strategyPath);
      if (raw === null) return null;
      try {
        const parsed: unknown = JSON.parse(raw);
        return validateStrategy(parsed);
      } catch {
        return null;
      }
    },

    // ---- Reservations ----

    async saveReservations(serialized: string): Promise<void> {
      await atomicWrite(reservationsPath, serialized);
    },

    async loadReservations(): Promise<string | null> {
      return safeReadFile(reservationsPath);
    },

    async saveDepositAttempted(swapIds: ReadonlyArray<string>): Promise<void> {
      // De-dup the persisted list so the file doesn't grow without bound
      // (every crash + retry would otherwise append duplicates). Bounded
      // implicitly by the lifetime of the Set in main.ts (entries are
      // cleared on swap:completed/swap:failed/swap:cancelled in a future
      // pass; for now the file size grows with the trader's swap throughput
      // and is read once at startup — acceptable cost).
      const unique = Array.from(new Set(swapIds));
      await atomicWrite(depositAttemptedPath, JSON.stringify(unique));
    },

    async loadDepositAttempted(): Promise<string[]> {
      const raw = await safeReadFile(depositAttemptedPath);
      if (raw === null) return [];
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((s): s is string => typeof s === 'string');
      } catch {
        return [];
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Null (no-op) store
// ---------------------------------------------------------------------------

export function createNullTraderStateStore(): TraderStateStore {
  return {
    async saveIntent(_record: IntentRecord): Promise<void> { /* no-op */ },
    async loadIntent(_intentId: string): Promise<IntentRecord | null> { return null; },
    async loadIntents(_filter?: { state?: IntentState | IntentState[] }): Promise<IntentRecord[]> { return []; },
    async deleteIntent(_intentId: string): Promise<void> { /* no-op */ },

    async saveDeal(_record: DealRecord): Promise<void> { /* no-op */ },
    async loadDeal(_dealId: string): Promise<DealRecord | null> { return null; },
    async loadDeals(_filter?: { state?: DealState | DealState[] }): Promise<DealRecord[]> { return []; },
    async deleteDeal(_dealId: string): Promise<void> { /* no-op */ },

    async saveStrategy(_strategy: TraderStrategy): Promise<void> { /* no-op */ },
    async loadStrategy(): Promise<TraderStrategy | null> { return null; },

    async saveReservations(_serialized: string): Promise<void> { /* no-op */ },
    async loadReservations(): Promise<string | null> { return null; },

    async saveDepositAttempted(_swapIds: ReadonlyArray<string>): Promise<void> { /* no-op */ },
    async loadDepositAttempted(): Promise<string[]> { return []; },
  };
}
