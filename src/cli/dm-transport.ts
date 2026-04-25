/**
 * Trader-side DM transport for the trader-ctl CLI.
 *
 * Sends ACP-0 `acp.command` envelopes directly to a running trader tenant
 * (the agentic-hosting manager is NOT in the loop) and awaits the
 * correlated `acp.result` / `acp.error`. The tenant's AcpListener accepts
 * commands signed by either the manager pubkey OR the configured
 * controller_pubkey — see src/tenant/acp-listener.ts for the auth gate.
 *
 * Source: trimmed from sphere-cli/src/transport/dm-transport.ts. The HMCP
 * variant in sphere-cli targets the host manager and parses HMCP responses;
 * this variant targets a tenant and parses ACP responses. The two diverge
 * just enough (envelope shape, correlator key) to warrant a separate file.
 */

import type { DirectMessage } from '@unicitylabs/sphere-sdk';

import { createAcpMessage, ACP_VERSION, isAcpResultPayload, isAcpErrorPayload } from '../protocols/acp.js';
import type { AcpMessage, AcpResultPayload, AcpErrorPayload } from '../protocols/acp.js';
import { parseAcpJson, isTimestampFresh, MAX_MESSAGE_SIZE } from '../protocols/envelope.js';

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export class TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransportError';
  }
}

export interface SphereComms {
  sendDM(recipient: string, content: string): Promise<{ recipientPubkey: string }>;
  onDirectMessage(handler: (message: DirectMessage) => void): () => void;
}

export interface TraderDmTransportConfig {
  /** Tenant address: @nametag, DIRECT://<hex>, or 64-char hex pubkey. */
  tenantAddress: string;
  /** Default per-request timeout in milliseconds. Default: 30 000. */
  timeoutMs?: number;
}

export interface TraderDmTransport {
  /**
   * Send an ACP command and resolve with the typed payload of the matching
   * acp.result / acp.error message. Rejects with TimeoutError if no response
   * arrives in time, or TransportError on send failure.
   */
  sendCommand(
    name: string,
    params: Record<string, unknown>,
    options?: { timeoutMs?: number; commandId?: string },
  ): Promise<AcpResultPayload | AcpErrorPayload>;
  dispose(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * Floor on caller-supplied --timeout values. Anything below this round-trips
 * before the tenant has finished parsing the request, so the user only ever
 * sees a TimeoutError. Mirrors sphere-cli's MIN_TIMEOUT_MS = 100 ms.
 */
export const MIN_TIMEOUT_MS = 100;

function normalizeKey(key: string): string {
  if (key.length === 66 && (key.startsWith('02') || key.startsWith('03'))) {
    return key.slice(2);
  }
  return key.toLowerCase();
}

interface Correlator {
  resolve: (response: AcpResultPayload | AcpErrorPayload) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class TraderDmTransportImpl implements TraderDmTransport {
  private readonly correlators = new Map<string, Correlator>();
  private readonly unsubscribe: () => void;
  /** Resolved x-only pubkey of the tenant — set on first send. */
  private resolvedPubkey: string | null = null;
  /** Buffer DMs that arrive between subscribe and pubkey resolution. */
  private readonly earlyMessages: DirectMessage[] = [];
  private static readonly EARLY_MESSAGE_CAP = 32;
  private disposed = false;
  private readonly timeoutMs: number;

  constructor(
    private readonly comms: SphereComms,
    private readonly tenantAddress: string,
    private readonly instanceId: string,
    private readonly instanceName: string,
    timeoutMs: number,
  ) {
    this.timeoutMs = timeoutMs;
    this.unsubscribe = comms.onDirectMessage((msg) => this.handleIncoming(msg));
  }

  private handleIncoming(msg: DirectMessage): void {
    if (this.disposed) return;
    if (msg.content.length > MAX_MESSAGE_SIZE) return;

    if (!this.resolvedPubkey) {
      if (this.earlyMessages.length < TraderDmTransportImpl.EARLY_MESSAGE_CAP) {
        this.earlyMessages.push(msg);
      }
      return;
    }
    if (normalizeKey(msg.senderPubkey) !== this.resolvedPubkey) return;

    const acpMsg = parseAcpJson(msg.content);
    if (acpMsg === null) return;
    if (!isTimestampFresh(acpMsg.ts_ms)) return;
    if (acpMsg.type !== 'acp.result' && acpMsg.type !== 'acp.error') return;

    const payload = acpMsg.payload as Record<string, unknown>;
    let typed: AcpResultPayload | AcpErrorPayload | null = null;
    if (acpMsg.type === 'acp.result' && isAcpResultPayload(payload)) {
      typed = payload;
    } else if (acpMsg.type === 'acp.error' && isAcpErrorPayload(payload)) {
      typed = payload;
    }
    if (typed === null) return;

    const correlator = this.correlators.get(typed.command_id);
    if (correlator !== undefined) {
      clearTimeout(correlator.timer);
      this.correlators.delete(typed.command_id);
      correlator.resolve(typed);
    }
  }

  async sendCommand(
    name: string,
    params: Record<string, unknown>,
    options: { timeoutMs?: number; commandId?: string } = {},
  ): Promise<AcpResultPayload | AcpErrorPayload> {
    if (this.disposed) {
      throw new TransportError('Transport has been disposed');
    }
    const commandId = options.commandId ?? `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const timeout = Math.max(options.timeoutMs ?? this.timeoutMs, MIN_TIMEOUT_MS);

    const envelope: AcpMessage = createAcpMessage(
      'acp.command',
      this.instanceId,
      this.instanceName,
      { command_id: commandId, name, params },
    );

    return new Promise<AcpResultPayload | AcpErrorPayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.correlators.delete(commandId);
        reject(new TimeoutError(`No response for ${name} (command_id=${commandId}) within ${timeout} ms`));
      }, timeout);

      this.correlators.set(commandId, { resolve, reject, timer });

      const payload = JSON.stringify(envelope);
      if (payload.length > MAX_MESSAGE_SIZE) {
        clearTimeout(timer);
        this.correlators.delete(commandId);
        reject(new TransportError(
          `Request too large: ${payload.length} bytes exceeds MAX_MESSAGE_SIZE (${MAX_MESSAGE_SIZE})`,
        ));
        return;
      }

      this.comms.sendDM(this.tenantAddress, payload).then((sent) => {
        if (!this.resolvedPubkey) {
          this.resolvedPubkey = normalizeKey(sent.recipientPubkey);
          // Drain pre-resolution buffer.
          const pending = this.earlyMessages.splice(0);
          for (const m of pending) this.handleIncoming(m);
        }
      }).catch((err: unknown) => {
        clearTimeout(timer);
        this.correlators.delete(commandId);
        reject(new TransportError(
          `Failed to send ${name}: ${err instanceof Error ? err.message : String(err)}`,
        ));
      });
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    const err = new TransportError('Transport disposed');
    const pending = Array.from(this.correlators.values());
    this.correlators.clear();
    for (const { timer, reject } of pending) {
      clearTimeout(timer);
      reject(err);
    }
  }
}

export function createTraderDmTransport(
  comms: SphereComms,
  config: TraderDmTransportConfig & { instanceId: string; instanceName: string },
): TraderDmTransport {
  return new TraderDmTransportImpl(
    comms,
    config.tenantAddress,
    config.instanceId,
    config.instanceName,
    config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
}

// Re-export ACP_VERSION so callers can stamp envelopes correctly without
// re-importing from protocols/.
export { ACP_VERSION };
