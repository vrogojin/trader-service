/**
 * AcpListener — the core tenant-side listener that orchestrates
 * ACP protocol handling, command dispatch, heartbeat, and external DM routing.
 */

import {
  createAcpMessage,
  isValidAcpMessage,
  type AcpMessage,
  type AcpCommandPayload,
} from '../protocols/acp.js';
import { serializeMessage } from '../protocols/envelope.js';
import { pubkeysEqual } from '../shared/crypto.js';
import type { ReplayGuard } from '../shared/replay-guard.js';
import type { Logger } from '../shared/logger.js';
import type { TenantConfig } from '../shared/types.js';
import type { SphereDmSender, SphereDmReceiver, DmSubscription } from './types.js';
import type { HeartbeatEmitter } from './heartbeat.js';
import { createHeartbeatEmitter } from './heartbeat.js';
import type { CommandHandler } from './command-handler.js';
import { createCommandHandler } from './command-handler.js';
import type { MessageHandler } from './message-handler.js';
import { createMessageHandler } from './message-handler.js';
import type { TenantStateStore } from './state-store.js';

export interface AcpListener {
  start(): Promise<void>;
  stop(): Promise<void>;
  isShutdownRequested(): boolean;
}

/**
 * Wire-safe error codes. Only codes in this allowlist may be echoed back to
 * the caller verbatim in an acp.error response. Any other value — even if it
 * looks like a legitimate code (all-uppercase, underscore-separated) — is
 * rewritten to INTERNAL_ERROR with a generic message.
 *
 * The previous regex-based gate (/^[A-Z_]+$/) accepted any all-uppercase
 * string, which would happily leak codes like DATABASE_CONNECTION_REFUSED
 * or FILE_NOT_FOUND_AT_ETC_SHADOW — disclosing internal architecture to an
 * attacker. This allowlist is deliberately small: new codes require a review
 * and explicit addition here, not just a matching shape.
 */
const WIRE_SAFE_ERROR_CODES = new Set<string>([
  'NOT_IMPLEMENTED',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'INVALID_PAYLOAD',
  'INVALID_ARGS',
  'NOT_FOUND',
  'CONFLICT',
  'TIMEOUT',
  'UNKNOWN_COMMAND',
  'RATE_LIMITED',
  'INSUFFICIENT_BALANCE',
  'PRECONDITION_FAILED',
]);

/**
 * Default wire messages per code. Handlers can opt-in to a custom message by
 * attaching a `publicMessage` property on the thrown Error (see F4 at catch
 * sites). Otherwise we template based on the code so the wire never carries
 * handler-internal strings (file paths, balances, addresses, stack fragments).
 */
const CODE_MESSAGE_TEMPLATES: Record<string, string> = {
  NOT_IMPLEMENTED: 'Command not implemented',
  UNAUTHORIZED: 'Unauthorized',
  FORBIDDEN: 'Forbidden',
  INVALID_PAYLOAD: 'Invalid payload',
  INVALID_ARGS: 'Invalid arguments',
  NOT_FOUND: 'Not found',
  CONFLICT: 'Conflict',
  TIMEOUT: 'Operation timed out',
  UNKNOWN_COMMAND: 'Unknown command',
  RATE_LIMITED: 'Rate limited',
  INSUFFICIENT_BALANCE: 'Insufficient balance',
  PRECONDITION_FAILED: 'Precondition failed',
};

/** Max length of a handler-supplied publicMessage. Longer messages fall back
 *  to the code template to avoid accidental disclosure through verbose prose. */
const MAX_PUBLIC_MESSAGE_LEN = 200;

/**
 * Character classes we strip from handler-supplied publicMessages before wire
 * transmission. Compiled once at module load for efficiency.
 *
 * Categories (in codepoint order):
 *
 *   - C0 controls (U+0000-U+001F) — ESC, NUL, BEL, CR, LF, TAB. ESC corrupts
 *     operator terminals (ANSI). NUL terminates C-strings in some downstream
 *     tooling. CR/LF break JSON-Lines framing.
 *   - Combining Grapheme Joiner (U+034F) — invisible combining mark that can
 *     fragment grapheme clusters and defeat naive string comparison or grep.
 *     Added round-23 F1.
 *   - Arabic Letter Mark (U+061C) — bidi mark used in Trojan Source-style
 *     attacks on strings containing Arabic text. Invisible but reorders
 *     neighbors. Added round-21 F1.
 *   - DEL + C1 (U+007F-U+009F) — alternate escape intros in some terminals.
 *   - Mongolian Vowel Separator (U+180E) — historically zero-width in
 *     Unicode 4.0-6.2, still rendered invisibly in legacy tools and can
 *     smuggle content past grep filters. Added round-21 F1.
 *   - Zero-width joiners/non-joiners (U+200B-U+200D) — invisible smuggling.
 *   - Bidi marks (U+200E-U+200F) — LRM, RLM.
 *   - LINE SEPARATOR (U+2028) + PARAGRAPH SEPARATOR (U+2029) — legacy
 *     JSON.parse rejected these; JSON-Lines aggregators that split on
 *     Unicode line boundaries (many log pipelines) break on them regardless.
 *     Added round-21 F1.
 *   - Bidi overrides + isolates (U+202A-U+202E, U+2066-U+2069) — Trojan
 *     Source attack surface. U+202E (RLO) can reverse the visual appearance
 *     of a log line in the operator's terminal.
 *   - Word Joiner (U+2060) — invisible zero-width joiner (preferred
 *     replacement for ZWNBSP for non-BOM uses). Added round-23 F1.
 *   - Invisible math operators (U+2061 FUNCTION APPLICATION, U+2062 TIMES,
 *     U+2063 SEPARATOR, U+2064 PLUS) — invisible, ignored by most renderers
 *     but can still smuggle content past text filters. Added round-23 F1.
 *   - Deprecated format controls (U+206A-U+206F) — inhibit/activate
 *     symmetric swapping, Arabic form shaping — all invisible format codes
 *     deprecated since Unicode 5.1 but still permitted by most renderers.
 *     Added round-23 F1. (Note: U+2066-U+2069 are in this block and already
 *     covered above; the combined range U+2066-U+206F collapses both into
 *     one class.)
 *   - Interlinear annotation markers (U+FFF9-U+FFFB) — ANCHOR/SEPARATOR/
 *     TERMINATOR used to wrap ruby-text annotations; some renderers display
 *     annotation content zero-width. Added round-23 F1.
 *   - BOM / ZWNBSP (U+FEFF) — invisible smuggling.
 */
//   - Hangul Filler (U+3164) — renders as whitespace in most fonts and is a
//     well-known homoglyph smuggling vector; has no legitimate use in log
//     messages. Added round-25 F2.
//   - Variation Selectors (U+FE00-U+FE0F) — 16 invisible variation selectors
//     used to smuggle content past grep; the Unicode Tags block already
//     covered the supplementary-plane selectors but the BMP ones were
//     missed. Added round-25 F2.
const STRIP_RE =
  /[\u0000-\u001f\u007f-\u009f\u034f\u061c\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u206f\u3164\ufe00-\ufe0f\ufff9-\ufffb\ufeff]/g;

/**
 * Secondary regex for stripping Unicode Tag characters (U+E0000-U+E007F) and
 * the Variation Selectors Supplement (U+E0100-U+E01EF). These live outside
 * the Basic Multilingual Plane, so they require a regex with the /u flag
 * and Unicode code-point escapes. Needed because modern "Unicode Tags"
 * prompt-injection attacks smuggle invisible instructions using this block:
 * the characters are rendered as nothing by most fonts but copy/paste
 * cleanly through logs into AI-model inputs.
 *
 * Round-25 F2 extends the range to cover U+E0100-U+E01EF (Variation
 * Selectors Supplement) — the supplementary-plane variation selectors that
 * share the same invisibility profile as the Tags block.
 *
 * Added round-23 F1; range extended round-25 F2.
 */
const STRIP_TAGS_RE = /[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;

/**
 * Truncate `s` to at most `maxLen` UTF-16 code units, taking care NOT to split
 * a surrogate pair. If the `maxLen`-th code unit is a high surrogate (0xD800-
 * 0xDBFF), the pair it heads spans positions maxLen-1 and maxLen — slicing at
 * maxLen would emit an unpaired high surrogate. We retreat one unit in that
 * case so the cut falls before the pair, not inside it.
 *
 * Example: a 201-character string whose 200th position is the high half of
 * an emoji. Naive `s.slice(0, 200)` produces 199 valid chars followed by an
 * unpaired 0xD83D. Downstream JSON encoders emit \ud83d which is a valid
 * string but gets flagged by strict Unicode validators; some terminals
 * render a replacement character \uFFFD unexpectedly.
 *
 * Added round-21 F2.
 */
function safeSlice(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  // Round-23 F5: retreat repeatedly if we're still on a high surrogate. In a
  // well-formed UTF-16 string a single decrement is always enough (high
  // surrogates only appear immediately before their paired low surrogate), but
  // if an upstream producer handed us a malformed run of consecutive high
  // surrogates without paired lows, a single decrement would still leave the
  // cut inside the malformed run. Defense-in-depth: NFC normalization earlier
  // in sanitizeWireMessage already rejects ill-formed surrogate input, so this
  // loop almost never iterates more than once in practice. The `cut > 0` bound
  // guarantees termination on pathological input (e.g. an all-high-surrogate
  // string) — we degrade to the empty string rather than loop forever.
  let cut = maxLen;
  while (cut > 0) {
    const code = s.charCodeAt(cut - 1);
    if (code < 0xd800 || code > 0xdbff) break;
    cut--;
  }
  return s.slice(0, cut);
}

/**
 * Sanitize a handler-supplied publicMessage before wire transmission.
 *
 * Round-18 F5 / Round-19 F1 / Round-21 F1+F2: length-bounding alone is
 * insufficient. An attacker-controlled or buggy handler can produce messages
 * containing:
 *
 *   - ANSI escape sequences (ESC + `[...m`) that corrupt operator terminals
 *     when manager/CLI logs re-emit the string verbatim.
 *   - Embedded newlines — CR/LF, U+2028 LINE SEPARATOR, U+2029 PARAGRAPH
 *     SEPARATOR — that break log-line framing (JSON-Lines logs become
 *     multi-line, breaking grep/jq pipelines and downstream parsers).
 *   - NUL bytes that terminate C-string handlers prematurely in some
 *     downstream tooling.
 *   - Non-NFC unicode, e.g. decomposed-form homoglyphs used for spoofing in
 *     reviewer UIs.
 *   - Unicode bidi control characters (U+061C Arabic Letter Mark, U+202E
 *     RLO, U+202D LRO, U+2066-U+2069 isolates, U+200E/U+200F LRM/RLM) used
 *     to visually reverse the appearance of strings in reviewer terminals —
 *     the classic "Trojan Source" attack where a log line reads one way but
 *     contains the opposite semantic content.
 *   - Zero-width joiners / non-joiners (U+200B-U+200D), U+180E Mongolian
 *     Vowel Separator (historically zero-width), and BOM/ZWNBSP (U+FEFF)
 *     used to smuggle invisible content past log grep filters.
 *   - Unpaired surrogates from a naive truncation that splits a surrogate
 *     pair at the 200-char boundary (emitted as orphan 0xD800-0xDBFF).
 *
 * We normalize to NFC, strip the full set of dangerous codepoints listed
 * above, safely truncate to 200 code units without splitting surrogate
 * pairs, then trim whitespace. The result is safe to splice into a JSON-
 * Lines log record without further escaping.
 */
function sanitizeWireMessage(msg: string): string {
  // Round-23 F1: apply both strip regexes — STRIP_RE covers BMP dangerous
  // codepoints, STRIP_TAGS_RE covers Unicode Tag characters (U+E0000-U+E007F)
  // that are outside BMP and used in modern "Unicode Tags" invisible prompt-
  // injection attacks. Replace-with-space preserves readability of surrounding
  // text; safeSlice + trim collapse leading/trailing whitespace.
  const normalized = msg.normalize('NFC');
  const stripped = normalized.replace(STRIP_RE, ' ').replace(STRIP_TAGS_RE, ' ');
  return safeSlice(stripped, MAX_PUBLIC_MESSAGE_LEN).trim();
}

/**
 * Map a thrown error to a (code, message) pair safe to send on the wire.
 *
 * - If `err.code` is on WIRE_SAFE_ERROR_CODES, we use it; otherwise we fall
 *   back to INTERNAL_ERROR.
 * - For the message, we prefer a handler-supplied `err.publicMessage` (short,
 *   explicitly opted-in, control-char stripped) over the templated default.
 *   INTERNAL_ERROR always uses the generic "Internal error" string — no
 *   handler override.
 */
function toWireError(err: unknown): { code: string; message: string } {
  const e = err as Error & { code?: string; publicMessage?: string };
  const code = (typeof e.code === 'string' && WIRE_SAFE_ERROR_CODES.has(e.code))
    ? e.code
    : 'INTERNAL_ERROR';
  if (code === 'INTERNAL_ERROR') {
    return { code, message: 'Internal error' };
  }
  // Sanitize FIRST, then length-check. The sanitized form may shrink (after
  // trim + control-char strip); a message that was 210 chars of mostly-
  // whitespace could legitimately shrink to <200 and be usable. Equally, a
  // sanitized-empty result (e.g. input was "\n\n\n\n") falls through to the
  // code template rather than emitting a blank message.
  const sanitized =
    typeof e.publicMessage === 'string' && e.publicMessage.length > 0
      ? sanitizeWireMessage(e.publicMessage)
      : '';
  const message = sanitized.length > 0
    ? sanitized
    : (CODE_MESSAGE_TEMPLATES[code] ?? 'Error');
  return { code, message };
}

export interface AcpListenerDeps {
  sender: SphereDmSender;
  receiver: SphereDmReceiver;
  config: TenantConfig;
  tenantPubkey: string;
  tenantDirectAddress: string;
  /** Registered Unicity ID (nametag) of this tenant, or null if none. */
  tenantNametag?: string | null;
  managerAddress: string;
  logger: Logger;
  stateStore?: TenantStateStore;
  /** Optional factory for custom command handler. When provided, used instead of createCommandHandler(). */
  commandHandlerFactory?: (instanceId: string, instanceName: string, startedAt: number, logger: Logger) => CommandHandler;
  /** Persistent replay guard for content-hash-based replay prevention. */
  replayGuard?: ReplayGuard;
}

export function createAcpListener(deps: AcpListenerDeps): AcpListener {
  const {
    sender,
    receiver,
    config,
    tenantPubkey,
    tenantDirectAddress,
    managerAddress,
    logger,
  } = deps;

  let subscription: DmSubscription | null = null;
  let stopped = false;
  /**
   * In-flight acp.command executions (manager AND controller paths). We must
   * await these before stop() proceeds to persistence, or an in-flight handler
   * can mutate owned state (WITHDRAW_TOKEN, SET_STRATEGY, ...) AFTER the
   * listener is nominally stopped — while main.ts is already tearing down the
   * Sphere. Tracked as a Set of Promises so multiple concurrent commands are
   * all awaited, with a bounded timeout so a hung command can't block
   * shutdown indefinitely.
   */
  const inFlightCommands = new Set<Promise<unknown>>();
  /** Maximum time stop() will wait for in-flight commands before proceeding. */
  const IN_FLIGHT_SHUTDOWN_TIMEOUT_MS = 5_000;
  /**
   * True once state recovery has completed for THE CURRENT RUN (including the
   * ENOENT-treated-as-fresh-start case). Guards stop()'s persistence path:
   * without it, a container SIGTERM'd mid-init would clobber a previously-
   * saved non-zero snapshot with fresh zeroes.
   *
   * Reset to `false` at the TOP of every start() call (round-18 F1) so the
   * invariant is PER-RUN: a previous successful start cannot leak its
   * "startedOnce=true" state into a later run whose recovery threw. Only
   * promoted back to `true` when the current run's recovery succeeded (or was
   * benignly absent via ENOENT). If the current run's load() throws, stop()
   * will NOT persist the in-memory counters — we don't know what's on disk
   * and must not overwrite it.
   */
  let startedOnce = false;
  /**
   * True only after start() has fully completed (past sendDm(hello)). Used to
   * gate the heartbeat.start() call in the acp.hello_ack handler so a
   * buffered/replayed hello_ack arriving DURING the sendDm(hello) await
   * window can't start the heartbeat before start() has confirmed setup —
   * otherwise a sendDm failure in start() would unsubscribe the DM feed but
   * leave the heartbeat firing forever with no way to stop it from outside.
   */
  let startCompleted = false;
  let messageCount = 0;
  let lastActivityMs = 0;

  const MIN_HEARTBEAT_MS = 1000;
  const replayGuard = deps.replayGuard;

  // --- Controller authority scope ---
  //
  // The design places the controller on top of the agent it spawned: the controller
  // IS the owner. Operations that are "owner-scoped" are accessible to the direct
  // controller. Operations that are "system-scoped" (touching the container sandbox,
  // host lifecycle, or diagnostic telemetry the manager aggregates) stay with the
  // manager.
  //
  // SYSTEM_ONLY_COMMANDS — manager-only:
  //   STATUS, SHUTDOWN_GRACEFUL, SET_LOG_LEVEL
  //     Host-level lifecycle + observability the manager coordinates across tenants.
  //   EXEC
  //     Arbitrary shell inside the tenant container. This breaks out of the "agent"
  //     abstraction and touches host-visible process state. Even though the controller
  //     is the owner, compromising the controller key should NOT equal a tenant root
  //     credential — the manager's narrower audit boundary holds it instead.
  //
  // NOT IN THIS SET (intentionally owner-scoped, controller-reachable):
  //   SET_STRATEGY — mutates trusted_escrows and trading policy. The owner controls
  //                  their own trust root; it is not a host-level policy.
  //   WITHDRAW_TOKEN — moves the owner's assets. The owner owns them.
  //   CREATE_INTENT / CANCEL_INTENT / LIST_INTENTS / LIST_SWAPS / GET_PORTFOLIO /
  //   DEBUG_* / GET_SWAP_PROGRESS — owner-scoped agent operations.
  //
  // If you add a new command that touches the CONTAINER (filesystem paths outside
  // /data/wallet and /data/tokens, process table, network namespace, etc.) add it
  // to SYSTEM_ONLY_COMMANDS. If it touches the AGENT's owned state, it stays open
  // to the controller.
  const SYSTEM_ONLY_COMMANDS = new Set(['STATUS', 'SHUTDOWN_GRACEFUL', 'SET_LOG_LEVEL', 'EXEC']);

  const heartbeat: HeartbeatEmitter = createHeartbeatEmitter(
    sender,
    config.instance_id,
    config.instance_name,
    managerAddress,
    logger.child({ component: 'heartbeat' }),
  );

  // Deferred to start() so STATUS uptime reflects actual start time, not construction time
  let commandHandler: CommandHandler | null = null;

  const messageHandler: MessageHandler = createMessageHandler(
    logger.child({ component: 'message-handler' }),
  );

  async function handleManagerMessage(content: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      logger.warn('invalid_json_from_manager', { content_length: content.length });
      return;
    }

    if (!isValidAcpMessage(parsed)) {
      logger.warn('invalid_acp_from_manager');
      return;
    }

    const msg = parsed as AcpMessage;

    // Content-hash replay guard: hash the full DM content and check against
    // a persistent set. The msg_id UUID acts as a nonce — same content with
    // different msg_id produces different hash. Attacker can't modify the
    // content without the sender's private key (NIP-17 encrypted).
    if (replayGuard && !replayGuard.check(content)) {
      logger.debug('acp_replay_rejected', { msg_id: msg.msg_id, type: msg.type });
      return;
    }

    // Increment counters before processing so STATUS always reflects current count
    messageCount++;
    lastActivityMs = Date.now();

    switch (msg.type) {
      case 'acp.hello_ack': {
        const payload = msg.payload as { accepted?: boolean; heartbeat_interval_ms?: number };
        if (payload.accepted === false) {
          logger.warn('hello_ack_rejected', { instance_id: config.instance_id });
          break;
        }
        // W8: Don't start heartbeat if stop() already ran (race with in-flight hello_ack)
        if (stopped) break;
        // F2: Don't start heartbeat before start() has fully completed. A
        // buffered/replayed hello_ack can arrive during the sendDm(hello)
        // await window; if sendDm then throws, start()'s catch unsubscribes
        // the DM feed — but a heartbeat started here would keep firing
        // forever with no owner to stop it.
        if (!startCompleted) {
          logger.warn('hello_ack_before_start_completed_dropped', { instance_id: config.instance_id });
          break;
        }
        // W6: Clamp interval to prevent tight-loop from hostile manager
        const rawInterval = typeof payload.heartbeat_interval_ms === 'number'
          ? payload.heartbeat_interval_ms
          : config.heartbeat_interval_ms;
        const safeInterval = Number.isFinite(rawInterval) ? rawInterval : config.heartbeat_interval_ms;
        const interval = Math.max(safeInterval, MIN_HEARTBEAT_MS);
        heartbeat.start(interval);
        // W5: Clear boot token from process environment after successful handshake
        delete process.env['UNICITY_BOOT_TOKEN'];
        logger.info('hello_ack_received', { heartbeat_interval_ms: interval });
        break;
      }

      case 'acp.ping': {
        const pong = createAcpMessage('acp.pong', config.instance_id, config.instance_name, {
          in_reply_to: msg.msg_id,
          ts_ms: Date.now(),
        });
        sender.sendDm(managerAddress, serializeMessage(pong)).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.error('pong_send_failed', { error: message });
        });
        logger.debug('ping_pong', { in_reply_to: msg.msg_id });
        break;
      }

      case 'acp.command': {
        // Round-18 F3: Drop commands that arrive after stop() has begun.
        // Previously only acp.hello_ack checked `stopped`, so an in-flight
        // acp.command could execute fully (potentially mutating state via
        // WITHDRAW_TOKEN, SET_STRATEGY, etc.) after the container was
        // nominally stopped. The tenant MUST NOT mutate owned state while it
        // has no live heartbeat and no live DM subscription — observers
        // (manager, controller) believe the tenant is quiesced.
        if (stopped) {
          logger.warn('command_received_after_stop_dropped', {
            instance_id: msg.instance_id,
            msg_id: msg.msg_id,
          });
          break;
        }
        const cmdPayload = msg.payload as unknown as AcpCommandPayload;
        // Validate required fields before accessing
        if (typeof cmdPayload.name !== 'string' || typeof cmdPayload.command_id !== 'string') {
          logger.warn('invalid_acp_command_payload', { instance_id: msg.instance_id });
          const errResponse = createAcpMessage('acp.error', config.instance_id, config.instance_name, {
            command_id: typeof cmdPayload.command_id === 'string' ? cmdPayload.command_id : '',
            ok: false,
            error_code: 'INVALID_PAYLOAD',
            message: 'acp.command requires string command_id and name fields',
          });
          sender.sendDm(managerAddress, serializeMessage(errResponse)).catch((err: unknown) => {
            logger.error('error_response_send_failed', { error: err instanceof Error ? err.message : String(err) });
          });
          break;
        }
        if (!commandHandler) {
          logger.error('command_before_start', { command: cmdPayload.name });
          break;
        }
        // Round-19 F2: Track in-flight command execution so stop() can await
        // them before persisting state / shutting down the Sphere. Previously
        // `await commandHandler.execute(...)` ran to completion even after
        // `stopped = true`, meaning WITHDRAW_TOKEN / SET_STRATEGY / etc.
        // could mutate owned state AFTER the listener was nominally stopped
        // (dangling handler vs. a Sphere that main.ts is already destroying).
        //
        // Wrap in a tracked promise. The handler still sends acp.result /
        // acp.error on its own; we just need a handle to Promise.allSettled
        // against in stop(). We capture `handlerCmd` so the closure below can
        // reference the exact command that spawned this execution — the outer
        // `cmdPayload` is scoped to the switch case and still live, but the
        // explicit capture makes the intent clear.
        const handlerCmd = cmdPayload;
        // Capture a local reference so the closure below doesn't have to
        // re-narrow `commandHandler` (which TS treats as nullable across the
        // async boundary even though we just guarded `!commandHandler` above).
        const handler = commandHandler;
        const execution: Promise<void> = (async () => {
          // Wrap commandHandler.execute in try/catch so an unexpected throw
          // can't be swallowed silently — the controller's request would
          // otherwise time out at 30s with zero diagnostic. Send an acp.error
          // DM back so the caller sees a structured failure instead of a
          // transport timeout.
          try {
            const result = await handler.execute(handlerCmd.name, {
              ...(handlerCmd.params && typeof handlerCmd.params === 'object' ? handlerCmd.params : {}),
              command_id: handlerCmd.command_id,
            });
            if (handlerCmd.name.toUpperCase() === 'SHUTDOWN_GRACEFUL' && result.ok && deps.stateStore) {
              try {
                await deps.stateStore.save({
                  instance_id: config.instance_id,
                  message_count: messageCount,
                  last_activity_ms: lastActivityMs,
                  custom: {},
                });
              } catch {
                // Best effort
              }
            }
            const responseType = result.ok ? 'acp.result' as const : 'acp.error' as const;
            const response = createAcpMessage(
              responseType,
              config.instance_id,
              config.instance_name,
              result as unknown as Record<string, unknown>,
            );
            sender.sendDm(managerAddress, serializeMessage(response)).catch((err: unknown) => {
              const message = err instanceof Error ? err.message : String(err);
              logger.error('command_response_send_failed', { error: message });
            });
            logger.debug('command_handled', { command: handlerCmd.name, ok: result.ok });
          } catch (err: unknown) {
            // F4/F5: err.message may contain file paths, SDK assertion strings,
            // wallet balances, or other internal detail that must not leak over
            // the wire. toWireError() maps the error to a code from the wire-
            // safe allowlist (defaulting to INTERNAL_ERROR) and a message that
            // is EITHER a handler-supplied `publicMessage` (explicit opt-in,
            // length-bounded) OR a templated default for the code. Operators
            // still see the full stack trace in local logs.
            const e = err as Error & { stack?: string };
            const { code: wireCode, message: wireMessage } = toWireError(err);
            logger.error('command_handler_threw', {
              command: handlerCmd.name,
              error: String(err),
              stack: e.stack,
            });
            const errResponse = createAcpMessage('acp.error', config.instance_id, config.instance_name, {
              command_id: handlerCmd.command_id,
              ok: false,
              error_code: wireCode,
              message: wireMessage,
            });
            sender.sendDm(managerAddress, serializeMessage(errResponse)).catch((sendErr: unknown) => {
              logger.warn('internal_error_send_failed', {
                error: sendErr instanceof Error ? sendErr.message : String(sendErr),
              });
            });
          }
        })();

        inFlightCommands.add(execution);
        void execution.finally(() => {
          inFlightCommands.delete(execution);
        });
        break;
      }

      default: {
        logger.debug('unhandled_acp_type', { type: msg.type });
        break;
      }
    }
  }

  async function handleControllerCommand(senderPubkey: string, senderAddress: string, content: string): Promise<void> {
    // Round-18 F3: Drop controller commands that arrive after stop() has
    // begun. Mirrors the manager-path check in handleManagerMessage.
    // Without this guard, a WITHDRAW_TOKEN or SET_STRATEGY from the
    // controller could execute after the container was nominally stopped.
    if (stopped) {
      logger.warn('controller_command_received_after_stop_dropped', {
        sender: senderPubkey.slice(0, 16),
      });
      return;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(content); } catch { return; }

    if (!isValidAcpMessage(parsed)) {
      logger.warn('invalid_acp_from_controller', { sender: senderPubkey.slice(0, 16) });
      return;
    }
    const msg = parsed as AcpMessage;

    // Content-hash replay guard applies to controller commands too
    if (replayGuard && !replayGuard.check(content)) {
      logger.debug('controller_replay_rejected', { msg_id: msg.msg_id });
      return;
    }

    if (msg.type !== 'acp.command') {
      logger.warn('controller_non_command_rejected', { type: msg.type, sender: senderPubkey.slice(0, 16) });
      return;
    }

    const cmdPayload = msg.payload as unknown as AcpCommandPayload;
    if (typeof cmdPayload.name !== 'string' || typeof cmdPayload.command_id !== 'string') {
      const errResponse = createAcpMessage('acp.error', config.instance_id, config.instance_name, {
        command_id: '',
        ok: false,
        error_code: 'INVALID_PAYLOAD',
        message: 'acp.command requires string command_id and name fields',
      });
      sender.sendDm(senderAddress, serializeMessage(errResponse)).catch((err: unknown) => {
        logger.warn('error_response_send_failed', { error: err instanceof Error ? err.message : String(err) });
      });
      return;
    }

    const upperName = cmdPayload.name.toUpperCase();
    if (SYSTEM_ONLY_COMMANDS.has(upperName)) {
      logger.warn('controller_system_command_rejected', { command: cmdPayload.name, sender: senderPubkey.slice(0, 16) });
      const errResponse = createAcpMessage('acp.error', config.instance_id, config.instance_name, {
        command_id: cmdPayload.command_id,
        ok: false,
        error_code: 'UNAUTHORIZED',
        message: `System command "${cmdPayload.name}" can only be sent by the host manager`,
      });
      sender.sendDm(senderAddress, serializeMessage(errResponse)).catch((err: unknown) => {
        logger.warn('error_response_send_failed', { error: err instanceof Error ? err.message : String(err) });
      });
      return;
    }

    messageCount++;
    lastActivityMs = Date.now();

    if (!commandHandler) {
      logger.error('controller_command_before_start', { command: cmdPayload.name });
      return;
    }

    // Round-19 F2: Track in-flight controller commands too. Same rationale as
    // the manager path: a controller-issued WITHDRAW_TOKEN that started before
    // stop() must run to completion — or be bounded by the shutdown timeout —
    // before stop() moves on to state persistence.
    const handlerCmd = cmdPayload;
    const handler = commandHandler;
    const execution: Promise<void> = (async () => {
      // Wrap execute in try/catch mirroring the manager path so the controller
      // also receives a structured acp.error on unexpected throws instead of a
      // 30s transport timeout.
      try {
        const result = await handler.execute(handlerCmd.name, {
          ...(handlerCmd.params && typeof handlerCmd.params === 'object' ? handlerCmd.params : {}),
          command_id: handlerCmd.command_id,
        });

        const responseType = result.ok ? 'acp.result' as const : 'acp.error' as const;
        const response = createAcpMessage(responseType, config.instance_id, config.instance_name, result as unknown as Record<string, unknown>);
        sender.sendDm(senderAddress, serializeMessage(response)).catch((err: unknown) => {
          logger.error('controller_response_send_failed', { error: err instanceof Error ? err.message : String(err) });
        });
      } catch (err: unknown) {
        // F4/F5: same scrubbing logic as the manager path — don't leak internal
        // error detail to the controller. toWireError() normalizes to a wire-
        // safe (code, message) pair; the message is EITHER a handler-supplied
        // `publicMessage` (explicit opt-in, length-bounded) OR a templated
        // default for the code.
        const e = err as Error & { stack?: string };
        const { code: wireCode, message: wireMessage } = toWireError(err);
        logger.error('controller_command_handler_threw', {
          command: handlerCmd.name,
          error: String(err),
          stack: e.stack,
        });
        const errResponse = createAcpMessage('acp.error', config.instance_id, config.instance_name, {
          command_id: handlerCmd.command_id,
          ok: false,
          error_code: wireCode,
          message: wireMessage,
        });
        sender.sendDm(senderAddress, serializeMessage(errResponse)).catch((sendErr: unknown) => {
          logger.warn('controller_internal_error_send_failed', {
            error: sendErr instanceof Error ? sendErr.message : String(sendErr),
          });
        });
      }
    })();

    inFlightCommands.add(execution);
    void execution.finally(() => {
      inFlightCommands.delete(execution);
    });
  }

  function handleExternalDm(senderPubkey: string, senderAddress: string, content: string): void {
    messageCount++;
    lastActivityMs = Date.now();
    messageHandler.handleDm(senderPubkey, senderAddress, content).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('external_dm_handler_failed', { error: message });
    });
  }

  return {
    async start(): Promise<void> {
      // F7: Throw on duplicate start() instead of silently returning. Callers
      // should explicitly stop() before restarting; silent success masked bugs
      // where two code paths both tried to start the listener. Also reset the
      // `stopped` flag so a legitimate stop() → start() restart works — without
      // this, every DM after restart would be dropped by the stopped-guard in
      // handleManagerMessage().
      if (subscription) {
        throw new Error('AcpListener already started');
      }
      stopped = false;
      // F2: reset per-run flag so a legitimate stop() → start() cycle doesn't
      // inherit the previous run's "completed" state.
      startCompleted = false;

      // Round-18 F1 + F2: Reset per-run state at the TOP of start(), BEFORE
      // attempting recovery. Previously `startedOnce`, `messageCount`, and
      // `lastActivityMs` were only initialized once at closure construction
      // and mutated by a successful load(). On a restart where load() throws
      // (real I/O error, not benign ENOENT), `startedOnce` would remain true
      // from the FIRST successful start — causing stop() to persist zeroed
      // counters from a failed recovery, clobbering on-disk state. And the
      // counters themselves would linger from the prior run rather than
      // reflecting "we don't trust anything about the prior state."
      //
      // Per-run invariant: these three fields describe ONLY the current run
      // until recovery either succeeds or benignly confirms a fresh start.
      startedOnce = false;
      messageCount = 0;
      lastActivityMs = 0;

      // Attempt to recover prior state — graceful fallback on any error.
      // F1: We must decide whether recovery succeeded (or was benignly absent)
      // vs. actually threw. Only the success/benign path promotes us to
      // "startedOnce" territory where stop() is safe to persist.
      let recoveryOk = true;
      if (deps.stateStore) {
        try {
          const prior = await deps.stateStore.load();
          if (prior) {
            messageCount = prior.message_count;
            lastActivityMs = prior.last_activity_ms;
            logger.info('state_recovered', { message_count: messageCount, last_activity_ms: lastActivityMs });
          }
          // `prior === null` is the ENOENT-treated-as-fresh-start case: a
          // legitimate first boot. Still counts as recoveryOk.
        } catch (err) {
          // State recovery threw — do NOT flip startedOnce. On stop() we'll
          // skip persistence so we don't clobber whatever is already on disk
          // (which we failed to read and might not have been zero).
          recoveryOk = false;
          logger.warn('state_recovery_failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // F1: Set startedOnce here — AFTER recovery has completed (success or
      // benign no-op), BEFORE wiring the DM subscription. This way any counter
      // increments triggered by DMs arriving during the sendDm(hello) await
      // window are guaranteed to be persisted on stop(), even if sendDm later
      // throws. We only skip this if state recovery itself threw, per above.
      if (recoveryOk) {
        startedOnce = true;
      }

      // Create command handler at start() time for accurate uptime reporting
      const startedAt = Date.now();
      const cmdLogger = logger.child({ component: 'command-handler' });
      if (deps.commandHandlerFactory) {
        commandHandler = deps.commandHandlerFactory(config.instance_id, config.instance_name, startedAt, cmdLogger);
      } else {
        commandHandler = createCommandHandler(
          config.instance_id,
          config.instance_name,
          startedAt,
          cmdLogger,
          () => ({ message_count: messageCount, last_activity_ms: lastActivityMs }),
        );
      }

      // Set up DM subscription BEFORE sending acp.hello so any immediate
      // hello_ack is captured. If anything below this point throws, we must
      // unsubscribe to avoid leaking a dangling listener on a listener that
      // was never successfully started.
      subscription = receiver.subscribeDm();
      try {
        subscription.onMessage((senderPubkey: string, senderAddress: string, content: string) => {
          // Enforce size limit before any parsing to prevent OOM/CPU exhaustion
          if (content.length > 65536) {
            logger.warn('oversized_dm_dropped', { sender: senderPubkey.slice(0, 16) + '...', size: content.length });
            return;
          }

          // Route based on sender identity
          if (pubkeysEqual(senderPubkey, config.manager_pubkey)) {
            handleManagerMessage(content).catch((err: unknown) => {
              logger.error('handle_manager_message_error', {
                error: err instanceof Error ? err.message : String(err),
              });
            });
          } else if (config.controller_pubkey && pubkeysEqual(senderPubkey, config.controller_pubkey)) {
            handleControllerCommand(senderPubkey, senderAddress, content).catch((err: unknown) => {
              logger.error('handle_controller_command_error', {
                error: err instanceof Error ? err.message : String(err),
              });
            });
          } else {
            handleExternalDm(senderPubkey, senderAddress, content);
          }
        });

        // Send acp.hello to manager
        const helloMsg = createAcpMessage('acp.hello', config.instance_id, config.instance_name, {
          boot_token: config.boot_token,
          tenant_pubkey: tenantPubkey,
          tenant_direct_address: tenantDirectAddress,
          tenant_nametag: deps.tenantNametag ?? null,
          adapter: {
            name: 'tenant-cli-boilerplate',
            version: '0.1',
            capabilities: ['heartbeat', 'ping', 'shutdown', 'status'],
          },
        });
        await sender.sendDm(managerAddress, serializeMessage(helloMsg));
        logger.info('hello_sent', { instance_id: config.instance_id });

        // F2: Mark start() as fully completed ONLY at the very end. The
        // hello_ack handler gates heartbeat.start() on this flag so a
        // replayed/buffered hello_ack arriving during sendDm(hello) can't
        // start a heartbeat we'd be unable to clean up if sendDm then threw.
        startCompleted = true;
        logger.info('acp_listener_started');
      } catch (err) {
        // Cleanup subscription if start() fails after subscribing — otherwise
        // the receiver leaks a listener attached to a listener that was never
        // started, and restart attempts produce duplicate listeners.
        try { subscription.unsubscribe(); } catch { /* best effort */ }
        subscription = null;
        // F2: Defensively stop the heartbeat in case an in-flight hello_ack
        // managed to start it before the startCompleted gate was added (or
        // via a future code path). Redundant when the gate is in place, but
        // harmless — heartbeat.stop() is idempotent.
        try { heartbeat.stop(); } catch { /* best effort */ }
        throw err;
      }
    },

    async stop(): Promise<void> {
      // F3: idempotency guard. Calling stop() twice would previously double-
      // write state (two stateStore.save() calls) and emit two
      // "acp_listener_stopped" log lines. `stopped` doubles as the idempotency
      // flag here — it's reset to false in start(), so a legitimate
      // stop → start → stop sequence still works. Set BEFORE any await so
      // two concurrent stop() calls racing into this method can't both pass
      // the guard.
      if (stopped) return;
      stopped = true;
      heartbeat.stop();
      if (subscription) {
        subscription.unsubscribe();
        subscription = null;
      }

      // Round-19 F2: Wait for in-flight commands to complete BEFORE we persist
      // state. Previously an `await commandHandler.execute(...)` could be
      // mid-flight when stop() ran — it would continue mutating Sphere state
      // AFTER we already believed the listener was quiesced, and the caller
      // (main.ts) would then destroy the Sphere out from under it. Bounded by
      // a timeout so a hung handler can't block shutdown indefinitely.
      if (inFlightCommands.size > 0) {
        const inFlightSnapshot = Array.from(inFlightCommands);
        logger.info('waiting_for_inflight_commands', { count: inFlightSnapshot.length });
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        const timeoutPromise = new Promise<'timeout'>((resolve) => {
          timeoutHandle = setTimeout(() => resolve('timeout'), IN_FLIGHT_SHUTDOWN_TIMEOUT_MS);
        });
        const result = await Promise.race([
          Promise.allSettled(inFlightSnapshot).then(() => 'done' as const),
          timeoutPromise,
        ]);
        if (timeoutHandle !== null) clearTimeout(timeoutHandle);
        if (result === 'timeout') {
          logger.warn('inflight_commands_timeout_on_stop', {
            still_pending: inFlightCommands.size,
          });
        }
      }

      // Persist last state AFTER stopping inbound so the saved snapshot matches
      // the moment we stopped accepting work.
      //
      // F1/F3: `startedOnce` is flipped as soon as state recovery completes
      // successfully (or benignly no-ops on ENOENT-first-boot) — BEFORE the DM
      // subscription is wired. So by the time any counter increments happen
      // (hello_ack, ping, command, external DM), startedOnce is already true
      // and those increments will be persisted here. The flag only STAYS false
      // when the stateStore.load() call itself throws an I/O error, which is
      // the one case where we genuinely don't know what's on disk and must not
      // overwrite it. In that path we skip the save entirely.
      if (startedOnce && deps.stateStore) {
        try {
          await deps.stateStore.save({
            instance_id: config.instance_id,
            message_count: messageCount,
            last_activity_ms: lastActivityMs,
            custom: {},
          });
        } catch (err: unknown) {
          // Best effort — don't fail stop on persistence error
          logger.warn('state_save_on_stop_failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      logger.info('acp_listener_stopped');
    },

    isShutdownRequested(): boolean {
      return commandHandler?.isShutdownRequested() ?? false;
    },
  };
}
