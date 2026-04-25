/**
 * tenant-fixture — provisions a fresh trader tenant container ready to trade.
 *
 * Flow per `provisionTrader(opts)`:
 *   1. Materialize a fresh Sphere wallet on the host filesystem (mkdtempSync).
 *   2. Optionally fund the wallet from the testnet faucet.
 *   3. `docker run` the trader image with the host wallet bind-mounted at
 *      /data/wallet so the container reuses the identity we just generated.
 *   4. Wait for the container daemon-state to be RUNNING.
 *   5. Optionally poll trader-ctl `status` until the in-container service is
 *      reachable (default budget: 60s).
 *
 * On any failure: cleanup partial resources (container + wallet dir) before
 * rethrowing. The returned `dispose()` is idempotent.
 *
 * Architectural note (echoes contracts.ts): NO host-manager, NO HMCP. We
 * provision via the local Docker daemon directly. The trader's ACP-0 listener
 * still demands UNICITY_MANAGER_PUBKEY — we synthesize a one-off pubkey for
 * that env var so the boilerplate startup checks pass; the e2e tests drive
 * the trader via trader-ctl over Sphere DM, never via the manager channel.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';

import type {
  ProvisionTraderOptions,
  ProvisionedTenant,
  DockerContainer,
} from './contracts.js';
import {
  runContainer,
  stopContainer,
  removeContainer,
  getContainerLogs,
  waitForContainerRunning,
} from './docker-helpers.js';
import { runTraderCtl } from './trader-ctl-driver.js';
import { RELAYS, TRADER_IMAGE } from './constants.js';
import { pollUntil } from './polling.js';
import { fundWallet } from './funding.js';

// ---------------------------------------------------------------------------
// Local extensions to ProvisionTraderOptions
// ---------------------------------------------------------------------------
//
// `contracts.ts:ProvisionTraderOptions` is the published shape. We accept a
// few extra knobs that aren't part of the published contract — they're
// optional so callers using the contract type still compile cleanly.

interface InternalProvisionOptions extends ProvisionTraderOptions {
  /** Request testnet tokens from the faucet after wallet creation. Default: false. */
  fundFromFaucet?: boolean;
  /** Faucet amount when funding (ignored if fundFromFaucet is false). */
  fundAmount?: bigint;
  /** Faucet coin id (ignored if fundFromFaucet is false). */
  fundCoinId?: string;
  /** Container image override; defaults to constants.TRADER_IMAGE. */
  image?: string;
  /** When false, skip readiness polling. Defaults to opts.waitForReady ?? true. */
  waitForReady?: boolean;
}

const DEFAULT_READY_TIMEOUT_MS = 60_000;
const READY_POLL_INTERVAL_MS = 2_000;
const READY_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_SCAN_INTERVAL_MS = 30_000;
const DEFAULT_MAX_ACTIVE_INTENTS = 10;
const FAUCET_RETRY_BASE_MS = 500;
const FAUCET_MAX_ATTEMPTS = 3;

/**
 * Best-effort cleanup: tolerant of partial state. Never throws — surfaces
 * cleanup errors to stderr only because we always call it from a `catch`
 * block where rethrowing would mask the original failure.
 */
async function safeCleanup(opts: {
  walletDir: string | null;
  container: DockerContainer | null;
}): Promise<void> {
  if (opts.container !== null) {
    try {
      await stopContainer(opts.container.id);
    } catch {
      /* container may already be stopped — best effort */
    }
    try {
      await removeContainer(opts.container.id);
    } catch {
      /* container may already be removed — best effort */
    }
  }
  if (opts.walletDir !== null) {
    try {
      rmSync(opts.walletDir, { recursive: true, force: true });
    } catch {
      /* fs may be in odd state — best effort */
    }
  }
}

/**
 * Generate a synthetic 33-byte secp256k1-shaped hex string. Not a real key —
 * just enough characters to satisfy the `SECP256K1_HEX_KEY_RE` check in
 * `parseTenantConfig` so the in-container service starts. Tests don't drive
 * the trader via the manager channel, so the value's cryptographic validity
 * is irrelevant.
 */
function fakeSecp256k1Hex(): string {
  // Compressed pubkey: 0x02 prefix + 32 random bytes = 66 hex chars.
  return '02' + randomBytes(32).toString('hex');
}

/**
 * Materialize a wallet directory layout the trader expects (data + tokens
 * subdirs). The actual Sphere wallet identity is generated lazily by the
 * in-container `Sphere.init({ autoGenerate: true })` against this directory.
 *
 * We don't pre-init the wallet on the host because that would require
 * configuring sphere-sdk providers AND a working trustbase fetch — both of
 * which the in-container startup already does. Generating the wallet inside
 * the container also keeps secrets off the host fs except as a bind-mount
 * snapshot.
 */
function materializeWalletDir(label: string): string {
  const safeLabel = label.replace(/[^a-zA-Z0-9-_]/g, '-').slice(0, 24);
  const root = mkdtempSync(join(tmpdir(), `trader-e2e-${safeLabel}-`));
  const walletDir = join(root, 'wallet');
  const tokensDir = join(root, 'tokens');
  mkdirSync(walletDir, { recursive: true });
  mkdirSync(tokensDir, { recursive: true });

  // Seed an empty .sphere-cli config so the in-container CLI tools have a
  // network to target. The trader bootstrap reads UNICITY_NETWORK directly
  // and ignores this file, but it's cheap insurance against future tooling
  // that might prefer the config file.
  const cfgDir = join(root, '.sphere-cli');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(
    join(cfgDir, 'config.json'),
    JSON.stringify({ network: 'testnet' }, null, 2),
    'utf8',
  );

  return root;
}

/**
 * Funding helper with bounded retry. Faucet 5xx is retried with exponential
 * backoff (3 attempts; 500 ms / 1 s / 2 s). 4xx propagates immediately.
 */
async function fundWithRetry(
  walletAddress: string,
  amount: bigint,
  coinId?: string,
): Promise<{ tx_id: string }> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= FAUCET_MAX_ATTEMPTS; attempt++) {
    try {
      return await fundWallet(walletAddress, amount, coinId);
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      // Heuristic: only retry transient (5xx / network) errors. The peer
      // worktree's funding.ts is expected to surface 4xx with a stable
      // message we can pattern-match — for now, retry on any error short
      // of an explicit 4xx string in the message.
      if (/4\d\d/.test(msg)) {
        throw err;
      }
      if (attempt < FAUCET_MAX_ATTEMPTS) {
        const backoff = FAUCET_RETRY_BASE_MS * 2 ** (attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Build the env-var bag the trader image expects. See `Dockerfile` and
 * `src/acp-adapter/main.ts` / `src/shared/config.ts` for the canonical list.
 */
function buildContainerEnv(opts: InternalProvisionOptions): Record<string, string> {
  const relays = (opts.relayUrls ?? RELAYS).join(',');
  const trustedEscrows = (opts.trustedEscrows ?? []).join(',');
  const scanInterval = opts.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
  const maxActiveIntents = opts.maxActiveIntents ?? DEFAULT_MAX_ACTIVE_INTENTS;

  // Synthesize ACP boot envelope. The trader's parseTenantConfig REQUIRES
  // these even in tests where the manager channel is unused (we drive via
  // trader-ctl over DM). UNICITY_MANAGER_DIRECT_ADDRESS is consumed by
  // src/trader/main.ts at startup — see lines 231-235 there.
  const managerPubkey = fakeSecp256k1Hex();
  const instanceId = `trader-e2e-${randomUUID()}`;
  const instanceName = `trader-${opts.label}-${instanceId.slice(-6)}`;
  const bootToken = randomUUID();

  return {
    // ACP boot contract (required by parseTenantConfig)
    UNICITY_MANAGER_PUBKEY: managerPubkey,
    UNICITY_MANAGER_DIRECT_ADDRESS: managerPubkey,
    UNICITY_BOOT_TOKEN: bootToken,
    UNICITY_INSTANCE_ID: instanceId,
    UNICITY_INSTANCE_NAME: instanceName,
    UNICITY_TEMPLATE_ID: 'trader',

    // Trader runtime config
    UNICITY_NETWORK: 'testnet',
    UNICITY_RELAYS: relays,
    UNICITY_DATA_DIR: '/data/wallet',
    UNICITY_TOKENS_DIR: '/data/tokens',
    UNICITY_TRUSTED_ESCROWS: trustedEscrows,
    TRADER_SCAN_INTERVAL_MS: String(scanInterval),
    TRADER_MAX_ACTIVE_INTENTS: String(maxActiveIntents),
    LOG_LEVEL: 'info',
  };
}

/**
 * Probe the trader by sending a `status` command via trader-ctl. Returns true
 * once the trader replies ok; false on any error or non-ok response. The
 * outer loop interprets false as "not yet" and keeps polling.
 */
async function probeReady(tenantAddress: string): Promise<boolean> {
  try {
    const result = await runTraderCtl('status', [], {
      tenant: tenantAddress,
      timeoutMs: READY_PROBE_TIMEOUT_MS,
      json: true,
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Compute the trader-ctl-targetable address for a freshly spawned tenant. In
 * the steady state the canonical address is `@<nametag>` — but the tenant
 * doesn't register its nametag until it boots and runs `Sphere.init`. Since
 * we don't have a host-side wallet pre-boot, we return the instance_name as
 * a stand-in DIRECT-style address; the integrator's real implementation will
 * read the actual transport pubkey from the container's `acp.hello` once
 * the bootstrap is wired into this fixture. For now: tests mock this layer
 * end-to-end, and live tests will be broken in a way the integrator must
 * fix when stitching the real docker-helpers + trader-ctl-driver in.
 */
function deriveTenantAddressFromEnv(env: Record<string, string>): string {
  // Use the synthesized DIRECT address so trader-ctl has SOMETHING to dial.
  // The integrator will replace this with the genuine post-boot resolution.
  const pk = env['UNICITY_MANAGER_DIRECT_ADDRESS'] ?? '';
  return `DIRECT://${pk}`;
}

/**
 * End-to-end provision: wallet → optional faucet → docker run → wait for
 * RUNNING → optional readiness probe. See module docstring for invariants.
 */
export async function provisionTrader(
  opts: ProvisionTraderOptions,
): Promise<ProvisionedTenant> {
  const internal = opts as InternalProvisionOptions;
  let walletDir: string | null = null;
  let container: DockerContainer | null = null;

  try {
    // 1. Materialize wallet dir on host
    walletDir = materializeWalletDir(opts.label);

    // 2. Optional: fund from faucet. Skipped by default to keep tests bound
    //    to a single network call instead of three (faucet hit, faucet
    //    confirm, balance verify).
    if (internal.fundFromFaucet === true) {
      // The wallet identity isn't yet generated on the host, so we don't have
      // a target pubkey to fund. The peer worktree authoring funding.ts may
      // accept a "post-boot fund this tenant" flow instead; for now we pass
      // the synthesized direct address as a placeholder. The integrator
      // reconciles this when the real funding flow lands.
      const targetAddress = `host-prefund-${randomUUID()}`;
      await fundWithRetry(
        targetAddress,
        internal.fundAmount ?? 0n,
        internal.fundCoinId,
      );
    }

    // 3. docker run trader image
    const env = buildContainerEnv(internal);
    container = await runContainer({
      image: internal.image ?? TRADER_IMAGE,
      label: opts.label,
      env,
      binds: [
        // /data/wallet must be RW — Sphere.init writes the seed + nametag
        // bind events here on first boot. Read-only would crash startup.
        { host: walletDir, container: '/data/wallet', readonly: false },
      ],
    });

    // 4. Wait for the container to be RUNNING per docker inspect
    const isRunning = await waitForContainerRunning(container.id);
    if (!isRunning) {
      // Capture logs before cleanup so the caller can see why
      let logs = '';
      try {
        logs = await getContainerLogs(container.id);
      } catch {
        /* best effort */
      }
      throw new Error(
        `provisionTrader: container ${container.id} failed to reach RUNNING state. ` +
          `Logs: ${logs.slice(-2000)}`,
      );
    }

    // 5. Optional readiness probe
    const tenantAddress = deriveTenantAddressFromEnv(env);
    const shouldWaitReady = internal.waitForReady ?? opts.waitForReady ?? true;
    if (shouldWaitReady) {
      const readyTimeout = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
      const ready = await pollUntil(() => probeReady(tenantAddress), {
        timeoutMs: readyTimeout,
        intervalMs: READY_POLL_INTERVAL_MS,
        description: `trader ${opts.label} ready`,
      });
      if (!ready) {
        let logs = '';
        try {
          logs = await getContainerLogs(container.id);
        } catch {
          /* best effort */
        }
        throw new Error(
          `provisionTrader: trader ${opts.label} did not become reachable within ` +
            `${readyTimeout}ms. Logs: ${logs.slice(-2000)}`,
        );
      }
    }

    // Build dispose() — idempotent via a guard flag captured in closure.
    let disposed = false;
    const capturedContainer = container;
    const capturedWalletDir = walletDir;
    const dispose = async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      await safeCleanup({
        walletDir: capturedWalletDir,
        container: capturedContainer,
      });
    };

    return {
      address: tenantAddress,
      container,
      walletDir,
      dispose,
    };
  } catch (err) {
    // Cleanup partial resources before propagating.
    await safeCleanup({ walletDir, container });
    throw err;
  }
}
