import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHeartbeatEmitter } from './heartbeat.js';
import { createLogger } from '../shared/logger.js';
import type { SphereDmSender } from './types.js';

function createTestSender(): SphereDmSender & { sent: Array<{ to: string; content: string }> } {
  const sent: Array<{ to: string; content: string }> = [];
  return {
    sent,
    async sendDm(to: string, content: string) {
      sent.push({ to, content });
    },
  };
}

function createTestLogger() {
  return createLogger({ component: 'test', writer: () => {} });
}

describe('HeartbeatEmitter', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('sends heartbeat immediately on start', () => {
    const sender = createTestSender();
    const emitter = createHeartbeatEmitter(sender, 'inst-1', 'bot-1', 'DIRECT://mgr', createTestLogger());

    emitter.start(5000);
    expect(sender.sent).toHaveLength(1);

    const msg = JSON.parse(sender.sent[0]!.content) as Record<string, unknown>;
    expect(msg['type']).toBe('acp.heartbeat');

    const payload = msg['payload'] as Record<string, unknown>;
    expect(payload['status']).toBe('RUNNING');
    expect(payload['uptime_ms']).toBe(0);
    expect((payload['app'] as Record<string, unknown>)['mode']).toBe('boilerplate');
    expect((payload['app'] as Record<string, unknown>)['pid']).toBe(process.pid);

    emitter.stop();
  });

  it('sends to the correct manager address', () => {
    const sender = createTestSender();
    const emitter = createHeartbeatEmitter(sender, 'inst-1', 'bot-1', 'DIRECT://my-manager', createTestLogger());

    emitter.start(5000);
    expect(sender.sent[0]!.to).toBe('DIRECT://my-manager');

    emitter.stop();
  });

  it('sends heartbeats at the correct interval', () => {
    const sender = createTestSender();
    const emitter = createHeartbeatEmitter(sender, 'inst-1', 'bot-1', 'DIRECT://mgr', createTestLogger());

    emitter.start(3000);
    expect(sender.sent).toHaveLength(1); // immediate

    vi.advanceTimersByTime(3000);
    expect(sender.sent).toHaveLength(2);

    vi.advanceTimersByTime(3000);
    expect(sender.sent).toHaveLength(3);

    vi.advanceTimersByTime(3000);
    expect(sender.sent).toHaveLength(4);

    emitter.stop();
  });

  it('tracks uptime_ms in payload', () => {
    const sender = createTestSender();
    const emitter = createHeartbeatEmitter(sender, 'inst-1', 'bot-1', 'DIRECT://mgr', createTestLogger());

    emitter.start(5000);

    vi.advanceTimersByTime(10000);
    const lastMsg = JSON.parse(sender.sent[sender.sent.length - 1]!.content) as Record<string, unknown>;
    const payload = lastMsg['payload'] as Record<string, unknown>;
    expect(payload['uptime_ms']).toBe(10000);

    emitter.stop();
  });

  it('stop clears the interval', () => {
    const sender = createTestSender();
    const emitter = createHeartbeatEmitter(sender, 'inst-1', 'bot-1', 'DIRECT://mgr', createTestLogger());

    emitter.start(5000);
    expect(sender.sent).toHaveLength(1);

    emitter.stop();
    vi.advanceTimersByTime(15000);
    // No more heartbeats after stop
    expect(sender.sent).toHaveLength(1);
  });

  it('isRunning reflects state', () => {
    const sender = createTestSender();
    const emitter = createHeartbeatEmitter(sender, 'inst-1', 'bot-1', 'DIRECT://mgr', createTestLogger());

    expect(emitter.isRunning()).toBe(false);
    emitter.start(5000);
    expect(emitter.isRunning()).toBe(true);
    emitter.stop();
    expect(emitter.isRunning()).toBe(false);
  });

  it('start is idempotent when already running', () => {
    const sender = createTestSender();
    const emitter = createHeartbeatEmitter(sender, 'inst-1', 'bot-1', 'DIRECT://mgr', createTestLogger());

    emitter.start(5000);
    emitter.start(5000); // second call should be no-op
    expect(sender.sent).toHaveLength(1);

    emitter.stop();
  });

  // Round-18 F4: heartbeat.start() must re-tune to a new interval if
  // invoked while already running at a different cadence. This supports
  // managers adjusting heartbeat cadence dynamically (e.g. for backpressure
  // or load shedding) by sending a fresh hello_ack.
  it('re-tunes to new interval when start is called with different interval', () => {
    const sender = createTestSender();
    const emitter = createHeartbeatEmitter(sender, 'inst-1', 'bot-1', 'DIRECT://mgr', createTestLogger());

    emitter.start(5000);
    expect(sender.sent).toHaveLength(1); // immediate heartbeat

    // Advance 3s — no tick yet at 5s interval
    vi.advanceTimersByTime(3000);
    expect(sender.sent).toHaveLength(1);

    // Re-tune to 1s — should NOT emit an extra immediate heartbeat
    // (re-tuning adjusts cadence, not conceptually a new start).
    emitter.start(1000);
    expect(sender.sent).toHaveLength(1);

    // New cadence takes effect: tick at 1s from the re-tune moment
    vi.advanceTimersByTime(1000);
    expect(sender.sent).toHaveLength(2);

    // Original 5s interval should NOT still fire (old timer was cleared)
    vi.advanceTimersByTime(1000);
    expect(sender.sent).toHaveLength(3); // another 1s tick, not a stale 5s one

    emitter.stop();
  });

  it('re-tune preserves uptime_ms (not a new boot)', () => {
    const sender = createTestSender();
    const emitter = createHeartbeatEmitter(sender, 'inst-1', 'bot-1', 'DIRECT://mgr', createTestLogger());

    emitter.start(5000);
    vi.advanceTimersByTime(4000);

    // Re-tune to 2s. Uptime should continue to accumulate from original start.
    emitter.start(2000);
    vi.advanceTimersByTime(2000);

    const lastMsg = JSON.parse(sender.sent[sender.sent.length - 1]!.content) as Record<string, unknown>;
    const payload = lastMsg['payload'] as Record<string, unknown>;
    // 4000ms elapsed before re-tune + 2000ms after = 6000ms total uptime
    expect(payload['uptime_ms']).toBe(6000);

    emitter.stop();
  });

  it('re-tune with same interval is still idempotent no-op', () => {
    const sender = createTestSender();
    const emitter = createHeartbeatEmitter(sender, 'inst-1', 'bot-1', 'DIRECT://mgr', createTestLogger());

    emitter.start(3000);
    expect(sender.sent).toHaveLength(1);

    vi.advanceTimersByTime(1500);
    emitter.start(3000); // same interval → true no-op
    expect(sender.sent).toHaveLength(1);

    // Timer should not have been reset — tick fires at original 3000ms mark
    vi.advanceTimersByTime(1500);
    expect(sender.sent).toHaveLength(2);

    emitter.stop();
  });

  it('logs error when sendDm fails', () => {
    const failingSender: SphereDmSender = {
      async sendDm() {
        throw new Error('network down');
      },
    };
    const emitter = createHeartbeatEmitter(failingSender, 'inst-1', 'bot-1', 'DIRECT://mgr', createTestLogger());

    // Should not throw
    emitter.start(5000);
    emitter.stop();
  });

  // Round-19 F4: rate-limited retune logging. A compromised/buggy manager
  // that flip-flops heartbeat cadence via repeated hello_acks must not be
  // able to flood the INFO log stream. First retune logs INFO; subsequent
  // retunes within the 60s window drop to DEBUG.
  describe('round-19 F4: retune log rate-limit', () => {
    it('first retune logs at INFO, subsequent retunes within window drop to DEBUG', () => {
      const sender = createTestSender();
      const logs: Array<{ level: string; event: string }> = [];
      const capturingLogger = createLogger({
        component: 'test',
        writer: (line: string) => {
          const parsed = JSON.parse(line) as { level: string; event: string };
          logs.push(parsed);
        },
        level: 'debug',
      });
      const emitter = createHeartbeatEmitter(sender, 'inst-1', 'bot-1', 'DIRECT://mgr', capturingLogger);

      emitter.start(5000);
      // First retune — INFO
      emitter.start(3000);
      // Flip-flop flood — next 5 retunes all within < 60s should be DEBUG
      emitter.start(2000);
      emitter.start(5000);
      emitter.start(1000);
      emitter.start(2000);

      const retuneEvents = logs.filter((e) => e.event === 'heartbeat_retuned');
      expect(retuneEvents.length).toBe(5);
      // First retune: INFO. Subsequent retunes: DEBUG.
      expect(retuneEvents[0]!.level).toBe('INFO');
      for (let i = 1; i < retuneEvents.length; i++) {
        expect(retuneEvents[i]!.level).toBe('DEBUG');
      }

      emitter.stop();
    });

    it('retune after window elapses returns to INFO', () => {
      const sender = createTestSender();
      const logs: Array<{ level: string; event: string }> = [];
      const capturingLogger = createLogger({
        component: 'test',
        writer: (line: string) => {
          const parsed = JSON.parse(line) as { level: string; event: string };
          logs.push(parsed);
        },
        level: 'debug',
      });
      const emitter = createHeartbeatEmitter(sender, 'inst-1', 'bot-1', 'DIRECT://mgr', capturingLogger);

      emitter.start(5000);
      emitter.start(3000); // INFO retune

      // Advance past the 60s window
      vi.advanceTimersByTime(61_000);
      emitter.start(2000); // Should log at INFO again

      const retuneEvents = logs.filter((e) => e.event === 'heartbeat_retuned');
      expect(retuneEvents.length).toBe(2);
      expect(retuneEvents[0]!.level).toBe('INFO');
      expect(retuneEvents[1]!.level).toBe('INFO');

      emitter.stop();
    });

    // Round-21 F4: fixed-window rate-limit. Prior sliding-window version
    // updated `lastRetuneAt` on every retune — an attacker retuning every
    // 30s (just under the 60s window) stayed at DEBUG forever after the
    // first retune, hiding the flip-flop from default log level. With a
    // fixed window, the tracking timestamp is only updated when we log at
    // INFO, so the operator sees ~one INFO per minute regardless of
    // attacker rate.
    it('fixed-window semantics: attacker retuning every 30s still produces periodic INFO', () => {
      const sender = createTestSender();
      const logs: Array<{ level: string; event: string }> = [];
      const capturingLogger = createLogger({
        component: 'test',
        writer: (line: string) => {
          const parsed = JSON.parse(line) as { level: string; event: string };
          logs.push(parsed);
        },
        level: 'debug',
      });
      const emitter = createHeartbeatEmitter(sender, 'inst-1', 'bot-1', 'DIRECT://mgr', capturingLogger);

      emitter.start(5000);
      // t=0: first retune → INFO (window 0 → now), lastRetuneAt := t=0
      emitter.start(3000);
      // t=30s: elapsed 30s < 60s → DEBUG, lastRetuneAt UNCHANGED at t=0
      vi.advanceTimersByTime(30_000);
      emitter.start(2000);
      // t=60s: elapsed 60s >= 60s → INFO, lastRetuneAt := t=60s
      vi.advanceTimersByTime(30_000);
      emitter.start(1000);
      // t=90s: elapsed 30s < 60s → DEBUG
      vi.advanceTimersByTime(30_000);
      emitter.start(4000);
      // t=120s: elapsed 60s >= 60s → INFO, lastRetuneAt := t=120s
      vi.advanceTimersByTime(30_000);
      emitter.start(5000);

      const retuneEvents = logs.filter((e) => e.event === 'heartbeat_retuned');
      expect(retuneEvents.length).toBe(5);
      // Expected pattern under fixed window: INFO, DEBUG, INFO, DEBUG, INFO.
      // Under the broken sliding window it would have been: INFO, DEBUG,
      // DEBUG, DEBUG, DEBUG — because every retune pushed lastRetuneAt
      // forward, keeping us inside the 60s window forever.
      expect(retuneEvents[0]!.level).toBe('INFO');
      expect(retuneEvents[1]!.level).toBe('DEBUG');
      expect(retuneEvents[2]!.level).toBe('INFO');
      expect(retuneEvents[3]!.level).toBe('DEBUG');
      expect(retuneEvents[4]!.level).toBe('INFO');

      emitter.stop();
    });

    it('fixed-window semantics: multiple retunes within one window all DEBUG except first', () => {
      // Complement the attacker-pattern test with a burst case — many
      // retunes clustered together should produce exactly ONE INFO (the
      // first) and all subsequent within the window should be DEBUG, with
      // lastRetuneAt frozen at the first INFO time.
      const sender = createTestSender();
      const logs: Array<{ level: string; event: string }> = [];
      const capturingLogger = createLogger({
        component: 'test',
        writer: (line: string) => {
          const parsed = JSON.parse(line) as { level: string; event: string };
          logs.push(parsed);
        },
        level: 'debug',
      });
      const emitter = createHeartbeatEmitter(sender, 'inst-1', 'bot-1', 'DIRECT://mgr', capturingLogger);

      emitter.start(5000);
      // t=0: INFO
      emitter.start(3000);
      // Burst of retunes at t=10s, 20s, 30s, 40s, 50s — all inside the 60s
      // window, all should be DEBUG, lastRetuneAt stays at 0.
      for (let i = 1; i <= 5; i++) {
        vi.advanceTimersByTime(10_000);
        emitter.start(1000 + i * 100);
      }
      // t=60s: elapsed 60s >= 60s → INFO (regardless of the 5 prior DEBUGs)
      vi.advanceTimersByTime(10_000);
      emitter.start(9000);

      const retuneEvents = logs.filter((e) => e.event === 'heartbeat_retuned');
      expect(retuneEvents.length).toBe(7);
      expect(retuneEvents[0]!.level).toBe('INFO');
      for (let i = 1; i <= 5; i++) {
        expect(retuneEvents[i]!.level).toBe('DEBUG');
      }
      expect(retuneEvents[6]!.level).toBe('INFO');

      emitter.stop();
    });
  });

  // Round-19 F3: defense-in-depth clamping. `setInterval(cb, 0)` or a
  // negative number gets clamped by Node to 1ms → thousands of heartbeats
  // per second. The AcpListener clamps at the hello_ack boundary, but the
  // heartbeat emitter itself must also enforce a floor.
  describe('round-19 F3: interval clamping', () => {
    it('clamps intervalMs=0 to the 1000ms minimum floor', () => {
      const sender = createTestSender();
      const emitter = createHeartbeatEmitter(sender, 'inst-1', 'bot-1', 'DIRECT://mgr', createTestLogger());

      emitter.start(0);
      expect(sender.sent).toHaveLength(1); // immediate heartbeat

      // After 999ms — still only the immediate tick
      vi.advanceTimersByTime(999);
      expect(sender.sent).toHaveLength(1);

      // At 1000ms the clamped-floor interval fires
      vi.advanceTimersByTime(1);
      expect(sender.sent).toHaveLength(2);

      emitter.stop();
    });

    it('clamps negative intervalMs to the 1000ms minimum floor', () => {
      const sender = createTestSender();
      const emitter = createHeartbeatEmitter(sender, 'inst-1', 'bot-1', 'DIRECT://mgr', createTestLogger());

      emitter.start(-5000);
      expect(sender.sent).toHaveLength(1);

      vi.advanceTimersByTime(999);
      expect(sender.sent).toHaveLength(1);

      vi.advanceTimersByTime(1);
      expect(sender.sent).toHaveLength(2);

      emitter.stop();
    });

    it('clamps NaN / Infinity / non-finite inputs to the 1000ms floor', () => {
      const sender = createTestSender();
      const emitter = createHeartbeatEmitter(sender, 'inst-1', 'bot-1', 'DIRECT://mgr', createTestLogger());

      emitter.start(NaN);
      expect(sender.sent).toHaveLength(1);
      vi.advanceTimersByTime(1000);
      expect(sender.sent).toHaveLength(2);
      emitter.stop();

      const sender2 = createTestSender();
      const emitter2 = createHeartbeatEmitter(sender2, 'inst-1', 'bot-1', 'DIRECT://mgr', createTestLogger());
      emitter2.start(Infinity);
      expect(sender2.sent).toHaveLength(1);
      vi.advanceTimersByTime(1000);
      expect(sender2.sent).toHaveLength(2);
      emitter2.stop();
    });

    it('logs heartbeat_interval_clamped when input is below floor', () => {
      const sender = createTestSender();
      const logs: Array<{ event: string; details?: Record<string, unknown> }> = [];
      const capturingLogger = createLogger({
        component: 'test',
        writer: (line: string) => {
          const parsed = JSON.parse(line) as { event: string; details?: Record<string, unknown> };
          logs.push(parsed);
        },
      });
      const emitter = createHeartbeatEmitter(sender, 'inst-1', 'bot-1', 'DIRECT://mgr', capturingLogger);

      emitter.start(0);
      const clampEvents = logs.filter((e) => e.event === 'heartbeat_interval_clamped');
      expect(clampEvents.length).toBeGreaterThanOrEqual(1);
      const details = clampEvents[0]!.details as Record<string, unknown>;
      expect(details['requested']).toBe(0);
      expect(details['applied']).toBe(1000);

      emitter.stop();
    });

    it('accepts exactly 1000ms unchanged (at the floor, not clamped)', () => {
      const sender = createTestSender();
      const logs: Array<{ event: string }> = [];
      const capturingLogger = createLogger({
        component: 'test',
        writer: (line: string) => {
          const parsed = JSON.parse(line) as { event: string };
          logs.push(parsed);
        },
      });
      const emitter = createHeartbeatEmitter(sender, 'inst-1', 'bot-1', 'DIRECT://mgr', capturingLogger);

      emitter.start(1000);
      // No clamp warning because 1000 >= floor
      expect(logs.find((e) => e.event === 'heartbeat_interval_clamped')).toBeUndefined();

      emitter.stop();
    });
  });

  it('includes instance_id and instance_name in message', () => {
    const sender = createTestSender();
    const emitter = createHeartbeatEmitter(sender, 'my-inst-42', 'my-bot', 'DIRECT://mgr', createTestLogger());

    emitter.start(5000);
    const msg = JSON.parse(sender.sent[0]!.content) as Record<string, unknown>;
    expect(msg['instance_id']).toBe('my-inst-42');
    expect(msg['instance_name']).toBe('my-bot');

    emitter.stop();
  });
});
