/**
 * Helper: invoke `sphere trader …` subcommands against a running tenant.
 *
 * sphere-cli's `sphere trader` namespace mirrors the trader-ctl ACP-0
 * surface but routes through the canonical CLI binary instead of
 * trader-service's bundled `bin/trader-ctl`. This is the
 * Architecture-B replacement for `trader-ctl-driver.ts`.
 *
 * All commands accept a `--tenant <address>` flag (the trader's
 * @nametag, DIRECT:// addr, or hex pubkey) and a `--timeout <ms>`
 * budget. Most commands support `--json` for machine-readable output.
 *
 * The functions in this module:
 *   - Build the argv consistent with sphere-cli's flag names.
 *   - Pass the tenant address and a sensible default timeout.
 *   - Parse the JSON output (sphere-cli wraps the ACP result in an
 *     envelope; we extract the `result` field for callers).
 *   - Throw on non-zero exit (with a redacted stderr-aware message),
 *     so callers don't repeat the defensive parse.
 *
 * Sync vs async: most commands are sync (use `runSphere`) because
 * tests issue them serially. Use `runSphereAsync` for any future
 * call site that needs parallelism.
 */

import { runSphere, type SphereRunResult } from './sphere-cli.js';

const DEFAULT_TRADER_TIMEOUT_MS = 60_000;

export interface TraderInvocationOpts {
  cliPath: string;
  cliHome: string;
  /** Trader tenant address: @nametag, DIRECT://hex, or 64-char hex pubkey. */
  tenant: string;
  /** Per-command timeout in ms; default 60s. Trader-side ACP roundtrips on
   *  testnet are typically <10s, but a slow relay can push it. */
  timeoutMs?: number;
}

/**
 * Shape of sphere-cli's `--json` output for trader commands.
 *
 * sphere-cli's `emitResult` calls `printJson(response)` where
 * `response` is the AcpResultPayload directly — NOT wrapped in any
 * envelope. The trader's `okPayload(cmdId, result)` produces:
 *   { command_id, ok: true,  result: {...} }
 * The trader's `errorPayload(...)` produces:
 *   { command_id, ok: false, error_code, message }
 */
interface AcpResultEnvelope {
  readonly command_id?: string;
  readonly ok?: boolean;
  readonly result?: unknown;
  readonly error_code?: string;
  readonly message?: string;
}

/**
 * Run a `sphere trader <subcommand> [args]` invocation and return the
 * parsed `result` object. Throws on non-zero exit or non-ok payload.
 *
 * `args` should NOT include `--tenant`, `--json`, `--timeout` — those
 * are added here to ensure consistent invocation shape across helpers.
 */
function runTraderCommand(
  subcommand: string,
  args: readonly string[],
  opts: TraderInvocationOpts,
): { result: unknown; raw: SphereRunResult } {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TRADER_TIMEOUT_MS;
  const fullArgs = [
    'trader',
    subcommand,
    ...args,
    '--tenant', opts.tenant,
    '--json',
    '--timeout', String(timeoutMs),
  ];
  // Add slack to the spawnSync timeout so sphere-cli's own timeout
  // fires first (cleaner error message than spawnSync's SIGKILL).
  const raw = runSphere(opts.cliPath, opts.cliHome, fullArgs, {
    timeoutMs: timeoutMs + 15_000,
  });
  if (raw.status !== 0) {
    // sphere-cli's `emitResult` prints the full ACP envelope to
    // stdout (including ok=false) AND sets exitCode=1. So a non-zero
    // exit doesn't mean the call had no useful output — the error
    // payload is on stdout. Include both streams in the message
    // (subprocess output here is not sensitive — these are
    // protocol-level error responses, not wallet material).
    throw new Error(
      `sphere trader ${subcommand} failed (status=${raw.status}, signal=${raw.signal}).\n` +
      `stderr: ${raw.stderr.slice(0, 800)}\n` +
      `stdout: ${raw.stdout.slice(0, 800)}`,
    );
  }
  // sphere-cli emits the parsed ACP envelope as JSON. Locate the
  // first `{` and last `}` (defensive against future log preambles).
  const start = raw.stdout.indexOf('{');
  const end = raw.stdout.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error(
      `sphere trader ${subcommand} --json: no JSON object in stdout. ` +
      `Got first 500 chars: ${raw.stdout.slice(0, 500)}`,
    );
  }
  let parsed: AcpResultEnvelope;
  try {
    parsed = JSON.parse(raw.stdout.slice(start, end + 1)) as AcpResultEnvelope;
  } catch (err) {
    throw new Error(
      `sphere trader ${subcommand}: failed to parse JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // The ACP error path lands as ok === false with error_code+message.
  // Surface those as test failures with the trader-side error code.
  if (parsed.ok === false) {
    throw new Error(
      `sphere trader ${subcommand}: trader rejected with ok=false. ` +
      `[${parsed.error_code ?? 'UNKNOWN'}] ${parsed.message ?? '(no message)'}`,
    );
  }
  // Successful path: AcpResultPayload has a `result` field with the
  // actual data. If `result` is unexpectedly absent (older trader
  // version?), fall back to the whole envelope so callers can
  // inspect it rather than getting a null.
  const result = parsed.result ?? parsed;
  return { result, raw };
}

// ---------------------------------------------------------------------------
// Typed wrappers around individual subcommands.
// ---------------------------------------------------------------------------

export interface SetStrategyOpts extends TraderInvocationOpts {
  /** Comma-joined trusted-escrow pubkeys (hex). */
  trustedEscrows?: string[];
  /** Maximum concurrent negotiations. */
  maxConcurrent?: number;
  /** Trader's rate strategy ('passive' | 'aggressive' etc — opaque to this helper). */
  rateStrategy?: string;
}

export function setStrategy(opts: SetStrategyOpts): unknown {
  const args: string[] = [];
  if (opts.rateStrategy !== undefined) args.push('--rate-strategy', opts.rateStrategy);
  if (opts.maxConcurrent !== undefined) args.push('--max-concurrent', String(opts.maxConcurrent));
  if (opts.trustedEscrows !== undefined && opts.trustedEscrows.length > 0) {
    args.push('--trusted-escrows', opts.trustedEscrows.join(','));
  }
  const { result } = runTraderCommand('set-strategy', args, opts);
  return result;
}

export interface CreateIntentOpts extends TraderInvocationOpts {
  direction: 'buy' | 'sell';
  baseAsset: string;
  quoteAsset: string;
  rateMin: bigint;
  rateMax: bigint;
  volumeMin: bigint;
  /** Total intent volume; matches the trader's ACP `volume_max` wire field. */
  volumeMax: bigint;
  expiryMs?: number;
}

export interface CreatedIntent {
  intentId: string;
}

export function createIntent(opts: CreateIntentOpts): CreatedIntent {
  const args = [
    '--direction', opts.direction,
    '--base', opts.baseAsset,
    '--quote', opts.quoteAsset,
    '--rate-min', opts.rateMin.toString(),
    '--rate-max', opts.rateMax.toString(),
    '--volume-min', opts.volumeMin.toString(),
    '--volume-max', opts.volumeMax.toString(),
  ];
  if (opts.expiryMs !== undefined) args.push('--expiry-ms', String(opts.expiryMs));
  const { result } = runTraderCommand('create-intent', args, opts);
  if (typeof result !== 'object' || result === null) {
    throw new Error(`create-intent: result is not an object. Got: ${JSON.stringify(result)}`);
  }
  const intentId = (result as Record<string, unknown>)['intent_id'];
  if (typeof intentId !== 'string') {
    throw new Error(`create-intent: missing intent_id in result. Got: ${JSON.stringify(result)}`);
  }
  return { intentId };
}

export interface CancelIntentOpts extends TraderInvocationOpts {
  intentId: string;
}

export function cancelIntent(opts: CancelIntentOpts): unknown {
  const { result } = runTraderCommand('cancel-intent', ['--intent-id', opts.intentId], opts);
  return result;
}

export interface IntentSummary {
  readonly intent_id: string;
  readonly state: string;
  readonly direction: string;
  readonly base_asset: string;
  readonly quote_asset: string;
  readonly volume_filled?: string;
  readonly volume_total?: string;
}

export function listIntents(opts: TraderInvocationOpts): readonly IntentSummary[] {
  const { result } = runTraderCommand('list-intents', [], opts);
  // Trader returns either { intents: [...] } or just [...] depending on version.
  if (Array.isArray(result)) return result as IntentSummary[];
  if (typeof result === 'object' && result !== null) {
    const arr = (result as Record<string, unknown>)['intents'];
    if (Array.isArray(arr)) return arr as IntentSummary[];
  }
  throw new Error(`list-intents: response not in expected shape. Got: ${JSON.stringify(result)}`);
}

export interface DealSummary {
  readonly deal_id: string;
  readonly state: string;
  readonly counterparty?: string;
  readonly volume?: string;
  readonly rate?: string;
  readonly created_at?: number;
  readonly updated_at?: number;
}

export function listDeals(opts: TraderInvocationOpts): readonly DealSummary[] {
  const { result } = runTraderCommand('list-deals', [], opts);
  if (Array.isArray(result)) return result as DealSummary[];
  if (typeof result === 'object' && result !== null) {
    const arr = (result as Record<string, unknown>)['deals'] ?? (result as Record<string, unknown>)['swaps'];
    if (Array.isArray(arr)) return arr as DealSummary[];
  }
  throw new Error(`list-deals: response not in expected shape. Got: ${JSON.stringify(result)}`);
}

export interface PortfolioBalance {
  readonly asset: string;
  readonly amount: string;
}

export function portfolio(opts: TraderInvocationOpts): readonly PortfolioBalance[] {
  const { result } = runTraderCommand('portfolio', [], opts);
  // Portfolio shape: either an array of {asset, amount} or a record
  // {asset: amount}. Tolerate both.
  if (Array.isArray(result)) return result as PortfolioBalance[];
  if (typeof result === 'object' && result !== null) {
    const r = result as Record<string, unknown>;
    const balances = r['balances'] ?? r['portfolio'];
    if (Array.isArray(balances)) return balances as PortfolioBalance[];
    // Record form: { UCT: '100', USDU: '50' }
    return Object.entries(r).map(([asset, amount]) => ({
      asset,
      amount: String(amount),
    }));
  }
  throw new Error(`portfolio: response not in expected shape. Got: ${JSON.stringify(result)}`);
}

export interface TraderStatus {
  readonly tenant_pubkey?: string;
  readonly active_intents?: number;
  readonly active_deals?: number;
  readonly version?: string;
  readonly uptime_ms?: number;
}

export function status(opts: TraderInvocationOpts): TraderStatus {
  const { result } = runTraderCommand('status', [], opts);
  if (typeof result !== 'object' || result === null) {
    throw new Error(`status: response not an object. Got: ${JSON.stringify(result)}`);
  }
  return result as TraderStatus;
}

/**
 * Poll list-deals until a deal in `targetState` appears, or budget
 * elapses. Returns the matching deal, or throws on timeout.
 *
 * Polls every 3s by default — settlement on testnet involves the
 * counterparty's negotiation, escrow's quote, and aggregator round-
 * trips, so polls more frequent than that just thrash the trader.
 */
export async function waitForDealInState(
  opts: TraderInvocationOpts & {
    targetState: string;
    timeoutMs?: number;
    intervalMs?: number;
  },
): Promise<DealSummary> {
  const deadline = Date.now() + (opts.timeoutMs ?? 600_000);
  const interval = opts.intervalMs ?? 3_000;
  let lastSeen: readonly DealSummary[] = [];
  while (Date.now() < deadline) {
    try {
      lastSeen = listDeals(opts);
      const match = lastSeen.find((d) => d.state === opts.targetState);
      if (match) return match;
    } catch {
      // Transient error (relay flake, etc.) — keep polling.
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  const summary = lastSeen.length > 0
    ? `last seen ${lastSeen.length} deal(s) in states [${lastSeen.map((d) => d.state).join(', ')}]`
    : 'no deals visible';
  throw new Error(
    `waitForDealInState: tenant ${opts.tenant} did not reach state="${opts.targetState}" ` +
    `within ${opts.timeoutMs ?? 600_000}ms. ${summary}.`,
  );
}
