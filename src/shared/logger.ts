/**
 * JSON Lines logger with injectable writer, child loggers, sensitive field
 * sanitization, and per-event rate limiting to prevent log-pipeline DoS via
 * attacker-triggerable events (replay rejections, rate-limit warnings, queue
 * saturation — all of which an authenticated-but-hostile peer can emit at
 * high rate).
 */

import type { LogLevel } from './types.js';
import { LOG_LEVEL_PRIORITY } from './types.js';

export interface LogEntry {
  readonly ts: string;
  readonly level: string;
  readonly component: string;
  readonly instance_id?: string;
  readonly instance_name?: string;
  readonly event: string;
  readonly details?: Record<string, unknown>;
}

export type LogWriter = (line: string) => void;

const SENSITIVE_KEYS = new Set([
  'boot_token',
  'mnemonic',
  'private_key',
  'privateKey',
  'nsec',
  'secret',
  'password',
]);

/**
 * High-confidence regex patterns matched against string values to catch
 * secrets that slip past the key-name check — e.g., an Error whose `.message`
 * string embeds an API key verbatim.
 *
 * Each pattern here MUST have very low false-positive rate. Adding a loose
 * pattern silently mangles legitimate log lines; keep these specific and
 * anchored to shapes that are essentially never legitimate plaintext.
 *
 * Round-25 F1 (CRITICAL regression fix): round-24 added three dangerous
 * false-positive generators — /\b[0-9a-f]{64}\b/ (matches deal_ids,
 * x-only pubkeys, content_hashes, SHA-256 digests — destroying observability
 * anywhere the trader logs senderPubkey) and two lowercase-word-run patterns
 * that ate any English log narrative of 12+/24+ words. Removed. Secret
 * detection for mnemonics / private keys / boot tokens is handled by the
 * key-name redaction in SENSITIVE_KEYS; value-level scrubbing only runs
 * against UNAMBIGUOUS shape patterns.
 *
 * Patterns kept:
 *   - `sk_<32 hex>` anchored at a word boundary on BOTH ends so a longer hex
 *     tail (`sk_abc...def` + `0123456789abcdef0`) can't leave a suffix
 *     un-redacted. The `\b` right anchor is the round-25 fix; without it,
 *     `sk_<33hex>` leaked the 33rd nibble.
 *   - `nsec1<58 bech32 chars>` — Nostr private keys. The original pattern
 *     used `[0-9a-z]` which overmatched: bech32 excludes `b`, `i`, `o`, `1`
 *     (well, the prefix `1` is special). Narrowed to the actual bech32
 *     charset so legitimate prose containing e.g. "nsec1 is cool" can't
 *     trip this.
 */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bsk_[0-9a-f]{32}\b/gi,                                       // Unicity API keys
  /nsec1[023456789acdefghjklmnpqrstuvwxyz]{58}/gi,               // Nostr secrets (bech32)
];

/**
 * Second-pass value scrub for string values. Runs AFTER the key-name check,
 * so { boot_token: 'deadbeef...' } is still redacted to '[REDACTED]' by the
 * key-name rule — this function only touches values that were already allowed
 * through. Non-string values pass through untouched.
 */
function scrubSecretValues(value: unknown): unknown {
  if (typeof value === 'string') {
    let scrubbed = value;
    for (const pattern of SECRET_VALUE_PATTERNS) {
      scrubbed = scrubbed.replace(pattern, '[REDACTED]');
    }
    return scrubbed;
  }
  return value;
}

const MAX_SANITIZE_DEPTH = 10;

function sanitizeValue(key: string, value: unknown, depth: number): unknown {
  if (depth > MAX_SANITIZE_DEPTH) return '[TOO_DEEP]';
  if (SENSITIVE_KEYS.has(key)) {
    return '[REDACTED]';
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => sanitizeValue(String(i), item, depth + 1));
  }
  if (typeof value === 'object' && value !== null) {
    return sanitizeObject(value as Record<string, unknown>, depth + 1);
  }
  // Second pass: apply value-level secret scrubbing to strings that slipped
  // past the key-name check (e.g. secrets embedded inside Error .message
  // strings, raw hex dumps passed under innocuous keys).
  return scrubSecretValues(value);
}

function sanitizeObject(obj: Record<string, unknown>, depth = 0): Record<string, unknown> {
  if (depth > MAX_SANITIZE_DEPTH) return { _truncated: '[TOO_DEEP]' };
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = sanitizeValue(key, value, depth);
  }
  return result;
}

export interface Logger {
  debug(event: string, details?: Record<string, unknown>): void;
  info(event: string, details?: Record<string, unknown>): void;
  warn(event: string, details?: Record<string, unknown>): void;
  error(event: string, details?: Record<string, unknown>): void;
  child(fields: { component?: string; instance_id?: string; instance_name?: string }): Logger;
  setLevel(level: LogLevel): void;
}

/**
 * Token-bucket rate limiter state, keyed by event name. Shared across all
 * child loggers created from a root — so "hmcp_replay_rejected" emitted from
 * the main logger and from a child for the same event share the bucket.
 */
interface BucketState {
  tokens: number;      // Remaining tokens in this window
  lastRefillMs: number; // Monotonic ms of last refill
  dropped: number;     // Events dropped since last successful emit
}

/**
 * Default rate-limit: 60 events per 60 seconds per (event-name) with a full
 * burst of 60. An attacker flooding an authenticated-peer event (replay,
 * rate-limit, queue-saturation) can emit at most 60 matching log lines per
 * minute regardless of volume. On a drop, the count is preserved and emitted
 * as `log_rate_limited` when the next token is available.
 */
const DEFAULT_BUCKET_CAPACITY = 60;
const DEFAULT_REFILL_WINDOW_MS = 60_000;

function monoNowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

/**
 * JSON.stringify that tolerates shared-or-circular references and BigInt values.
 * Shared/circular refs become "[shared-or-circular]"; BigInts become decimal
 * strings. Prevents the logger from silently dropping log lines when details
 * carry shared/self-referential objects or BigInt payloads.
 *
 * Limitation: JSON.stringify's replacer API is called top-down and can't
 * distinguish "re-used sibling" from "true cycle" — a WeakSet of visited nodes
 * necessarily marks the second occurrence of any shared object as a circle,
 * even when it's an ordinary DAG. The marker name reflects this: a replacement
 * means "we've seen this node before," not specifically "there is a cycle."
 * A proper recursive walker with an ancestor stack could distinguish the two,
 * but for logs this approximation is acceptable — logs are diagnostic, not
 * round-trippable, and the value is labeled rather than silently omitted.
 *
 * BigInt is serialized as a decimal string because JSON has no bigint type.
 * Downstream log consumers rely on this format; do not change it.
 */
function safeStringify(obj: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(obj, (_key, value) => {
    // bigint serialized as decimal string (JSON has no bigint type)
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value as object)) return '[shared-or-circular]';
      seen.add(value as object);
    }
    return value;
  });
}

export interface CreateLoggerOptions {
  component: string;
  writer?: LogWriter;
  level?: LogLevel;
  instance_id?: string;
  instance_name?: string;
  /** Internal — shared across child loggers. Do not pass from user code. */
  _sharedBuckets?: Map<string, BucketState>;
  /** Internal — events exempt from rate limiting (e.g. operator events). */
  _rateLimitExempt?: Set<string>;
  /** Bucket capacity per event (default 60). */
  rate_limit_capacity?: number;
  /** Refill window in ms (default 60_000). */
  rate_limit_window_ms?: number;
}

export function createLogger(opts: CreateLoggerOptions): Logger {
  const writer: LogWriter = opts.writer ?? ((line: string) => process.stdout.write(line + '\n'));
  let currentLevel: LogLevel = opts.level ?? 'info';
  const component = opts.component;
  const instanceId = opts.instance_id;
  const instanceName = opts.instance_name;
  const buckets = opts._sharedBuckets ?? new Map<string, BucketState>();
  const exempt = opts._rateLimitExempt ?? new Set<string>();
  const capacity = opts.rate_limit_capacity ?? DEFAULT_BUCKET_CAPACITY;
  const windowMs = opts.rate_limit_window_ms ?? DEFAULT_REFILL_WINDOW_MS;
  // Validate: capacity=0 or negative silences all events including the rate-limit
  // sidecar; windowMs=0 divides by zero (Infinity refill = never drops); negative
  // windowMs inverts the sign so tokens drain to -Infinity and events stay silenced.
  // All three are operator misconfigurations — fail loudly at construction.
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new Error(`Logger rate_limit_capacity must be a positive integer, got: ${capacity}`);
  }
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error(`Logger rate_limit_window_ms must be a positive finite number, got: ${windowMs}`);
  }
  const refillPerMs = capacity / windowMs;

  function shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[currentLevel];
  }

  /**
   * Consume one token for `event`. Returns:
   *   - { allowed: true, dropped: N }  — emit the log; if N > 0 also emit a sidecar
   *   - { allowed: false }             — silently drop, increment counter
   *
   * Exempt events always return { allowed: true, dropped: 0 }.
   */
  function takeToken(event: string): { allowed: boolean; dropped: number } {
    if (exempt.has(event)) return { allowed: true, dropped: 0 };

    const now = monoNowMs();
    let state = buckets.get(event);
    if (!state) {
      state = { tokens: capacity, lastRefillMs: now, dropped: 0 };
      buckets.set(event, state);
    } else {
      // Refill fractional tokens based on elapsed time, capped at capacity.
      const elapsed = Math.max(0, now - state.lastRefillMs);
      state.tokens = Math.min(capacity, state.tokens + elapsed * refillPerMs);
      state.lastRefillMs = now;
    }

    if (state.tokens >= 1) {
      state.tokens -= 1;
      const dropped = state.dropped;
      state.dropped = 0;
      return { allowed: true, dropped };
    }
    state.dropped += 1;
    return { allowed: false, dropped: 0 };
  }

  function emit(entry: LogEntry): void {
    try {
      writer(safeStringify(entry));
    } catch {
      try { process.stderr.write(`LOGGER_ERROR: ${entry.event}\n`); } catch { /* give up */ }
    }
  }

  function log(level: LogLevel, event: string, details?: Record<string, unknown>): void {
    if (!shouldLog(level)) return;

    const { allowed, dropped } = takeToken(event);
    if (!allowed) return;

    try {
      const entry: LogEntry = {
        ts: new Date().toISOString(),
        level: level.toUpperCase(),
        component,
        ...(instanceId !== undefined && { instance_id: instanceId }),
        ...(instanceName !== undefined && { instance_name: instanceName }),
        event,
        ...(details !== undefined && { details: sanitizeObject(details) }),
      };

      emit(entry);

      // Emit aggregated drop count as a sidecar event so the operator still
      // knows the log pipeline was rate-limiting. This is itself exempt from
      // the token bucket to guarantee the signal is never silenced.
      if (dropped > 0) {
        emit({
          ts: new Date().toISOString(),
          level: 'WARN',
          component,
          ...(instanceId !== undefined && { instance_id: instanceId }),
          ...(instanceName !== undefined && { instance_name: instanceName }),
          event: 'log_rate_limited',
          details: { suppressed_event: event, dropped_count: dropped },
        });
      }
    } catch {
      try { process.stderr.write(`LOGGER_ERROR: ${event}\n`); } catch { /* give up */ }
    }
  }

  const logger: Logger = {
    debug: (event, details) => log('debug', event, details),
    info: (event, details) => log('info', event, details),
    warn: (event, details) => log('warn', event, details),
    error: (event, details) => log('error', event, details),
    setLevel: (level: LogLevel) => { currentLevel = level; },
    // Child loggers share the parent's rate-limit buckets so a flood across
    // multiple child loggers (e.g. per-instance children) still hits one cap.
    child: (fields) =>
      createLogger({
        component: fields.component ?? component,
        writer,
        level: currentLevel,
        instance_id: fields.instance_id ?? instanceId,
        instance_name: fields.instance_name ?? instanceName,
        _sharedBuckets: buckets,
        _rateLimitExempt: exempt,
        rate_limit_capacity: capacity,
        rate_limit_window_ms: windowMs,
      }),
  };

  return logger;
}
