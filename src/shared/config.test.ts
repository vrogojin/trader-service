import { describe, it, expect } from 'vitest';
import { parseTenantConfig } from './config.js';

const VALID_PUBKEY = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab';
const OTHER_PUBKEY = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function makeEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    UNICITY_MANAGER_PUBKEY: VALID_PUBKEY,
    UNICITY_BOOT_TOKEN: 'boot-token-123',
    UNICITY_INSTANCE_ID: 'inst-1',
    UNICITY_INSTANCE_NAME: 'inst-name-1',
    UNICITY_TEMPLATE_ID: 'escrow-service',
    ...extra,
  };
}

describe('acp-adapter / parseTenantConfig', () => {
  it('parses a valid env block with defaults', () => {
    const cfg = parseTenantConfig(makeEnv());
    expect(cfg.manager_pubkey).toBe(VALID_PUBKEY);
    expect(cfg.boot_token).toBe('boot-token-123');
    expect(cfg.instance_id).toBe('inst-1');
    expect(cfg.network).toBe('testnet');
    expect(cfg.data_dir).toBe('/data/wallet');
    expect(cfg.tokens_dir).toBe('/data/tokens');
    expect(cfg.heartbeat_interval_ms).toBe(5000);
    expect(cfg.controller_pubkey).toBeNull();
    expect(cfg.log_level).toBe('info');
  });

  it('rejects missing required vars', () => {
    expect(() => parseTenantConfig(makeEnv({ UNICITY_MANAGER_PUBKEY: undefined }))).toThrow();
    expect(() => parseTenantConfig(makeEnv({ UNICITY_BOOT_TOKEN: undefined }))).toThrow();
    expect(() => parseTenantConfig(makeEnv({ UNICITY_INSTANCE_ID: undefined }))).toThrow();
  });

  it('rejects invalid manager pubkey', () => {
    expect(() => parseTenantConfig(makeEnv({ UNICITY_MANAGER_PUBKEY: 'not-hex' }))).toThrow(/UNICITY_MANAGER_PUBKEY/);
  });

  it('rejects invalid controller pubkey', () => {
    expect(() => parseTenantConfig(makeEnv({ UNICITY_CONTROLLER_PUBKEY: 'not-hex' }))).toThrow(/UNICITY_CONTROLLER_PUBKEY/);
  });

  it('rejects controller equal to manager (privilege separation)', () => {
    expect(() =>
      parseTenantConfig(makeEnv({ UNICITY_CONTROLLER_PUBKEY: VALID_PUBKEY })),
    ).toThrow(/privilege separation/);
  });

  it('accepts controller distinct from manager', () => {
    const cfg = parseTenantConfig(makeEnv({ UNICITY_CONTROLLER_PUBKEY: OTHER_PUBKEY }));
    expect(cfg.controller_pubkey).toBe(OTHER_PUBKEY);
  });

  it('rejects non-positive heartbeat_interval_ms', () => {
    expect(() =>
      parseTenantConfig(makeEnv({ UNICITY_HEARTBEAT_INTERVAL_MS: '0' })),
    ).toThrow(/positive integer/);
    expect(() =>
      parseTenantConfig(makeEnv({ UNICITY_HEARTBEAT_INTERVAL_MS: 'foo' })),
    ).toThrow(/positive integer/);
  });

  it('clamps heartbeat below 1000ms', () => {
    expect(() =>
      parseTenantConfig(makeEnv({ UNICITY_HEARTBEAT_INTERVAL_MS: '500' })),
    ).toThrow(/at least 1000/);
  });

  it('falls back to info log_level on invalid value', () => {
    const cfg = parseTenantConfig(makeEnv({ UNICITY_LOG_LEVEL: 'BOGUS' }));
    expect(cfg.log_level).toBe('info');
  });
});
