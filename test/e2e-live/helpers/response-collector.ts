/**
 * DM response collector — indexes HMCP responses by `in_reply_to`.
 *
 * Interface-based design: the DmTransport can be wired to either the
 * real Sphere SDK or a MockSphereNetwork for local testing.
 *
 * Responses that arrive before anyone calls waitForResponse() are
 * buffered so callers never miss a fast reply.
 */

import { isValidHmcpResponse } from '../../../src/protocols/hmcp.js';
import type { HmcpResponse } from '../../../src/protocols/hmcp.js';
import { HMCP_RESPONSE_TIMEOUT_MS } from './constants.js';

// ---------------------------------------------------------------------------
// Transport abstraction
// ---------------------------------------------------------------------------

export interface DmTransport {
  sendDm(recipientAddress: string, content: string): Promise<void>;
  onDm(handler: (senderPubkey: string, senderAddress: string, content: string) => void): () => void;
}

// ---------------------------------------------------------------------------
// ResponseCollector interface
// ---------------------------------------------------------------------------

export interface ResponseCollector {
  /** Wait for any HMCP response whose `in_reply_to` matches `msgId`. */
  waitForResponse(msgId: string, timeoutMs?: number): Promise<Record<string, unknown>>;

  /** Wait for a response with a specific `type` field (e.g. 'hm.spawn_ready'). */
  waitForResponseType(msgId: string, type: string, timeoutMs?: number): Promise<Record<string, unknown>>;

  /** Tear down the DM subscription. Call in afterAll. */
  destroy(): void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface Waiter {
  msgId: string;
  type: string | null;
  resolve: (response: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function createResponseCollector(transport: DmTransport): ResponseCollector {
  // Buffered responses keyed by in_reply_to. Each msgId can have multiple
  // responses (e.g. hm.spawn_ack then hm.spawn_ready).
  const buffer = new Map<string, HmcpResponse[]>();

  // Active waiters — one per waitForResponse/waitForResponseType call.
  const waiters: Waiter[] = [];

  function tryResolveWaiter(waiter: Waiter, response: HmcpResponse): boolean {
    if (waiter.type !== null && response.type !== waiter.type) {
      return false;
    }
    clearTimeout(waiter.timer);
    waiter.resolve(response as unknown as Record<string, unknown>);
    return true;
  }

  function handleResponse(response: HmcpResponse): void {
    const replyTo = response.in_reply_to;

    // Try to resolve a waiting caller first
    const idx = waiters.findIndex(
      (w) => w.msgId === replyTo && (w.type === null || w.type === response.type),
    );
    if (idx !== -1) {
      const waiter = waiters[idx]!;
      waiters.splice(idx, 1);
      tryResolveWaiter(waiter, response);
      return;
    }

    // No waiter yet — buffer it
    let arr = buffer.get(replyTo);
    if (!arr) {
      arr = [];
      buffer.set(replyTo, arr);
    }
    arr.push(response);
  }

  // Subscribe to all incoming DMs and filter for valid HMCP responses
  const unsubscribe = transport.onDm((_senderPubkey, _senderAddress, content) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return; // Not JSON — ignore
    }
    if (isValidHmcpResponse(parsed)) {
      handleResponse(parsed);
    }
  });

  return {
    waitForResponse(msgId: string, timeoutMs = HMCP_RESPONSE_TIMEOUT_MS): Promise<Record<string, unknown>> {
      return waitForResponseType(msgId, null, timeoutMs);
    },

    waitForResponseType(msgId: string, type: string, timeoutMs = HMCP_RESPONSE_TIMEOUT_MS): Promise<Record<string, unknown>> {
      return waitForResponseType(msgId, type, timeoutMs);
    },

    destroy(): void {
      unsubscribe();
      // Reject any remaining waiters
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('ResponseCollector destroyed'));
      }
      waiters.length = 0;
      buffer.clear();
    },
  };

  function waitForResponseType(
    msgId: string,
    type: string | null,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    // Check buffer first
    const buffered = buffer.get(msgId);
    if (buffered) {
      const idx = type === null
        ? 0
        : buffered.findIndex((r) => r.type === type);
      if (idx !== -1) {
        const match = buffered[idx]!;
        buffered.splice(idx, 1);
        if (buffered.length === 0) buffer.delete(msgId);
        return Promise.resolve(match as unknown as Record<string, unknown>);
      }
    }

    // Not buffered — register a waiter with a timeout
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        const wIdx = waiters.findIndex((w) => w.msgId === msgId && w.type === type);
        if (wIdx !== -1) waiters.splice(wIdx, 1);
        reject(
          new Error(
            `Timeout waiting for HMCP response (msgId=${msgId}, type=${type ?? 'any'}) after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);

      waiters.push({ msgId, type, resolve, reject, timer });
    });
  }
}
