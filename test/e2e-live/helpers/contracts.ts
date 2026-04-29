/**
 * E2E-live test infrastructure contracts.
 *
 * Five worktrees are filling in the helper modules in parallel; this file
 * pins down their EXPORTED shapes so each can compile and test against the
 * contract while peer impls land. Once all impls are in, this file becomes
 * a stable interface registry — useful for understanding the harness without
 * reading every helper.
 *
 * Architecture (the model the user actually wants for partner demos):
 *
 *   Test                 → uses --                              docker-helpers
 *     │                                                              │
 *     ├── tenant-fixture (provisions traders) ─── docker run ────────┘
 *     │
 *     └── trader-ctl-driver (drives commands) ─── DM ──→ trader tenant
 *
 *   Crucially: NO host-manager, NO HMCP. Tests provision containers
 *   directly via the Docker daemon and drive trading via trader-ctl. This
 *   matches the production architecture where agentic-hosting only
 *   orchestrates LIFECYCLE; trading happens controller ↔ tenant directly.
 */

// ============================================================================
// docker-helpers.ts — owns: provisioning + lifecycle of a single container
// ============================================================================

export interface DockerRunOptions {
  /** Fully-qualified image ref, e.g. ghcr.io/vrogojin/agentic-hosting/trader:v0.1 */
  image: string;
  /** Optional human-readable name suffix; helpful for log scraping. */
  label?: string;
  /** Env vars baked into the container at start time. */
  env?: Record<string, string>;
  /** Bind-mount: host path → container path. Used for /data/wallet/, /data/config/. */
  binds?: Array<{ host: string; container: string; readonly?: boolean }>;
  /** Resource caps. Default: 256 MiB / 128 PIDs (per-container, not enforced). */
  resources?: { memoryMb?: number; pidsLimit?: number };
  /** Network mode. Default: 'bridge'. */
  network?: 'bridge' | 'host';
  /** Wall-clock timeout for `docker run` to return. Default: 30 s. */
  startTimeoutMs?: number;
}

export interface DockerContainer {
  /** Docker container ID (sha256-ish, 64 chars). */
  id: string;
  /** Operator-friendly short name. */
  name: string;
  /** Created-at wall-clock time for log correlation. */
  createdAt: Date;
}

/**
 * Spawn a container with the given options. Returns once the daemon has
 * accepted the run (NOT once the app inside is ready — provisioning code
 * upstream polls for that).
 */
export type RunContainer = (opts: DockerRunOptions) => Promise<DockerContainer>;

/**
 * Stop with SIGTERM, fall back to SIGKILL after `timeoutMs`. Idempotent —
 * stopping an already-stopped container is a no-op.
 */
export type StopContainer = (id: string, timeoutMs?: number) => Promise<void>;

/** Remove the container record. Throws if container is still running. */
export type RemoveContainer = (id: string) => Promise<void>;

/** Read the last `lines` of stdout+stderr for diagnostic output on failure. */
export type GetContainerLogs = (id: string, lines?: number) => Promise<string>;

/** Resolve true once container is RUNNING per `docker inspect`, else false on `timeoutMs` elapse. */
export type WaitForContainerRunning = (id: string, timeoutMs?: number) => Promise<boolean>;

// ============================================================================
// trader-ctl-driver.ts — owns: invoke the canonical CLI as a subprocess
// ============================================================================

export interface TraderCtlOptions {
  /** Tenant address: @nametag, DIRECT://hex, or 64-char hex pubkey. */
  tenant: string;
  /** Optional Sphere wallet dir override (caller's identity). */
  dataDir?: string;
  /** Optional tokens dir override. */
  tokensDir?: string;
  /** Per-command timeout in ms (must be >= 100; floor enforced by tenant). */
  timeoutMs?: number;
  /** When true, parse stdout as JSON; throw on non-JSON. */
  json?: boolean;
}

export interface TraderCtlResult {
  /** Always 0 on success; see `error` field on non-zero. */
  exitCode: number;
  /** Parsed JSON result if `json` was true; raw string otherwise. */
  output: unknown;
  /** stderr concatenated; empty on success. */
  stderr: string;
}

/**
 * Run `trader-ctl <command> [args]` as a subprocess. Uses the bundled
 * trader-ctl from this repo (../bin/trader-ctl). Throws ONLY on subprocess
 * launch failure; non-zero exit codes are returned as `result.exitCode`.
 */
export type RunTraderCtl = (
  command: string,
  args: ReadonlyArray<string>,
  opts: TraderCtlOptions,
) => Promise<TraderCtlResult>;

// ============================================================================
// tenant-fixture.ts — owns: provision N trader tenants ready to trade
// ============================================================================

export interface ProvisionTraderOptions {
  /** Operator-friendly label, used in container name and logs. */
  label: string;
  /** Comma-joined trusted-escrow addresses passed via env. */
  trustedEscrows?: string[];
  /** Override default scan interval (ms). */
  scanIntervalMs?: number;
  /** Override default max active intents. */
  maxActiveIntents?: number;
  /** Sphere relay URLs (testnet defaults if omitted). */
  relayUrls?: string[];
  /** Wait for the trader to be reachable (poll info command). Default: true. */
  waitForReady?: boolean;
  /** Ready-poll budget. Default: 60s. */
  readyTimeoutMs?: number;
  /**
   * Self-mint funding (replaces faucet HTTP). When set, the trader
   * mints the listed amounts at startup via
   * sphere.payments.mintFungibleToken (genesis mint with the wallet's
   * own SigningService as issuer). Public testnet registry coinIds
   * (UCT / USDU) work because there's no cryptographic restriction
   * on which key issues a given CoinId — `class CoinId { ctor(bytes) }`.
   *
   * Eliminates the test's faucet HTTP dependency. The remaining
   * external services are L3 aggregator + Nostr relays, both of
   * which the swap path already requires.
   */
  selfMintFund?: Array<{ coinIdHex: string; amount: bigint }>;
}

export interface ProvisionedTenant {
  /** trader-ctl-targetable address. Either DIRECT://hex or 64-char hex. */
  address: string;
  /** Container record for cleanup / log retrieval. */
  container: DockerContainer;
  /** Wallet dir on host filesystem (for cleanup). */
  walletDir: string;
  /** Stop the container, cleanup the wallet dir. Idempotent. */
  dispose(): Promise<void>;
}

/**
 * End-to-end provision: create wallet → fund from faucet → docker run trader →
 * wait until reachable. Returns a fully-armed tenant.
 *
 * On any step failure, partial resources are cleaned up before throwing.
 */
export type ProvisionTrader = (opts: ProvisionTraderOptions) => Promise<ProvisionedTenant>;

// ============================================================================
// constants.ts — owns: testnet-wide invariants
// ============================================================================

export interface TestnetConstants {
  /** Default sphere-sdk relay set for testnet wallets. */
  readonly RELAYS: ReadonlyArray<string>;
  /** Aggregator URL for proofs. */
  readonly AGGREGATOR_URL: string;
  /** IPFS gateway for content addressing. */
  readonly IPFS_GATEWAY: string;
  /** Faucet endpoint. */
  readonly FAUCET_URL: string;
  /** Default trader image (matches templates.json shortcut). */
  readonly TRADER_IMAGE: string;
  /** Default escrow image. */
  readonly ESCROW_IMAGE: string;
  /** Per-test default timeout (slow because real-network). */
  readonly DEFAULT_TIMEOUT_MS: number;
  /** Max wait for a swap to terminal state. */
  readonly SWAP_TIMEOUT_MS: number;
}

// ============================================================================
// polling.ts — owns: wait-for-condition utility
// ============================================================================

/**
 * Poll `predicate` every `intervalMs` until it returns true or `timeoutMs`
 * elapses. Returns true on success, false on timeout. Predicate exceptions
 * are treated as "not yet" (logged at debug, retry).
 */
export type PollUntil = (
  predicate: () => Promise<boolean>,
  opts?: { timeoutMs?: number; intervalMs?: number; description?: string },
) => Promise<boolean>;

// ============================================================================
// funding.ts — owns: testnet faucet integration
// ============================================================================

/**
 * Request testnet tokens from the configured faucet for a freshly-created
 * wallet. Returns the resolved tx_id on success. Throws on faucet 4xx/5xx.
 *
 * Tests SHOULD use this once per fresh wallet; the faucet is a shared
 * resource and should not be hammered.
 */
export type FundWallet = (
  walletAddress: string,
  amount: bigint,
  coinId?: string,
) => Promise<{ tx_id: string }>;

// ============================================================================
// scenario-helpers.ts — owns: reusable scenario primitives
// ============================================================================
//
// Used by individual test files to express common shapes:
//   - "two traders post matching intents and the deal completes"
//   - "trader cancels an intent before it matches"
//   - "trader's intent expires"
// without re-implementing the orchestration in every test.

export interface MatchingIntents {
  /** Buyer's intent id from CREATE_INTENT. */
  buyerIntentId: string;
  /** Seller's intent id from CREATE_INTENT. */
  sellerIntentId: string;
}

/**
 * Submit two intents that should match (one buy, one sell, overlapping
 * rate ranges). Returns intent_ids after both CREATE_INTENT replies.
 */
export type CreateMatchingIntents = (
  buyer: ProvisionedTenant,
  seller: ProvisionedTenant,
  terms: {
    base_asset: string;
    quote_asset: string;
    rate_min: bigint;
    rate_max: bigint;
    volume_min: bigint;
    volume_max: bigint;
  },
) => Promise<MatchingIntents>;

/**
 * Poll list-deals on `tenant` until a deal in `state` exists. Returns the
 * deal record. Times out if no matching deal appears within `timeoutMs`.
 */
export type WaitForDealInState = (
  tenant: ProvisionedTenant,
  state: 'PROPOSED' | 'ACCEPTED' | 'EXECUTING' | 'COMPLETED' | 'FAILED',
  timeoutMs?: number,
) => Promise<Record<string, unknown>>;
