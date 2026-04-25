/**
 * Live E2E test environment — ZERO mocks.
 *
 * Uses real Sphere SDK wallets for controller and manager DMs over Nostr,
 * real Dockerode adapter for container lifecycle, and real ACP handshake.
 * Tenant containers send acp.hello over real Nostr, manager receives it,
 * and instances reach RUNNING.
 *
 * Requires: Docker daemon running, images built locally, network access
 * to testnet infrastructure (Nostr relays, aggregator, faucet).
 */

import { Sphere } from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';
import { createHostManager, type HostManager } from '../../../src/host-manager/manager.js';
import { createTemplateRegistry, type TemplateRegistry } from '../../../src/host-manager/template-registry.js';
import { createAuthValidator } from '../../../src/host-manager/auth.js';
import { createLogger } from '../../../src/shared/logger.js';
import type { ManagerConfig, TemplateConfig } from '../../../src/shared/types.js';
import type { DmTransport, ResponseCollector } from './response-collector.js';
import { createResponseCollector } from './response-collector.js';
import { NETWORK, TRUSTBASE_URL, resolveApiKey } from './constants.js';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import type { DirectMessage } from '@unicitylabs/sphere-sdk';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LiveTestEnvironment {
  envName: string;
  controllerSphere: Sphere;
  controllerNametag: string;
  managerSphere: Sphere;
  managerNametag: string;
  controllerTransport: DmTransport;
  controllerPubkey: string;
  managerAddress: string;
  manager: HostManager;
  responses: ResponseCollector;
  spawnedInstances: string[];
}

export interface SpawnedAgent {
  instanceId: string;
  instanceName: string;
  tenantPubkey: string;
  tenantDirectAddress: string;
  tenantNametag: string | null;
}

// ---------------------------------------------------------------------------
// Docker availability check
// ---------------------------------------------------------------------------

/**
 * Check if Docker daemon is running and required images exist.
 * Returns null if ready, or a skip reason string if not.
 */
export function checkDockerAvailability(): string | null {
  try {
    execSync('docker info', { stdio: 'pipe' });
  } catch {
    return 'Docker daemon is not running';
  }

  // Check at least the tenant image exists (base image for all templates)
  try {
    const result = execSync(
      'docker images ghcr.io/unicitynetwork/agentic-hosting/tenant:0.1 --format "{{.ID}}"',
      { stdio: 'pipe', encoding: 'utf-8' },
    ).trim();
    if (!result) {
      return 'Docker image ghcr.io/unicitynetwork/agentic-hosting/tenant:0.1 not built. Run: docker build -f docker/Dockerfile.tenant -t ghcr.io/unicitynetwork/agentic-hosting/tenant:0.1 .';
    }
  } catch {
    return 'Failed to check Docker images';
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function generateEnvName(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `live-${ts}-${rand}`;
}

/**
 * Creates a temporary directory hierarchy for a single Sphere wallet instance.
 * Each wallet gets an isolated directory to prevent storage collisions.
 */
function makeTempDir(label: string): { dataDir: string; tokensDir: string } {
  const rand = Math.random().toString(36).slice(2, 8);
  const dataDir = join(tmpdir(), `sphere-e2e-${label}-${Date.now()}-${rand}`);
  const tokensDir = join(dataDir, 'tokens');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(tokensDir, { recursive: true });
  return { dataDir, tokensDir };
}

/**
 * Generates a unique nametag safe for testnet registration.
 *
 * Nametag format: 3-20 lowercase alphanumeric/underscore/hyphen chars.
 * We keep it short (prefix + 6 random hex chars) to stay well under the cap.
 */
/**
 * Convert a 33-byte compressed secp256k1 pubkey (66 hex chars, 02/03 prefix)
 * to a 32-byte x-only pubkey (64 hex chars) by stripping the prefix.
 * Nostr DM events use x-only pubkeys, so the auth allowlist must match.
 */
function toXOnlyPubkey(compressedPubkey: string): string {
  if (compressedPubkey.length === 66 &&
      (compressedPubkey.startsWith('02') || compressedPubkey.startsWith('03'))) {
    return compressedPubkey.slice(2);
  }
  return compressedPubkey;
}

function generateNametag(prefix: string): string {
  const rand = Math.random().toString(36).replace(/[^a-z0-9]/g, '').slice(0, 6);
  return `${prefix.slice(0, 4)}${rand}`.toLowerCase();
}

/**
 * Initialises a Sphere wallet on the testnet and registers a unique nametag.
 *
 * Downloads the trustbase, sets up providers, and returns the wallet ready
 * for DM communication over Nostr.
 */
async function initWallet(
  label: string,
): Promise<{ sphere: Sphere; dataDir: string; nametag: string }> {
  const { dataDir, tokensDir } = makeTempDir(label);

  // Download trustbase into the wallet's data directory
  const tbResponse = await fetch(TRUSTBASE_URL);
  if (!tbResponse.ok) {
    throw new Error(`Failed to download trustbase: HTTP ${tbResponse.status}`);
  }
  writeFileSync(join(dataDir, 'trustbase.json'), await tbResponse.text());

  const providers = createNodeProviders({
    network: NETWORK,
    dataDir,
    tokensDir,
    oracle: {
      trustBasePath: join(dataDir, 'trustbase.json'),
      apiKey: resolveApiKey(),
    },
  });

  const nametag = generateNametag(label.replace(/[^a-z]/g, '').slice(0, 4) || 'e2e');

  const { sphere } = await Sphere.init({
    ...providers,
    autoGenerate: true,
    nametag,
  });

  return { sphere, dataDir, nametag };
}

function loadTemplates(): TemplateConfig[] {
  try {
    const templatesPath = join(process.cwd(), 'config', 'templates.json');
    const raw = readFileSync(templatesPath, 'utf-8');
    const parsed = JSON.parse(raw) as { templates: TemplateConfig[] };
    return parsed.templates;
  } catch {
    return [
      {
        template_id: 'tenant-cli-boilerplate',
        image: 'ghcr.io/unicitynetwork/agentic-hosting/tenant:0.1',
        entrypoint: ['node', '/app/dist/tenant.js'],
        env_defaults: {},
      },
    ];
  }
}

// ---------------------------------------------------------------------------
// Sphere → DmTransport wrapper
// ---------------------------------------------------------------------------

/**
 * Wraps a real Sphere instance as a DmTransport for the response collector
 * and controller command sending.
 */
function wrapSphereAsTransport(sphere: Sphere): DmTransport {
  return {
    async sendDm(recipientAddress: string, content: string): Promise<void> {
      await sphere.communications.sendDM(recipientAddress, content);
    },
    onDm(handler: (senderPubkey: string, senderAddress: string, content: string) => void): () => void {
      return sphere.on('message:dm', (msg: DirectMessage) => {
        // DirectMessage has senderPubkey — use @nametag if available,
        // otherwise raw hex pubkey (both work with Sphere SDK's sendDM).
        const senderAddress = msg.senderNametag
          ? `@${msg.senderNametag}`
          : msg.senderPubkey;
        handler(msg.senderPubkey, senderAddress, msg.content);
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a live test environment with ZERO mocks.
 *
 * - Real Sphere SDK wallets for controller and manager (Nostr transport).
 * - Real Dockerode adapter (talks to local Docker daemon).
 * - Real ACP handshake: tenant acp.hello arrives via Nostr, manager receives
 *   it and marks the instance RUNNING.
 */
export async function createTestEnvironment(): Promise<LiveTestEnvironment> {
  const envName = generateEnvName();

  console.log(`[e2e-live] Initialising controller wallet...`);
  const controller = await initWallet('ctrl');
  const controllerIdentity = controller.sphere.identity;
  if (!controllerIdentity) throw new Error('Controller wallet has no identity');
  console.log(`[e2e-live] Controller: nametag=${controller.nametag}, pubkey=${controllerIdentity.chainPubkey.slice(0, 16)}...`);

  console.log(`[e2e-live] Initialising manager wallet...`);
  const managerWallet = await initWallet('mgr');
  const managerIdentity = managerWallet.sphere.identity;
  if (!managerIdentity) throw new Error('Manager wallet has no identity');
  // For Sphere SDK DM routing, use @nametag (resolveRecipient understands it).
  // The DIRECT:// address is for the manager config internal identity, not for DM addressing.
  const managerDmAddress = `@${managerWallet.nametag}`;
  const managerDirectAddress = managerIdentity.directAddress ?? `DIRECT://${managerIdentity.chainPubkey}`;
  console.log(`[e2e-live] Manager: nametag=${managerWallet.nametag}, pubkey=${managerIdentity.chainPubkey.slice(0, 16)}..., dm=${managerDmAddress}`);

  // Real Docker adapter
  const { createDockerodeAdapter } = await import('../../../src/host-manager/docker-adapter.js');
  const docker = createDockerodeAdapter('/var/run/docker.sock');

  const templates = loadTemplates();
  const templateRegistry: TemplateRegistry = createTemplateRegistry(templates);

  // Manager config — generous hello timeout for real Nostr transport
  const tenantsDir = join(tmpdir(), `agentic-e2e-${envName}`);
  mkdirSync(tenantsDir, { recursive: true });

  // Use x-only pubkeys (32 bytes) for the auth allowlist because Nostr DM
  // events provide x-only pubkeys in DirectMessage.senderPubkey. The
  // pubkeysEqual() function requires matching lengths.
  const controllerXOnly = toXOnlyPubkey(controllerIdentity.chainPubkey);
  const managerXOnly = toXOnlyPubkey(managerIdentity.chainPubkey);

  const config: ManagerConfig = {
    host_id: `e2e-${envName}`,
    manager_pubkey: managerXOnly,
    manager_direct_address: managerDirectAddress,
    authorized_controllers: [controllerXOnly],
    templates_path: join(process.cwd(), 'config', 'templates.json'),
    tenants_dir: tenantsDir,
    hello_timeout_ms: 60_000,
    heartbeat_interval_ms: 30_000,
    heartbeat_timeout_ms: 90_000,
    docker_socket: '/var/run/docker.sock',
    network: NETWORK,
    persistence_path: null,
    max_instance_lock_queue: 64,
  };

  // Manager's DM sender wraps the real Sphere wallet
  const managerSender = {
    async sendDm(recipientAddress: string, content: string): Promise<void> {
      await managerWallet.sphere.communications.sendDM(recipientAddress, content);
    },
  };

  const manager = createHostManager({
    config,
    docker,
    sender: managerSender,
    templateRegistry,
    auth: createAuthValidator([controllerXOnly]),
    logger: createLogger({ component: `e2e-live-${envName}` }),
  });

  // Wire manager DM subscription — real Nostr messages from controller and tenants.
  // The senderAddress must be something Sphere SDK's sendDM() can resolve:
  // either @nametag (for nametag lookup) or raw hex pubkey (passed through as-is).
  //
  // Note: Nostr DM events provide 32-byte x-only pubkeys in senderPubkey,
  // while the auth validator uses 33-byte compressed keys (02/03 prefix).
  // We pass the x-only key through directly — the auth allowlist below
  // is also built with x-only keys for consistent comparison.
  managerWallet.sphere.on('message:dm', (msg: DirectMessage) => {
    const senderAddress = msg.senderNametag
      ? `@${msg.senderNametag}`
      : msg.senderPubkey;
    manager.handleIncomingDm(msg.senderPubkey, senderAddress, msg.content).catch((err) => {
      console.error('[e2e-live] Manager DM handler error:', err);
    });
  });

  // Controller transport wraps real Sphere
  const controllerTransport = wrapSphereAsTransport(controller.sphere);
  const responses = createResponseCollector(controllerTransport);

  return {
    envName,
    controllerSphere: controller.sphere,
    controllerNametag: controller.nametag,
    managerSphere: managerWallet.sphere,
    managerNametag: managerWallet.nametag,
    controllerTransport,
    controllerPubkey: controllerXOnly,
    managerAddress: managerDmAddress,
    manager,
    responses,
    spawnedInstances: [],
  };
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

export async function teardownEnvironment(env: LiveTestEnvironment): Promise<void> {
  const { createHmcpRequest } = await import('../../../src/protocols/hmcp.js');
  const { serializeMessage } = await import('../../../src/protocols/envelope.js');

  // Stop all spawned instances
  for (const instanceName of env.spawnedInstances) {
    try {
      const req = createHmcpRequest('hm.stop', { instance_name: instanceName });
      await env.controllerTransport.sendDm(env.managerAddress, serializeMessage(req));
      await env.responses.waitForResponseType(req.msg_id, 'hm.stop_result', 15_000).catch(() => {});
    } catch {
      console.warn(`[teardown] Failed to stop ${instanceName}`);
    }
  }

  // Remove all containers
  for (const instanceName of env.spawnedInstances) {
    try {
      const req = createHmcpRequest('hm.remove', { instance_name: instanceName });
      await env.controllerTransport.sendDm(env.managerAddress, serializeMessage(req));
      await env.responses.waitForResponseType(req.msg_id, 'hm.remove_result', 10_000).catch(() => {});
    } catch {
      console.warn(`[teardown] Failed to remove ${instanceName}`);
    }
  }

  // Dispose manager
  env.responses.destroy();
  await env.manager.dispose();

  // Destroy Sphere instances
  await env.controllerSphere.destroy();
  await env.managerSphere.destroy();

  // Clean up temp directories
  const tenantsDir = join(tmpdir(), `agentic-e2e-${env.envName}`);
  try {
    rmSync(tenantsDir, { recursive: true, force: true });
  } catch {
    console.warn(`[teardown] Failed to remove ${tenantsDir}`);
  }
}
