/**
 * In-process faucet client for e2e-live tests.
 *
 * Bootstraps a Sphere wallet in the test process, then sends ACP-0
 * `FAUCET_REQUEST` DMs to a spawned faucet-agent's pubkey and awaits
 * the result envelope. Replaces both:
 *
 *   - TRADER_TEST_FUND self-mint (which only works on certain
 *     sphere-sdk branches and produces self-issued tokens that may
 *     interact poorly with the swap protocol).
 *   - Public-faucet HTTP (`FAUCET_URL`) which has been observed to
 *     return 200 OK with a tx_id but never deliver the deposit.
 *
 * All communication is encrypted Sphere DMs; no HTTP. Mirrors the
 * pattern js-faucet/test/e2e-live/faucet-roundtrip.e2e-live.test.ts
 * uses to drive its own roundtrip test.
 */

import { Sphere } from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';
import type { DirectMessage } from '@unicitylabs/sphere-sdk';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const TRUSTBASE_URL =
  'https://raw.githubusercontent.com/unicitynetwork/unicity-ids/refs/heads/main/bft-trustbase.testnet.json';

/**
 * In-process client. Holds a Sphere wallet + DM subscription that
 * captures incoming acp.result/acp.error envelopes keyed by command_id.
 */
export interface FaucetClient {
  readonly sphere: Sphere;
  readonly pubkey: string;
  readonly directAddress: string;
  /**
   * Send `FAUCET_REQUEST` to the faucet's pubkey and wait for the
   * matching acp.result. Throws on acp.error or timeout.
   */
  request(faucetPubkey: string, params: FaucetRequestParams, timeoutMs?: number): Promise<FaucetDelivery[]>;
  /** Tear down the wallet + DM subscription. */
  destroy(): Promise<void>;
}

export interface FaucetRequestParams {
  recipient: string;
  asset?: string;
  amount?: string;
  memo?: string;
  items?: ReadonlyArray<{ asset: string; amount: string; memo?: string }>;
}

export interface FaucetDelivery {
  asset: string;
  coin_id: string;
  amount: string;
  token_id: string;
  transfer_id: string;
}

interface IncomingResponse {
  type: string;
  payload: Record<string, unknown>;
}

/**
 * Bootstrap a fresh Sphere wallet in the test process and return a
 * FaucetClient. The wallet's data dir is a unique tmpdir; caller MUST
 * call `destroy()` to release the wallet + relay subscription.
 */
export async function createFaucetClient(): Promise<FaucetClient> {
  const dataDir = mkdtempSync(join(tmpdir(), 'trader-e2e-faucet-cli-'));
  const tokensDir = join(dataDir, 'tokens');

  const tbResp = await fetch(TRUSTBASE_URL, { signal: AbortSignal.timeout(30_000) });
  if (!tbResp.ok) throw new Error(`failed to fetch trustbase: HTTP ${String(tbResp.status)}`);
  const trustbasePath = join(dataDir, 'trustbase.json');
  writeFileSync(trustbasePath, await tbResp.text());

  // Forward Nostr-relay override so the in-process FaucetClient connects
  // to the same relay as the spawned tenants when the local-infra harness
  // is active. Without this, the client connects to testnet defaults and
  // can't reach a faucet-agent that's only on the local relay → its
  // FAUCET_REQUEST DMs go out into testnet and the response never arrives.
  const relayOverride = (() => {
    const raw = process.env['UNICITY_NOSTR_RELAYS'] ?? process.env['SPHERE_NOSTR_RELAYS'];
    if (!raw) return undefined;
    const relays = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    return relays.length > 0 ? relays : undefined;
  })();
  const providers = createNodeProviders({
    network: 'testnet',
    dataDir,
    tokensDir,
    oracle: { trustBasePath: trustbasePath },
    ...(relayOverride ? { transport: { relays: relayOverride } } : {}),
  });
  const { sphere } = await Sphere.init({
    ...providers,
    autoGenerate: true,
    nametag: `fc-${randomUUID().slice(0, 12).replace(/-/g, '')}`,
    accounting: true,
    swap: false,
    market: false,
  });

  const identity = sphere.identity;
  if (!identity) throw new Error('Sphere.init returned no identity');
  const pubkey = identity.chainPubkey;
  const directAddress = identity.directAddress ?? `DIRECT://${pubkey}`;

  // Capture inbound result envelopes keyed by command_id.
  const responses = new Map<string, IncomingResponse>();
  const unsubscribe = sphere.on('message:dm', (msg: DirectMessage) => {
    const acp = parseAcpJson(msg.content);
    if (acp === null) return;
    if (acp.type !== 'acp.result' && acp.type !== 'acp.error') return;
    const payload = acp.payload as Record<string, unknown>;
    const cmdId = typeof payload['command_id'] === 'string' ? payload['command_id'] : null;
    if (cmdId === null) return;
    responses.set(cmdId, { type: acp.type, payload });
  });

  async function request(
    faucetPubkey: string,
    params: FaucetRequestParams,
    timeoutMs = 180_000,
  ): Promise<FaucetDelivery[]> {
    const cmdId = randomUUID();
    const msg = createAcpCommandEnvelope(cmdId, 'FAUCET_REQUEST', params as unknown as Record<string, unknown>);
    await sphere.communications.sendDM(`DIRECT://${faucetPubkey}`, JSON.stringify(msg));

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const r = responses.get(cmdId);
      if (r) {
        responses.delete(cmdId);
        if (r.type === 'acp.error') {
          const code = String(r.payload['error_code'] ?? 'UNKNOWN');
          const message = String(r.payload['message'] ?? '');
          throw new Error(`FAUCET_REQUEST failed: [${code}] ${message}`);
        }
        const result = r.payload['result'] as { deliveries?: FaucetDelivery[] } | undefined;
        const deliveries = result?.deliveries ?? [];
        if (!Array.isArray(deliveries)) {
          throw new Error(`FAUCET_REQUEST: result.deliveries not an array. Got: ${JSON.stringify(r.payload)}`);
        }
        return deliveries;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`FAUCET_REQUEST: no response for command_id=${cmdId} within ${String(timeoutMs)}ms`);
  }

  async function destroy(): Promise<void> {
    try { unsubscribe(); } catch { /* ignore */ }
    try { await sphere.destroy(); } catch { /* ignore */ }
  }

  return { sphere, pubkey, directAddress, request, destroy };
}

// ---------------------------------------------------------------------------
// Minimal ACP envelope helpers — duplicated here to avoid pulling in the
// full agentic-hosting protocol module. Trader-service doesn't ship the
// ACP envelope code; the trader's command-handler operates on already-
// parsed payloads. The js-faucet listener parses these envelopes itself.
// ---------------------------------------------------------------------------

const ACP_VERSION = '0.1';

function createAcpCommandEnvelope(
  cmdId: string,
  name: string,
  params: Record<string, unknown>,
): {
  acp_version: string;
  msg_id: string;
  ts_ms: number;
  instance_id: string;
  instance_name: string;
  type: string;
  payload: { command_id: string; name: string; params: Record<string, unknown> };
} {
  return {
    acp_version: ACP_VERSION,
    msg_id: randomUUID(),
    ts_ms: Date.now(),
    instance_id: 'controller',
    instance_name: 'controller',
    type: 'acp.command',
    payload: { command_id: cmdId, name, params },
  };
}

interface AcpEnvelope {
  type: string;
  payload: unknown;
}

function parseAcpJson(content: string): AcpEnvelope | null {
  if (content.length > 65_536) return null;
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const env = parsed as Record<string, unknown>;
    if (typeof env['type'] !== 'string') return null;
    return { type: env['type'], payload: env['payload'] };
  } catch {
    return null;
  }
}
