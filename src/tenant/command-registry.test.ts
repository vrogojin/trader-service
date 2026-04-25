/**
 * Tests for the command registry + dispatcher.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createCommandRegistry,
  CommandError,
  InvalidParamsError,
  HandlerTimeoutError,
  DuplicateCommandError,
  InvalidCommandNameError,
  anyParams,
  noParams,
  readRegistryOptionsFromEnv,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_QUEUE_MAX,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  LOG_PARAMS_MAX_BYTES,
  type Validator,
  type CommandRegistry,
  type DispatchInput,
} from './command-registry.js';
import { createLogger, type Logger } from '../shared/logger.js';

// -----------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------

function makeLogger(capturedLines?: string[]): Logger {
  return createLogger({
    component: 'test',
    writer: capturedLines ? (line: string) => capturedLines.push(line) : () => {},
  });
}

function makeInput(overrides: Partial<DispatchInput> = {}): DispatchInput {
  return {
    name: 'ping',
    params: {},
    msgId: 'msg-1',
    commandId: 'cmd-1',
    instanceId: 'inst-1',
    instanceName: 'bot-1',
    ...overrides,
  };
}

// -----------------------------------------------------------------
// Basic registration
// -----------------------------------------------------------------

describe('CommandRegistry: registration', () => {
  let registry: CommandRegistry;

  beforeEach(() => {
    registry = createCommandRegistry();
  });

  it('registers a command and lists it', () => {
    registry.register('hello', {
      description: 'greets',
      handler: async () => ({ msg: 'hi' }),
    });
    expect(registry.has('hello')).toBe(true);
    const list = registry.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({ name: 'hello', description: 'greets' });
  });

  it('lookup is case-insensitive', () => {
    registry.register('Hello', { handler: async () => ({}) });
    expect(registry.has('hello')).toBe(true);
    expect(registry.has('HELLO')).toBe(true);
    expect(registry.has('HeLLo')).toBe(true);
  });

  it('rejects duplicate registration (default policy)', () => {
    registry.register('x', { handler: async () => ({}) });
    expect(() => registry.register('x', { handler: async () => ({}) })).toThrow(DuplicateCommandError);
    expect(() => registry.register('X', { handler: async () => ({}) })).toThrow(DuplicateCommandError);
  });

  it('unregister returns true when a command existed, false otherwise', () => {
    registry.register('x', { handler: async () => ({}) });
    expect(registry.unregister('x')).toBe(true);
    expect(registry.unregister('x')).toBe(false);
    expect(registry.has('x')).toBe(false);
  });

  it('clear() removes all commands', () => {
    registry.register('a', { handler: async () => ({}) });
    registry.register('b', { handler: async () => ({}) });
    registry.clear();
    expect(registry.list()).toEqual([]);
  });

  it('rejects invalid command names', () => {
    expect(() => registry.register('', { handler: async () => ({}) })).toThrow(CommandError);
  });
});

// -----------------------------------------------------------------
// Dispatch happy / sad paths
// -----------------------------------------------------------------

describe('CommandRegistry: dispatch', () => {
  let registry: CommandRegistry;
  let logger: Logger;
  let logLines: string[];

  beforeEach(() => {
    logLines = [];
    logger = makeLogger(logLines);
    registry = createCommandRegistry();
  });

  it('returns ok result when handler succeeds', async () => {
    registry.register('add', {
      handler: async (p: unknown) => {
        const params = p as { a: number; b: number };
        return { sum: params.a + params.b };
      },
    });
    const res = await registry.dispatch(makeInput({ name: 'add', params: { a: 2, b: 3 } }), logger);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result['sum']).toBe(5);
  });

  it('unknown_command when not registered', async () => {
    const res = await registry.dispatch(makeInput({ name: 'missing' }), logger);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error_code).toBe('unknown_command');
      expect(res.outcome).toBe('error');
    }
  });

  it('invalid_params when schema itself throws (buggy validator)', async () => {
    const throwing: Validator<never> = {
      parse() { throw new Error('boom inside validator'); },
    };
    registry.register('bad-validator', { paramsSchema: throwing, handler: async () => ({}) });
    const res = await registry.dispatch(makeInput({ name: 'bad-validator' }), logger);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error_code).toBe('invalid_params');
  });

  it('invalid_params when schema rejects', async () => {
    const onlyStrings: Validator<{ s: string }> = {
      parse(input) {
        const o = input as Record<string, unknown>;
        if (typeof o['s'] !== 'string') return { ok: false, reason: 's must be string', details: { field: 's' } };
        return { ok: true, value: { s: o['s'] } };
      },
    };
    registry.register('echo', {
      paramsSchema: onlyStrings,
      handler: async (p) => ({ s: p.s }),
    });
    const res = await registry.dispatch(makeInput({ name: 'echo', params: { s: 42 } }), logger);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error_code).toBe('invalid_params');
      expect(res.reason).toEqual({ field: 's' });
    }
  });

  it('noParams validator rejects unknown params', async () => {
    registry.register('p', { paramsSchema: noParams, handler: async () => ({}) });
    const res = await registry.dispatch(makeInput({ name: 'p', params: { extra: 1 } }), logger);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error_code).toBe('invalid_params');
  });

  it('noParams validator accepts command_id passthrough', async () => {
    registry.register('p', { paramsSchema: noParams, handler: async () => ({ ok: true }) });
    const res = await registry.dispatch(makeInput({ name: 'p', params: { command_id: 'xyz' } }), logger);
    expect(res.ok).toBe(true);
  });

  it('anyParams validator accepts object', async () => {
    registry.register('any', { paramsSchema: anyParams, handler: async (p) => ({ echo: p }) });
    const res = await registry.dispatch(makeInput({ name: 'any', params: { a: 1, b: 'x' } }), logger);
    expect(res.ok).toBe(true);
  });

  it('handler_error when handler throws a plain Error', async () => {
    registry.register('boom', {
      handler: async () => { throw new Error('raw internal detail /etc/passwd'); },
    });
    const res = await registry.dispatch(makeInput({ name: 'boom' }), logger);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error_code).toBe('handler_error');
      // Raw message passes through (sanitized — but /etc/passwd string itself
      // is valid text, no control chars to strip). Outer ACP listener layer
      // adds the actual secret-stripping pass.
      expect(res.message.length).toBeLessThanOrEqual(512);
    }
  });

  it('preserves CommandError.code and publicMessage', async () => {
    registry.register('err', {
      handler: async () => { throw new CommandError('my_code', 'short public msg', { foo: 'bar' }); },
    });
    const res = await registry.dispatch(makeInput({ name: 'err' }), logger);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error_code).toBe('my_code');
      expect(res.message).toBe('short public msg');
      expect(res.reason).toEqual({ foo: 'bar' });
    }
  });

  it('truncates and sanitizes long, control-char-laden error messages', async () => {
    const evil = 'prefix\u0000\u001bANSI' + 'x'.repeat(1000);
    registry.register('san', {
      handler: async () => { throw new Error(evil); },
    });
    const res = await registry.dispatch(makeInput({ name: 'san' }), logger);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.message).not.toContain('\u0000');
      expect(res.message).not.toContain('\u001b');
      expect(res.message.length).toBeLessThanOrEqual(512);
    }
  });

  it('result_not_serializable when handler returns circular/non-JSON', async () => {
    const circ: Record<string, unknown> = {};
    circ['self'] = circ;
    registry.register('circ', {
      handler: async () => circ,
    });
    const res = await registry.dispatch(makeInput({ name: 'circ' }), logger);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error_code).toBe('result_not_serializable');
  });

  it('result_not_serializable when handler returns a non-object scalar', async () => {
    registry.register('num', {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async () => 42 as any,
    });
    const res = await registry.dispatch(makeInput({ name: 'num' }), logger);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error_code).toBe('result_not_serializable');
  });

  it('result_not_serializable when handler returns an array', async () => {
    registry.register('arr', {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async () => [1, 2, 3] as any,
    });
    const res = await registry.dispatch(makeInput({ name: 'arr' }), logger);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error_code).toBe('result_not_serializable');
  });

  it('result_not_serializable for BigInt values in returned object', async () => {
    registry.register('big', {
      handler: async () => ({ value: BigInt(10) }),
    });
    const res = await registry.dispatch(makeInput({ name: 'big' }), logger);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error_code).toBe('result_not_serializable');
  });
});

// -----------------------------------------------------------------
// Timeout + AbortSignal propagation
// -----------------------------------------------------------------

describe('CommandRegistry: timeouts', () => {
  let registry: CommandRegistry;
  let logger: Logger;

  beforeEach(() => {
    vi.useFakeTimers();
    logger = makeLogger();
    registry = createCommandRegistry({ defaultTimeoutMs: 100 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns handler_timeout when handler exceeds timeout', async () => {
    registry.register('slow', {
      handler: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 10_000));
        return { ok: true };
      },
    });

    const p = registry.dispatch(makeInput({ name: 'slow' }), logger);
    // Advance past timeout
    await vi.advanceTimersByTimeAsync(150);
    // Let any scheduled microtasks settle
    await vi.runAllTimersAsync();
    const res = await p;
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error_code).toBe('handler_timeout');
      expect(res.outcome).toBe('timeout');
    }
  });

  it('raises AbortSignal when timeout fires', async () => {
    let observed = false;
    registry.register('abortable', {
      handler: async (_params, ctx) => {
        // Wait, then check aborted.
        await new Promise<void>((resolve) => setTimeout(resolve, 10_000));
        observed = ctx.signal.aborted;
        return { observed };
      },
    });
    const p = registry.dispatch(makeInput({ name: 'abortable' }), logger);
    await vi.advanceTimersByTimeAsync(150);
    await vi.runAllTimersAsync();
    await p;
    // The handler's setTimeout callback runs after abort was signaled;
    // by the time we examine `observed`, abort must have been true.
    expect(observed).toBe(true);
  });

  it('honors caller-supplied timeout up to maxTimeoutMs', async () => {
    // Use a registry with longer default + caller supplies a tighter (but
    // still valid, >= MIN_TIMEOUT_MS) timeout. The handler waits longer than
    // the caller's timeout so we expect handler_timeout.
    vi.useRealTimers();
    const registryLocal = createCommandRegistry({ defaultTimeoutMs: 1000 });
    registryLocal.register('fast', {
      handler: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 1000));
        return { ok: true };
      },
    });

    // Caller-supplied timeout = MIN_TIMEOUT_MS (100ms). Handler awaits 1000ms.
    const res = await registryLocal.dispatch(makeInput({ name: 'fast', timeoutMs: 100 }), logger);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error_code).toBe('handler_timeout');
  });

  it('rejects caller-supplied timeout above maxTimeoutMs (steelman fix #2)', async () => {
    vi.useRealTimers();
    const small = createCommandRegistry({ defaultTimeoutMs: 100, maxTimeoutMs: 50_000 });
    small.register('quick', {
      handler: async () => ({ ok: true }),
    });
    // Caller requests 1 hour timeout — exceeds maxTimeoutMs and is rejected
    // as `invalid_params` (no longer silently clamped).
    const res = await small.dispatch(makeInput({ name: 'quick', timeoutMs: 3_600_000 }), logger);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error_code).toBe('invalid_params');
      expect(res.message).toContain('timeout_ms must be an integer');
    }
  });
});

// -----------------------------------------------------------------
// Concurrency + queueing
// -----------------------------------------------------------------

describe('CommandRegistry: concurrency', () => {
  it('queues commands past maxConcurrent and runs them serially', async () => {
    const registry = createCommandRegistry({ maxConcurrent: 2, queueMax: 10 });
    const started: number[] = [];
    const unblock: Array<() => void> = [];

    registry.register('slow', {
      handler: async (_p: unknown, ctx) => {
        started.push(started.length);
        await new Promise<void>((resolve) => { unblock.push(resolve); });
        return { id: ctx.commandId };
      },
    });

    const logger = makeLogger();
    const p1 = registry.dispatch(makeInput({ name: 'slow', commandId: 'c1' }), logger);
    const p2 = registry.dispatch(makeInput({ name: 'slow', commandId: 'c2' }), logger);
    const p3 = registry.dispatch(makeInput({ name: 'slow', commandId: 'c3' }), logger);
    const p4 = registry.dispatch(makeInput({ name: 'slow', commandId: 'c4' }), logger);

    // Give microtasks a tick to allocate slots
    await Promise.resolve();
    await Promise.resolve();
    expect(started.length).toBe(2);
    expect(registry.stats().active).toBe(2);
    expect(registry.stats().queued).toBe(2);

    // Release first two
    unblock[0]?.();
    unblock[1]?.();
    await p1;
    await p2;

    // Let queued ones pick up
    await Promise.resolve();
    await Promise.resolve();
    expect(started.length).toBe(4);

    unblock[2]?.();
    unblock[3]?.();
    await p3;
    await p4;
  });

  it('rejects with too_busy when queue is full', async () => {
    const registry = createCommandRegistry({ maxConcurrent: 1, queueMax: 1 });
    const unblock: Array<() => void> = [];

    registry.register('slow', {
      handler: async () => {
        await new Promise<void>((resolve) => { unblock.push(resolve); });
        return { done: true };
      },
    });

    const logger = makeLogger();
    const p1 = registry.dispatch(makeInput({ name: 'slow', commandId: 'c1' }), logger);
    const p2 = registry.dispatch(makeInput({ name: 'slow', commandId: 'c2' }), logger); // queued
    const p3 = registry.dispatch(makeInput({ name: 'slow', commandId: 'c3' }), logger); // should be too_busy

    const r3 = await p3;
    expect(r3.ok).toBe(false);
    if (!r3.ok) {
      expect(r3.error_code).toBe('too_busy');
      expect(r3.outcome).toBe('too_busy');
    }

    unblock[0]?.();
    await p1;
    // Let queued one pick up
    await Promise.resolve();
    unblock[1]?.();
    await p2;
  });
});

// -----------------------------------------------------------------
// Telemetry
// -----------------------------------------------------------------

describe('CommandRegistry: telemetry', () => {
  it('emits command.start and command.end log events with expected fields', async () => {
    const lines: string[] = [];
    const logger = createLogger({ component: 'test', writer: (l) => lines.push(l) });
    const registry = createCommandRegistry();
    registry.register('demo', { handler: async () => ({ ok: true }) });
    await registry.dispatch(makeInput({ name: 'demo', msgId: 'abc' }), logger);

    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const starts = parsed.filter((p) => p['event'] === 'command.start');
    const ends = parsed.filter((p) => p['event'] === 'command.end');
    expect(starts.length).toBe(1);
    expect(ends.length).toBe(1);
    const startDetails = starts[0]!['details'] as Record<string, unknown>;
    expect(startDetails['command']).toBe('demo');
    expect(startDetails['msg_id']).toBe('abc');
    expect(typeof startDetails['params_size_bytes']).toBe('number');
    const endDetails = ends[0]!['details'] as Record<string, unknown>;
    expect(endDetails['command']).toBe('demo');
    expect(endDetails['outcome']).toBe('ok');
    expect(typeof endDetails['duration_ms']).toBe('number');
  });

  it('emits command.rejected with error_code for unknown_command (steelman fix #3)', async () => {
    const lines: string[] = [];
    const logger = createLogger({ component: 'test', writer: (l) => lines.push(l) });
    const registry = createCommandRegistry();
    await registry.dispatch(makeInput({ name: 'unknown' }), logger);
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    // Pre-validation rejection: command.start is NOT emitted, command.rejected IS.
    expect(parsed.find((p) => p['event'] === 'command.start')).toBeUndefined();
    const rejected = parsed.find((p) => p['event'] === 'command.rejected');
    expect(rejected).toBeDefined();
    const details = rejected!['details'] as Record<string, unknown>;
    expect(details['error_code']).toBe('unknown_command');
  });

  it('emits command.end (not command.rejected) when handler runs and fails', async () => {
    const lines: string[] = [];
    const logger = createLogger({ component: 'test', writer: (l) => lines.push(l) });
    const registry = createCommandRegistry();
    registry.register('boom', { handler: async () => { throw new Error('boom'); } });
    await registry.dispatch(makeInput({ name: 'boom' }), logger);
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed.find((p) => p['event'] === 'command.start')).toBeDefined();
    const end = parsed.find((p) => p['event'] === 'command.end');
    expect(end).toBeDefined();
    const details = end!['details'] as Record<string, unknown>;
    expect(details['outcome']).toBe('error');
    expect(details['error_code']).toBe('handler_error');
  });
});

// -----------------------------------------------------------------
// Env-based options
// -----------------------------------------------------------------

describe('readRegistryOptionsFromEnv', () => {
  it('returns defaults when unset', () => {
    const opts = readRegistryOptionsFromEnv({});
    expect(opts.maxConcurrent).toBe(DEFAULT_MAX_CONCURRENT);
    expect(opts.queueMax).toBe(DEFAULT_QUEUE_MAX);
  });

  it('parses UNICITY_MAX_CONCURRENT_COMMANDS', () => {
    const opts = readRegistryOptionsFromEnv({ UNICITY_MAX_CONCURRENT_COMMANDS: '8' });
    expect(opts.maxConcurrent).toBe(8);
  });

  it('parses UNICITY_COMMAND_QUEUE_MAX', () => {
    const opts = readRegistryOptionsFromEnv({ UNICITY_COMMAND_QUEUE_MAX: '32' });
    expect(opts.queueMax).toBe(32);
  });

  it('falls back to defaults on malformed values', () => {
    const opts = readRegistryOptionsFromEnv({
      UNICITY_MAX_CONCURRENT_COMMANDS: 'not-a-number',
      UNICITY_COMMAND_QUEUE_MAX: '-5',
    });
    expect(opts.maxConcurrent).toBe(DEFAULT_MAX_CONCURRENT);
    expect(opts.queueMax).toBe(DEFAULT_QUEUE_MAX);
  });

  it('clamps out-of-range values to defaults', () => {
    // Values above max get clamped to default (safer than accepting bogus)
    const opts = readRegistryOptionsFromEnv({
      UNICITY_MAX_CONCURRENT_COMMANDS: '99999',
      UNICITY_COMMAND_QUEUE_MAX: '99999',
    });
    expect(opts.maxConcurrent).toBe(DEFAULT_MAX_CONCURRENT);
    expect(opts.queueMax).toBe(DEFAULT_QUEUE_MAX);
  });
});

// -----------------------------------------------------------------
// Boundaries
// -----------------------------------------------------------------

describe('Constants', () => {
  it('exposes consistent timeout bounds', () => {
    expect(DEFAULT_TIMEOUT_MS).toBeLessThanOrEqual(MAX_TIMEOUT_MS);
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('typed error hierarchy preserves CommandError properties', () => {
    const e = new InvalidParamsError('bad', { field: 'x' });
    expect(e).toBeInstanceOf(CommandError);
    expect(e.code).toBe('invalid_params');
    expect(e.publicMessage).toBe('bad');
    expect(e.reason).toEqual({ field: 'x' });
    const t = new HandlerTimeoutError();
    expect(t.code).toBe('handler_timeout');
  });
});

describe('copyRegistryCommands', () => {
  it('copies commands from source to destination', async () => {
    const { copyRegistryCommands } = await import('./command-registry.js');
    const src = createCommandRegistry();
    src.register('a', { description: 'alpha', handler: async () => ({ a: 1 }) });
    src.register('b', { handler: async () => ({ b: 2 }) });
    const dst = createCommandRegistry();
    copyRegistryCommands(src, dst);
    expect(dst.has('a')).toBe(true);
    expect(dst.has('b')).toBe(true);
    // Dispatching through the copy executes the original handler.
    const res = await dst.dispatch(
      { name: 'a', msgId: 'm', commandId: 'c', instanceId: 'i', instanceName: 'n' },
      makeLogger(),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result['a']).toBe(1);
  });

  it('raises DuplicateCommandError when destination has an existing name', async () => {
    const { copyRegistryCommands } = await import('./command-registry.js');
    const src = createCommandRegistry();
    src.register('dup', { handler: async () => ({}) });
    const dst = createCommandRegistry();
    dst.register('dup', { handler: async () => ({}) });
    expect(() => copyRegistryCommands(src, dst)).toThrow(DuplicateCommandError);
  });
});

describe('default registry singleton', () => {
  afterEach(async () => {
    const { resetDefaultRegistry } = await import('./command-registry.js');
    resetDefaultRegistry();
  });

  it('registerCommand() adds to a singleton visible via listCommands()', async () => {
    const { registerCommand, listCommands } = await import('./command-registry.js');
    registerCommand('singleton-test', {
      description: 'test',
      handler: async () => ({ ok: true }),
    });
    const list = listCommands();
    expect(list.some((c) => c.name === 'singleton-test')).toBe(true);
  });

  it('resetDefaultRegistry() clears the singleton', async () => {
    const { registerCommand, listCommands, resetDefaultRegistry } = await import('./command-registry.js');
    registerCommand('temp', { handler: async () => ({}) });
    expect(listCommands().some((c) => c.name === 'temp')).toBe(true);
    resetDefaultRegistry();
    expect(listCommands().some((c) => c.name === 'temp')).toBe(false);
  });
});

// -----------------------------------------------------------------
// Steelman fix #2 — strict timeout validation
// -----------------------------------------------------------------

describe('CommandRegistry: timeout validation (steelman fix #2)', () => {
  let registry: CommandRegistry;
  let logger: Logger;

  beforeEach(() => {
    logger = makeLogger();
    registry = createCommandRegistry();
    registry.register('echo', { handler: async () => ({ ok: true }) });
  });

  it('rejects timeoutMs: 0.5 (sub-millisecond DoS)', async () => {
    const res = await registry.dispatch(makeInput({ name: 'echo', timeoutMs: 0.5 }), logger);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error_code).toBe('invalid_params');
      expect(res.message).toContain('timeout_ms must be an integer between 100 and');
    }
  });

  it('rejects timeoutMs: -1 (negative)', async () => {
    const res = await registry.dispatch(makeInput({ name: 'echo', timeoutMs: -1 }), logger);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error_code).toBe('invalid_params');
  });

  it('rejects timeoutMs: NaN', async () => {
    const res = await registry.dispatch(makeInput({ name: 'echo', timeoutMs: NaN }), logger);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error_code).toBe('invalid_params');
  });

  it('rejects timeoutMs: Infinity', async () => {
    const res = await registry.dispatch(makeInput({ name: 'echo', timeoutMs: Infinity }), logger);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error_code).toBe('invalid_params');
  });

  it('rejects timeoutMs: 50 (below MIN_TIMEOUT_MS=100)', async () => {
    const res = await registry.dispatch(makeInput({ name: 'echo', timeoutMs: 50 }), logger);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error_code).toBe('invalid_params');
  });

  it('rejects non-integer like 100.1', async () => {
    const res = await registry.dispatch(makeInput({ name: 'echo', timeoutMs: 100.1 }), logger);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error_code).toBe('invalid_params');
  });

  it('accepts timeoutMs: MIN_TIMEOUT_MS (100)', async () => {
    const res = await registry.dispatch(makeInput({ name: 'echo', timeoutMs: MIN_TIMEOUT_MS }), logger);
    expect(res.ok).toBe(true);
  });

  it('accepts timeoutMs: MAX_TIMEOUT_MS (300000)', async () => {
    const res = await registry.dispatch(makeInput({ name: 'echo', timeoutMs: MAX_TIMEOUT_MS }), logger);
    expect(res.ok).toBe(true);
  });

  it('omitted timeoutMs uses default (no rejection)', async () => {
    const res = await registry.dispatch(makeInput({ name: 'echo' }), logger);
    expect(res.ok).toBe(true);
  });
});

// -----------------------------------------------------------------
// Steelman fix #3 — telemetry size amplification cap
// -----------------------------------------------------------------

describe('CommandRegistry: telemetry size cap (steelman fix #3)', () => {
  it('emits command.rejected (not command.start) for unknown commands and bounds output size', async () => {
    const lines: string[] = [];
    const logger = createLogger({ component: 'test', writer: (l) => lines.push(l) });
    const registry = createCommandRegistry();

    // 50 KB params blob targeting an unknown command. Old behavior:
    // command.start carried the full 50KB JSON-stringified blob in
    // params_size_bytes context. New behavior: command.rejected with
    // bounded fields only — no params, no inline name overflow.
    const blob: Record<string, unknown> = {};
    for (let i = 0; i < 1000; i++) blob[`field_${i}`] = 'x'.repeat(50);

    const res = await registry.dispatch(
      makeInput({ name: 'no-such-command', params: blob }),
      logger,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error_code).toBe('unknown_command');

    // No command.start was emitted (we rejected before that point).
    const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const starts = events.filter((e) => e['event'] === 'command.start');
    expect(starts).toHaveLength(0);

    const rejected = events.find((e) => e['event'] === 'command.rejected');
    expect(rejected).toBeDefined();

    // Total log volume must be small (< 2 KB) regardless of input size.
    const totalBytes = lines.reduce((acc, l) => acc + l.length, 0);
    expect(totalBytes).toBeLessThan(2048);
  });

  it('emits command.start with params_size_bytes_clamped=true for oversize valid params', async () => {
    const lines: string[] = [];
    const logger = createLogger({ component: 'test', writer: (l) => lines.push(l) });
    const registry = createCommandRegistry();
    registry.register('big-input', {
      paramsSchema: anyParams,
      handler: async () => ({ ok: true }),
    });

    const big: Record<string, unknown> = {};
    for (let i = 0; i < 200; i++) big[`f${i}`] = 'a'.repeat(20);

    const res = await registry.dispatch(makeInput({ name: 'big-input', params: big }), logger);
    expect(res.ok).toBe(true);

    const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const start = events.find((e) => e['event'] === 'command.start');
    expect(start).toBeDefined();
    const details = start!['details'] as Record<string, unknown>;
    if (typeof details['params_size_bytes'] === 'number' && details['params_size_bytes'] > LOG_PARAMS_MAX_BYTES) {
      // Sanity: should never exceed cap.
      throw new Error('params_size_bytes exceeds cap');
    }
    expect(details['params_size_bytes']).toBe(LOG_PARAMS_MAX_BYTES);
    expect(details['params_size_bytes_clamped']).toBe(true);
  });
});

// -----------------------------------------------------------------
// Steelman fix #4 — env-config rejection logging
// -----------------------------------------------------------------

describe('readRegistryOptionsFromEnv: rejection logging (steelman fix #4)', () => {
  it('logs env_config_rejected when env value is non-numeric', () => {
    const lines: string[] = [];
    const logger = createLogger({ component: 'test', writer: (l) => lines.push(l) });
    const opts = readRegistryOptionsFromEnv(
      { UNICITY_MAX_CONCURRENT_COMMANDS: 'banana' },
      logger,
    );
    expect(opts.maxConcurrent).toBe(DEFAULT_MAX_CONCURRENT);
    const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const warn = events.find((e) => e['event'] === 'env_config_rejected');
    expect(warn).toBeDefined();
    const details = warn!['details'] as Record<string, unknown>;
    expect(details['var']).toBe('UNICITY_MAX_CONCURRENT_COMMANDS');
    expect(details['value']).toBe('banana');
    expect(details['falling_back_to']).toBe(DEFAULT_MAX_CONCURRENT);
  });

  it('logs env_config_rejected when value is below min', () => {
    const lines: string[] = [];
    const logger = createLogger({ component: 'test', writer: (l) => lines.push(l) });
    readRegistryOptionsFromEnv(
      { UNICITY_MAX_CONCURRENT_COMMANDS: '0' },
      logger,
    );
    const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const warn = events.find((e) => e['event'] === 'env_config_rejected');
    expect(warn).toBeDefined();
    const details = warn!['details'] as Record<string, unknown>;
    expect(details['reason']).toMatch(/below minimum/);
  });

  it('logs env_config_rejected when value is above max', () => {
    const lines: string[] = [];
    const logger = createLogger({ component: 'test', writer: (l) => lines.push(l) });
    readRegistryOptionsFromEnv(
      { UNICITY_COMMAND_QUEUE_MAX: '99999' },
      logger,
    );
    const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const warn = events.find((e) => e['event'] === 'env_config_rejected');
    expect(warn).toBeDefined();
    const details = warn!['details'] as Record<string, unknown>;
    expect(details['reason']).toMatch(/above maximum/);
  });

  it('does NOT log when value is valid', () => {
    const lines: string[] = [];
    const logger = createLogger({ component: 'test', writer: (l) => lines.push(l) });
    readRegistryOptionsFromEnv(
      { UNICITY_MAX_CONCURRENT_COMMANDS: '8', UNICITY_COMMAND_QUEUE_MAX: '32' },
      logger,
    );
    const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.find((e) => e['event'] === 'env_config_rejected')).toBeUndefined();
  });

  it('does NOT log when env vars are absent', () => {
    const lines: string[] = [];
    const logger = createLogger({ component: 'test', writer: (l) => lines.push(l) });
    readRegistryOptionsFromEnv({}, logger);
    const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.find((e) => e['event'] === 'env_config_rejected')).toBeUndefined();
  });
});

// -----------------------------------------------------------------
// Steelman fix #5 — abandoned-handler tracking
// -----------------------------------------------------------------

describe('CommandRegistry: abandoned-handler tracking (steelman fix #5)', () => {
  it('exposes stats().abandoned starting at 0', () => {
    const registry = createCommandRegistry();
    expect(registry.stats().abandoned).toBe(0);
  });

  it('increments abandoned when handler ignores signal and runs past timeout+1s', async () => {
    vi.useRealTimers();
    const logger = makeLogger();
    const registry = createCommandRegistry({ defaultTimeoutMs: 100 });
    let resolveHandler: () => void = () => { /* set below */ };
    const handlerDone = new Promise<void>((resolve) => { resolveHandler = resolve; });

    registry.register('runaway', {
      handler: async () => {
        // Deliberately ignore ctx.signal — simulate a buggy handler.
        await handlerDone;
        return { done: true };
      },
    });

    const dispatchPromise = registry.dispatch(makeInput({ name: 'runaway' }), logger);
    const res = await dispatchPromise;
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error_code).toBe('handler_timeout');

    // Wait > 1000ms past timeout fire so the detection timer trips, then
    // resolve the handler so .finally() fires and `abandoned` increments.
    await new Promise<void>((r) => setTimeout(r, 1100));
    resolveHandler();
    // Allow the .finally microtask to run.
    await new Promise<void>((r) => setTimeout(r, 50));

    expect(registry.stats().abandoned).toBe(1);
  });

  it('does NOT increment abandoned when handler bails quickly after signal', async () => {
    vi.useRealTimers();
    const logger = makeLogger();
    const registry = createCommandRegistry({ defaultTimeoutMs: 100 });
    registry.register('cooperative', {
      handler: async (_p, ctx) => {
        // Cooperatively bail when aborted.
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => reject(new Error('cancelled'));
          if (ctx.signal.aborted) onAbort();
          else ctx.signal.addEventListener('abort', onAbort, { once: true });
        });
        return { done: true };
      },
    });
    await registry.dispatch(makeInput({ name: 'cooperative' }), logger);
    // Wait briefly to let any abandoned-detection settle.
    await new Promise<void>((r) => setTimeout(r, 200));
    expect(registry.stats().abandoned).toBe(0);
  });
});

// -----------------------------------------------------------------
// Steelman fix #6 — strict-FIFO concurrency
// -----------------------------------------------------------------

describe('CommandRegistry: strict FIFO (steelman fix #6)', () => {
  it('queued waiter inherits the slot atomically (no leapfrogging)', async () => {
    // We construct a scenario where a sibling sync-dispatch could
    // race a queued waiter. With the fix, the waiter is first.
    vi.useRealTimers();
    const logger = makeLogger();
    const registry = createCommandRegistry({ maxConcurrent: 1, queueMax: 5 });

    const startOrder: string[] = [];
    const unblock: Array<() => void> = [];

    registry.register('worker', {
      handler: async (_p, ctx) => {
        startOrder.push(ctx.commandId);
        await new Promise<void>((resolve) => { unblock.push(resolve); });
        return { id: ctx.commandId };
      },
    });

    // p1 takes the only slot.
    const p1 = registry.dispatch(makeInput({ name: 'worker', commandId: 'first' }), logger);
    // p2 queues (slot full).
    const p2 = registry.dispatch(makeInput({ name: 'worker', commandId: 'second' }), logger);

    await Promise.resolve();
    await Promise.resolve();
    expect(startOrder).toEqual(['first']);
    expect(registry.stats().queued).toBe(1);

    // Release p1 — releaseSlot should transfer the slot to p2 directly.
    unblock[0]?.();
    // While p2's continuation is being scheduled, fire a sibling sync
    // dispatch that would otherwise leapfrog the queue:
    const p3 = registry.dispatch(makeInput({ name: 'worker', commandId: 'third' }), logger);

    // Let microtasks settle. Slot release + finalize traversal involves
    // multiple awaits (Promise.race + JSON serialization). Yielding once
    // to a macrotask lane drains everything pending.
    await new Promise<void>((r) => setTimeout(r, 0));

    // Strict FIFO: 'second' must have started before 'third' even though
    // 'third' was a sibling sync dispatch attempt.
    expect(startOrder).toEqual(['first', 'second']);

    // Drain the rest.
    unblock[1]?.();
    await p2;
    await Promise.resolve();
    unblock[2]?.();
    await p3;
    await p1;
  });
});

// -----------------------------------------------------------------
// Steelman fix #7 — command-name allowlist
// -----------------------------------------------------------------

describe('CommandRegistry: command-name allowlist (steelman fix #7)', () => {
  let registry: CommandRegistry;
  beforeEach(() => { registry = createCommandRegistry(); });

  it('register() rejects names with newline (log injection vector)', () => {
    expect(() => registry.register('PING\n{evil}', { handler: async () => ({}) }))
      .toThrow(InvalidCommandNameError);
  });

  it('register() rejects names with spaces', () => {
    expect(() => registry.register('my command', { handler: async () => ({}) }))
      .toThrow(InvalidCommandNameError);
  });

  it('register() rejects names with JSON metacharacters', () => {
    expect(() => registry.register('foo"bar', { handler: async () => ({}) }))
      .toThrow(InvalidCommandNameError);
    expect(() => registry.register('a{b}', { handler: async () => ({}) }))
      .toThrow(InvalidCommandNameError);
  });

  it('register() rejects names longer than 64 chars', () => {
    const long = 'a'.repeat(65);
    expect(() => registry.register(long, { handler: async () => ({}) }))
      .toThrow(InvalidCommandNameError);
  });

  it('register() accepts standard names with letters, digits, _, -, .', () => {
    expect(() => registry.register('foo.bar_baz-1', { handler: async () => ({}) }))
      .not.toThrow();
  });

  it('register() accepts the 64-char boundary', () => {
    const exact = 'a'.repeat(64);
    expect(() => registry.register(exact, { handler: async () => ({}) }))
      .not.toThrow();
  });

  it('dispatch() rejects malformed names as unknown_command (no leak)', async () => {
    registry.register('echo', { handler: async () => ({ ok: true }) });
    const res = await registry.dispatch(
      makeInput({ name: 'PING\n{injection}' }),
      makeLogger(),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error_code).toBe('unknown_command');
  });

  it('dispatch() with malformed name does not surface the validation message', async () => {
    const res = await registry.dispatch(
      makeInput({ name: 'has spaces' }),
      makeLogger(),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error_code).toBe('unknown_command');
      // Should not reveal "must match regex" details.
      expect(res.message).not.toContain('regex');
    }
  });

  it('emits command.rejected (not command.start) for invalid names', async () => {
    const lines: string[] = [];
    const logger = createLogger({ component: 'test', writer: (l) => lines.push(l) });
    await registry.dispatch(makeInput({ name: 'has\nnewline' }), logger);
    const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.find((e) => e['event'] === 'command.start')).toBeUndefined();
    expect(events.find((e) => e['event'] === 'command.rejected')).toBeDefined();
  });
});

// -----------------------------------------------------------------
// Round-2 fix #1 (CRITICAL) — slot-leak DoS regression
// -----------------------------------------------------------------

describe('CommandRegistry: slot-leak DoS regression (round-2 fix #1)', () => {
  it('non-cooperating handler past timeout keeps holding its slot until settle', async () => {
    // Reproduce the original DoS: timeout fires, dispatch returns `timeout`,
    // but the handler IGNORES `signal.aborted` and keeps running. The slot
    // must remain occupied until `runPromise` actually settles. Previously
    // the slot was freed in a synchronous `finally`, allowing unbounded
    // concurrent handlers despite a nominal `maxConcurrent` cap.
    vi.useRealTimers();
    const registry = createCommandRegistry({
      maxConcurrent: 2,
      queueMax: 0, // queue full instantly so we observe `too_busy` directly
      defaultTimeoutMs: 100,
    });
    const handlerGate: Array<() => void> = [];
    registry.register('runaway', {
      handler: async () => {
        // Buggy handler: never yields to the abort signal.
        await new Promise<void>((resolve) => { handlerGate.push(resolve); });
        return { done: true };
      },
    });

    const logger = makeLogger();
    // Saturate the cap with two non-cooperating handlers.
    const r1 = await registry.dispatch(makeInput({ name: 'runaway', commandId: 'a' }), logger);
    const r2 = await registry.dispatch(makeInput({ name: 'runaway', commandId: 'b' }), logger);
    // Both timed out, but the handlers are still running.
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error_code).toBe('handler_timeout');
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error_code).toBe('handler_timeout');

    // CRITICAL: slots should NOT have been released. The third dispatch
    // MUST be rejected with `too_busy`. Pre-fix: this returned timeout
    // (slot was synchronously released, allowing unbounded concurrent work).
    const r3 = await registry.dispatch(makeInput({ name: 'runaway', commandId: 'c' }), logger);
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.error_code).toBe('too_busy');

    // active count reflects the still-running handlers.
    expect(registry.stats().active).toBe(2);

    // Finalize handlers: now the slots release properly, and a new
    // dispatch can succeed.
    handlerGate[0]?.();
    handlerGate[1]?.();
    // Wait for finally to fire.
    await new Promise<void>((r) => setTimeout(r, 50));
    expect(registry.stats().active).toBe(0);
  });

  it('attacker pattern: timeout-spam with non-cooperating handlers eventually returns too_busy', async () => {
    // Simulate an attacker that flood-dispatches commands knowing the
    // handler is buggy + ignores the abort signal. Pre-fix: every dispatch
    // returned `timeout` (cheap, no backpressure), spawning unbounded
    // concurrent handlers. Post-fix: after `maxConcurrent` are stuck, the
    // queue fills, then new dispatches get `too_busy`.
    //
    // We use `queueMax: 0` so we don't have to drain queued waiters — once
    // the cap is hit by stuck handlers, the next dispatch IMMEDIATELY hits
    // the synchronous `too_busy` path. Awaiting all dispatches is safe
    // because no waiters get queued (they all reject synchronously).
    vi.useRealTimers();
    const registry = createCommandRegistry({
      maxConcurrent: 2,
      queueMax: 0,
      defaultTimeoutMs: 100,
    });
    const blockers: Array<() => void> = [];
    registry.register('runaway', {
      handler: async () => {
        await new Promise<void>((resolve) => { blockers.push(resolve); });
        return { done: true };
      },
    });

    const logger = makeLogger();
    const outcomes: string[] = [];
    // First 2 dispatches saturate the cap and time out (handlers stuck).
    // Subsequent dispatches must hit `too_busy` because the cap is real.
    for (let i = 0; i < 8; i++) {
      const r = await registry.dispatch(
        makeInput({ name: 'runaway', commandId: `c${i}` }),
        logger,
      );
      outcomes.push(r.ok ? 'ok' : r.error_code);
    }

    // The attacker MUST hit `too_busy` at some point — that's the whole
    // point of the cap. Pre-fix this would not happen; the attacker would
    // see only `handler_timeout` repeatedly.
    expect(outcomes).toContain('too_busy');
    // First two times out (slots saturated by stuck handlers).
    expect(outcomes.slice(0, 2)).toEqual(['handler_timeout', 'handler_timeout']);
    // Remaining dispatches see too_busy (slots stuck, queue full at 0).
    expect(outcomes.slice(2).every((o) => o === 'too_busy')).toBe(true);

    // Drain the test.
    for (const release of blockers) release();
    await new Promise<void>((r) => setTimeout(r, 50));
  });

  it('cooperative handler frees its slot promptly after abort', async () => {
    // Sanity check: a well-behaved handler that observes `signal.aborted`
    // and returns/throws still releases its slot in time for the next
    // dispatch. Post-fix this should hold (since the .finally still fires).
    vi.useRealTimers();
    const registry = createCommandRegistry({
      maxConcurrent: 1,
      queueMax: 0,
      defaultTimeoutMs: 100,
    });
    registry.register('cooperative', {
      handler: async (_p, ctx) => {
        return new Promise<{ aborted: true }>((resolve, reject) => {
          if (ctx.signal.aborted) reject(new Error('aborted'));
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
    });

    const logger = makeLogger();
    const r1 = await registry.dispatch(makeInput({ name: 'cooperative', commandId: 'a' }), logger);
    expect(r1.ok).toBe(false);
    // Handler finished promptly via abort -> slot freed -> next dispatch ok.
    await new Promise<void>((r) => setTimeout(r, 20));
    expect(registry.stats().active).toBe(0);

    const r2 = await registry.dispatch(makeInput({ name: 'cooperative', commandId: 'b' }), logger);
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      // Either handler_timeout (cooperative) or handler_error (abort thrown);
      // crucially, NOT too_busy — the slot was properly freed.
      expect(r2.error_code).not.toBe('too_busy');
    }
  });
});

// -----------------------------------------------------------------
// Round-2 fix #3 — command.rejected correlation fields
// -----------------------------------------------------------------

describe('CommandRegistry: command.rejected correlation fields (round-2 fix #3)', () => {
  it('emits command_id, instance_id, instance_name, duration_ms in command.rejected', async () => {
    const lines: string[] = [];
    const logger = createLogger({ component: 'test', writer: (l) => lines.push(l) });
    const registry = createCommandRegistry();
    await registry.dispatch(
      makeInput({
        name: 'no-such-cmd',
        commandId: 'cmd-correlation-1',
        instanceId: 'inst-9',
        instanceName: 'bot-corr',
      }),
      logger,
    );
    const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const rejected = events.find((e) => e['event'] === 'command.rejected');
    expect(rejected).toBeDefined();
    const details = rejected!['details'] as Record<string, unknown>;
    expect(details['command_id']).toBe('cmd-correlation-1');
    expect(details['instance_id']).toBe('inst-9');
    expect(details['instance_name']).toBe('bot-corr');
    expect(typeof details['duration_ms']).toBe('number');
    expect(details['duration_ms']).toBeGreaterThanOrEqual(0);
  });

  it('correlation fields present even on invalid name rejections', async () => {
    const lines: string[] = [];
    const logger = createLogger({ component: 'test', writer: (l) => lines.push(l) });
    const registry = createCommandRegistry();
    await registry.dispatch(
      makeInput({
        name: 'bad name', // space → invalid
        commandId: 'cmd-x',
        instanceId: 'inst-x',
        instanceName: 'bot-x',
      }),
      logger,
    );
    const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const rejected = events.find((e) => e['event'] === 'command.rejected');
    expect(rejected).toBeDefined();
    const details = rejected!['details'] as Record<string, unknown>;
    // All four fields present.
    expect(details['command_id']).toBe('cmd-x');
    expect(details['instance_id']).toBe('inst-x');
    expect(details['instance_name']).toBe('bot-x');
    expect(typeof details['duration_ms']).toBe('number');
  });

  it('correlation fields present on invalid timeout rejections', async () => {
    const lines: string[] = [];
    const logger = createLogger({ component: 'test', writer: (l) => lines.push(l) });
    const registry = createCommandRegistry();
    registry.register('echo', { handler: async () => ({ ok: true }) });
    await registry.dispatch(
      makeInput({
        name: 'echo',
        commandId: 'cmd-tmo',
        instanceId: 'inst-tmo',
        instanceName: 'bot-tmo',
        timeoutMs: 50, // below MIN_TIMEOUT_MS
      }),
      logger,
    );
    const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const rejected = events.find((e) => e['event'] === 'command.rejected');
    expect(rejected).toBeDefined();
    const details = rejected!['details'] as Record<string, unknown>;
    expect(details['command_id']).toBe('cmd-tmo');
    expect(details['instance_id']).toBe('inst-tmo');
    expect(details['instance_name']).toBe('bot-tmo');
    expect(typeof details['duration_ms']).toBe('number');
  });
});

// -----------------------------------------------------------------
// Round-2 fix #4 — env_config_rejected secret redaction
// -----------------------------------------------------------------

describe('readRegistryOptionsFromEnv: secret redaction (round-2 fix #4)', () => {
  it('does NOT redact value for non-sensitive var names', () => {
    const lines: string[] = [];
    const logger = createLogger({ component: 'test', writer: (l) => lines.push(l) });
    readRegistryOptionsFromEnv(
      { UNICITY_MAX_CONCURRENT_COMMANDS: 'banana' },
      logger,
    );
    const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const warn = events.find((e) => e['event'] === 'env_config_rejected');
    expect(warn).toBeDefined();
    const details = warn!['details'] as Record<string, unknown>;
    // Standard config var — value passes through.
    expect(details['value']).toBe('banana');
  });

  it('redacts value when var name matches a secret substring', async () => {
    // Stand-in for any future operator-tunable env var whose name
    // happens to match a secret pattern. We exercise the helper directly
    // by importing the same shape via a synthetic name.
    const { isSecretEnvName } = await import('./secrets.js');
    expect(isSecretEnvName('UNICITY_AUTH_TIMEOUT_MS')).toBe(true);
    expect(isSecretEnvName('UNICITY_OAUTH_BEARER')).toBe(true);
    expect(isSecretEnvName('UNICITY_MAX_CONCURRENT_COMMANDS')).toBe(false);
  });

  it('isSecretEnvName matches case-insensitively', async () => {
    const { isSecretEnvName } = await import('./secrets.js');
    expect(isSecretEnvName('my_secret_thing')).toBe(true);
    expect(isSecretEnvName('apicredential')).toBe(true);
    expect(isSecretEnvName('SOMETHING_TOKEN')).toBe(true);
    expect(isSecretEnvName('plain_var')).toBe(false);
  });
});

// -----------------------------------------------------------------
// Round-2 fix #7 — reserved-name rejection
// -----------------------------------------------------------------

describe('CommandRegistry: reserved name rejection (round-2 fix #7)', () => {
  let registry: CommandRegistry;
  beforeEach(() => { registry = createCommandRegistry(); });

  it('register() rejects __proto__ even though it passes the regex', () => {
    expect(() => registry.register('__proto__', { handler: async () => ({}) }))
      .toThrow(InvalidCommandNameError);
  });

  it('register() rejects constructor', () => {
    expect(() => registry.register('constructor', { handler: async () => ({}) }))
      .toThrow(InvalidCommandNameError);
  });

  it('register() rejects prototype', () => {
    expect(() => registry.register('prototype', { handler: async () => ({}) }))
      .toThrow(InvalidCommandNameError);
  });

  it('register() rejects reserved names case-insensitively', () => {
    expect(() => registry.register('PROTOTYPE', { handler: async () => ({}) }))
      .toThrow(InvalidCommandNameError);
    expect(() => registry.register('Constructor', { handler: async () => ({}) }))
      .toThrow(InvalidCommandNameError);
  });

  it('dispatch() returns unknown_command for reserved names', async () => {
    const res = await registry.dispatch(makeInput({ name: '__proto__' }), makeLogger());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error_code).toBe('unknown_command');
  });

  it('register() still accepts names containing reserved substrings', () => {
    // 'prototype_helper' contains 'prototype' but is not exactly that name.
    expect(() => registry.register('prototype_helper', { handler: async () => ({}) }))
      .not.toThrow();
  });
});
