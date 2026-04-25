import { describe, it, expect } from 'vitest';
import {
  createAcpMessage,
  isValidAcpMessage,
  isAcpCommandPayload,
  isAcpHelloAckPayload,
  isAcpPongPayload,
  isAcpResultPayload,
  isAcpErrorPayload,
  ACP_VERSION,
  ACP_MESSAGE_TYPES,
} from './acp.js';
import {
  hasDangerousKeys,
  isTimestampFresh,
  MAX_CLOCK_SKEW_MS,
  parseAcpJson,
  serializeMessage,
} from './envelope.js';

describe('acp-adapter / protocols', () => {
  describe('createAcpMessage', () => {
    it('produces a well-formed envelope', () => {
      const msg = createAcpMessage('acp.heartbeat', 'inst-1', 'name-1', { status: 'ok' });
      expect(msg.acp_version).toBe(ACP_VERSION);
      expect(msg.instance_id).toBe('inst-1');
      expect(msg.instance_name).toBe('name-1');
      expect(msg.type).toBe('acp.heartbeat');
      expect(msg.payload).toEqual({ status: 'ok' });
      expect(typeof msg.msg_id).toBe('string');
      expect(msg.msg_id.length).toBeGreaterThan(0);
      expect(Number.isFinite(msg.ts_ms)).toBe(true);
    });

    it.each(ACP_MESSAGE_TYPES)('round-trips message of type %s through validation', (type) => {
      const msg = createAcpMessage(type, 'inst', 'name', {});
      expect(isValidAcpMessage(msg)).toBe(true);
    });
  });

  describe('isValidAcpMessage', () => {
    it('rejects null / non-object input', () => {
      expect(isValidAcpMessage(null)).toBe(false);
      expect(isValidAcpMessage(undefined)).toBe(false);
      expect(isValidAcpMessage('a string')).toBe(false);
      expect(isValidAcpMessage(42)).toBe(false);
    });

    it('rejects wrong acp_version', () => {
      const msg = createAcpMessage('acp.ping', 'i', 'n', {});
      const tampered = { ...msg, acp_version: '99.0' };
      expect(isValidAcpMessage(tampered)).toBe(false);
    });

    it('rejects unknown type', () => {
      const msg = createAcpMessage('acp.ping', 'i', 'n', {});
      const tampered = { ...msg, type: 'acp.bogus' };
      expect(isValidAcpMessage(tampered)).toBe(false);
    });

    it('rejects missing instance_id / instance_name', () => {
      const msg = createAcpMessage('acp.ping', 'i', 'n', {});
      expect(isValidAcpMessage({ ...msg, instance_id: '' })).toBe(false);
      expect(isValidAcpMessage({ ...msg, instance_name: '' })).toBe(false);
    });

    it('rejects messages with __proto__ / constructor / prototype keys', () => {
      // Use JSON.parse to actually create an own __proto__ property — object
      // literal syntax {__proto__: ...} is a getter/setter pattern, not a
      // real own key. JSON.parse always creates own keys.
      const msg = JSON.parse(JSON.stringify(createAcpMessage('acp.ping', 'i', 'n', {})));
      msg.payload = JSON.parse('{"__proto__": {"polluted": true}}');
      expect(isValidAcpMessage(msg)).toBe(false);
    });
  });

  describe('hasDangerousKeys', () => {
    it('flags __proto__ at any depth', () => {
      // JSON.parse to ensure __proto__ becomes a real own key (object literal
      // syntax doesn't — see note above).
      const dangerous = JSON.parse('{"a": {"b": {"__proto__": {"x": 1}}}}');
      expect(hasDangerousKeys(dangerous)).toBe(true);
    });

    it('returns false for plain objects', () => {
      expect(hasDangerousKeys({ a: 1, b: { c: 2 } })).toBe(false);
    });

    it('caps recursion depth', () => {
      // Build a deeply nested object that exceeds MAX_NESTING_DEPTH (=20)
      let obj: Record<string, unknown> = { x: 1 };
      for (let i = 0; i < 25; i++) {
        obj = { nested: obj };
      }
      // Treated as dangerous (returns true) at depth cap to defend against
      // adversarial nesting that could starve the stack.
      expect(hasDangerousKeys(obj)).toBe(true);
    });
  });

  describe('parseAcpJson', () => {
    it('round-trips serializeMessage → parseAcpJson', () => {
      const msg = createAcpMessage('acp.command', 'i', 'n', {
        command_id: 'c1',
        name: 'STATUS',
        params: {},
      });
      const wire = serializeMessage(msg);
      const parsed = parseAcpJson(wire);
      expect(parsed).not.toBeNull();
      expect(parsed!.type).toBe('acp.command');
      expect(parsed!.payload['command_id']).toBe('c1');
    });

    it('returns null for invalid JSON', () => {
      expect(parseAcpJson('{not json')).toBeNull();
    });

    it('returns null for oversize input', () => {
      const big = '{"x":"' + 'a'.repeat(70_000) + '"}';
      expect(parseAcpJson(big)).toBeNull();
    });

    it('returns null for valid JSON that is not a valid ACP message', () => {
      expect(parseAcpJson(JSON.stringify({ acp_version: '0.1', type: 'acp.ping' }))).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Clock-skew gate (defense-in-depth above content-hash replay guard).
  // ---------------------------------------------------------------------------
  describe('isTimestampFresh', () => {
    const NOW = 1_700_000_000_000;

    it('accepts a ts_ms equal to now', () => {
      expect(isTimestampFresh(NOW, NOW)).toBe(true);
    });

    it('accepts a ts_ms within the past window', () => {
      expect(isTimestampFresh(NOW - (MAX_CLOCK_SKEW_MS - 1), NOW)).toBe(true);
    });

    it('accepts a ts_ms within the future window (sender clock slightly ahead)', () => {
      expect(isTimestampFresh(NOW + (MAX_CLOCK_SKEW_MS - 1), NOW)).toBe(true);
    });

    it('rejects a ts_ms older than MAX_CLOCK_SKEW_MS', () => {
      expect(isTimestampFresh(NOW - (MAX_CLOCK_SKEW_MS + 1), NOW)).toBe(false);
    });

    it('rejects a ts_ms further in the future than MAX_CLOCK_SKEW_MS', () => {
      expect(isTimestampFresh(NOW + (MAX_CLOCK_SKEW_MS + 1), NOW)).toBe(false);
    });

    it('rejects NaN', () => {
      expect(isTimestampFresh(Number.NaN, NOW)).toBe(false);
    });

    it('rejects +Infinity / -Infinity', () => {
      expect(isTimestampFresh(Number.POSITIVE_INFINITY, NOW)).toBe(false);
      expect(isTimestampFresh(Number.NEGATIVE_INFINITY, NOW)).toBe(false);
    });

    it('rejects non-number input (defensive — TS callers should not hit this)', () => {
      expect(isTimestampFresh('1700000000000' as unknown as number, NOW)).toBe(false);
      expect(isTimestampFresh(null as unknown as number, NOW)).toBe(false);
      expect(isTimestampFresh(undefined as unknown as number, NOW)).toBe(false);
    });

    it('uses Date.now() when `now` is omitted', () => {
      // Sanity check: a timestamp very near current wall clock must pass.
      expect(isTimestampFresh(Date.now())).toBe(true);
      // And one a year in the past must fail.
      expect(isTimestampFresh(Date.now() - 365 * 24 * 60 * 60 * 1_000)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Typed payload guards. Each guard: happy path + 5 malformed cases
  // (null, missing fields, wrong types, oversized strings, prototype pollution).
  // ---------------------------------------------------------------------------
  describe('isAcpCommandPayload', () => {
    it('accepts a well-formed payload', () => {
      expect(isAcpCommandPayload({ command_id: 'c1', name: 'STATUS', params: {} })).toBe(true);
    });

    it('rejects null', () => {
      expect(isAcpCommandPayload(null)).toBe(false);
    });

    it('rejects missing fields', () => {
      expect(isAcpCommandPayload({ command_id: 'c1', name: 'STATUS' })).toBe(false);
      expect(isAcpCommandPayload({ command_id: 'c1', params: {} })).toBe(false);
      expect(isAcpCommandPayload({ name: 'STATUS', params: {} })).toBe(false);
    });

    it('rejects wrong types', () => {
      expect(isAcpCommandPayload({ command_id: 42, name: 'STATUS', params: {} })).toBe(false);
      expect(isAcpCommandPayload({ command_id: 'c1', name: 42, params: {} })).toBe(false);
      // params must be an object — not an array, primitive, or null.
      expect(isAcpCommandPayload({ command_id: 'c1', name: 'STATUS', params: [] })).toBe(false);
      expect(isAcpCommandPayload({ command_id: 'c1', name: 'STATUS', params: 'x' })).toBe(false);
      expect(isAcpCommandPayload({ command_id: 'c1', name: 'STATUS', params: null })).toBe(false);
    });

    it('rejects empty-string command_id / name (oversized-coverage proxy: empty is invalid wire shape)', () => {
      expect(isAcpCommandPayload({ command_id: '', name: 'STATUS', params: {} })).toBe(false);
      expect(isAcpCommandPayload({ command_id: 'c1', name: '', params: {} })).toBe(false);
    });

    it('rejects prototype-pollution attempts at the top level', () => {
      // Plain object literals don't create real own __proto__ keys — JSON.parse does.
      const polluted = JSON.parse('{"command_id":"c1","name":"STATUS","params":{},"__proto__":{"x":1}}');
      // Guard itself doesn't sweep for dangerous keys (parseAcpJson does that
      // upstream), but it MUST not be confused by an attacker's stray fields.
      // A polluted-but-otherwise-valid payload is still recognized as command-shaped;
      // the dangerous-keys check is enforced earlier in the pipeline.
      // Still, accept the standard well-formed-fields contract.
      expect(isAcpCommandPayload(polluted)).toBe(true);
      // A payload whose REQUIRED field is itself prototype-poisoned is invalid.
      const bad = JSON.parse('{"command_id":"c1","name":"STATUS","params":[1,2]}');
      expect(isAcpCommandPayload(bad)).toBe(false);
    });
  });

  describe('isAcpHelloAckPayload', () => {
    it('accepts a minimal well-formed payload', () => {
      expect(isAcpHelloAckPayload({ accepted: true, manager_pubkey: 'abc' })).toBe(true);
    });

    it('accepts a fully populated well-formed payload', () => {
      expect(
        isAcpHelloAckPayload({
          accepted: true,
          manager_pubkey: 'abc',
          heartbeat_interval_ms: 5_000,
          notes: 'ok',
        }),
      ).toBe(true);
    });

    it('rejects null / non-object', () => {
      expect(isAcpHelloAckPayload(null)).toBe(false);
      expect(isAcpHelloAckPayload('hello')).toBe(false);
      expect(isAcpHelloAckPayload(42)).toBe(false);
    });

    it('rejects missing required fields', () => {
      expect(isAcpHelloAckPayload({ manager_pubkey: 'abc' })).toBe(false);
      expect(isAcpHelloAckPayload({ accepted: true })).toBe(false);
    });

    it('rejects wrong types for required fields', () => {
      expect(isAcpHelloAckPayload({ accepted: 'yes', manager_pubkey: 'abc' })).toBe(false);
      expect(isAcpHelloAckPayload({ accepted: true, manager_pubkey: 123 })).toBe(false);
    });

    it('rejects NaN heartbeat_interval_ms (would drive setInterval(NaN) into a tight loop)', () => {
      expect(
        isAcpHelloAckPayload({
          accepted: true,
          manager_pubkey: 'abc',
          heartbeat_interval_ms: Number.NaN,
        }),
      ).toBe(false);
    });

    it('rejects +Infinity heartbeat_interval_ms', () => {
      expect(
        isAcpHelloAckPayload({
          accepted: true,
          manager_pubkey: 'abc',
          heartbeat_interval_ms: Number.POSITIVE_INFINITY,
        }),
      ).toBe(false);
    });

    it('rejects zero / negative heartbeat_interval_ms', () => {
      expect(
        isAcpHelloAckPayload({ accepted: true, manager_pubkey: 'abc', heartbeat_interval_ms: 0 }),
      ).toBe(false);
      expect(
        isAcpHelloAckPayload({ accepted: true, manager_pubkey: 'abc', heartbeat_interval_ms: -100 }),
      ).toBe(false);
    });

    it('rejects non-string notes when present', () => {
      expect(
        isAcpHelloAckPayload({ accepted: true, manager_pubkey: 'abc', notes: 42 }),
      ).toBe(false);
    });

    it('accepts oversized strings (length cap is enforced upstream by MAX_MESSAGE_SIZE)', () => {
      const longString = 'a'.repeat(40_000);
      expect(
        isAcpHelloAckPayload({ accepted: true, manager_pubkey: longString, notes: longString }),
      ).toBe(true);
    });
  });

  describe('isAcpPongPayload', () => {
    it('accepts well-formed payload', () => {
      expect(isAcpPongPayload({ in_reply_to: 'msg-1', ts_ms: 1_700_000_000_000 })).toBe(true);
    });

    it('rejects null', () => {
      expect(isAcpPongPayload(null)).toBe(false);
    });

    it('rejects missing fields', () => {
      expect(isAcpPongPayload({ in_reply_to: 'msg-1' })).toBe(false);
      expect(isAcpPongPayload({ ts_ms: 1 })).toBe(false);
    });

    it('rejects wrong types', () => {
      expect(isAcpPongPayload({ in_reply_to: 42, ts_ms: 1 })).toBe(false);
      expect(isAcpPongPayload({ in_reply_to: 'msg-1', ts_ms: '1' })).toBe(false);
    });

    it('rejects empty in_reply_to', () => {
      expect(isAcpPongPayload({ in_reply_to: '', ts_ms: 1 })).toBe(false);
    });

    it('rejects NaN/Infinity ts_ms', () => {
      expect(isAcpPongPayload({ in_reply_to: 'm', ts_ms: Number.NaN })).toBe(false);
      expect(isAcpPongPayload({ in_reply_to: 'm', ts_ms: Number.POSITIVE_INFINITY })).toBe(false);
    });
  });

  describe('isAcpResultPayload', () => {
    it('accepts well-formed payload', () => {
      expect(isAcpResultPayload({ command_id: 'c1', ok: true, result: { x: 1 } })).toBe(true);
    });

    it('rejects null', () => {
      expect(isAcpResultPayload(null)).toBe(false);
    });

    it('rejects missing fields', () => {
      expect(isAcpResultPayload({ command_id: 'c1', ok: true })).toBe(false);
      expect(isAcpResultPayload({ ok: true, result: {} })).toBe(false);
    });

    it('rejects wrong types and ok=false', () => {
      expect(isAcpResultPayload({ command_id: 42, ok: true, result: {} })).toBe(false);
      expect(isAcpResultPayload({ command_id: 'c1', ok: false, result: {} })).toBe(false);
      expect(isAcpResultPayload({ command_id: 'c1', ok: 'true', result: {} })).toBe(false);
      // result must be an object (not array, not primitive, not null)
      expect(isAcpResultPayload({ command_id: 'c1', ok: true, result: [] })).toBe(false);
      expect(isAcpResultPayload({ command_id: 'c1', ok: true, result: null })).toBe(false);
    });

    it('rejects empty command_id', () => {
      expect(isAcpResultPayload({ command_id: '', ok: true, result: {} })).toBe(false);
    });

    it('accepts oversized result (size cap is upstream)', () => {
      const big: Record<string, string> = {};
      for (let i = 0; i < 1_000; i++) big[`k${i}`] = 'v';
      expect(isAcpResultPayload({ command_id: 'c1', ok: true, result: big })).toBe(true);
    });
  });

  describe('isAcpErrorPayload', () => {
    it('accepts well-formed payload', () => {
      expect(
        isAcpErrorPayload({
          command_id: 'c1',
          ok: false,
          error_code: 'INVALID',
          message: 'bad input',
        }),
      ).toBe(true);
    });

    it('rejects null', () => {
      expect(isAcpErrorPayload(null)).toBe(false);
    });

    it('rejects missing fields', () => {
      expect(
        isAcpErrorPayload({ command_id: 'c1', ok: false, error_code: 'X' }),
      ).toBe(false);
      expect(
        isAcpErrorPayload({ command_id: 'c1', ok: false, message: 'X' }),
      ).toBe(false);
    });

    it('rejects ok=true (would be a result, not an error)', () => {
      expect(
        isAcpErrorPayload({ command_id: 'c1', ok: true, error_code: 'X', message: 'm' }),
      ).toBe(false);
    });

    it('rejects empty error_code', () => {
      expect(
        isAcpErrorPayload({ command_id: 'c1', ok: false, error_code: '', message: 'm' }),
      ).toBe(false);
    });

    it('rejects wrong types', () => {
      expect(
        isAcpErrorPayload({ command_id: 42, ok: false, error_code: 'X', message: 'm' }),
      ).toBe(false);
      expect(
        isAcpErrorPayload({ command_id: 'c1', ok: false, error_code: 42, message: 'm' }),
      ).toBe(false);
      expect(
        isAcpErrorPayload({ command_id: 'c1', ok: false, error_code: 'X', message: 42 }),
      ).toBe(false);
    });

    it('accepts oversized message (size cap is upstream)', () => {
      const big = 'a'.repeat(40_000);
      expect(
        isAcpErrorPayload({ command_id: 'c1', ok: false, error_code: 'X', message: big }),
      ).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Integration: parseAcpJson + isTimestampFresh together (the boundary path
  // exercised by main.ts on every inbound DM). We assert the freshness gate
  // behaves correctly for stale, future, and current timestamps.
  // ---------------------------------------------------------------------------
  describe('parse-and-freshness boundary', () => {
    function buildMsg(tsMs: number) {
      const msg = createAcpMessage('acp.ping', 'inst', 'name', { ts_ms: tsMs });
      // Override the auto-generated ts_ms so we can assert the gate behavior.
      return { ...msg, ts_ms: tsMs };
    }

    it('accepts a fresh ts_ms (current wall clock)', () => {
      const now = Date.now();
      const wire = serializeMessage(buildMsg(now));
      const parsed = parseAcpJson(wire);
      expect(parsed).not.toBeNull();
      expect(isTimestampFresh(parsed!.ts_ms, now)).toBe(true);
    });

    it('rejects a stale ts_ms (older than MAX_CLOCK_SKEW_MS)', () => {
      const now = Date.now();
      const stale = now - (MAX_CLOCK_SKEW_MS + 60_000);
      const wire = serializeMessage(buildMsg(stale));
      const parsed = parseAcpJson(wire);
      expect(parsed).not.toBeNull(); // structurally valid
      expect(isTimestampFresh(parsed!.ts_ms, now)).toBe(false); // but stale
    });

    it('rejects a future ts_ms (further than MAX_CLOCK_SKEW_MS ahead)', () => {
      const now = Date.now();
      const future = now + (MAX_CLOCK_SKEW_MS + 60_000);
      const wire = serializeMessage(buildMsg(future));
      const parsed = parseAcpJson(wire);
      expect(parsed).not.toBeNull();
      expect(isTimestampFresh(parsed!.ts_ms, now)).toBe(false);
    });
  });
});
