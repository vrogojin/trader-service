/**
 * Helper: pre-provision a Sphere wallet for the host-manager and spawn the
 * compiled `dist/host-manager.js` binary from the agentic-hosting repo as
 * a child process.
 *
 * Why this lives in trader-service instead of being imported from
 * agentic-hosting: the trader-service repo doesn't depend on
 * agentic-hosting as an npm package — they're sibling projects in the
 * Unicity ecosystem. This helper reads the manager binary from a path
 * resolved at runtime (default
 * `/home/vrogojin/agentic_hosting/dist/host-manager.js`, override via
 * `AGENTIC_HOSTING_PATH`). When agentic-hosting eventually publishes
 * its manager binary as a versioned npm package, this resolver can be
 * swapped to use the package path without touching the test layer.
 *
 * Why pre-create the wallet?
 *   The manager validates `MANAGER_PUBKEY`/`MANAGER_DIRECT_ADDRESS` env
 *   vars against the loaded wallet's identity (drift guard added in
 *   agentic-hosting Phase 5). Auto-generating a wallet at boot would
 *   mint a random keypair that doesn't match the env vars we set, so
 *   the manager would refuse to start. By pre-creating the wallet here
 *   we know the pubkey before spawn and wire env vars accordingly.
 *
 * The HMA itself runs as a Sphere wallet identity on testnet — same
 * relay (`wss://nostr-relay.testnet.unicity.network`) that traders and
 * escrow use. Tests using this helper consume one extra HMA wallet
 * registration per run.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

const TRUSTBASE_URL =
  'https://raw.githubusercontent.com/unicitynetwork/unicity-ids/refs/heads/main/bft-trustbase.testnet.json';

const DEFAULT_AGENTIC_HOSTING_PATH = '/home/vrogojin/agentic_hosting';

export interface HostManagerProcess {
  /** Manager's chainPubkey, hex secp256k1. */
  readonly pubkey: string;
  /** Canonical Unicity DIRECT://... address. */
  readonly directAddress: string;
  /** `@nametag` registration if successful; null if registration failed. */
  readonly nametag: string | null;
  /** Wallet directory the manager loaded its identity from. */
  readonly dataDir: string;
  /** templates.json path the manager is configured against. */
  readonly templatesPath: string;
  /** Authorized controller pubkey baked into AUTHORIZED_CONTROLLERS. */
  readonly controllerPubkey: string;
  /** Process handle — null after `stop()`. */
  child: ChildProcess | null;
  /** Accumulated stdout+stderr (JSON Lines + plain). */
  readonly logs: string[];
  /** Resolves when the manager logs `host_manager_started`. */
  readonly ready: Promise<void>;
  stop(): Promise<void>;
}

/**
 * Resolve the path to the agentic-hosting checkout. Used to find
 * `dist/host-manager.js`. Override the default via
 * `AGENTIC_HOSTING_PATH`. Existence is checked at spawn time so the
 * error message points at the env-var the operator can fix.
 */
function resolveAgenticHostingPath(): string {
  return (process.env['AGENTIC_HOSTING_PATH'] ?? '').trim() || DEFAULT_AGENTIC_HOSTING_PATH;
}

async function ensureTrustbase(dataDir: string): Promise<string> {
  await mkdir(dataDir, { recursive: true });
  const trustbasePath = join(dataDir, 'trustbase.json');
  const res = await fetch(TRUSTBASE_URL);
  if (!res.ok) {
    throw new Error(`Failed to download trustbase: HTTP ${res.status}`);
  }
  await writeFile(trustbasePath, await res.text(), 'utf-8');
  return trustbasePath;
}

/**
 * Pre-create the manager's Sphere wallet so the spawned binary loads it
 * (instead of auto-generating a fresh one) and the env-var drift guard
 * passes. Returns the identity that must be wired into MANAGER_PUBKEY /
 * MANAGER_DIRECT_ADDRESS.
 */
async function provisionManagerWallet(dataDir: string, hostId: string): Promise<{
  pubkey: string;
  directAddress: string;
  nametag: string | null;
}> {
  const trustbasePath = await ensureTrustbase(dataDir);
  // Forward UNICITY_API_KEY when set; the SDK falls back to its public
  // placeholder otherwise.
  const apiKey = process.env['UNICITY_API_KEY']?.trim() || undefined;
  const providers = createNodeProviders({
    network: 'testnet',
    dataDir,
    tokensDir: join(dataDir, 'tokens'),
    oracle: {
      trustBasePath: trustbasePath,
      ...(apiKey ? { apiKey } : {}),
    },
  });
  const nametag = `m-${hostId.replace(/[^a-z0-9]/gi, '').slice(0, 12).toLowerCase()}`;
  const { sphere } = await Sphere.init({
    ...providers,
    autoGenerate: true,
    nametag,
  });
  const identity = sphere.identity;
  if (!identity) {
    throw new Error('manager wallet provisioning returned no identity');
  }
  const pubkey = identity.chainPubkey;
  const directAddress = identity.directAddress ?? `DIRECT://${pubkey}`;
  const resolvedNametag = identity.nametag ?? null;
  // Tear down the helper-side wallet — the spawned manager re-loads
  // from dataDir on its own. Two Sphere instances pointing at the same
  // storage simultaneously would race relay subscriptions.
  sphere.destroy();
  return { pubkey, directAddress, nametag: resolvedNametag };
}

export interface SpawnHostManagerOptions {
  /** Test-supplied controller pubkey (hex secp256k1) added to AUTHORIZED_CONTROLLERS. */
  controllerPubkey: string;
  /** Path to a templates.json file — defaults to agentic-hosting's config/templates.json. */
  templatesPath?: string;
  /** HOST_ID override. Default: random `e2elive-<8chars>`. */
  hostId?: string;
  /** Health/metrics port (diagnostics-only HTTP). Default 19401. */
  healthPort?: number;
  /** Hello-handshake timeout in ms (default 60000 — generous for testnet boot). */
  helloTimeoutMs?: number;
}

/**
 * Provision a fresh Sphere wallet for the manager, then spawn the
 * compiled host-manager binary against it. Resolves once the manager
 * has logged `host_manager_started` (DM listener active, ready to
 * accept HMCP). Rejects if the binary exits before that point with the
 * last 30 log lines for diagnosis.
 *
 * Caller MUST call `.stop()` even if a test fails — the manager holds
 * the persistence-path lock and a relay connection.
 */
export async function spawnHostManager(opts: SpawnHostManagerOptions): Promise<HostManagerProcess> {
  const agenticPath = resolveAgenticHostingPath();
  const binPath = join(agenticPath, 'dist', 'host-manager.js');
  try {
    await access(binPath);
  } catch {
    throw new Error(
      `host-manager binary not found at ${binPath}. ` +
      `Build it first (cd ${agenticPath} && npm run build), or set ` +
      `AGENTIC_HOSTING_PATH to a checkout that has dist/host-manager.js.`,
    );
  }

  const templatesPath = opts.templatesPath ?? join(agenticPath, 'config', 'templates.json');
  try {
    await access(templatesPath);
  } catch {
    throw new Error(
      `templates.json not found at ${templatesPath}. ` +
      `Pass templatesPath explicitly or check AGENTIC_HOSTING_PATH.`,
    );
  }

  const hostId = opts.hostId ?? `e2elive-${randomUUID().slice(0, 8)}`;
  const sessionDir = join(tmpdir(), `trader-e2e-hma-${randomUUID()}`);
  const dataDir = join(sessionDir, 'wallet');
  const tenantsDir = join(sessionDir, 'tenants');
  const stateDir = join(sessionDir, 'state');
  await mkdir(sessionDir, { recursive: true });
  await mkdir(tenantsDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  const identity = await provisionManagerWallet(dataDir, hostId);

  const persistencePath = join(stateDir, 'state.json');
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    HOST_ID: hostId,
    MANAGER_PUBKEY: identity.pubkey,
    MANAGER_DIRECT_ADDRESS: identity.directAddress,
    AUTHORIZED_CONTROLLERS: opts.controllerPubkey,
    TEMPLATES_PATH: templatesPath,
    TENANTS_DIR: tenantsDir,
    SPHERE_MANAGER_DATA_DIR: dataDir,
    PERSISTENCE_PATH: persistencePath,
    UNICITY_HEALTH_PORT: String(opts.healthPort ?? 19401),
    UNICITY_NETWORK: 'testnet',
    HELLO_TIMEOUT_MS: String(opts.helloTimeoutMs ?? 60_000),
    LOG_LEVEL: 'info',
  };
  if (process.env['UNICITY_API_KEY']) env['UNICITY_API_KEY'] = process.env['UNICITY_API_KEY'];

  const child = spawn('node', [binPath], { env, cwd: sessionDir, stdio: ['ignore', 'pipe', 'pipe'] });

  const logs: string[] = [];
  child.stdout?.setEncoding('utf-8');
  child.stderr?.setEncoding('utf-8');
  child.stdout?.on('data', (chunk: string) => {
    for (const line of chunk.split('\n')) if (line) logs.push(line);
  });
  child.stderr?.on('data', (chunk: string) => {
    for (const line of chunk.split('\n')) if (line) logs.push(line);
  });

  // Resolve when `host_manager_started` log line appears. Reject if
  // the process exits before that (boot failure surfaces here, not as
  // an opaque hang during the first hm.spawn).
  const ready = new Promise<void>((resolve, reject) => {
    let settled = false;
    const finishOk = (): void => { if (!settled) { settled = true; resolve(); } };
    const finishErr = (e: Error): void => { if (!settled) { settled = true; reject(e); } };

    const watcher = setInterval(() => {
      if (logs.some((l) => l.includes('"host_manager_started"'))) {
        clearInterval(watcher);
        finishOk();
      }
    }, 250);

    child.once('exit', (code) => {
      clearInterval(watcher);
      finishErr(new Error(
        `host-manager exited prematurely (code=${code}) before host_manager_started. ` +
        `last logs:\n${logs.slice(-30).join('\n')}`,
      ));
    });
    child.once('error', (err) => {
      clearInterval(watcher);
      finishErr(err);
    });
    setTimeout(() => {
      clearInterval(watcher);
      finishErr(new Error(
        `host-manager did not reach host_manager_started within 240s. last logs:\n${logs.slice(-40).join('\n')}`,
      ));
    }, 240_000).unref();
  });

  const proc: HostManagerProcess = {
    pubkey: identity.pubkey,
    directAddress: identity.directAddress,
    nametag: identity.nametag,
    dataDir,
    templatesPath,
    controllerPubkey: opts.controllerPubkey,
    child,
    logs,
    ready,
    async stop(): Promise<void> {
      const c = proc.child;
      if (!c) return;
      proc.child = null;
      if (c.exitCode === null) {
        c.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const killTimer = setTimeout(() => {
            try { c.kill('SIGKILL'); } catch { /* already dead */ }
          }, 12_000);
          killTimer.unref();
          c.once('exit', () => { clearTimeout(killTimer); resolve(); });
        });
      }
      await rm(sessionDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
    },
  };

  return proc;
}
