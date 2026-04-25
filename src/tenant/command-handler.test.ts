import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCommandHandler } from './command-handler.js';
import { createLogger } from '../shared/logger.js';

function createTestLogger() {
  return createLogger({ component: 'test', writer: () => {} });
}

describe('CommandHandler', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  describe('STATUS command', () => {
    it('returns status with uptime_ms, instance_id, instance_name', async () => {
      const startedAt = Date.now();
      const handler = createCommandHandler('inst-1', 'bot-1', startedAt, createTestLogger());

      vi.advanceTimersByTime(5000);

      const result = await handler.execute('STATUS', { command_id: 'cmd-1' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result['status']).toBe('RUNNING');
        expect(result.result['uptime_ms']).toBe(5000);
        expect(result.result['instance_id']).toBe('inst-1');
        expect(result.result['instance_name']).toBe('bot-1');
      }
    });

    it('handles case-insensitive command name', async () => {
      const handler = createCommandHandler('inst-1', 'bot-1', Date.now(), createTestLogger());
      const result = await handler.execute('status', { command_id: 'cmd-2' });
      expect(result.ok).toBe(true);
    });
  });

  describe('SHUTDOWN_GRACEFUL command', () => {
    it('sets shutdown flag and returns acknowledged', async () => {
      const handler = createCommandHandler('inst-1', 'bot-1', Date.now(), createTestLogger());

      expect(handler.isShutdownRequested()).toBe(false);

      const result = await handler.execute('SHUTDOWN_GRACEFUL', { command_id: 'cmd-3' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result['acknowledged']).toBe(true);
      }

      expect(handler.isShutdownRequested()).toBe(true);
    });
  });

  describe('SET_LOG_LEVEL command', () => {
    it('accepts valid log levels', async () => {
      const handler = createCommandHandler('inst-1', 'bot-1', Date.now(), createTestLogger());

      for (const level of ['debug', 'info', 'warn', 'error']) {
        const result = await handler.execute('SET_LOG_LEVEL', { command_id: 'cmd-lev', level });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.result['level']).toBe(level);
        }
      }
    });

    it('rejects invalid log level', async () => {
      const handler = createCommandHandler('inst-1', 'bot-1', Date.now(), createTestLogger());

      const result = await handler.execute('SET_LOG_LEVEL', { command_id: 'cmd-bad', level: 'verbose' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error_code).toBe('INVALID_PARAM');
        expect(result.message).toContain('verbose');
      }
    });

    it('rejects non-string level', async () => {
      const handler = createCommandHandler('inst-1', 'bot-1', Date.now(), createTestLogger());

      const result = await handler.execute('SET_LOG_LEVEL', { command_id: 'cmd-num', level: 42 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error_code).toBe('INVALID_PARAM');
      }
    });

    it('rejects missing level param', async () => {
      const handler = createCommandHandler('inst-1', 'bot-1', Date.now(), createTestLogger());

      const result = await handler.execute('SET_LOG_LEVEL', { command_id: 'cmd-miss' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error_code).toBe('INVALID_PARAM');
      }
    });
  });

  describe('unknown command', () => {
    it('returns UNKNOWN_COMMAND error', async () => {
      const handler = createCommandHandler('inst-1', 'bot-1', Date.now(), createTestLogger());

      const result = await handler.execute('DO_MAGIC', { command_id: 'cmd-unk' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error_code).toBe('UNKNOWN_COMMAND');
        expect(result.message).toContain('DO_MAGIC');
      }
    });
  });

  describe('command_id handling', () => {
    it('passes through command_id from params', async () => {
      const handler = createCommandHandler('inst-1', 'bot-1', Date.now(), createTestLogger());
      const result = await handler.execute('STATUS', { command_id: 'abc-123' });
      expect(result.command_id).toBe('abc-123');
    });

    it('defaults to empty string if command_id missing', async () => {
      const handler = createCommandHandler('inst-1', 'bot-1', Date.now(), createTestLogger());
      const result = await handler.execute('STATUS', {});
      expect(result.command_id).toBe('');
    });
  });
});
