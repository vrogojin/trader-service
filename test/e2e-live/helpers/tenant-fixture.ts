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
import { randomBytes, randomUUID } from 'node:crypto';
import {
  getPublicKey,
  Sphere,
} from '@unicitylabs/sphere-sdk';

// Drive-by fix: same change is also in PR #10. `@unicitylabs/sphere-sdk` no
// longer exports `generatePrivateKey` at the package root (moved to the L1
// sub-namespace). A secp256k1 private key is just 32 random bytes — inline
// here so this test fixture compiles against current sphere-sdk regardless
// of which PR lands first. The fix is identical in both PRs.
function generatePrivateKey(): string {
  return randomBytes(32).toString('hex');
}
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
  /**
   * Self-mint funding (replaces faucet HTTP). Each entry instructs the
   * trader to mint `amount` smallest-units of the canonical CoinId
   * `coinIdHex` at startup, before agent.start(). The trader uses
   * sphere.payments.mintFungibleToken (genesis mint with the wallet's
   * own SigningService as issuer). UCT/USDU coinIds from the public
   * testnet registry (https://raw.githubusercontent.com/unicitynetwork/
   * unicity-ids/refs/heads/main/unicity-ids.testnet.json):
   *
   *   UCT  → 455ad8720656b08e8dbd5bac1f3c73eeea5431565f6c1c3af742b1aa12d41d89
   *   USDU → 8f0f3d7a5e7297be0ee98c63b81bcebb2740f43f616566fc290f9823a54f52d7
   *
   * The mint runs at trader startup (before agent.start), so balances
   * are visible to the intent engine on the first scan cycle.
   * Sets TRADER_FAULT_INJECTION_ALLOWED=1 implicitly so the trader's
   * production guard accepts TRADER_TEST_FUND.
   */
  selfMintFund?: Array<{ coinIdHex: string; amount: bigint }>;
}

const DEFAULT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_SCAN_INTERVAL_MS = 30_000;
const DEFAULT_MAX_ACTIVE_INTENTS = 10;
const FAUCET_RETRY_BASE_MS = 1_000;
const FAUCET_RETRY_CAP_MS = 8_000;
const FAUCET_MAX_ATTEMPTS = 10;

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
      // Retry transient errors (5xx, network, faucet nametag-resolution
      // timeouts) but fast-fail on real 4xx client errors.
      //
      // Anchor the status detection to "Faucet returned <code>" — without
      // anchoring, /4\d\d/ matches arbitrary "4xx" patterns inside random
      // instance_ids surfaced in faucet error bodies (e.g. the substring
      // `4909` in `tradere2eea4909558`), incorrectly classifying 5xx as
      // 4xx and short-circuiting all retries.
      const statusMatch = msg.match(/Faucet returned (\d{3})/);
      const status = statusMatch ? Number(statusMatch[1]) : 0;
      const isNametagPropagationRace =
        /Nametag not found/i.test(msg) ||
        /Nametag resolution timed out/i.test(msg);
      const isClientError = status >= 400 && status < 500;
      if (isClientError && !isNametagPropagationRace) {
        throw err;
      }
      if (attempt < FAUCET_MAX_ATTEMPTS) {
        const backoffRaw = FAUCET_RETRY_BASE_MS * 2 ** (attempt - 1);
        const backoff = Math.min(backoffRaw, FAUCET_RETRY_CAP_MS);
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
    // The trader's production guard requires TRADER_FAULT_INJECTION_ALLOWED=1
    // alongside the actual fault flag to actually inject the fault.
    ...(opts.faultSkipDeposits === true
      ? { TRADER_FAULT_SKIP_DEPOSITS: '1', TRADER_FAULT_INJECTION_ALLOWED: '1' }
      : {}),
    // Self-mint TEST funding (replaces faucet HTTP). When opts.selfMint is
    // set, the trader self-mints the listed amounts at startup via
    // sphere.payments.mintFungibleToken. Both the network gate AND
    // TRADER_FAULT_INJECTION_ALLOWED=1 are required by the trader's
    // production guard to actually run the mint.
    ...(opts.selfMintFund !== undefined && opts.selfMintFund.length > 0
      ? {
          TRADER_TEST_FUND: opts.selfMintFund
            .map(({ coinIdHex, amount }) => `${coinIdHex}:${amount.toString()}`)
            .join(','),
          TRADER_FAULT_INJECTION_ALLOWED: '1',
        }
      : {}),
  };
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
    let earlyError: string | null = null;
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
      // 2026-04-30 FIX: detect early-exit failure conditions and short-
      // circuit the 180s timeout. Pre-fix, a trader process that crashed
      // at ~1s with "Failed to register Unicity ID" would leave the
      // container running but the node process dead — we'd poll for
      // sphere_initialized for the full 180s budget and report it as a
      // generic "did not log" hang.
      if (parsed['event'] === 'trader_acp_startup_failed' ||
          parsed['msg'] === 'trader_acp_startup_failed') {
        const errDetails = (parsed['details'] as Record<string, unknown> | undefined)?.['error']
          ?? parsed['error'];
        earlyError = `trader_acp_startup_failed: ${typeof errDetails === 'string' ? errDetails : JSON.stringify(errDetails)}`;
      }
    }
    if (earlyError !== null) {
      throw new Error(
        `waitForReadyAddress: container ${containerId} reported startup failure: ${earlyError}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `waitForReadyAddress: container ${containerId} did not log sphere_initialized within ${timeoutMs}ms`,
  );
}

/**
 * Polls container logs for a JSON event line matching the given event name.
 * Trader uses { event: '<name>' }; escrow uses pino { msg: '<name>' }. Returns
 * true on first match, false on timeout.
 */
async function waitForLogEvent(
  containerId: string,
  eventName: string,
  opts: { timeoutMs?: number; intervalMs?: number; logsLines?: number } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const intervalMs = opts.intervalMs ?? 1_500;
  const logsLines = opts.logsLines ?? 500;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    let logs = '';
    try {
      logs = (await getContainerLogs(containerId, logsLines)) ?? '';
    } catch {
      /* container exited; fall through to retry */
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
      if (parsed['event'] === eventName || parsed['msg'] === eventName) {
        return true;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
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

    // 6. Optional readiness check.
    //
    // We previously did a DM-based probe (`runTraderCtl list-intents`) that
    // bounced through Nostr. With multiple traders provisioning concurrently
    // against a SINGLE testnet relay, the probe consumed precious relay
    // subscription bandwidth — each probe spawned a fresh subprocess with
    // its own Nostr connection, polled every 2s for 180s = up to 90 fresh
    // subscriptions per trader. This was a major contributor to the
    // observed relay "appears stale" warnings and provisioning timeouts.
    //
    // Now we read the container log for `acp_listener_started` — that's
    // the trader's own canonical "I'm fully up" signal. The Nostr
    // dependency is removed from the readiness check entirely. Downstream
    // test ops (createIntent, list-intents, etc.) still use DMs and have
    // their own retry budgets.
    const shouldWaitReady = internal.waitForReady ?? opts.waitForReady ?? true;
    if (shouldWaitReady) {
      const readyTimeout = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
      const ready = await waitForLogEvent(container.id, 'acp_listener_started', {
        timeoutMs: readyTimeout,
      });
      if (!ready) {
        let logs = '';
        try {
          logs = await getContainerLogs(container.id);
        } catch {
          /* best effort */
        }
        throw new Error(
          `provisionTrader: trader ${opts.label} did not log acp_listener_started within ` +
            `${readyTimeout}ms. Logs: ${logs.slice(-2000)}`,
        );
      }
    }

    // 7. Optional funding. Two paths:
    //    - selfMintFund: trader self-mints at startup (no faucet HTTP).
    //      Already happened during sphere init (TRADER_TEST_FUND env var
    //      consumed by src/trader/main.ts before agent.start()). We just
    //      poll until balances are visible to confirm.
    //    - fundFromFaucet: legacy faucet HTTP path. Calls testnet faucet
    //      AFTER readiness; tokens arrive via Nostr DMs.
    if ((internal.selfMintFund?.length ?? 0) > 0) {
      const expectedCoinCount = internal.selfMintFund!.length;
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
        { timeoutMs: 180_000, intervalMs: 5_000, description: `${opts.label} all ${expectedCoinCount} coins self-minted` },
      );
    } else if (internal.fundFromFaucet === true) {
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
    // 2026-04-30 DIAGNOSTIC ENHANCEMENT: dump container logs BEFORE
    // cleanup so post-mortem analysis can distinguish "hung in Sphere
    // init" (e.g. Nostr publishNametagBinding never returned) from
    // "TS exception in our code". Previously the failed-provisioning
    // path called safeCleanup() immediately, leaving us with no
    // evidence about where the trader actually hung. Print the dump to
    // stderr (vitest captures it into the test output) so it shows up
    // on a CI failure without requiring docker access post-hoc.
    if (container) {
      try {
        const failedLogs = await getContainerLogs(container.id, 500);
        process.stderr.write(
          `\n=== CONTAINER LOGS [provisionTrader-failed ${opts.label}] (last 500 lines) ===\n${failedLogs}\n=== END ${opts.label} ===\n`,
        );
      } catch (logErr) {
        process.stderr.write(
          `\n=== CONTAINER LOGS [provisionTrader-failed ${opts.label}] dump failed: ${logErr instanceof Error ? logErr.message : String(logErr)} ===\n`,
        );
      }
    }
    // Cleanup partial resources before propagating.
    await safeCleanup({ walletDir, container });
    throw err;
  }
}

// ============================================================================
// provisionTradersStaggered — concurrent provisioning with kickoff stagger
// ============================================================================

/**
 * Provisions multiple traders sequentially.
 *
 * **Why sequential, not parallel:** the testnet's single Nostr relay is
 * the bottleneck. When N traders run `Sphere.init` concurrently, all of
 * them publish nametag binding events and then each does a self-verify
 * `sphere.resolve()` query. The relay's queryEvents subscription queue
 * serializes — under N>=3 concurrent load, queries time out at 15s and
 * each trader's verify loop runs out of budget. We've seen all 3 traders
 * hang at sphere_initialized for 180s under pure Promise.all.
 *
 * Sequential gives each trader's binding event time to propagate to the
 * relay's query index before the next trader starts hitting it. Cost is
 * ~30-60s per trader (dominated by sphere.init + verify); total wall
 * time scales linearly with N.
 *
 * If the testnet relay's subscription throughput improves, this can be
 * revisited as parallel-with-stagger.
 */
export async function provisionTradersStaggered(
  factories: Array<() => Promise<ProvisionedTenant>>,
): Promise<ProvisionedTenant[]> {
  const results: ProvisionedTenant[] = [];
  for (const factory of factories) {
    if (factory === undefined) continue;
    results.push(await factory());
  }
  return results;
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
