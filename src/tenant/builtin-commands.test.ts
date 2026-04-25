/**
 * Tests for the built-in commands: ping, info, shutdown, env.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createCommandRegistry, type CommandRegistry } from './command-registry.js';
import { registerBuiltinCommands, safeEnvSnapshot, type BuiltinContext } from './builtin-commands.js';
import { createLogger, type Logger } from '../shared/logger.js';

function makeLogger(): Logger {
  return createLogger({ component: 'test', writer: () => {} });
}

function makeCtx(overrides: Partial<BuiltinContext> = {}): BuiltinContext & {
  shutdownCalled: { current: boolean };
} {
  const shutdownCalled = { current: false };
  return {
    startedAt: Date.now() - 10_000,
    instanceId: 'inst-1',
    instanceName: 'bot-1',
    templateId: 'tmpl-1',
    version: '1.2.3',
    requestShutdown: () => { shutdownCalled.current = true; },
    env: { NODE_ENV: 'test' },
    shutdownCalled,
    ...overrides,
  };
}

function dispatchInput(name: string) {
  return {
    name,
    params: {},
    msgId: 'msg',
    commandId: 'cmd',
    instanceId: 'inst-1',
    instanceName: 'bot-1',
  };
}

describe('builtin: ping', () => {
  let registry: CommandRegistry;

  beforeEach(() => {
    registry = createCommandRegistry();
    registerBuiltinCommands(registry, makeCtx());
  });

  it('returns { pong: true, ts } with ISO timestamp', async () => {
    const res = await registry.dispatch(dispatchInput('ping'), makeLogger());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result['pong']).toBe(true);
      const ts = res.result['ts'];
      expect(typeof ts).toBe('string');
      // ISO 8601 format
      expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    }
  });

  it('is case-insensitive (PING, Ping)', async () => {
    const r1 = await registry.dispatch(dispatchInput('PING'), makeLogger());
    const r2 = await registry.dispatch(dispatchInput('Ping'), makeLogger());
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });
});

describe('builtin: info', () => {
  it('returns version, instance_id, uptime_seconds, template_id', async () => {
    const ctx = makeCtx({
      startedAt: Date.now() - 12_345,
      templateId: 'tenant-cli-boilerplate',
      version: '0.2.0',
      instanceId: 'inst-99',
      instanceName: 'bot-99',
    });
    const registry = createCommandRegistry();
    registerBuiltinCommands(registry, ctx);

    const res = await registry.dispatch(dispatchInput('info'), makeLogger());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result['version']).toBe('0.2.0');
      expect(res.result['instance_id']).toBe('inst-99');
      expect(res.result['instance_name']).toBe('bot-99');
      expect(res.result['template_id']).toBe('tenant-cli-boilerplate');
      expect(typeof res.result['uptime_seconds']).toBe('number');
      expect(res.result['uptime_seconds']).toBeGreaterThanOrEqual(12);
    }
  });

  it('returns template_id: null when undefined', async () => {
    const ctx = makeCtx({ templateId: undefined });
    const registry = createCommandRegistry();
    registerBuiltinCommands(registry, ctx);
    const res = await registry.dispatch(dispatchInput('info'), makeLogger());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result['template_id']).toBeNull();
    }
  });
});

describe('builtin: shutdown', () => {
  it('returns remote_shutdown_disabled when env var is unset', async () => {
    const ctx = makeCtx({ env: {} });
    const registry = createCommandRegistry();
    registerBuiltinCommands(registry, ctx);
    const res = await registry.dispatch(dispatchInput('shutdown'), makeLogger());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result['error']).toBe('remote_shutdown_disabled');
    }
    expect(ctx.shutdownCalled.current).toBe(false);
  });

  it('returns remote_shutdown_disabled when env var is "0"', async () => {
    const ctx = makeCtx({ env: { UNICITY_ALLOW_REMOTE_SHUTDOWN: '0' } });
    const registry = createCommandRegistry();
    registerBuiltinCommands(registry, ctx);
    const res = await registry.dispatch(dispatchInput('shutdown'), makeLogger());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result['error']).toBe('remote_shutdown_disabled');
    }
    expect(ctx.shutdownCalled.current).toBe(false);
  });

  it('requests shutdown when UNICITY_ALLOW_REMOTE_SHUTDOWN=1', async () => {
    const ctx = makeCtx({ env: { UNICITY_ALLOW_REMOTE_SHUTDOWN: '1' } });
    const registry = createCommandRegistry();
    registerBuiltinCommands(registry, ctx);
    const res = await registry.dispatch(dispatchInput('shutdown'), makeLogger());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result['acknowledged']).toBe(true);
    }
    expect(ctx.shutdownCalled.current).toBe(true);
  });

  it('does not require true === "1" — strict equality only', async () => {
    // "true" must NOT trigger shutdown — only the literal "1".
    const ctx = makeCtx({ env: { UNICITY_ALLOW_REMOTE_SHUTDOWN: 'true' } });
    const registry = createCommandRegistry();
    registerBuiltinCommands(registry, ctx);
    const res = await registry.dispatch(dispatchInput('shutdown'), makeLogger());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result['error']).toBe('remote_shutdown_disabled');
    }
    expect(ctx.shutdownCalled.current).toBe(false);
  });
});

describe('builtin: env', () => {
  it('returns only UNICITY_* and NODE_ENV, nothing else', () => {
    const snap = safeEnvSnapshot({
      NODE_ENV: 'production',
      UNICITY_INSTANCE_ID: 'inst-1',
      UNICITY_NETWORK: 'testnet',
      PATH: '/usr/bin',
      HOME: '/home/alice',
      USER: 'alice',
    });
    expect(snap).toEqual({
      NODE_ENV: 'production',
      UNICITY_INSTANCE_ID: 'inst-1',
      UNICITY_NETWORK: 'testnet',
    });
  });

  it('redacts UNICITY_BOOT_TOKEN explicitly', () => {
    const snap = safeEnvSnapshot({
      UNICITY_BOOT_TOKEN: 'secret-xyz',
      UNICITY_INSTANCE_ID: 'inst-1',
    });
    expect(snap).toEqual({ UNICITY_INSTANCE_ID: 'inst-1' });
    expect(Object.keys(snap)).not.toContain('UNICITY_BOOT_TOKEN');
  });

  it('redacts any key containing SECRET / KEY / PASSWORD / TOKEN / NSEC / MNEMONIC', () => {
    const snap = safeEnvSnapshot({
      UNICITY_API_KEY: 'sk_abc',
      UNICITY_DB_PASSWORD: 'hunter2',
      UNICITY_SESSION_TOKEN: 't-1',
      UNICITY_NSEC: 'nsec1...',
      UNICITY_MNEMONIC: 'word word word',
      UNICITY_SECRET_SAUCE: 'umami',
      UNICITY_INSTANCE_ID: 'inst-keep',
    });
    expect(Object.keys(snap)).toEqual(['UNICITY_INSTANCE_ID']);
  });

  it('redacts CREDENTIAL/AUTH/BEARER/COOKIE/SESSION/CERT/SIGNATURE/SIG (steelman)', () => {
    const snap = safeEnvSnapshot({
      UNICITY_DB_CREDENTIAL: 'creds',
      UNICITY_AUTH_HEADER: 'h',
      UNICITY_OAUTH_BEARER: 'eyJhbGc...',
      UNICITY_SESSION_COOKIE: 'sess=...',
      UNICITY_USER_SESSION: 'sid-1',
      UNICITY_TLS_CERT: 'PEM...',
      UNICITY_TX_SIGNATURE: 'sigblob',
      UNICITY_SIG: 'short-sig',
      UNICITY_INSTANCE_ID: 'keep-me',
    });
    expect(Object.keys(snap)).toEqual(['UNICITY_INSTANCE_ID']);
  });

  it('case-insensitive substring matches the new redaction terms', () => {
    const snap = safeEnvSnapshot({
      UNICITY_oauth_Bearer: 'eyJ',
      UNICITY_tls_Cert: 'PEM',
      UNICITY_authToken: 'qwerty', // doubly-secret: AUTH + TOKEN
      UNICITY_signature_v2: 'sigblob',
      UNICITY_my_credential: 'creds',
      UNICITY_INSTANCE_ID: 'keep-me',
    });
    expect(Object.keys(snap)).toEqual(['UNICITY_INSTANCE_ID']);
  });

  it('is case-insensitive on redaction check', () => {
    const snap = safeEnvSnapshot({
      UNICITY_api_key: 'sk_abc',
      UNICITY_My_Password: 'hunter',
    });
    expect(snap).toEqual({});
  });

  it('env command returns safeEnvSnapshot via the registry', async () => {
    const ctx = makeCtx({
      env: {
        NODE_ENV: 'test',
        UNICITY_INSTANCE_ID: 'inst-1',
        UNICITY_BOOT_TOKEN: 'dangerous-value',
        HOME: '/home/alice',
      },
    });
    const registry = createCommandRegistry();
    registerBuiltinCommands(registry, ctx);
    const res = await registry.dispatch(dispatchInput('env'), makeLogger());
    expect(res.ok).toBe(true);
    if (res.ok) {
      const env = res.result['env'] as Record<string, string>;
      expect(env['NODE_ENV']).toBe('test');
      expect(env['UNICITY_INSTANCE_ID']).toBe('inst-1');
      expect(env['UNICITY_BOOT_TOKEN']).toBeUndefined();
      expect(env['HOME']).toBeUndefined();
    }
  });
});

describe('registerBuiltinCommands: full set', () => {
  it('registers exactly four commands by default', () => {
    const registry = createCommandRegistry();
    registerBuiltinCommands(registry, makeCtx());
    const names = registry.list().map((c) => c.name);
    expect(names.sort()).toEqual(['env', 'info', 'ping', 'shutdown']);
  });

  it('refuses to double-register (duplicate detected)', () => {
    const registry = createCommandRegistry();
    registerBuiltinCommands(registry, makeCtx());
    expect(() => registerBuiltinCommands(registry, makeCtx())).toThrow();
  });
});
