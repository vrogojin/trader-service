/**
 * Tenant command registry and dispatcher.
 *
 * A framework for registering custom commands that can be executed by the
 * tenant in response to `acp.command` messages from the manager or controller.
 *
 * Design goals:
 *   - Simple registration API: `registerCommand(name, { paramsSchema, handler })`
 *   - Per-command parameter validation (hand-rolled validator interface —
 *     zod isn't a dep and adding it is ~22kb tipping the balance)
 *   - Timeouts with AbortSignal propagation so handlers can cooperate
 *   - Bounded concurrency + queueing with explicit too_busy rejection
 *   - Structured telemetry at start + end
 *   - Sanitized error envelopes (never leak stack traces / file paths)
 *   - Backwards-compatible facade with the existing `CommandHandler` interface
 *
 * The registry is a *per-instance* object — tests construct fresh registries
 * between cases, and production code wires a single registry into the
 * ACP listener. There's also a module-level `getDefaultRegistry()` singleton
 * used by the top-level `registerCommand()` helper that tenant authors can
 * import directly.
 */

import type { Logger } from '../shared/logger.js';
import { AgenticHostingError } from '../shared/errors.js';
import { isSecretEnvName } from './secrets.js';
import {
  MIN_TIMEOUT_MS as SHARED_MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS as SHARED_MAX_TIMEOUT_MS,
} from '../shared/timeout-constants.js';

// ---------------------------------------------------------------------------
// Error hierarchy
// ---------------------------------------------------------------------------

/**
 * Base class for errors thrown by command handlers. Authors may throw
 * subclasses (or construct instances directly) to signal structured failure
 * reasons back to the caller. The `code` becomes the `error_code` on the
 * wire; `publicMessage` is length-bounded and sanitized before transmission.
 */
export class CommandError extends AgenticHostingError {
  /** Optional human-readable message to surface on the wire. */
  public readonly publicMessage: string;
  /** Optional structured reason object (JSON-serializable). Not leaked to wire. */
  public readonly reason: Readonly<Record<string, unknown>> | undefined;

  constructor(code: string, publicMessage: string, reason?: Record<string, unknown>) {
    super(publicMessage, code);
    this.name = 'CommandError';
    this.publicMessage = publicMessage;
    this.reason = reason;
  }
}

export class InvalidParamsError extends CommandError {
  constructor(publicMessage: string, reason?: Record<string, unknown>) {
    super('invalid_params', publicMessage, reason);
    this.name = 'InvalidParamsError';
  }
}

export class HandlerTimeoutError extends CommandError {
  constructor(publicMessage: string = 'Handler timed out') {
    super('handler_timeout', publicMessage);
    this.name = 'HandlerTimeoutError';
  }
}

export class HandlerError extends CommandError {
  constructor(publicMessage: string, reason?: Record<string, unknown>) {
    super('handler_error', publicMessage, reason);
    this.name = 'HandlerError';
  }
}

export class UnknownCommandError extends CommandError {
  constructor(name: string) {
    super('unknown_command', `Unknown command: ${name}`, { name });
    this.name = 'UnknownCommandError';
  }
}

export class TooBusyError extends CommandError {
  constructor(publicMessage: string = 'Too many concurrent commands — try again') {
    super('too_busy', publicMessage);
    this.name = 'TooBusyError';
  }
}

export class ResultNotSerializableError extends CommandError {
  constructor(publicMessage: string = 'Handler result is not JSON-serializable') {
    super('result_not_serializable', publicMessage);
    this.name = 'ResultNotSerializableError';
  }
}

export class DuplicateCommandError extends CommandError {
  constructor(name: string) {
    super('duplicate_command', `Command already registered: ${name}`);
    this.name = 'DuplicateCommandError';
  }
}

/**
 * Raised at register-time when a command name doesn't match the strict
 * allowlist regex (`/^[a-zA-Z0-9_.-]{1,64}$/`). Steelman fix: prevents a
 * controller-supplied name like `"PING\n{...}"` from injecting structured
 * fields into telemetry log lines. At dispatch-time we map the same
 * validation to `unknown_command` so failed lookups can't reveal whether
 * the rejection was due to a missing handler or a malformed name.
 */
export class InvalidCommandNameError extends CommandError {
  constructor(name: string) {
    super(
      'invalid_command_name',
      `Invalid command name (must match /^[a-zA-Z0-9_.-]{1,64}$/): ${truncateForError(name)}`,
      { name: truncateForError(name) },
    );
    this.name = 'InvalidCommandNameError';
  }
}

/**
 * Allowlist regex for command names. Matches at register-time AND
 * dispatch-time. Forbids whitespace, newlines, JSON metacharacters, and
 * anything outside `[a-zA-Z0-9_.-]`. The 64-char cap is generous for any
 * real protocol name and protects against attacker-grown payloads. The
 * boundary is enforced via the regex anchors, not a separate length check.
 */
const COMMAND_NAME_REGEX = /^[a-zA-Z0-9_.-]{1,64}$/;

/**
 * Returns true iff `name` is a string that passes the strict allowlist AND
 * is not a reserved property name. Round-2 fix #7: even though Map storage
 * is safe today, a future refactor that swaps in a plain object would be
 * vulnerable to `commands.__proto__` lookups. Reject those names up front.
 */
function isValidCommandName(name: unknown): name is string {
  if (typeof name !== 'string') return false;
  if (!COMMAND_NAME_REGEX.test(name)) return false;
  if (RESERVED_NAMES.has(name.toLowerCase())) return false;
  return true;
}

/** Truncate a candidate name for use in error messages (defense in depth). */
function truncateForError(name: unknown): string {
  const s = typeof name === 'string' ? name : String(name);
  // Strip control chars before truncating so the error doesn't smuggle them.
  const clean = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
  return clean.length <= 64 ? clean : `${clean.slice(0, 64)}…`;
}

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

/**
 * A validator for command parameters. Return `{ ok: true, value }` when the
 * input is valid (optionally returning a parsed/coerced form), or
 * `{ ok: false, reason }` with a short structured reason. The reason flows
 * into the `invalid_params` error envelope.
 *
 * Intentionally shaped to be cheap to hand-roll without pulling in zod.
 * Authors wanting schema-based validation can bring their own library and
 * wrap the parse/safeParse result in this interface.
 */
export type ValidatorResult<T> = { ok: true; value: T } | { ok: false; reason: string; details?: Record<string, unknown> };

export interface Validator<T = unknown> {
  parse(input: unknown): ValidatorResult<T>;
}

/**
 * Context passed to every handler invocation. Intentionally narrow —
 * additions should be considered carefully.
 *
 * ## Cancellation contract
 *
 * The `signal` exposes the dispatcher's AbortController. Handlers MUST
 * cooperate with this signal for cancellation to work:
 *   - In long async loops, check `ctx.signal.aborted` and bail out.
 *   - When calling cancellation-aware APIs (`fetch`, `setTimeout`,
 *     `child_process.exec`), pass `ctx.signal` through.
 *
 * **Important:** A purely synchronous handler that runs a tight CPU loop
 * cannot be aborted mid-loop — JavaScript has no preemption. The dispatch
 * timer fires AFTER the handler's first `await`, so a handler that never
 * awaits will run to completion regardless of timeout. Handlers ignoring
 * `signal.aborted` continue to occupy their concurrency slot until their
 * promise settles (round-2 fix #1: the slot is no longer freed at timeout).
 * They are tracked via `registry.stats().abandoned` for diagnostics.
 * Authors who need real preemption should split work across
 * `await Promise.resolve()` yields. See `docs/tenant-extension-guide.md`
 * (Concurrency + timeouts).
 */
export interface CommandContext {
  /** Instance ID of the tenant (UUID). */
  readonly instanceId: string;
  /** Instance name (human-readable). */
  readonly instanceName: string;
  /** Command name as dispatched. Useful for logging from within handlers. */
  readonly commandName: string;
  /** The ACP envelope msg_id (for cross-referencing manager/tenant logs). */
  readonly msgId: string;
  /** The caller-supplied command_id (from payload). */
  readonly commandId: string;
  /** Structured logger scoped to the command execution. */
  readonly logger: Logger;
  /**
   * Abort signal tied to this command's timeout. Handlers MUST observe it
   * (see "Cancellation contract" above). Sync handlers cannot be preempted.
   */
  readonly signal: AbortSignal;
  /**
   * Optional opaque value the ACP listener may populate with shared
   * resources (e.g. the tenant's Sphere instance). Kept as `unknown` here
   * to avoid a runtime dep on sphere-sdk from this module.
   */
  readonly sphere?: unknown;
}

export type CommandHandlerFn<P = unknown, R = unknown> = (
  params: P,
  ctx: CommandContext,
) => Promise<R> | R;

export interface CommandDefinition<P = unknown, R = unknown> {
  /** One-line human-readable description, surfaced via `listCommands()`. */
  readonly description?: string;
  /** Optional validator; if absent, `params` is passed through as `Record<string, unknown>`. */
  readonly paramsSchema?: Validator<P>;
  /** Async or sync function. Return value MUST be JSON-serializable. */
  readonly handler: CommandHandlerFn<P, R>;
}

export interface RegistryOptions {
  /** Max concurrent handlers. Default 4. Min 1, max 256. */
  readonly maxConcurrent?: number;
  /**
   * Queue depth beyond `maxConcurrent`. Requests past this are rejected
   * with `too_busy`. Default 16. Min 0, max 1024.
   */
  readonly queueMax?: number;
  /** Default per-command timeout (ms). Default 30_000. */
  readonly defaultTimeoutMs?: number;
  /** Absolute cap — even an inbound `timeout_ms` larger than this is clamped. */
  readonly maxTimeoutMs?: number;
}

export interface DispatchInput {
  readonly name: string;
  readonly params?: Record<string, unknown>;
  readonly msgId: string;
  readonly commandId: string;
  readonly timeoutMs?: number;
  readonly instanceId: string;
  readonly instanceName: string;
  readonly sphere?: unknown;
}

export type DispatchOutcome = 'ok' | 'error' | 'timeout' | 'too_busy';

export interface DispatchOkResult {
  readonly ok: true;
  readonly result: Record<string, unknown>;
  readonly outcome: 'ok';
}

export interface DispatchErrorResult {
  readonly ok: false;
  readonly error_code: string;
  readonly message: string;
  readonly outcome: 'error' | 'timeout' | 'too_busy';
  readonly reason?: Record<string, unknown>;
}

export type DispatchResult = DispatchOkResult | DispatchErrorResult;

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

/** Default concurrency cap (override via UNICITY_MAX_CONCURRENT_COMMANDS). */
export const DEFAULT_MAX_CONCURRENT = 4;
/** Default queue cap (override via UNICITY_COMMAND_QUEUE_MAX). */
export const DEFAULT_QUEUE_MAX = 16;
/** Default per-command timeout when the caller doesn't specify one. */
export const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * Absolute ceiling — caller-supplied timeouts larger than this are rejected.
 * Re-exported from `shared/timeout-constants.ts` so both the HMCP layer and
 * the tenant registry agree on the upper bound (round-2 fix #5).
 */
export const MAX_TIMEOUT_MS = SHARED_MAX_TIMEOUT_MS;
/**
 * Minimum caller-supplied timeout in ms. Anything finer-grained is treated
 * as malformed input — a sub-millisecond timeout is functionally a guaranteed
 * `handler_timeout` on every dispatch, which a malicious controller could use
 * to drain the registry's concurrency slots without doing useful work.
 *
 * Round-2 fix #5: re-exported from `shared/timeout-constants.ts` so the HMCP
 * layer rejects sub-MIN_TIMEOUT_MS values BEFORE they reach the tenant.
 * Previously the HMCP validator accepted any positive finite number, leading
 * to confusing two-hop errors when the tenant later rejected the value.
 */
export const MIN_TIMEOUT_MS = SHARED_MIN_TIMEOUT_MS;
/** Upper bound on publicMessage length before truncation. */
export const MAX_PUBLIC_MESSAGE_LEN = 512;
/**
 * Cap on the size (in bytes) of any params blob we serialize into a log line.
 * `command.start` is emitted with `params_size_bytes`; we never embed the
 * params themselves. But to defend against amplification on
 * `command.rejected` (when the dispatch is rejected before schema
 * validation), we additionally truncate any string value we surface to this
 * many bytes so a 100KB blob can't generate a 100KB log line.
 *
 * Round-2 fix #2: previously this was applied as a CHARACTER count via
 * `String#length`, but UTF-8 bytes are what matter for log-volume
 * accounting (a 1024-char string of 4-byte codepoints is 4 KiB on disk).
 * `approximatePayloadSize` now uses `Buffer.byteLength(...,'utf8')`.
 */
export const LOG_PARAMS_MAX_BYTES = 1024;
/**
 * Round-2 fix #8: window after a `handler_timeout` fires during which we
 * watch for `runPromise` settlement. If the handler still hasn't settled
 * after this many ms, we mark it as abandoned in `stats().abandoned` and
 * emit a `command.abandoned` warn. Hoisted to a named constant so tests
 * can reference it for clarity instead of hardcoding 1000ms in two places.
 */
export const ABANDONED_DETECT_MS = 1000;
/**
 * Reserved property names that must never be allowed as command identifiers
 * even though they pass the regex character class. Defense in depth against
 * a future refactor that uses a plain object instead of a Map for command
 * storage — `commands.__proto__` would prototype-pollute the lookup.
 * Round-2 fix #7.
 */
const RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Parse a positive integer env value. Returns `fallback` on parse failure or
 * out-of-range, AND, when a `logger` + `varName` are supplied, emits a
 * `warn` event so operators can spot misconfigurations instead of guessing
 * why their tuning didn't take effect.
 *
 * Round-2 fix #4: when `varName` matches any SECRET_SUBSTRINGS entry
 * (case-insensitive), the raw value is replaced with `[REDACTED]` in the
 * log. None of the parsePositiveInt-managed env vars are sensitive today
 * (`UNICITY_MAX_CONCURRENT_COMMANDS` etc.) but any future operator-tunable
 * knob whose name happens to match a secret pattern (e.g. a fictitious
 * `UNICITY_AUTH_TIMEOUT_MS`) would otherwise leak its value into telemetry.
 */
function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  varName?: string,
  logger?: Logger,
): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    if (logger && varName !== undefined) {
      const reason = !Number.isFinite(n)
        ? 'not a finite number'
        : !Number.isInteger(n)
          ? 'not an integer'
          : n < min
            ? `below minimum ${min}`
            : `above maximum ${max}`;
      // Defense in depth (#4): redact value when the env name matches a
      // secret pattern. The var name itself is fine to log — it's
      // operator-controlled and bounded — but the value is not.
      const safeValue = isSecretEnvName(varName) ? '[REDACTED]' : raw;
      logger.warn('env_config_rejected', {
        var: varName,
        value: safeValue,
        reason,
        falling_back_to: fallback,
      });
    }
    return fallback;
  }
  return n;
}

/**
 * Read registry tuning options from `env`. When a `logger` is supplied,
 * any rejected value emits an `env_config_rejected` warn event. Production
 * code passes the tenant logger through so operators are alerted without
 * having to inspect process.env manually.
 */
export function readRegistryOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  logger?: Logger,
): RegistryOptions {
  return {
    maxConcurrent: parsePositiveInt(
      env['UNICITY_MAX_CONCURRENT_COMMANDS'],
      DEFAULT_MAX_CONCURRENT,
      1,
      256,
      'UNICITY_MAX_CONCURRENT_COMMANDS',
      logger,
    ),
    queueMax: parsePositiveInt(
      env['UNICITY_COMMAND_QUEUE_MAX'],
      DEFAULT_QUEUE_MAX,
      0,
      1024,
      'UNICITY_COMMAND_QUEUE_MAX',
      logger,
    ),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Check if `value` is safely JSON-serializable without throwing. Returns the
 * plain-object form (post JSON round-trip) so undefined, functions, BigInt,
 * and circular refs are detected before we send the result on the wire.
 *
 * We DO NOT accept non-object results as the top-level return value — the
 * wire payload has `result: Record<string, unknown>`. Handlers that want to
 * return a scalar should wrap it in an object.
 */
function validateJsonSerializable(value: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'handler must return a plain object' };
  }
  try {
    const serialized = JSON.stringify(value);
    const reparsed = JSON.parse(serialized) as unknown;
    if (reparsed === null || typeof reparsed !== 'object' || Array.isArray(reparsed)) {
      return { ok: false, reason: 'handler return value did not round-trip as an object' };
    }
    return { ok: true, value: reparsed as Record<string, unknown> };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'non-serializable' };
  }
}

/**
 * Sanitize a handler error message for wire transmission. We strip ANSI
 * escapes, control characters, and truncate to 512 chars. Stack traces are
 * never included. This is a *last-resort* scrubber — the more comprehensive
 * unicode sanitizer in acp-listener.ts handles publicMessage for established
 * error codes. This helper is used when generating a handler-supplied
 * `handler_error` message from a thrown non-CommandError.
 */
function sanitizeErrorMessage(msg: string): string {
  // Strip ESC / ANSI escape sequences, C0/C1 controls, common unicode
  // smuggling codepoints. Mirrors acp-listener's sanitization family but is
  // simpler — we don't need the full Trojan Source gauntlet here because
  // the acp-listener runs another pass on publicMessage before wire emission.
  const stripped = msg.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
  if (stripped.length <= MAX_PUBLIC_MESSAGE_LEN) return stripped;
  return stripped.slice(0, MAX_PUBLIC_MESSAGE_LEN);
}

function normalizeName(name: string): string {
  return name.toLowerCase();
}

/**
 * Approximate the UTF-8 byte size of a params blob for telemetry.
 *
 * Round-2 fix #2: uses `Buffer.byteLength(..., 'utf8')` instead of
 * `String#length`. The constant `LOG_PARAMS_MAX_BYTES` is named for bytes,
 * and a string of 4-byte codepoints would otherwise blow past the cap by 4x.
 *
 * Round-2 fix #6: on `JSON.stringify` throw (circular ref, BigInt, etc.) we
 * return `{ bytes: 0, measurable: false }`. Callers should set a separate
 * `params_unmeasurable: true` field so histograms don't conflate "0 bytes"
 * with "couldn't measure".
 */
function approximatePayloadSize(params: unknown): { bytes: number; measurable: boolean } {
  if (params === undefined) return { bytes: 0, measurable: true };
  try {
    return { bytes: Buffer.byteLength(JSON.stringify(params), 'utf8'), measurable: true };
  } catch {
    return { bytes: 0, measurable: false };
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface RegisteredCommand {
  readonly name: string;
  readonly description: string | undefined;
}

export interface RegistryStats {
  /** Slots currently held by running handlers. */
  readonly active: number;
  /** Dispatchers awaiting a slot (FIFO). */
  readonly queued: number;
  /** Configured max concurrency. */
  readonly maxConcurrent: number;
  /** Configured max queue depth (waiters past `maxConcurrent`). */
  readonly queueMax: number;
  /**
   * Cumulative count of handlers that timed out AND were still observed to
   * be running ~ABANDONED_DETECT_MS after the timeout fired. Counts
   * handlers that ignored their `ctx.signal`.
   *
   * Round-2: this is now PURELY DIAGNOSTIC. The concurrency cap is real
   * because `releaseSlot` is attached to `runPromise.finally` (round-2
   * fix #1) — a non-cooperating handler permanently holds its slot until
   * it actually settles, so attacker-driven slot exhaustion now naturally
   * surfaces as `too_busy` instead of leaking unbounded concurrent work.
   * An ever-growing `abandoned` value still signals a misbehaving handler
   * that authors should fix to cooperate with `signal.aborted`.
   */
  readonly abandoned: number;
}

export interface CommandRegistry {
  register<P, R>(name: string, def: CommandDefinition<P, R>): void;
  unregister(name: string): boolean;
  has(name: string): boolean;
  list(): RegisteredCommand[];
  clear(): void;
  dispatch(input: DispatchInput, logger: Logger): Promise<DispatchResult>;
  /** Snapshot of current concurrency + queue state (for tests / diagnostics). */
  readonly stats: () => RegistryStats;
  /**
   * Internal: return an iterable of (name, definition) pairs for
   * cross-registry merging. Authors SHOULD NOT rely on this — it's exposed
   * for the `createCommandHandler(mergeDefaultRegistry: true)` code path.
   */
  entries(): Iterable<[string, CommandDefinition<unknown, unknown>]>;
}

/**
 * Copy every registered command from `source` into `dest`. Raises a
 * `DuplicateCommandError` via the destination registry's guard if a name
 * collides — callers MUST ensure `dest` is either empty of that name or
 * call `dest.unregister()` first.
 */
export function copyRegistryCommands(source: CommandRegistry, dest: CommandRegistry): void {
  for (const [name, def] of source.entries()) {
    dest.register(name, def);
  }
}

export function createCommandRegistry(options: RegistryOptions = {}): CommandRegistry {
  const maxConcurrent = Math.max(1, Math.min(256, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT));
  const queueMax = Math.max(0, Math.min(1024, options.queueMax ?? DEFAULT_QUEUE_MAX));
  const defaultTimeoutMs = Math.max(1, Math.min(MAX_TIMEOUT_MS, options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS));
  const maxTimeoutMs = Math.max(1, Math.min(MAX_TIMEOUT_MS, options.maxTimeoutMs ?? MAX_TIMEOUT_MS));

  const commands = new Map<string, CommandDefinition<unknown, unknown>>();
  let active = 0;
  /**
   * Cumulative count of abandoned (post-timeout still-running) handlers.
   * Surfaced via `stats().abandoned` for diagnostics. Steelman fix #5.
   */
  let abandoned = 0;
  /**
   * Serialized queue of slot-waiters. Each entry is a resolver that
   * releases when a slot is available. We limit `queue.length` to `queueMax`
   * — past that we immediately reject the incoming dispatch with too_busy.
   */
  const queue: Array<() => void> = [];

  /**
   * Try to acquire a slot synchronously. Returns:
   *   - 'ok'        — slot claimed, caller MUST eventually call releaseSlot()
   *   - 'queue'     — caller should await the returned promise below
   *   - 'too_busy'  — reject immediately
   *
   * The two-phase design preserves the historical synchronous fast path:
   * when `active < maxConcurrent` the handler starts running in the same
   * microtask as dispatch() is called, so tests that observe handler-set
   * state (e.g. SHUTDOWN_GRACEFUL setting `shutdownRequested`) synchronously
   * after triggering a DM still pass.
   */
  function tryAcquireSlotSync(): 'ok' | 'queue' | 'too_busy' {
    if (active < maxConcurrent) {
      active++;
      return 'ok';
    }
    if (queue.length >= queueMax) {
      return 'too_busy';
    }
    return 'queue';
  }

  function waitForSlot(): Promise<void> {
    return new Promise<void>((resolve) => {
      // The waiter inherits the slot from the previous holder atomically —
      // see releaseSlot. We therefore DO NOT increment `active` here.
      queue.push(() => resolve());
    });
  }

  /**
   * Release a slot held by a finishing handler. Steelman fix (strict-FIFO):
   * if a queued waiter exists, transfer the slot directly to it WITHOUT
   * decrementing `active`. The waiter pops a `resolve()` whose continuation
   * will resume in a future microtask; meanwhile `active` stays at the cap
   * so any concurrent (sibling) `dispatch()` call hitting
   * `tryAcquireSlotSync()` correctly takes the queue path. This guarantees
   * FIFO ordering across siblings — without the fix, a synchronous caller
   * could leapfrog the queue between `active--` and the waiter's resume.
   *
   * If no waiter is queued, decrement `active` so the next dispatch's
   * sync fast path can fire.
   */
  function releaseSlot(): void {
    const next = queue.shift();
    if (next) {
      // Slot transferred to the waiter: keep `active` unchanged.
      next();
      return;
    }
    active--;
  }

  function emitEnd(
    logger: Logger,
    name: string,
    msgId: string,
    startMs: number,
    outcome: DispatchOutcome,
    errorCode?: string,
    level: 'info' | 'warn' | 'error' = outcome === 'ok' ? 'info' : 'warn',
  ): void {
    logger[level]('command.end', {
      event: 'command.end',
      command: name,
      msg_id: msgId,
      duration_ms: Date.now() - startMs,
      outcome,
      ...(errorCode !== undefined && { error_code: errorCode }),
    });
  }

  /**
   * Emit a `command.rejected` event. Used when dispatch is rejected BEFORE
   * the handler is dispatched — i.e. unknown command, invalid name, invalid
   * timeout, or schema validation failure. Steelman fix #3 (round 1)
   * replaced the previous behavior of emitting `command.start` (with full
   * params_size_bytes) followed by `command.end` for rejected dispatches,
   * which an attacker could exploit to amplify log volume by sending large
   * params payloads to an unknown command.
   *
   * Round-2 fix #3: include `command_id`, `instance_id`, `instance_name`,
   * and `duration_ms` so rejected dispatches are correlatable with
   * `command.start`/`command.end` from sibling sessions on the same
   * tenant. All fields are bounded (caller-supplied strings are truncated).
   */
  function emitRejected(
    logger: Logger,
    input: DispatchInput,
    startMs: number,
    reason: string,
    errorCode: string,
  ): void {
    logger.warn('command.rejected', {
      event: 'command.rejected',
      command: truncateForError(input.name),
      msg_id: typeof input.msgId === 'string' ? input.msgId.slice(0, 128) : '',
      command_id: typeof input.commandId === 'string' ? input.commandId.slice(0, 128) : '',
      instance_id: typeof input.instanceId === 'string' ? input.instanceId.slice(0, 128) : '',
      instance_name: typeof input.instanceName === 'string' ? input.instanceName.slice(0, 128) : '',
      duration_ms: Date.now() - startMs,
      reason: reason.slice(0, 256),
      error_code: errorCode,
    });
  }

  /**
   * Run an already-started handler promise under a timeout + abort.
   * `runPromise` is kicked off *synchronously* by the caller so the handler
   * body executes up to its first await before we arrive here — preserving
   * the fast-path synchronous side-effects (flag-setting etc.).
   */
  async function raceUnderTimeout(
    runPromise: Promise<{ kind: 'ok'; value: unknown } | { kind: 'throw'; error: unknown }>,
    controller: AbortController,
    timeoutMs: number,
  ): Promise<{ kind: 'ok'; value: unknown } | { kind: 'timeout' } | { kind: 'throw'; error: unknown }> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        try { controller.abort(new Error('handler_timeout')); } catch { /* best effort */ }
        resolve('timeout');
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });

    try {
      const result = await Promise.race([runPromise, timeoutPromise]);
      if (result === 'timeout') return { kind: 'timeout' };
      return result;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function dispatch(input: DispatchInput, logger: Logger): Promise<DispatchResult> {
    // Synchronous validation and fast-path handler kickoff. We do NOT wrap
    // this in an `async` function so the handler body runs in the same
    // microtask as the caller — preserving the old switch-statement's
    // synchronous side effects.
    //
    // ORDER MATTERS (steelman fix #3): we validate name + timeout + schema
    // BEFORE emitting `command.start`, so a 100KB params blob aimed at an
    // unknown command produces only a single bounded `command.rejected`
    // event instead of being copied into a `command.start` log line.
    const startMs = Date.now();

    // 1) Command-name allowlist (steelman fix #7). Reject malformed names
    //    BEFORE any further work. Map to `unknown_command` on the wire so
    //    we don't reveal whether the name was syntactically invalid vs.
    //    just unregistered — but log internally as `invalid_command_name`
    //    for operators to spot abuse patterns.
    if (!isValidCommandName(input.name)) {
      emitRejected(logger, input, startMs, 'invalid_command_name', 'unknown_command');
      const err = new UnknownCommandError(truncateForError(input.name));
      return Promise.resolve<DispatchResult>({
        ok: false,
        error_code: err.code,
        message: err.publicMessage,
        outcome: 'error',
      });
    }

    // 2) Lookup. We pass through to `unknown_command` if not registered.
    const def = commands.get(normalizeName(input.name));
    if (!def) {
      emitRejected(logger, input, startMs, 'no_handler_registered', 'unknown_command');
      const err = new UnknownCommandError(input.name);
      return Promise.resolve<DispatchResult>({
        ok: false,
        error_code: err.code,
        message: err.publicMessage,
        outcome: 'error',
      });
    }

    // 3) Strict timeout validation (steelman fix #2). The previous code
    //    permitted any finite positive number, which a malicious caller
    //    could exploit by sending `timeout_ms: 0.5` to guarantee
    //    `handler_timeout` on every dispatch — a slot-draining DoS.
    //    Now: when supplied, MUST be an integer in [MIN_TIMEOUT_MS,
    //    maxTimeoutMs]. When omitted, defaultTimeoutMs applies.
    let resolvedTimeout: number;
    if (input.timeoutMs !== undefined) {
      const t = input.timeoutMs;
      if (
        !Number.isInteger(t)
        || t < MIN_TIMEOUT_MS
        || t > maxTimeoutMs
      ) {
        emitRejected(logger, input, startMs, 'invalid_timeout_ms', 'invalid_params');
        return Promise.resolve<DispatchResult>({
          ok: false,
          error_code: 'invalid_params',
          message: `timeout_ms must be an integer between ${MIN_TIMEOUT_MS} and ${maxTimeoutMs}`,
          outcome: 'error',
        });
      }
      resolvedTimeout = t;
    } else {
      // Default applies when caller didn't supply timeoutMs. Clamp it to
      // the registry's maxTimeoutMs in case operator config is incoherent.
      resolvedTimeout = Math.max(1, Math.min(maxTimeoutMs, defaultTimeoutMs));
    }

    // 4) Validate params synchronously. A schema that throws is treated as
    //    `invalid_params` with a sanitized message — authors shouldn't
    //    throw from their parse() but buggy/third-party validators
    //    sometimes do.
    let validated: unknown = input.params ?? {};
    if (def.paramsSchema) {
      let parse: ReturnType<Validator<unknown>['parse']>;
      try {
        parse = def.paramsSchema.parse(input.params ?? {});
      } catch (err) {
        emitRejected(logger, input, startMs, 'validator_threw', 'invalid_params');
        return Promise.resolve<DispatchResult>({
          ok: false,
          error_code: 'invalid_params',
          message: sanitizeErrorMessage(err instanceof Error ? err.message : 'validator threw'),
          outcome: 'error',
        });
      }
      if (!parse.ok) {
        emitRejected(logger, input, startMs, 'schema_rejected', 'invalid_params');
        return Promise.resolve<DispatchResult>({
          ok: false,
          error_code: 'invalid_params',
          message: sanitizeErrorMessage(parse.reason),
          outcome: 'error',
          ...(parse.details !== undefined && { reason: parse.details }),
        });
      }
      validated = parse.value;
    }

    // 5) ONLY NOW we know the dispatch is well-formed. Emit `command.start`
    //    with the bounded `params_size_bytes` AND a `params_size_bytes_clamped`
    //    flag indicating whether the size was capped at LOG_PARAMS_MAX_BYTES.
    //    Note: we never put the params themselves in the log line — only
    //    the size. The flag is informational so operators can recognize
    //    when oversized payloads are being received.
    //
    //    Round-2 fix #6: when `JSON.stringify` throws (circular ref / BigInt /
    //    etc.), we report `params_size_bytes: 0` AND set
    //    `params_unmeasurable: true` so histograms can distinguish "0 bytes"
    //    from "couldn't measure". The handler will still run; if it returns
    //    a non-serializable value the response side surfaces that as
    //    `result_not_serializable`.
    const sized = approximatePayloadSize(input.params);
    const clamped = sized.measurable && sized.bytes > LOG_PARAMS_MAX_BYTES;
    logger.info('command.start', {
      event: 'command.start',
      command: input.name,
      msg_id: input.msgId,
      params_size_bytes: clamped ? LOG_PARAMS_MAX_BYTES : sized.bytes,
      params_size_bytes_clamped: clamped,
      ...(sized.measurable ? {} : { params_unmeasurable: true }),
    });

    // 6) Slot acquisition — try synchronously first.
    const slotStatus = tryAcquireSlotSync();
    if (slotStatus === 'too_busy') {
      emitEnd(logger, input.name, input.msgId, startMs, 'too_busy', 'too_busy', 'warn');
      const err = new TooBusyError();
      return Promise.resolve<DispatchResult>({
        ok: false,
        error_code: err.code,
        message: err.publicMessage,
        outcome: 'too_busy',
      });
    }

    if (slotStatus === 'ok') {
      // FAST PATH: slot granted synchronously. Kick the handler off NOW so
      // its body runs in this microtask (setting any sync side-effects).
      const controller = new AbortController();
      const ctx = buildContext(input, logger, controller);
      const runPromise = kickoffHandler(def.handler, validated, ctx);
      return finalizeDispatch(input, logger, startMs, runPromise, controller, resolvedTimeout);
    }

    // Slow path: we have to queue.
    return (async () => {
      await waitForSlot();
      const controller = new AbortController();
      const ctx = buildContext(input, logger, controller);
      const runPromise = kickoffHandler(def.handler, validated, ctx);
      return finalizeDispatch(input, logger, startMs, runPromise, controller, resolvedTimeout);
    })();
  }

  function buildContext(input: DispatchInput, logger: Logger, controller: AbortController): CommandContext {
    return {
      instanceId: input.instanceId,
      instanceName: input.instanceName,
      commandName: input.name,
      msgId: input.msgId,
      commandId: input.commandId,
      logger: logger.child({ component: `cmd:${input.name}` }),
      signal: controller.signal,
      ...(input.sphere !== undefined && { sphere: input.sphere }),
    };
  }

  function kickoffHandler(
    handler: CommandHandlerFn<unknown, unknown>,
    params: unknown,
    ctx: CommandContext,
  ): Promise<{ kind: 'ok'; value: unknown } | { kind: 'throw'; error: unknown }> {
    // Invoke the handler synchronously. Async function bodies run up to
    // the first `await` synchronously; sync handlers return a value
    // directly (wrapped via `Promise.resolve` below). Either way, any
    // top-of-handler side effects fire before we return control.
    try {
      const raw = handler(params, ctx);
      if (raw instanceof Promise) {
        return raw.then(
          (value) => ({ kind: 'ok' as const, value }),
          (error: unknown) => ({ kind: 'throw' as const, error }),
        );
      }
      return Promise.resolve({ kind: 'ok' as const, value: raw });
    } catch (error) {
      // Sync throw
      return Promise.resolve({ kind: 'throw' as const, error });
    }
  }

  async function finalizeDispatch(
    input: DispatchInput,
    logger: Logger,
    startMs: number,
    runPromise: Promise<{ kind: 'ok'; value: unknown } | { kind: 'throw'; error: unknown }>,
    controller: AbortController,
    resolvedTimeout: number,
  ): Promise<DispatchResult> {
    // ROUND-2 FIX #1 (CRITICAL — slot-leak DoS): the slot is released ONLY
    // when `runPromise` actually settles, never on timeout alone.
    //
    // Previous behavior: `releaseSlot()` was attached to the synchronous
    // `finally` of this function, meaning a handler that ignored
    // `signal.aborted` had its slot freed at timeout time while it kept
    // running. Combined with `MIN_TIMEOUT_MS=100`, an attacker who could
    // trigger non-cooperating handlers could spawn unbounded concurrent
    // work: every 100ms, dispatch returned `timeout` and freed the slot,
    // but the handler kept consuming CPU/memory/file handles. The
    // pre-existing comment claimed "slot stays held until runPromise
    // settles" but the code did the opposite — `stats.abandoned` merely
    // OBSERVED the leak.
    //
    // Fix (Path A): attach `releaseSlot` to `runPromise.finally`. The slot
    // is held for as long as the handler is actually running. The
    // trade-off is that a permanently-stuck handler will permanently
    // consume a slot — but that is the SAME failure mode as the old code,
    // just made VISIBLE: when all slots are stuck, new dispatches naturally
    // hit `too_busy`. `stats().abandoned` is now informational only — the
    // concurrency cap is real.
    //
    // We use a one-shot guard (`slotReleased`) so neither a sync error in
    // this function nor a double-finally chain double-counts.
    let slotReleased = false;
    const releaseOnce = (): void => {
      if (slotReleased) return;
      slotReleased = true;
      releaseSlot();
    };
    runPromise.finally(releaseOnce).catch(() => { /* defensive */ });

    const outcome = await raceUnderTimeout(runPromise, controller, resolvedTimeout);

    if (outcome.kind === 'timeout') {
      emitEnd(logger, input.name, input.msgId, startMs, 'timeout', 'handler_timeout', 'warn');
      // Track handlers that ignore `signal.aborted` and continue running
      // past the timeout. The slot stays held until `runPromise` settles
      // (per fix #1 above); a non-cooperating handler is identified by
      // whether `runPromise` still hasn't resolved `ABANDONED_DETECT_MS`
      // after the timeout fired. When it eventually settles we increment
      // `abandoned` for diagnostics + emit `command.abandoned`. This
      // detection runs in parallel with the slot-holding behavior; both
      // serve different purposes (one for diagnostics, one for resource
      // safety).
      let detached = false;
      const detectTimer = setTimeout(() => { detached = true; }, ABANDONED_DETECT_MS);
      if (typeof detectTimer.unref === 'function') detectTimer.unref();
      runPromise.finally(() => {
        clearTimeout(detectTimer);
        if (detached) {
          abandoned++;
          // One-shot warn log so operators can identify the offender,
          // subject to the logger's own rate limiter.
          logger.warn('command.abandoned', {
            event: 'command.abandoned',
            command: input.name,
            msg_id: input.msgId,
            abandoned_total: abandoned,
          });
        }
      }).catch(() => { /* swallow — handler errors already surfaced via raceUnderTimeout */ });
      const err = new HandlerTimeoutError(`Handler timed out after ${resolvedTimeout}ms`);
      return {
        ok: false,
        error_code: err.code,
        message: err.publicMessage,
        outcome: 'timeout',
      };
    }

    if (outcome.kind === 'throw') {
      const raw = outcome.error;
      let code: string;
      let message: string;
      let reason: Record<string, unknown> | undefined;
      if (raw instanceof CommandError) {
        code = raw.code;
        message = sanitizeErrorMessage(raw.publicMessage);
        reason = raw.reason as Record<string, unknown> | undefined;
      } else {
        code = 'handler_error';
        const rawMsg = raw instanceof Error ? raw.message : String(raw);
        message = sanitizeErrorMessage(rawMsg);
      }
      emitEnd(logger, input.name, input.msgId, startMs, 'error', code, 'error');
      return {
        ok: false,
        error_code: code,
        message,
        outcome: 'error',
        ...(reason !== undefined && { reason }),
      };
    }

    // Success path — validate serializability
    const serOk = validateJsonSerializable(outcome.value);
    if (!serOk.ok) {
      emitEnd(logger, input.name, input.msgId, startMs, 'error', 'result_not_serializable', 'error');
      return {
        ok: false,
        error_code: 'result_not_serializable',
        message: sanitizeErrorMessage(serOk.reason),
        outcome: 'error',
      };
    }

    emitEnd(logger, input.name, input.msgId, startMs, 'ok');
    return { ok: true, result: serOk.value, outcome: 'ok' };
  }

  return {
    register<P, R>(name: string, def: CommandDefinition<P, R>): void {
      // Steelman fix #7: enforce strict allowlist regex at register-time.
      // Authors who try to use whitespace/newlines/special chars in a
      // command name fail loudly here rather than silently passing into
      // telemetry. The same regex is enforced at dispatch-time (mapped to
      // `unknown_command` to avoid leaking the validation pattern).
      if (!isValidCommandName(name)) {
        throw new InvalidCommandNameError(name);
      }
      const key = normalizeName(name);
      if (commands.has(key)) {
        throw new DuplicateCommandError(name);
      }
      commands.set(key, def as CommandDefinition<unknown, unknown>);
    },

    unregister(name: string): boolean {
      return commands.delete(normalizeName(name));
    },

    has(name: string): boolean {
      return commands.has(normalizeName(name));
    },

    list(): RegisteredCommand[] {
      const out: RegisteredCommand[] = [];
      for (const [name, def] of commands.entries()) {
        out.push({ name, description: def.description });
      }
      return out;
    },

    clear(): void {
      commands.clear();
    },

    dispatch,

    stats: () => ({ active, queued: queue.length, maxConcurrent, queueMax, abandoned }),

    entries(): Iterable<[string, CommandDefinition<unknown, unknown>]> {
      return commands.entries();
    },
  };
}

// ---------------------------------------------------------------------------
// Module-level default registry — for ergonomic top-level `registerCommand`
// ---------------------------------------------------------------------------

let defaultRegistry: CommandRegistry | null = null;

/** Returns the process-wide default registry, creating it on first access. */
export function getDefaultRegistry(): CommandRegistry {
  if (!defaultRegistry) {
    defaultRegistry = createCommandRegistry(readRegistryOptionsFromEnv());
  }
  return defaultRegistry;
}

/**
 * For tests. Resets the default registry so each test starts clean.
 * Production code SHOULD NOT call this — the default registry is initialized
 * once at tenant startup and populated with built-ins.
 */
export function resetDefaultRegistry(): void {
  defaultRegistry = null;
}

/**
 * Top-level registration helper — equivalent to
 * `getDefaultRegistry().register(name, def)`. Tenant authors importing from
 * the package index use this.
 */
export function registerCommand<P, R>(name: string, def: CommandDefinition<P, R>): void {
  getDefaultRegistry().register(name, def);
}

export function unregisterCommand(name: string): boolean {
  return getDefaultRegistry().unregister(name);
}

export function listCommands(): RegisteredCommand[] {
  return getDefaultRegistry().list();
}

// ---------------------------------------------------------------------------
// Validator helpers (tiny hand-rolled set — authors can bring their own)
// ---------------------------------------------------------------------------

/** Passes any input through. Use when params are free-form. */
export const anyParams: Validator<Record<string, unknown>> = {
  parse(input: unknown): ValidatorResult<Record<string, unknown>> {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, reason: 'params must be an object' };
    }
    return { ok: true, value: input as Record<string, unknown> };
  },
};

/** Rejects anything but an empty object (or omitted). */
export const noParams: Validator<Record<string, never>> = {
  parse(input: unknown): ValidatorResult<Record<string, never>> {
    if (input === undefined || input === null) return { ok: true, value: {} as Record<string, never> };
    if (typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, reason: 'params must be empty or an object' };
    }
    const keys = Object.keys(input as Record<string, unknown>).filter((k) => k !== 'command_id');
    if (keys.length > 0) {
      return { ok: false, reason: `unexpected params: ${keys.join(', ')}`, details: { keys } };
    }
    return { ok: true, value: {} as Record<string, never> };
  },
};
