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
import { randomUUID } from 'node:crypto';
import {
  generatePrivateKey,
  getPublicKey,
  Sphere,
} from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

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
import { RELAYS, TRADER_IMAGE, ESCROW_IMAGE } from './constants.js';
import { pollUntil } from './polling.js';
import { fundWallet } from './funding.js';

// ---------------------------------------------------------------------------
// Local extensions to ProvisionTraderOptions
// ---------------------------------------------------------------------------
//
// `contracts.ts:ProvisionTraderOptions` is the published shape. We accept a
// few extra knobs that aren't part of the published contract — they're
// optional so callers using the contract type still compile cleanly.

export interface InternalProvisionOptions extends ProvisionTraderOptions {
  /**
   * Fund the wallet with faucet tokens after the container boots (uses the
   * real nametag address, not a synthesized placeholder). Default: false.
   */
  fundFromFaucet?: boolean;
  /**
   * Coin/amount pairs to fund. Funding happens AFTER boot, once the wallet
   * address (nametag) is known. Each coin is funded independently; faucet
   * errors are thrown and abort provisioning.
   * Default when fundFromFaucet=true: [{coinId:'UCT', amount:5000n}, {coinId:'USDU', amount:5000n}]
   */
  fundCoins?: Array<{ coinId: string; amount: bigint }>;
  /** Container image override; defaults to constants.TRADER_IMAGE. */
  image?: string;
  /**
   * Test-only fault injection. When true, sets `TRADER_FAULT_SKIP_DEPOSITS=1`
   * in the container env so the trader's `swap:announced` handler skips its
   * `swapModule.deposit()` call. Used by negotiation-failures' deposit-timeout
   * scenario to simulate a peer that accepts the deal but never deposits;
   * the counterparty's swap then hits EXECUTION_TIMEOUT and both sides
   * transition to FAILED. Production deployments must NEVER set this.
   */
  faultSkipDeposits?: boolean;
}

const DEFAULT_READY_TIMEOUT_MS = 60_000;
const READY_POLL_INTERVAL_MS = 2_000;
const READY_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_SCAN_INTERVAL_MS = 30_000;
const DEFAULT_MAX_ACTIVE_INTENTS = 10;
const FAUCET_RETRY_BASE_MS = 500;
const FAUCET_MAX_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Controller wallet — shared across all provisionTrader / provisionEscrow
// calls in a single test process.
//
// Why this exists:
//   - Tenants enforce sender-pubkey auth on incoming DMs. Only senders whose
//     pubkey matches `UNICITY_MANAGER_PUBKEY` or `UNICITY_CONTROLLER_PUBKEY`
//     reach the command dispatcher. Anything else routes to handleExternalDm
//     and the trader-ctl status probe will time out without ever getting a
//     reply.
//   - trader-ctl on the host invokes through Sphere with its own wallet.
//     We need that wallet's pubkey to match what the trader recognises.
//   - Solution: generate ONE controller wallet on the host, reuse for every
//     trader-ctl invocation in this process, set its pubkey as
//     UNICITY_CONTROLLER_PUBKEY on every spawned trader.
//
// The wallet lives in a tmp dir; vitest tears the whole process between
// runs so persistence isn't needed.
// ---------------------------------------------------------------------------

interface ControllerWallet {
  /** 33-byte compressed secp256k1 hex — matches what tenants compare against. */
  pubkey: string;
  /** Wallet data directory; passed to trader-ctl via --data-dir. */
  dataDir: string;
  /** Tokens directory; passed to trader-ctl via --tokens-dir. */
  tokensDir: string;
}

let controllerCache: Promise<ControllerWallet> | null = null;

export async function getControllerWallet(): Promise<ControllerWallet> {
  if (controllerCache !== null) return controllerCache;
  controllerCache = (async () => {
    const root = mkdtempSync(join(tmpdir(), 'trader-e2e-controller-'));
    const dataDir = join(root, 'wallet');
    const tokensDir = join(root, 'tokens');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(tokensDir, { recursive: true });

    const providers = createNodeProviders({
      network: 'testnet',
      dataDir,
      tokensDir,
    });
    const { sphere } = await Sphere.init({
      storage: providers.storage,
      transport: providers.transport,
      oracle: providers.oracle,
      network: 'testnet',
      autoGenerate: true,
    });
    if (sphere.identity === null) {
      throw new Error('getControllerWallet: Sphere.init returned null identity');
    }
    const pubkey = sphere.identity.chainPubkey;
    await sphere.destroy();
    return { pubkey, dataDir, tokensDir };
  })();
  return controllerCache;
}

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
 * Generate a real, on-curve secp256k1 compressed pubkey. The first run of
 * the live tests against a real trader image surfaced that random hex strings
 * with a 0x02 prefix have ~50% probability of NOT being on the curve, and
 * the trader's startup performs actual point validation (not just regex
 * shape) — failing with "bad point: is not on curve, sqrt error: Cannot
 * find square root".
 *
 * We don't need the private key (the test never signs as "manager"); just
 * generate one, derive the pubkey, throw the private key away.
 */
function realSecp256k1Pubkey(): string {
  const privateKey = generatePrivateKey();
  return getPublicKey(privateKey);  // returns 33-byte compressed hex
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
 *
 * The controller pubkey passed in here is the host-side trader-ctl wallet's
 * pubkey — set as UNICITY_CONTROLLER_PUBKEY so the trader's auth gate
 * accepts trader-ctl-signed DMs.
 */
function buildContainerEnv(
  opts: InternalProvisionOptions,
  controllerPubkey: string,
): Record<string, string> {
  const relays = (opts.relayUrls ?? RELAYS).join(',');
  const trustedEscrows = (opts.trustedEscrows ?? []).join(',');
  const scanInterval = opts.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
  const maxActiveIntents = opts.maxActiveIntents ?? DEFAULT_MAX_ACTIVE_INTENTS;

  // Synthesize ACP boot envelope. parseTenantConfig requires these even
  // though we drive the trader via trader-ctl as the controller — the
  // manager keypair is generated and discarded; only its pubkey matters.
  const managerPubkey = realSecp256k1Pubkey();
  const instanceId = `trader-e2e-${randomUUID()}`;
  const instanceName = `trader-${opts.label}-${instanceId.slice(-6)}`;
  const bootToken = randomUUID();

  return {
    // ACP boot contract (required by parseTenantConfig)
    UNICITY_MANAGER_PUBKEY: managerPubkey,
    UNICITY_MANAGER_DIRECT_ADDRESS: managerPubkey,
    UNICITY_CONTROLLER_PUBKEY: controllerPubkey,
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
    // Fault-injection: deposit-skip. Only set when the test caller asks.
    ...(opts.faultSkipDeposits === true ? { TRADER_FAULT_SKIP_DEPOSITS: '1' } : {}),
  };
}

/**
 * Probe the trader by sending a `list-intents` command via trader-ctl. Returns
 * true once the trader replies ok; false on any error or non-ok response. The
 * outer loop interprets false as "not yet" and keeps polling.
 *
 * Why list-intents and not status: STATUS is in the trader's
 * SYSTEM_ONLY_COMMANDS allowlist (manager-only — see acp-listener.ts:367).
 * Controllers like trader-ctl get UNAUTHORIZED on STATUS by design. We use
 * LIST_INTENTS as a controller-accessible "is the engine alive?" probe.
 */
async function probeReady(tenantAddress: string, controller: ControllerWallet): Promise<boolean> {
  try {
    const result = await runTraderCtl('list-intents', [], {
      tenant: tenantAddress,
      timeoutMs: READY_PROBE_TIMEOUT_MS,
      json: true,
      dataDir: controller.dataDir,
      tokensDir: controller.tokensDir,
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Wait for a container to log its `sphere_initialized` event and return the
 * resolved on-the-wire address (a `DIRECT://<hex>` or `@<nametag>`).
 *
 * Two log shapes supported because trader and escrow use different loggers:
 *   - Trader (custom JSON):    `{event:'sphere_initialized', details:{agent_address:'@…'}}`
 *   - Escrow  (pino):          `{msg:'sphere_initialized', direct_address:'DIRECT://…'}`
 *
 * The address shape itself doesn't matter — sphere-sdk's `sendDM` accepts
 * `@nametag`, `DIRECT://hex`, or raw 64-char hex pubkey. We pass through
 * whichever one the container chose to log.
 */
async function waitForReadyAddress(
  containerId: string,
  opts: { timeoutMs?: number; intervalMs?: number; logsLines?: number } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const intervalMs = opts.intervalMs ?? 1_500;
  const logsLines = opts.logsLines ?? 500;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    let logs = '';
    try {
      // `?? ''` defends against a mocked or future implementation that
      // resolves with a non-string; the production getContainerLogs always
      // returns a string but the unit-test mock can return undefined when
      // not explicitly stubbed, which would otherwise crash split('\n')
      // before the timeout-path's clearer error message kicks in.
      logs = (await getContainerLogs(containerId, logsLines)) ?? '';
    } catch {
      // Container may have already exited; keep trying briefly so we hit
      // the timeout path with a clear message rather than crashing here.
    }
    for (const line of logs.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed[0] !== '{') continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }
      // Trader format: { event: 'sphere_initialized', details: { agent_address } }
      if (parsed['event'] === 'sphere_initialized') {
        const details = parsed['details'];
        if (typeof details === 'object' && details !== null) {
          const addr = (details as Record<string, unknown>)['agent_address'];
          if (typeof addr === 'string' && addr !== '') return addr;
        }
      }
      // Escrow format (pino): { msg: 'sphere_initialized', direct_address }
      if (parsed['msg'] === 'sphere_initialized') {
        const addr = parsed['direct_address'];
        if (typeof addr === 'string' && addr !== '') return addr;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `waitForReadyAddress: container ${containerId} did not log sphere_initialized within ${timeoutMs}ms`,
  );
}

/**
 * End-to-end provision: wallet → optional faucet → docker run → wait for
 * RUNNING → optional readiness probe. See module docstring for invariants.
 */
export async function provisionTrader(
  opts: InternalProvisionOptions,
): Promise<ProvisionedTenant> {
  const internal = opts;
  let walletDir: string | null = null;
  let container: DockerContainer | null = null;

  try {
    // 1. Materialize wallet dir on host
    walletDir = materializeWalletDir(opts.label);

    // 2. docker run trader image (funding happens AFTER boot once address is known)
    const controller = await getControllerWallet();
    const env = buildContainerEnv(internal, controller.pubkey);
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

    // 5. Read the trader's real address from its sphere_initialized log line.
    //    Replaces the previous synthesized DIRECT://<managerPubkey> stub.
    const tenantAddress = await waitForReadyAddress(container.id, {
      timeoutMs: opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    });

    // 6. Optional readiness probe
    const shouldWaitReady = internal.waitForReady ?? opts.waitForReady ?? true;
    if (shouldWaitReady) {
      const readyTimeout = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
      const ready = await pollUntil(() => probeReady(tenantAddress, controller), {
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

    // 7. Optional: post-boot faucet funding. The wallet address (nametag) is now
    //    known so we can fund the real identity. Runs after readiness to ensure
    //    the trader's sync loop is already running and will pick up tokens.
    if (internal.fundFromFaucet === true) {
      // Faucet expects coin names, not symbols: 'unicity' → UCT, 'unicity-usd' → USDU
      const coins = internal.fundCoins ?? [
        { coinId: 'unicity', amount: 5000n },
        { coinId: 'unicity-usd', amount: 5000n },
      ];
      for (const { coinId, amount } of coins) {
        await fundWithRetry(tenantAddress, amount, coinId);
      }
      // Poll portfolio (calls payments.refresh() inside the trader) until
      // ALL funded coins show a positive confirmed balance, or 120s elapses.
      const expectedCoinCount = coins.length;
      await pollUntil(
        async () => {
          try {
            const result = await runTraderCtl('portfolio', [], {
              tenant: tenantAddress,
              timeoutMs: 10_000,
              json: true,
              dataDir: controller.dataDir,
              tokensDir: controller.tokensDir,
            });
            if (result.exitCode !== 0) return false;
            const out = result.output as Record<string, unknown>;
            const balances = (
              out['balances'] ?? (out['result'] as Record<string, unknown> | undefined)?.['balances']
            ) as unknown;
            if (!Array.isArray(balances)) return false;
            const nonZeroCount = balances.filter(
              (b: unknown) =>
                typeof b === 'object' &&
                b !== null &&
                BigInt(String((b as Record<string, unknown>)['confirmed'] ?? '0')) > 0n,
            ).length;
            return nonZeroCount >= expectedCoinCount;
          } catch {
            return false;
          }
        },
        { timeoutMs: 180_000, intervalMs: 5_000, description: `${opts.label} all ${expectedCoinCount} coins funded` },
      );
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

// ============================================================================
// provisionEscrow — same pattern, different image + simpler env
// ============================================================================

export interface ProvisionEscrowOptions {
  /** Operator-friendly label, used in container name and logs. */
  label: string;
  /** Sphere relay URLs (testnet defaults if omitted). */
  relayUrls?: string[];
  /** Deadline for the container to log `sphere_initialized`. Default 90s. */
  readyTimeoutMs?: number;
  /** Image override (defaults to constants.ESCROW_IMAGE). */
  image?: string;
}

function buildEscrowEnv(
  opts: ProvisionEscrowOptions,
  controllerPubkey: string,
): Record<string, string> {
  const relays = (opts.relayUrls ?? RELAYS).join(',');
  const managerPubkey = realSecp256k1Pubkey();
  const instanceId = `escrow-e2e-${randomUUID()}`;
  const instanceName = `escrow-${opts.label}-${instanceId.slice(-6)}`;
  const bootToken = randomUUID();
  return {
    UNICITY_MANAGER_PUBKEY: managerPubkey,
    UNICITY_MANAGER_DIRECT_ADDRESS: managerPubkey,
    UNICITY_CONTROLLER_PUBKEY: controllerPubkey,
    UNICITY_BOOT_TOKEN: bootToken,
    UNICITY_INSTANCE_ID: instanceId,
    UNICITY_INSTANCE_NAME: instanceName,
    UNICITY_TEMPLATE_ID: 'escrow',
    UNICITY_NETWORK: 'testnet',
    UNICITY_RELAYS: relays,
    UNICITY_DATA_DIR: '/data/wallet',
    UNICITY_TOKENS_DIR: '/data/tokens',
    LOG_LEVEL: 'info',
  };
}

/**
 * End-to-end escrow provision. Mirrors `provisionTrader` for an escrow
 * tenant: materialize wallet dir → docker run escrow image → wait for
 * `sphere_initialized` → return ProvisionedTenant.
 *
 * Test files use this in their `beforeAll` to spawn an escrow whose
 * `address` is a real `DIRECT://<pubkey>` that newly-spawned trader tenants
 * can list as a trusted_escrow.
 */
export async function provisionEscrow(
  opts: ProvisionEscrowOptions,
): Promise<ProvisionedTenant> {
  let walletDir: string | null = null;
  let container: DockerContainer | null = null;

  try {
    walletDir = materializeWalletDir(opts.label);

    const controller = await getControllerWallet();
    const env = buildEscrowEnv(opts, controller.pubkey);
    container = await runContainer({
      image: opts.image ?? ESCROW_IMAGE,
      label: opts.label,
      env,
      binds: [{ host: walletDir, container: '/data/wallet', readonly: false }],
    });

    const isRunning = await waitForContainerRunning(container.id);
    if (!isRunning) {
      let logs = '';
      try { logs = await getContainerLogs(container.id); } catch { /* best effort */ }
      throw new Error(
        `provisionEscrow: container ${container.id} failed to reach RUNNING. Logs: ${logs.slice(-2000)}`,
      );
    }

    const escrowAddress = await waitForReadyAddress(container.id, {
      timeoutMs: opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    });

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
      address: escrowAddress,
      container,
      walletDir,
      dispose,
    };
  } catch (err) {
    await safeCleanup({ walletDir, container });
    throw err;
  }
}
