import { describe, it, expect, vi } from 'vitest';
import { createLogger } from './logger.js';

function captureLogger(opts: { component: string; level?: 'debug' | 'info' | 'warn' | 'error' }) {
  const lines: string[] = [];
  const writer = (line: string) => lines.push(line);
  const logger = createLogger({ ...opts, writer });
  return { logger, lines, parse: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

describe('Logger', () => {
  it('writes JSON Lines to the writer', () => {
    const { logger, parse } = captureLogger({ component: 'test' });
    logger.info('hello', { foo: 'bar' });
    const entries = parse();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: 'INFO',
      component: 'test',
      event: 'hello',
      details: { foo: 'bar' },
    });
    expect(entries[0]).toHaveProperty('ts');
  });

  it('filters by log level', () => {
    const { logger, lines } = captureLogger({ component: 'test', level: 'warn' });
    logger.debug('skipped');
    logger.info('skipped');
    logger.warn('included');
    logger.error('included');
    expect(lines).toHaveLength(2);
  });

  it('omits details when not provided', () => {
    const { logger, parse } = captureLogger({ component: 'test' });
    logger.info('no-details');
    expect(parse()[0]).not.toHaveProperty('details');
  });

  it('sanitizes sensitive fields', () => {
    const { logger, parse } = captureLogger({ component: 'test' });
    logger.info('sensitive', {
      boot_token: 'secret-value',
      mnemonic: 'word1 word2 word3',
      private_key: 'deadbeef',
      nsec: 'nsec1...',
      secret: 'top-secret',
      password: 'hunter2',
      safe_field: 'visible',
    });
    const details = parse()[0]!['details'] as Record<string, unknown>;
    expect(details['boot_token']).toBe('[REDACTED]');
    expect(details['mnemonic']).toBe('[REDACTED]');
    expect(details['private_key']).toBe('[REDACTED]');
    expect(details['nsec']).toBe('[REDACTED]');
    expect(details['secret']).toBe('[REDACTED]');
    expect(details['password']).toBe('[REDACTED]');
    expect(details['safe_field']).toBe('visible');
  });

  it('sanitizes nested sensitive fields', () => {
    const { logger, parse } = captureLogger({ component: 'test' });
    logger.info('nested', {
      outer: { boot_token: 'nested-secret', safe: 'ok' },
    });
    const details = parse()[0]!['details'] as Record<string, unknown>;
    const outer = details['outer'] as Record<string, unknown>;
    expect(outer['boot_token']).toBe('[REDACTED]');
    expect(outer['safe']).toBe('ok');
  });

  describe('value-level secret scrubbing', () => {
    it('redacts API keys embedded in error messages', () => {
      const { logger, parse } = captureLogger({ component: 'test' });
      logger.error('api_call_failed', {
        error: 'invalid auth token sk_abcdef0123456789abcdef0123456789 rejected',
      });
      const details = parse()[0]!['details'] as Record<string, unknown>;
      expect(details['error']).toBe('invalid auth token [REDACTED] rejected');
    });

    it('redacts nsec secrets in string values', () => {
      const { logger, parse } = captureLogger({ component: 'test' });
      // 58 chars of bech32 charset (excludes b, i, o, 1) after nsec1 prefix
      const nsec = 'nsec1' + 'acdefghjklmnpqrstuvwxyz023456789acdefghjklmnpqrstuvwxyz023';
      logger.warn('leaked', { msg: `keypair decode: ${nsec} invalid` });
      const details = parse()[0]!['details'] as Record<string, unknown>;
      expect(details['msg']).toBe('keypair decode: [REDACTED] invalid');
    });

    // Round-25 F1: the following three patterns used to be redacted, but were
    // catastrophic false-positive generators (matched deal_ids, x-only pubkeys,
    // SHA-256 digests, any 12-word English sentence). The scrubber was narrowed
    // to only sk_<32hex> and nsec1<58 bech32>. These tests pin the NEW behavior
    // so a future regression can't re-introduce the false positives.

    it('passes through 64-hex strings (deal_ids, pubkeys, content hashes)', () => {
      const { logger, parse } = captureLogger({ component: 'test' });
      const hex64 = 'deadbeef'.repeat(8); // 64 hex chars — same shape as deal_id
      logger.warn('np_message_invalid', { sender: hex64, reason: `deal ${hex64}` });
      const details = parse()[0]!['details'] as Record<string, unknown>;
      expect(details['sender']).toBe(hex64);
      expect(details['reason']).toBe(`deal ${hex64}`);
    });

    it('passes through long English sentences unchanged', () => {
      const { logger, parse } = captureLogger({ component: 'test' });
      // Looks like a mnemonic shape (12+ lowercase words) but is just prose.
      const prose = 'unable to reconcile the pending deal because the acceptor refused to sign the envelope';
      logger.error('reconciliation_failed', { error: prose });
      const details = parse()[0]!['details'] as Record<string, unknown>;
      expect(details['error']).toBe(prose);
    });

    it('leaves normal strings untouched', () => {
      const { logger, parse } = captureLogger({ component: 'test' });
      logger.info('normal', {
        msg: 'Container started successfully on port 8080',
        path: '/var/run/docker.sock',
      });
      const details = parse()[0]!['details'] as Record<string, unknown>;
      expect(details['msg']).toBe('Container started successfully on port 8080');
      expect(details['path']).toBe('/var/run/docker.sock');
    });
  });

  it('creates child loggers with inherited settings', () => {
    const { logger, parse } = captureLogger({ component: 'parent' });
    const child = logger.child({ component: 'child', instance_id: 'inst-1', instance_name: 'bot' });
    child.info('from-child');
    const entry = parse()[0]!;
    expect(entry['component']).toBe('child');
    expect(entry['instance_id']).toBe('inst-1');
    expect(entry['instance_name']).toBe('bot');
  });

  it('child inherits parent fields when not overridden', () => {
    const lines: string[] = [];
    const writer = (line: string) => lines.push(line);
    const parent = createLogger({
      component: 'parent',
      writer,
      instance_id: 'p-id',
      instance_name: 'p-name',
    });
    const child = parent.child({});
    child.info('test');
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry['component']).toBe('parent');
    expect(entry['instance_id']).toBe('p-id');
    expect(entry['instance_name']).toBe('p-name');
  });

  it('setLevel changes filtering dynamically', () => {
    const { logger, lines } = captureLogger({ component: 'test', level: 'info' });
    logger.debug('skipped');
    expect(lines).toHaveLength(0);
    logger.setLevel('debug');
    logger.debug('included');
    expect(lines).toHaveLength(1);
  });

  it('uses process.stdout.write as default writer', () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const logger = createLogger({ component: 'default-writer' });
    logger.info('test-event');
    expect(writeSpy).toHaveBeenCalledOnce();
    const call = writeSpy.mock.calls[0]![0] as string;
    expect(call).toContain('test-event');
    expect(call.endsWith('\n')).toBe(true);
    writeSpy.mockRestore();
  });

  describe('rate limiting', () => {
    it('drops events past the per-event bucket capacity', () => {
      const lines: string[] = [];
      const logger = createLogger({
        component: 'test',
        writer: (line) => lines.push(line),
        rate_limit_capacity: 3,
        rate_limit_window_ms: 60_000,
      });
      for (let i = 0; i < 10; i++) logger.warn('floodable');
      const emitted = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
      const floodable = emitted.filter((e) => e['event'] === 'floodable');
      // Capacity is 3 — 7 should be dropped.
      expect(floodable.length).toBe(3);
    });

    it('emits log_rate_limited sidecar with dropped count on next allowed emit', async () => {
      const lines: string[] = [];
      // Short window so we don't sleep long in tests. capacity=2 / window=200ms
      // → refill = 0.01 token/ms. Waiting 150ms adds 1.5 tokens (enough for 1 call).
      const logger = createLogger({
        component: 'test',
        writer: (line) => lines.push(line),
        rate_limit_capacity: 2,
        rate_limit_window_ms: 200,
      });
      logger.warn('attack'); // 1/2
      logger.warn('attack'); // 2/2
      logger.warn('attack'); // dropped
      logger.warn('attack'); // dropped
      await new Promise((r) => setTimeout(r, 150));
      logger.warn('attack'); // allowed again, sidecar reports 2 dropped

      const entries = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
      const sidecar = entries.find((e) => e['event'] === 'log_rate_limited');
      expect(sidecar).toBeDefined();
      expect((sidecar!['details'] as Record<string, unknown>)['suppressed_event']).toBe('attack');
      expect((sidecar!['details'] as Record<string, unknown>)['dropped_count']).toBe(2);
    });

    it('rate-limit buckets are per-event (distinct events do not share a bucket)', () => {
      const lines: string[] = [];
      const logger = createLogger({
        component: 'test',
        writer: (line) => lines.push(line),
        rate_limit_capacity: 1,
        rate_limit_window_ms: 60_000,
      });
      logger.warn('event_a'); // allowed
      logger.warn('event_b'); // allowed — different bucket
      logger.warn('event_a'); // dropped — same bucket full
      expect(lines.length).toBe(2);
    });

    it('rejects rate_limit_capacity < 1 at construction', () => {
      expect(() => createLogger({ component: 'x', rate_limit_capacity: 0 })).toThrow(/positive integer/);
      expect(() => createLogger({ component: 'x', rate_limit_capacity: -5 })).toThrow(/positive integer/);
      expect(() => createLogger({ component: 'x', rate_limit_capacity: 1.5 })).toThrow(/positive integer/);
    });

    it('rejects rate_limit_window_ms <= 0 or non-finite', () => {
      expect(() => createLogger({ component: 'x', rate_limit_window_ms: 0 })).toThrow(/positive finite/);
      expect(() => createLogger({ component: 'x', rate_limit_window_ms: -1 })).toThrow(/positive finite/);
      expect(() => createLogger({ component: 'x', rate_limit_window_ms: Infinity })).toThrow(/positive finite/);
      expect(() => createLogger({ component: 'x', rate_limit_window_ms: NaN })).toThrow(/positive finite/);
    });

    it('child loggers share the parent rate-limit buckets', () => {
      const lines: string[] = [];
      const parent = createLogger({
        component: 'parent',
        writer: (line) => lines.push(line),
        rate_limit_capacity: 2,
        rate_limit_window_ms: 60_000,
      });
      const child = parent.child({ component: 'child' });
      parent.warn('shared_event'); // 1/2 (parent)
      child.warn('shared_event');  // 2/2 (child counts against same bucket)
      child.warn('shared_event');  // dropped
      const entries = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
      const shared = entries.filter((e) => e['event'] === 'shared_event');
      expect(shared.length).toBe(2);
    });
  });
});
