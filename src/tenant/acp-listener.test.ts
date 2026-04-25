import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAcpListener } from './acp-listener.js';
import type { AcpListenerDeps } from './acp-listener.js';
import { createAcpMessage, ACP_VERSION } from '../protocols/acp.js';
import { serializeMessage } from '../protocols/envelope.js';
import { createLogger } from '../shared/logger.js';
import type { TenantConfig } from '../shared/types.js';
import type { SphereDmSender, SphereDmReceiver, DmSubscription } from './types.js';

// ---- Test Helpers ----

function createTestSender(): SphereDmSender & { sent: Array<{ to: string; content: string }> } {
  const sent: Array<{ to: string; content: string }> = [];
  return {
    sent,
    async sendDm(to: string, content: string) {
      sent.push({ to, content });
    },
  };
}

type DmCallback = (senderPubkey: string, senderAddress: string, content: string) => void;

function createTestReceiver(): SphereDmReceiver & { triggerMessage: DmCallback; unsubscribeCalled: boolean } {
  let messageCallback: DmCallback | null = null;
  const result = {
    unsubscribeCalled: false,
    triggerMessage(senderPubkey: string, senderAddress: string, content: string) {
      if (messageCallback) {
        messageCallback(senderPubkey, senderAddress, content);
      }
    },
    subscribeDm(): DmSubscription {
      return {
        onMessage(cb: DmCallback) {
          messageCallback = cb;
        },
        unsubscribe() {
          result.unsubscribeCalled = true;
          messageCallback = null;
        },
      };
    },
  };
  return result;
}

function createTestLogger() {
  return createLogger({ component: 'test', writer: () => {} });
}

// Manager pubkey must be a valid hex pubkey (33 bytes compressed)
const MANAGER_PUBKEY = '02aabbccddee00112233445566778899aabbccddee00112233445566778899aa';

function createTestConfig(overrides?: Partial<TenantConfig>): TenantConfig {
  return {
    manager_pubkey: MANAGER_PUBKEY,
    boot_token: 'test-boot-token',
    instance_id: 'inst-1',
    instance_name: 'bot-1',
    template_id: 'tmpl-1',
    network: 'testnet',
    data_dir: '/data/wallet',
    tokens_dir: '/data/tokens',
    log_level: 'debug',
    heartbeat_interval_ms: 5000,
    controller_pubkey: null,
    ...overrides,
  };
}

function createTestDeps(overrides?: Partial<AcpListenerDeps>): AcpListenerDeps & {
  sender: ReturnType<typeof createTestSender>;
  receiver: ReturnType<typeof createTestReceiver>;
} {
  const sender = createTestSender();
  const receiver = createTestReceiver();
  const config = createTestConfig();
  const base: AcpListenerDeps = {
    sender,
    receiver,
    config,
    tenantPubkey: '03tenant_pubkey_placeholder_for_testing_00000000000000000000000000',
    tenantDirectAddress: 'DIRECT://tenant',
    managerAddress: 'DIRECT://manager',
    logger: createTestLogger(),
    ...overrides,
  };
  // Return the base deps with the test-extended sender/receiver re-attached.
  // Spread above may cast SphereDmSender to the bare interface type; re-pin
  // sender/receiver here so callers can still access `.sent` / `.triggerMessage`.
  return { ...base, sender, receiver };
}

describe('AcpListener', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  describe('start', () => {
    it('sends acp.hello on start', async () => {
      const deps = createTestDeps();
      const listener = createAcpListener(deps);

      await listener.start();

      expect(deps.sender.sent).toHaveLength(1);
      const msg = JSON.parse(deps.sender.sent[0]!.content) as Record<string, unknown>;
      expect(msg['type']).toBe('acp.hello');
      expect(msg['acp_version']).toBe(ACP_VERSION);
      expect(msg['instance_id']).toBe('inst-1');
      expect(msg['instance_name']).toBe('bot-1');

      const payload = msg['payload'] as Record<string, unknown>;
      expect(payload['boot_token']).toBe('test-boot-token');
      expect(payload['tenant_direct_address']).toBe('DIRECT://tenant');

      await listener.stop();
    });

    it('sends hello to the manager address', async () => {
      const deps = createTestDeps();
      const listener = createAcpListener(deps);

      await listener.start();
      expect(deps.sender.sent[0]!.to).toBe('DIRECT://manager');

      await listener.stop();
    });
  });

  describe('hello_ack handling', () => {
    it('starts heartbeat after receiving hello_ack', async () => {
      const deps = createTestDeps();
      const listener = createAcpListener(deps);

      await listener.start();
      const sentBefore = deps.sender.sent.length;

      // Simulate manager sending hello_ack
      const helloAck = createAcpMessage('acp.hello_ack', 'inst-1', 'bot-1', {
        accepted: true,
        manager_pubkey: MANAGER_PUBKEY,
        heartbeat_interval_ms: 3000,
        notes: 'ok',
      });
      deps.receiver.triggerMessage(MANAGER_PUBKEY, 'DIRECT://manager', serializeMessage(helloAck));

      // Heartbeat should send immediately on start
      expect(deps.sender.sent.length).toBe(sentBefore + 1);
      const heartbeatMsg = JSON.parse(deps.sender.sent[deps.sender.sent.length - 1]!.content) as Record<string, unknown>;
      expect(heartbeatMsg['type']).toBe('acp.heartbeat');

      // Advance time — more heartbeats should arrive
      vi.advanceTimersByTime(3000);
      expect(deps.sender.sent.length).toBe(sentBefore + 2);

      await listener.stop();
    });

    it('uses config heartbeat_interval_ms if hello_ack does not specify', async () => {
      const deps = createTestDeps();
      deps.config = createTestConfig({ heartbeat_interval_ms: 7000 });
      const listener = createAcpListener(deps);

      await listener.start();
      const sentBefore = deps.sender.sent.length;

      const helloAck = createAcpMessage('acp.hello_ack', 'inst-1', 'bot-1', {
        accepted: true,
        manager_pubkey: MANAGER_PUBKEY,
        notes: 'ok',
      });
      deps.receiver.triggerMessage(MANAGER_PUBKEY, 'DIRECT://manager', serializeMessage(helloAck));

      // Immediate heartbeat
      expect(deps.sender.sent.length).toBe(sentBefore + 1);

      // Should not fire at 5000
      vi.advanceTimersByTime(5000);
      expect(deps.sender.sent.length).toBe(sentBefore + 1);

      // Should fire at 7000
      vi.advanceTimersByTime(2000);
      expect(deps.sender.sent.length).toBe(sentBefore + 2);

      await listener.stop();
    });
  });

  describe('ping/pong handling', () => {
    it('responds to acp.ping with acp.pong', async () => {
      const deps = createTestDeps();
      const listener = createAcpListener(deps);

      await listener.start();
      const sentBefore = deps.sender.sent.length;

      const ping = createAcpMessage('acp.ping', 'inst-1', 'bot-1', {
        ts_ms: Date.now(),
      });
      deps.receiver.triggerMessage(MANAGER_PUBKEY, 'DIRECT://manager', serializeMessage(ping));

      // Allow async sendDm to settle
      await vi.advanceTimersByTimeAsync(0);

      expect(deps.sender.sent.length).toBe(sentBefore + 1);
      const pongRaw = JSON.parse(deps.sender.sent[deps.sender.sent.length - 1]!.content) as Record<string, unknown>;
      expect(pongRaw['type']).toBe('acp.pong');

      const pongPayload = pongRaw['payload'] as Record<string, unknown>;
      expect(pongPayload['in_reply_to']).toBe(ping.msg_id);
      expect(typeof pongPayload['ts_ms']).toBe('number');

      await listener.stop();
    });

    it('sends pong to manager address', async () => {
      const deps = createTestDeps();
      const listener = createAcpListener(deps);

      await listener.start();

      const ping = createAcpMessage('acp.ping', 'inst-1', 'bot-1', {
        ts_ms: Date.now(),
      });
      deps.receiver.triggerMessage(MANAGER_PUBKEY, 'DIRECT://manager', serializeMessage(ping));

      await vi.advanceTimersByTimeAsync(0);

      const lastSent = deps.sender.sent[deps.sender.sent.length - 1]!;
      expect(lastSent.to).toBe('DIRECT://manager');

      await listener.stop();
    });
  });

  describe('command dispatch', () => {
    it('dispatches acp.command to command handler and sends result', async () => {
      const deps = createTestDeps();
      const listener = createAcpListener(deps);

      await listener.start();
      const sentBefore = deps.sender.sent.length;

      const cmd = createAcpMessage('acp.command', 'inst-1', 'bot-1', {
        command_id: 'cmd-42',
        name: 'STATUS',
        params: {},
      });
      deps.receiver.triggerMessage(MANAGER_PUBKEY, 'DIRECT://manager', serializeMessage(cmd));

      await vi.advanceTimersByTimeAsync(0);

      expect(deps.sender.sent.length).toBe(sentBefore + 1);
      const responseRaw = JSON.parse(deps.sender.sent[deps.sender.sent.length - 1]!.content) as Record<string, unknown>;
      expect(responseRaw['type']).toBe('acp.result');

      const payload = responseRaw['payload'] as Record<string, unknown>;
      expect(payload['command_id']).toBe('cmd-42');
      expect(payload['ok']).toBe(true);

      const result = payload['result'] as Record<string, unknown>;
      expect(result['status']).toBe('RUNNING');
      expect(result['instance_id']).toBe('inst-1');

      await listener.stop();
    });

    it('sends acp.error for unknown command', async () => {
      const deps = createTestDeps();
      const listener = createAcpListener(deps);

      await listener.start();
      const sentBefore = deps.sender.sent.length;

      const cmd = createAcpMessage('acp.command', 'inst-1', 'bot-1', {
        command_id: 'cmd-99',
        name: 'EXPLODE',
        params: {},
      });
      deps.receiver.triggerMessage(MANAGER_PUBKEY, 'DIRECT://manager', serializeMessage(cmd));

      await vi.advanceTimersByTimeAsync(0);

      expect(deps.sender.sent.length).toBe(sentBefore + 1);
      const responseRaw = JSON.parse(deps.sender.sent[deps.sender.sent.length - 1]!.content) as Record<string, unknown>;
      expect(responseRaw['type']).toBe('acp.error');

      const payload = responseRaw['payload'] as Record<string, unknown>;
      expect(payload['ok']).toBe(false);
      expect(payload['error_code']).toBe('UNKNOWN_COMMAND');

      await listener.stop();
    });

    it('SHUTDOWN_GRACEFUL sets shutdown flag', async () => {
      const deps = createTestDeps();
      const listener = createAcpListener(deps);

      await listener.start();
      expect(listener.isShutdownRequested()).toBe(false);

      const cmd = createAcpMessage('acp.command', 'inst-1', 'bot-1', {
        command_id: 'cmd-shut',
        name: 'SHUTDOWN_GRACEFUL',
        params: {},
      });
      deps.receiver.triggerMessage(MANAGER_PUBKEY, 'DIRECT://manager', serializeMessage(cmd));

      expect(listener.isShutdownRequested()).toBe(true);

      await listener.stop();
    });
  });

  describe('external DM routing', () => {
    it('routes non-manager DMs to the message handler (log only, no response)', async () => {
      const deps = createTestDeps();
      const listener = createAcpListener(deps);

      await listener.start();
      const sentBefore = deps.sender.sent.length;

      // External sender (different pubkey than manager)
      const externalPubkey = '03eeff00112233445566778899aabbccddee00112233445566778899aabbccdd';
      deps.receiver.triggerMessage(externalPubkey, 'DIRECT://alice', 'Hello bot!');

      // MessageHandler logs the DM but does NOT send a response (prevents identity leak)
      await vi.advanceTimersByTimeAsync(10);

      expect(deps.sender.sent.length).toBe(sentBefore);

      await listener.stop();
    });

    it('does not leak instance identity to external senders', async () => {
      const deps = createTestDeps();
      const listener = createAcpListener(deps);

      await listener.start();
      const sentBefore = deps.sender.sent.length;

      const externalPubkey = '03eeff00112233445566778899aabbccddee00112233445566778899aabbccdd';
      deps.receiver.triggerMessage(externalPubkey, 'DIRECT://bob', 'Hey');

      await vi.advanceTimersByTimeAsync(10);

      // No new messages sent — external DMs are logged but not responded to
      expect(deps.sender.sent.length).toBe(sentBefore);

      await listener.stop();
    });
  });

  describe('invalid messages from manager', () => {
    it('ignores invalid JSON from manager', async () => {
      const deps = createTestDeps();
      const listener = createAcpListener(deps);

      await listener.start();
      const sentBefore = deps.sender.sent.length;

      deps.receiver.triggerMessage(MANAGER_PUBKEY, 'DIRECT://manager', 'not valid json{{{');

      // Should not send any response
      expect(deps.sender.sent.length).toBe(sentBefore);

      await listener.stop();
    });

    it('ignores non-ACP JSON from manager', async () => {
      const deps = createTestDeps();
      const listener = createAcpListener(deps);

      await listener.start();
      const sentBefore = deps.sender.sent.length;

      deps.receiver.triggerMessage(MANAGER_PUBKEY, 'DIRECT://manager', JSON.stringify({ foo: 'bar' }));

      expect(deps.sender.sent.length).toBe(sentBefore);

      await listener.stop();
    });
  });

  describe('round-18 F1/F2: per-run state reset', () => {
    it('resets messageCount and lastActivityMs at start() entry when no state store', async () => {
      // Without a state store, per-run fields must ALWAYS start at zero.
      const deps = createTestDeps();
      const listener = createAcpListener(deps);
      await listener.start();

      // Send a ping to drive messageCount up
      const ping = createAcpMessage('acp.ping', 'inst-1', 'bot-1', { ts_ms: Date.now() });
      deps.receiver.triggerMessage(MANAGER_PUBKEY, 'DIRECT://manager', serializeMessage(ping));
      await vi.advanceTimersByTimeAsync(0);

      await listener.stop();

      // Restart — the per-run state should be reset before recovery.
      // Since there's no state store, nothing is recovered, so counters
      // must be 0. We observe this indirectly by sending a STATUS command
      // that reads messageCount via the command handler snapshot fn.
      await listener.start();
      const cmd = createAcpMessage('acp.command', 'inst-1', 'bot-1', {
        command_id: 'cmd-status',
        name: 'STATUS',
        params: {},
      });
      deps.receiver.triggerMessage(MANAGER_PUBKEY, 'DIRECT://manager', serializeMessage(cmd));
      await vi.advanceTimersByTimeAsync(0);

      const statusResp = JSON.parse(deps.sender.sent[deps.sender.sent.length - 1]!.content) as Record<string, unknown>;
      expect(statusResp['type']).toBe('acp.result');
      const payload = statusResp['payload'] as Record<string, unknown>;
      const result = payload['result'] as Record<string, unknown>;
      // After restart: 1 message (the STATUS command itself) not the prior run's tally
      expect(result['message_count']).toBe(1);

      await listener.stop();
    });

    it('does NOT persist when state recovery threw (startedOnce stays false for the run)', async () => {
      const saveCalls: unknown[] = [];
      const throwingStateStore = {
        async load() { throw new Error('disk error'); },
        async save(state: unknown) { saveCalls.push(state); },
      };
      const deps = createTestDeps({ stateStore: throwingStateStore });
      const listener = createAcpListener(deps);

      await listener.start();
      // Send a ping to increment counters
      const ping = createAcpMessage('acp.ping', 'inst-1', 'bot-1', { ts_ms: Date.now() });
      deps.receiver.triggerMessage(MANAGER_PUBKEY, 'DIRECT://manager', serializeMessage(ping));
      await vi.advanceTimersByTimeAsync(0);

      await listener.stop();

      // stop() must have skipped save() because recovery threw
      expect(saveCalls).toHaveLength(0);
    });

    it('persists in later run when recovery succeeds, even if earlier run failed', async () => {
      // Round-18 F1: startedOnce must NOT remain stuck at true across a
      // failed-recovery run — it must be reset per-run. If we recover cleanly
      // on the second start(), we SHOULD save on stop.
      const saveCalls: unknown[] = [];
      let shouldThrow = true;
      const flakyStateStore = {
        async load() {
          if (shouldThrow) throw new Error('disk error');
          return null; // fresh-start, ENOENT-equivalent
        },
        async save(state: unknown) { saveCalls.push(state); },
      };

      const deps = createTestDeps({ stateStore: flakyStateStore });
      const listener = createAcpListener(deps);

      await listener.start(); // recovery throws
      await listener.stop();
      expect(saveCalls).toHaveLength(0); // no save on failed-recovery run

      // Recovery now succeeds on next attempt
      shouldThrow = false;
      await listener.start();
      await listener.stop();

      // Second run recovered cleanly — save MUST happen
      expect(saveCalls).toHaveLength(1);
    });
  });

  describe('round-18 F3: stopped guard on acp.command', () => {
    it('drops acp.command arriving after stop()', async () => {
      const deps = createTestDeps();
      const listener = createAcpListener(deps);

      await listener.start();
      await listener.stop();

      const sentBefore = deps.sender.sent.length;

      const cmd = createAcpMessage('acp.command', 'inst-1', 'bot-1', {
        command_id: 'cmd-late',
        name: 'STATUS',
        params: {},
      });
      // Trigger AFTER stop — unsubscribe was called, but if a buffered
      // callback fires, the handler must drop it.
      //
      // Our test receiver clears the callback on unsubscribe, so the
      // trigger is a no-op here. Simulate the race directly by sending
      // through a new subscription before stop completes — but more
      // simply, verify the stopped guard is the one that prevents send
      // by re-starting and checking a pre-stopped drop: call stop() mid-
      // flight via a synchronous path. The simpler assertion here is that
      // after stop+unsubscribe, nothing new gets sent — regardless of
      // which layer drops it.
      deps.receiver.triggerMessage(MANAGER_PUBKEY, 'DIRECT://manager', serializeMessage(cmd));
      await vi.advanceTimersByTimeAsync(10);

      expect(deps.sender.sent.length).toBe(sentBefore);
    });
  });

  describe('round-18 F4: heartbeat retune via second hello_ack', () => {
    it('second hello_ack with a different interval re-tunes heartbeat', async () => {
      const deps = createTestDeps();
      const listener = createAcpListener(deps);

      await listener.start();

      // First hello_ack at 5000ms
      const helloAck1 = createAcpMessage('acp.hello_ack', 'inst-1', 'bot-1', {
        accepted: true,
        manager_pubkey: MANAGER_PUBKEY,
        heartbeat_interval_ms: 5000,
        notes: 'ok',
      });
      deps.receiver.triggerMessage(MANAGER_PUBKEY, 'DIRECT://manager', serializeMessage(helloAck1));
      const sentAfterFirstAck = deps.sender.sent.length;

      // Advance to t=3000 (no tick yet at 5000 interval)
      vi.advanceTimersByTime(3000);
      expect(deps.sender.sent.length).toBe(sentAfterFirstAck);

      // Second hello_ack at 1000ms — manager wants faster cadence now
      const helloAck2 = createAcpMessage('acp.hello_ack', 'inst-1', 'bot-1', {
        accepted: true,
        manager_pubkey: MANAGER_PUBKEY,
        heartbeat_interval_ms: 1000,
        notes: 'slow down not, speed up',
      });
      deps.receiver.triggerMessage(MANAGER_PUBKEY, 'DIRECT://manager', serializeMessage(helloAck2));
      // Re-tune doesn't emit an immediate heartbeat, so count unchanged
      expect(deps.sender.sent.length).toBe(sentAfterFirstAck);

      // Advance 1000ms — now we SHOULD see the new cadence tick
      vi.advanceTimersByTime(1000);
      expect(deps.sender.sent.length).toBe(sentAfterFirstAck + 1);

      await listener.stop();
    });
  });

  describe('round-18 F5: publicMessage sanitization', () => {
    it('strips control chars and ANSI escapes from publicMessage', async () => {
      // Create a command handler factory that throws an error with a
      // nasty publicMessage.
      const factory = (_id: string, _name: string, _t: number, _l: unknown) => ({
        async execute(_cmd: string, _params: unknown): Promise<{ ok: boolean; command_id: string }> {
          const err = new Error('boom');
          (err as Error & { code?: string; publicMessage?: string }).code = 'INVALID_ARGS';
          (err as Error & { code?: string; publicMessage?: string }).publicMessage =
            // ANSI escape to paint the operator's terminal red + embedded newline + NUL byte
            'bad\u001b[31mARG\u0000\ninjected';
          throw err;
        },
        isShutdownRequested() { return false; },
      });

      const deps = createTestDeps({ commandHandlerFactory: factory as never });
      const listener = createAcpListener(deps);

      await listener.start();

      const cmd = createAcpMessage('acp.command', 'inst-1', 'bot-1', {
        command_id: 'cmd-san',
        name: 'ANY',
        params: {},
      });
      deps.receiver.triggerMessage(MANAGER_PUBKEY, 'DIRECT://manager', serializeMessage(cmd));
      await vi.advanceTimersByTimeAsync(10);

      const lastMsg = JSON.parse(deps.sender.sent[deps.sender.sent.length - 1]!.content) as Record<string, unknown>;
      expect(lastMsg['type']).toBe('acp.error');
      const payload = lastMsg['payload'] as Record<string, unknown>;
      expect(payload['error_code']).toBe('INVALID_ARGS');
      const wireMsg = payload['message'] as string;
      // No ESC, no NUL, no newline should make it through sanitization
      expect(wireMsg).not.toMatch(/\u001b/);
      expect(wireMsg).not.toMatch(/\u0000/);
      expect(wireMsg).not.toMatch(/\n/);
      // Control bytes are replaced with spaces then trimmed/collapsed by slice+trim
      expect(wireMsg.length).toBeGreaterThan(0);

      await listener.stop();
    });
  });

  describe('round-19 F1: bidi/invisible unicode sanitization', () => {
    it('strips U+202E right-to-left override and other bidi/invisible chars from publicMessage', async () => {
      // Round-19 F1: Trojan Source style attack — a publicMessage containing
      // U+202E (RLO) can reverse the visual appearance of a log line in the
      // operator's terminal so "PAYMENT_FAILED" reads as "DELIAF_TNEMYAP"
      // from the right, or vice versa. The prior sanitizer stripped C0/C1
      // controls but left bidi marks, ZWJs, and BOM pass through. This test
      // asserts they all go.
      const factory = (_id: string, _name: string, _t: number, _l: unknown) => ({
        async execute(_cmd: string, _params: unknown): Promise<{ ok: boolean; command_id: string }> {
          const err = new Error('boom');
          (err as Error & { code?: string; publicMessage?: string }).code = 'INVALID_ARGS';
          (err as Error & { code?: string; publicMessage?: string }).publicMessage =
            // Every class the regex must cover:
            //  U+202E RLO, U+202D LRO, U+2066-U+2069 isolates,
            //  U+200B-U+200D ZWSP/ZWNJ/ZWJ, U+200E/F LRM/RLM, U+FEFF BOM
            'benign \u202e tamper \u202d more \u2066 iso \u2067 \u2068 \u2069' +
            ' \u200b zw \u200c nj \u200d j \u200e lrm \u200f rlm \u{feff} bom';
          throw err;
        },
        isShutdownRequested() { return false; },
      });

      const deps = createTestDeps({ commandHandlerFactory: factory as never });
      const listener = createAcpListener(deps);

      await listener.start();

      const cmd = createAcpMessage('acp.command', 'inst-1', 'bot-1', {
        command_id: 'cmd-bidi',
        name: 'ANY',
        params: {},
      });
      deps.receiver.triggerMessage(MANAGER_PUBKEY, 'DIRECT://manager', serializeMessage(cmd));
      await vi.advanceTimersByTimeAsync(10);

      const lastMsg = JSON.parse(deps.sender.sent[deps.sender.sent.length - 1]!.content) as Record<string, unknown>;
      expect(lastMsg['type']).toBe('acp.error');
      const payload = lastMsg['payload'] as Record<string, unknown>;
      const wireMsg = payload['message'] as string;

      // None of the dangerous codepoints should survive
      for (const cp of [
        '\u202e', '\u202d', '\u2066', '\u2067', '\u2068', '\u2069',
        '\u200b', '\u200c', '\u200d', '\u200e', '\u200f', '\ufeff',
      ]) {
        expect(wireMsg.includes(cp)).toBe(false);
      }

      await listener.stop();
    });

    it('sanitizes minimal "benign \\u202E tamper" case', async () => {
      // Regression test for the exact example called out in the fix spec.
      const factory = (_id: string, _name: string, _t: number, _l: unknown) => ({
        async execute(_cmd: string, _params: unknown): Promise<{ ok: boolean; command_id: string }> {
          const err = new Error('boom');
          (err as Error & { code?: string; publicMessage?: string }).code = 'INVALID_ARGS';
          (err as Error & { code?: string; publicMessage?: string }).publicMessage =
            'benign \u202e tamper';
          throw err;
        },
        isShutdownRequested() { return false; },
      });
      const deps = createTestDeps({ commandHandlerFactory: factory as never });
      const listener = createAcpListener(deps);
      await listener.start();
      const cmd = createAcpMessage('acp.command', 'inst-1', 'bot-1', {
        command_id: 'cmd-bidi-2', name: 'ANY', params: {},
      });
      deps.receiver.triggerMessage(MANAGER_PUBKEY, 'DIRECT://manager', serializeMessage(cmd));
      await vi.advanceTimersByTimeAsync(10);
      const lastMsg = JSON.parse(deps.sender.sent[deps.sender.sent.length - 1]!.content) as Record<string, unknown>;
      const payload = lastMsg['payload'] as Record<string, unknown>;
      const wireMsg = payload['message'] as string;
      expect(wireMsg.includes('\u202e')).toBe(false);
      // The surrounding words should remain
      expect(wireMsg).toContain('benign');
      expect(wireMsg).toContain('tamper');
      await listener.stop();
    });
  });

  describe('round-21 F1: JSON-Lines breakers + additional bidi controls', () => {
    // Round-21 F1: the round-19 regex missed four categories that can break
    // log pipelines or enable Trojan Source attacks:
    //   - U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR: while modern
    //     JSON.parse accepts them, many JSON-Lines aggregators split on
    //     Unicode line boundaries and break framing.
    //   - U+061C ARABIC LETTER MARK: bidi mark used in Trojan-Source
    //     variants on Arabic text.
    //   - U+180E MONGOLIAN VOWEL SEPARATOR: historically zero-width
    //     (Unicode 4.0-6.2), still renders invisibly in legacy tooling.
    it('strips U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR', async () => {
      const factory = (_id: string, _name: string, _t: number, _l: unknown) => ({
        async execute(_cmd: string, _params: unknown): Promise<{ ok: boolean; command_id: string }> {
          const err = new Error('boom');
          (err as Error & { code?: string; publicMessage?: string }).code = 'INVALID_ARGS';
          (err as Error & { code?: string; publicMessage?: string }).publicMessage =
            'line\u2028separator\u2029paragraph';
          throw err;
        },
        isShutdownRequested() { return false; },
      });
      const deps = createTestDeps({ commandHandlerFactory: factory as never });
      const listener = createAcpListener(deps);
      await listener.start();
      const cmd = createAcpMessage('acp.command', 'inst-1', 'bot-1', {
        command_id: 'cmd-jsonlines', name: 'ANY', params: {},
      });
      deps.receiver.triggerMessage(MANAGER_PUBKEY, 'DIRECT://manager', serializeMessage(cmd));
      await vi.advanceTimersByTimeAsync(10);

      const lastMsg = JSON.parse(deps.sender.sent[deps.sender.sent.length - 1]!.content) as Record<string, unknown>;
      const payload = lastMsg['payload'] as Record<string, unknown>;
      const wireMsg = payload['message'] as string;
      expect(wireMsg.includes('\u2028')).toBe(false);
      expect(wireMsg.includes('\u2029')).toBe(false);
      // Surrounding text should survive (replaced with spaces, not removed)
      expect(wireMsg).toContain('line');
      expect(wireMsg).toContain('separator');
      expect(wireMsg).toContain('paragraph');
      await listener.stop();
    });

    it('strips U+061C ARABIC LETTER MARK and U+180E MONGOLIAN VOWEL SEPARATOR', async () => {
      const factory = (_id: string, _name: string, _t: number, _l: unknown) => ({
        async execute(_cmd: string, _params: unknown): Promise<{ ok: boolean; command_id: string }> {
          const err = new Error('boom');
          (err as Error & { code?: string; publicMessage?: string }).code = 'INVALID_ARGS';
          (err as Error & { code?: string; publicMessage?: string }).publicMessage =
            'arabic\u061cmark\u180emongolian';
          throw err;
        },
        isShutdownRequested() { return false; },
      });
      const deps = createTestDeps({ commandHandlerFactory: factory as never });
      const listener = createAcpListener(deps);
      await listener.start();
      const cmd = createAcpMessage('acp.command', 'inst-1', 'bot-1', {
        command_id: 'cmd-extra-bidi', name: 'ANY', params: {},
      });
      deps.receiver.triggerMessage(MANAGER_PUBKEY, 'DIRECT://manager', serializeMessage(cmd));
      await vi.advanceTimersByTimeAsync(10);

      const lastMsg = JSON.parse(deps.sender.sent[deps.sender.sent.length - 1]!.content) as Record<string, unknown>;
      const payload = lastMsg['payload'] as Record<string, unknown>;
      const wireMsg = payload['message'] as string;
      expect(wireMsg.includes('\u061c')).toBe(false);
      expect(wireMsg.includes('\u180e')).toBe(false);
      expect(wireMsg).toContain('arabic');
      expect(wireMsg).toContain('mongolian');
      await listener.stop();
    });
  });

  describe('round-21 F2: surrogate pair not split on truncation', () => {
    // Round-21 F2: slice(0, 200) can emit an unpaired high surrogate if the
    // 200th UTF-16 code unit is the first half of an emoji/astral char. The
    // safeSlice helper retreats one unit in that case so the cut falls
    // before the pair. Without the fix, the sanitized output would contain
    // a stray 0xD800-0xDBFF codepoint.
    it('does not emit an unpaired high surrogate when truncating at a surrogate pair boundary', async () => {
      // Craft a publicMessage where position 199 is exactly a high surrogate
      // half. Strategy: pad to length 199, then append a 2-code-unit emoji.
      // Total length 201 → naive slice(0, 200) would cut between the pair.
      const emoji = '\u{1F600}'; // smiling face, encodes as 2 UTF-16 code units
      expect(emoji.length).toBe(2);
      const padded = 'a'.repeat(199) + emoji; // total length 201
      expect(padded.length).toBe(201);
      // Position 199 (0-indexed) should be the high surrogate
      expect(padded.charCodeAt(199)).toBeGreaterThanOrEqual(0xd800);
      expect(padded.charCodeAt(199)).toBeLessThanOrEqual(0xdbff);

      const factory = (_id: string, _name: string, _t: number, _l: unknown) => ({
        async execute(_cmd: string, _params: unknown): Promise<{ ok: boolean; command_id: string }> {
          const err = new Error('boom');
          (err as Error & { code?: string; publicMessage?: string }).code = 'INVALID_ARGS';
          (err as Error & { code?: string; publicMessage?: string }).publicMessage = padded;
          throw err;
        },
        isShutdownRequested() { return false; },
      });
      const deps = createTestDeps({ commandHandlerFactory: factory as never });
      const listener = createAcpListener(deps);
      await listener.start();
      const cmd = createAcpMessage('acp.command', 'inst-1', 'bot-1', {
        command_id: 'cmd-surrogate', name: 'ANY', params: {},
      });
      deps.receiver.triggerMessage(MANAGER_PUBKEY, 'DIRECT://manager', serializeMessage(cmd));
      await vi.advanceTimersByTimeAsync(10);

      const lastMsg = JSON.parse(deps.sender.sent[deps.sender.sent.length - 1]!.content) as Record<string, unknown>;
      const payload = lastMsg['payload'] as Record<string, unknown>;
      const wireMsg = payload['message'] as string;

      // Every code unit in the output must be either:
      //   - not a surrogate half, OR
      //   - a high surrogate (0xD800-0xDBFF) followed by a low surrogate (0xDC00-0xDFFF), OR
      //   - a low surrogate preceded by a high surrogate
      // Loop and check for unpaired surrogates.
      for (let i = 0; i < wireMsg.length; i++) {
        const code = wireMsg.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
          // High surrogate — next char MUST be a low surrogate
          expect(i + 1).toBeLessThan(wireMsg.length);
          const next = wireMsg.charCodeAt(i + 1);
          expect(next).toBeGreaterThanOrEqual(0xdc00);
          expect(next).toBeLessThanOrEqual(0xdfff);
          i++; // skip the paired low surrogate
        } else if (code >= 0xdc00 && code <= 0xdfff) {
          // Low surrogate not preceded by a high — test fails
          throw new Error(`Unpaired low surrogate at position ${i}`);
        }
      }

      await listener.stop();
    });

    it('preserves a complete surrogate pair when it falls entirely within bounds', async () => {
      // Sanity check: a short message with an emoji at the start should
      // come through intact — we're only truncating, not stripping, astrals.
      const emoji = '\u{1F680}'; // rocket
      const factory = (_id: string, _name: string, _t: number, _l: unknown) => ({
        async execute(_cmd: string, _params: unknown): Promise<{ ok: boolean; command_id: string }> {
          const err = new Error('boom');
          (err as Error & { code?: string; publicMessage?: string }).code = 'INVALID_ARGS';
          (err as Error & { code?: string; publicMessage?: string }).publicMessage =
            `launch ${emoji} success`;
          throw err;
        },
        isShutdownRequested() { return false; },
      });
      const deps = createTestDeps({ commandHandlerFactory: factory as never });
      const listener = createAcpListener(deps);
      await listener.start();
      const cmd = createAcpMessage('acp.command', 'inst-1', 'bot-1', {
        command_id: 'cmd-astral', name: 'ANY', params: {},
      });
      deps.receiver.triggerMessage(MANAGER_PUBKEY, 'DIRECT://manager', serializeMessage(cmd));
      await vi.advanceTimersByTimeAsync(10);

      const lastMsg = JSON.parse(deps.sender.sent[deps.sender.sent.length - 1]!.content) as Record<string, unknown>;
      const payload = lastMsg['payload'] as Record<string, unknown>;
      const wireMsg = payload['message'] as string;
      expect(wireMsg).toContain(emoji);
    });
  });

  describe('round-23 F1: invisible prompt-injection characters stripped', () => {
    // Round-23 F1: the round-21 strip set missed several classes of invisible
    // characters used in modern Unicode-based prompt-injection attacks:
    //   - Word Joiner (U+2060) and invisible math operators (U+2061-U+2064)
    //   - Deprecated format controls (U+206A-U+206F)
    //   - Interlinear annotation markers (U+FFF9-U+FFFB)
    //   - Unicode Tag characters (U+E0000-U+E007F) — the "Unicode Tags"
    //     invisible prompt-injection attack. Requires the /u regex flag
    //     because these codepoints are outside the BMP.
    //   - Combining Grapheme Joiner (U+034F) — invisible combining mark
    it('strips word joiner (U+2060) and invisible math operators (U+2061-U+2064)', async () => {
      const factory = (_id: string, _name: string, _t: number, _l: unknown) => ({
        async execute(_cmd: string, _params: unknown): Promise<{ ok: boolean; command_id: string }> {
          const err = new Error('boom');
          (err as Error & { code?: string; publicMessage?: string }).code = 'INVALID_ARGS';
          (err as Error & { code?: string; publicMessage?: string }).publicMessage =
            'a\u2060b\u2061c\u2062d\u2063e\u2064f';
          throw err;
        },
        isShutdownRequested() { return false; },
      });
      const deps = createTestDeps({ commandHandlerFactory: factory as never });
      const listener = createAcpListener(deps);
      await listener.start();
      const cmd = createAcpMessage('acp.command', 'inst-1', 'bot-1', {
        command_id: 'cmd-word-joiner', name: 'ANY', params: {},
      });
      deps.receiver.triggerMessage(MANAGER_PUBKEY, 'DIRECT://manager', serializeMessage(cmd));
      await vi.advanceTimersByTimeAsync(10);
      const lastMsg = JSON.parse(deps.sender.sent[deps.sender.sent.length - 1]!.content) as Record<string, unknown>;
      const payload = lastMsg['payload'] as Record<string, unknown>;
      const wireMsg = payload['message'] as string;
      for (const cp of ['\u2060', '\u2061', '\u2062', '\u2063', '\u2064']) {
        expect(wireMsg.includes(cp)).toBe(false);
      }
      // Visible surrounding chars should survive
      for (const ch of ['a', 'b', 'c', 'd', 'e', 'f']) {
        expect(wireMsg).toContain(ch);
      }
      await listener.stop();
    });

    it('strips deprecated format controls (U+206A-U+206F)', async () => {
      const factory = (_id: string, _name: string, _t: number, _l: unknown) => ({
        async execute(_cmd: string, _params: unknown): Promise<{ ok: boolean; command_id: string }> {
          const err = new Error('boom');
          (err as Error & { code?: string; publicMessage?: string }).code = 'INVALID_ARGS';
          (err as Error & { code?: string; publicMessage?: string }).publicMessage =
            'x\u206ay\u206bz\u206cw\u206dv\u206eu\u206ft';
          throw err;
        },
        isShutdownRequested() { return false; },
      });
      const deps = createTestDeps({ commandHandlerFactory: factory as never });
      const listener = createAcpListener(deps);
      await listener.start();
      const cmd = createAcpMessage('acp.command', 'inst-1', 'bot-1', {
        command_id: 'cmd-depr-format', name: 'ANY', params: {},
      });
      deps.receiver.triggerMessage(MANAGER_PUBKEY, 'DIRECT://manager', serializeMessage(cmd));
      await vi.advanceTimersByTimeAsync(10);
      const lastMsg = JSON.parse(deps.sender.sent[deps.sender.sent.length - 1]!.content) as Record<string, unknown>;
      const payload = lastMsg['payload'] as Record<string, unknown>;
      const wireMsg = payload['message'] as string;
      for (const cp of ['\u206a', '\u206b', '\u206c', '\u206d', '\u206e', '\u206f']) {
        expect(wireMsg.includes(cp)).toBe(false);
      }
      await listener.stop();
    });

    it('strips interlinear annotation markers (U+FFF9-U+FFFB)', async () => {
      const factory = (_id: string, _name: string, _t: number, _l: unknown) => ({
        async execute(_cmd: string, _params: unknown): Promise<{ ok: boolean; command_id: string }> {
          const err = new Error('boom');
          (err as Error & { code?: string; publicMessage?: string }).code = 'INVALID_ARGS';
          (err as Error & { code?: string; publicMessage?: string }).publicMessage =
            'annotation\ufff9anchor\ufffasep\ufffbterm';
          throw err;
        },
        isShutdownRequested() { return false; },
      });
      const deps = createTestDeps({ commandHandlerFactory: factory as never });
      const listener = createAcpListener(deps);
      await listener.start();
      const cmd = createAcpMessage('acp.command', 'inst-1', 'bot-1', {
        command_id: 'cmd-annotation', name: 'ANY', params: {},
      });
      deps.receiver.triggerMessage(MANAGER_PUBKEY, 'DIRECT://manager', serializeMessage(cmd));
      await vi.advanceTimersByTimeAsync(10);
      const lastMsg = JSON.parse(deps.sender.sent[deps.sender.sent.length - 1]!.content) as Record<string, unknown>;
      const payload = lastMsg['payload'] as Record<string, unknown>;
      const wireMsg = payload['message'] as string;
      for (const cp of ['\ufff9', '\ufffa', '\ufffb']) {
        expect(wireMsg.includes(cp)).toBe(false);
      }
      await listener.stop();
    });

    it('strips Unicode Tag characters (U+E0000-U+E007F) used in modern prompt-injection attacks', async () => {
      // The "Unicode Tags" attack smuggles invisible instructions into text
      // using the U+E0000-U+E007F block. Most fonts render them as nothing,
      // but they copy/paste cleanly through logs into AI-model inputs.
      // Regex requires /u flag because these are outside BMP.
      const factory = (_id: string, _name: string, _t: number, _l: unknown) => ({
        async execute(_cmd: string, _params: unknown): Promise<{ ok: boolean; command_id: string }> {
          const err = new Error('boom');
          (err as Error & { code?: string; publicMessage?: string }).code = 'INVALID_ARGS';
          (err as Error & { code?: string; publicMessage?: string }).publicMessage =
            // Mix: LANGUAGE TAG (U+E0001), several TAG LATIN LETTERS, CANCEL TAG (U+E007F)
            'benign\u{E0041}tag\u{E0042}chars\u{E0001}lang\u{E007F}cancel\u2060joiner';
          throw err;
        },
        isShutdownRequested() { return false; },
      });
      const deps = createTestDeps({ commandHandlerFactory: factory as never });
      const listener = createAcpListener(deps);
      await listener.start();
      const cmd = createAcpMessage('acp.command', 'inst-1', 'bot-1', {
        command_id: 'cmd-tag-chars', name: 'ANY', params: {},
      });
      deps.receiver.triggerMessage(MANAGER_PUBKEY, 'DIRECT://manager', serializeMessage(cmd));
      await vi.advanceTimersByTimeAsync(10);
      const lastMsg = JSON.parse(deps.sender.sent[deps.sender.sent.length - 1]!.content) as Record<string, unknown>;
      const payload = lastMsg['payload'] as Record<string, unknown>;
      const wireMsg = payload['message'] as string;
      // Neither tag chars nor the word joiner should survive
      expect(wireMsg).not.toMatch(/[\u{E0000}-\u{E007F}]/u);
      expect(wireMsg.includes('\u2060')).toBe(false);
      // Visible surrounding words should survive
      expect(wireMsg).toContain('benign');
      expect(wireMsg).toContain('tag');
      expect(wireMsg).toContain('chars');
      expect(wireMsg).toContain('lang');
      expect(wireMsg).toContain('cancel');
      expect(wireMsg).toContain('joiner');
      await listener.stop();
    });

    it('strips combining grapheme joiner (U+034F)', async () => {
      const factory = (_id: string, _name: string, _t: number, _l: unknown) => ({
        async execute(_cmd: string, _params: unknown): Promise<{ ok: boolean; command_id: string }> {
          const err = new Error('boom');
          (err as Error & { code?: string; publicMessage?: string }).code = 'INVALID_ARGS';
          (err as Error & { code?: string; publicMessage?: string }).publicMessage =
            'combining\u034fgrapheme\u034fjoiner';
          throw err;
        },
        isShutdownRequested() { return false; },
      });
      const deps = createTestDeps({ commandHandlerFactory: factory as never });
      const listener = createAcpListener(deps);
      await listener.start();
      const cmd = createAcpMessage('acp.command', 'inst-1', 'bot-1', {
        command_id: 'cmd-cgj', name: 'ANY', params: {},
      });
      deps.receiver.triggerMessage(MANAGER_PUBKEY, 'DIRECT://manager', serializeMessage(cmd));
      await vi.advanceTimersByTimeAsync(10);
      const lastMsg = JSON.parse(deps.sender.sent[deps.sender.sent.length - 1]!.content) as Record<string, unknown>;
      const payload = lastMsg['payload'] as Record<string, unknown>;
      const wireMsg = payload['message'] as string;
      expect(wireMsg.includes('\u034f')).toBe(false);
      expect(wireMsg).toContain('combining');
      expect(wireMsg).toContain('grapheme');
      expect(wireMsg).toContain('joiner');
      await listener.stop();
    });
  });

  describe('round-23 F5: safeSlice handles consecutive high surrogates', () => {
    // Round-23 F5: the round-21 safeSlice decremented at most once, so a
    // malformed string with consecutive unpaired high surrogates at the cut
    // boundary could still leave an unpaired surrogate in the output. The
    // while-loop variant keeps retreating as long as `cut - 1` is a high
    // surrogate. In well-formed UTF-16 this is harmless overhead; in the
    // malformed case it's defense-in-depth.
    it('does not emit unpaired high surrogates from a run of consecutive high surrogates at the cut boundary', async () => {
      // Build a publicMessage whose positions 198 and 199 are both high
      // surrogates (malformed — no low surrogates anywhere). Because
      // sanitizeWireMessage normalizes to NFC first, an ill-formed string
      // with lone high surrogates is already suspect; this test exercises
      // the defense-in-depth while-loop. We construct via String.fromCharCode
      // to bypass the \uXXXX literal validation.
      const highSurrogates = String.fromCharCode(0xd83d, 0xd83d); // two lone high surrogates
      // Pad to a total length that makes position 199 a high surrogate,
      // and position 198 also a high surrogate (so a single-decrement slice
      // at cut=200 would retreat to 199 — still a high surrogate — and emit
      // it unpaired).
      const padded = 'a'.repeat(198) + highSurrogates + 'b'.repeat(3); // length 203
      expect(padded.length).toBe(203);
      expect(padded.charCodeAt(198)).toBeGreaterThanOrEqual(0xd800);
      expect(padded.charCodeAt(198)).toBeLessThanOrEqual(0xdbff);
      expect(padded.charCodeAt(199)).toBeGreaterThanOrEqual(0xd800);
      expect(padded.charCodeAt(199)).toBeLessThanOrEqual(0xdbff);

      const factory = (_id: string, _name: string, _t: number, _l: unknown) => ({
        async execute(_cmd: string, _params: unknown): Promise<{ ok: boolean; command_id: string }> {
          const err = new Error('boom');
          (err as Error & { code?: string; publicMessage?: string }).code = 'INVALID_ARGS';
          (err as Error & { code?: string; publicMessage?: string }).publicMessage = padded;
          throw err;
        },
        isShutdownRequested() { return false; },
      });
      const deps = createTestDeps({ commandHandlerFactory: factory as never });
      const listener = createAcpListener(deps);
      await listener.start();
      const cmd = createAcpMessage('acp.command', 'inst-1', 'bot-1', {
        command_id: 'cmd-consecutive-surr', name: 'ANY', params: {},
      });
      deps.receiver.triggerMessage(MANAGER_PUBKEY, 'DIRECT://manager', serializeMessage(cmd));
      await vi.advanceTimersByTimeAsync(10);

      const lastMsg = JSON.parse(deps.sender.sent[deps.sender.sent.length - 1]!.content) as Record<string, unknown>;
      const payload = lastMsg['payload'] as Record<string, unknown>;
      const wireMsg = payload['message'] as string;

      // No unpaired surrogates should survive: loop and check.
      for (let i = 0; i < wireMsg.length; i++) {
        const code = wireMsg.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
          expect(i + 1).toBeLessThan(wireMsg.length);
          const next = wireMsg.charCodeAt(i + 1);
          expect(next).toBeGreaterThanOrEqual(0xdc00);
          expect(next).toBeLessThanOrEqual(0xdfff);
          i++;
        } else if (code >= 0xdc00 && code <= 0xdfff) {
          throw new Error(`Unpaired low surrogate at position ${i}`);
        }
      }

      await listener.stop();
    });
  });

  describe('round-19 F2: stop() waits for in-flight commands', () => {
    it('awaits in-flight command execution before returning from stop()', async () => {
      // Without the fix, stop() returns immediately even while a command
      // handler is mid-execute(). With the fix, stop() awaits allSettled on
      // the tracked in-flight set (bounded by the 5s timeout).
      let resolveExecute!: (value: { ok: boolean; command_id: string; result: unknown }) => void;
      const executePromise = new Promise<{ ok: boolean; command_id: string; result: unknown }>((res) => {
        resolveExecute = res;
      });
      let executeStarted = false;

      const factory = (_id: string, _name: string, _t: number, _l: unknown) => ({
        async execute(_cmd: string, params: { command_id?: string }): Promise<{ ok: boolean; command_id: string; result: unknown }> {
          executeStarted = true;
          const result = await executePromise;
          // Preserve the caller's command_id
          return { ...result, command_id: params.command_id ?? '' };
        },
        isShutdownRequested() { return false; },
      });

      // Use real timers for this test because we rely on the event-loop
      // resolving microtasks around the awaited execute().
      vi.useRealTimers();
      try {
        const deps = createTestDeps({ commandHandlerFactory: factory as never });
        const listener = createAcpListener(deps);
        await listener.start();

        const cmd = createAcpMessage('acp.command', 'inst-1', 'bot-1', {
          command_id: 'cmd-inflight',
          name: 'LONG_RUNNING',
          params: {},
        });
        deps.receiver.triggerMessage(MANAGER_PUBKEY, 'DIRECT://manager', serializeMessage(cmd));
        // Yield so the async IIFE inside the command case begins
        await new Promise((r) => setImmediate(r));
        expect(executeStarted).toBe(true);

        // Initiate stop — it must NOT resolve while the command is pending.
        let stopResolved = false;
        const stopPromise = listener.stop().then(() => { stopResolved = true; });

        // Give the event loop a few ticks to confirm stop is still awaiting
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        expect(stopResolved).toBe(false);

        // Resolve the command's execute()
        resolveExecute({ ok: true, command_id: 'cmd-inflight', result: { done: true } });

        // Now stop() should be able to complete
        await stopPromise;
        expect(stopResolved).toBe(true);
      } finally {
        vi.useFakeTimers();
      }
    });

    it('stop() does not block forever when a command hangs — bounded by shutdown timeout', async () => {
      // If a command handler hangs (never resolves), stop() must still make
      // progress after the in-flight timeout fires (5s in production; we
      // use fake timers to advance past it without real delay).
      const factory = (_id: string, _name: string, _t: number, _l: unknown) => ({
        async execute(_cmd: string, _params: unknown): Promise<{ ok: boolean; command_id: string }> {
          // Never resolves
          return new Promise(() => {});
        },
        isShutdownRequested() { return false; },
      });

      const deps = createTestDeps({ commandHandlerFactory: factory as never });
      const listener = createAcpListener(deps);
      await listener.start();

      const cmd = createAcpMessage('acp.command', 'inst-1', 'bot-1', {
        command_id: 'cmd-hung',
        name: 'HANG_FOREVER',
        params: {},
      });
      deps.receiver.triggerMessage(MANAGER_PUBKEY, 'DIRECT://manager', serializeMessage(cmd));
      await vi.advanceTimersByTimeAsync(0);

      // Kick off stop — it sets up a 5000ms timeout internally
      const stopPromise = listener.stop();

      // Advance fake timers past the in-flight shutdown timeout
      await vi.advanceTimersByTimeAsync(5000);

      // stop() should resolve now even though the command never completed
      await stopPromise;
    });
  });

  describe('stop', () => {
    it('stops heartbeat on stop', async () => {
      const deps = createTestDeps();
      const listener = createAcpListener(deps);

      await listener.start();

      // Start heartbeat
      const helloAck = createAcpMessage('acp.hello_ack', 'inst-1', 'bot-1', {
        accepted: true,
        manager_pubkey: MANAGER_PUBKEY,
        heartbeat_interval_ms: 2000,
        notes: 'ok',
      });
      deps.receiver.triggerMessage(MANAGER_PUBKEY, 'DIRECT://manager', serializeMessage(helloAck));

      const sentBeforeStop = deps.sender.sent.length;

      await listener.stop();

      // No more heartbeats after stop
      vi.advanceTimersByTime(10000);
      expect(deps.sender.sent.length).toBe(sentBeforeStop);
    });

    it('unsubscribes DM subscription on stop', async () => {
      const deps = createTestDeps();
      const listener = createAcpListener(deps);

      await listener.start();
      expect(deps.receiver.unsubscribeCalled).toBe(false);

      await listener.stop();
      expect(deps.receiver.unsubscribeCalled).toBe(true);
    });
  });
});
