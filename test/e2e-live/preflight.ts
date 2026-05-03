/**
 * Preflight infrastructure check for the e2e-live suite.
 *
 * Wraps `@unicitylabs/infra-probe` to verify that every Unicity Network
 * service the e2e-live tests depend on (Nostr relay, L3 Aggregator, IPFS
 * gateway, L1 Fulcrum, Market API) is reachable and functional BEFORE
 * spawning any Docker containers or burning faucet quota.
 *
 * Failure modes the probe catches that the e2e suite would otherwise hit
 * as opaque timeouts 5-15 minutes deep into a run:
 *   - Nostr relay silently dropping kind:30078 / kind:1059 publishes
 *     (the symptom of the 2026-04-30 outage that motivated this gate)
 *   - Aggregator API key rejection / rate-limit
 *   - IPFS gateway 5xx
 *   - Fulcrum chain tip stale (L1 stuck) → token-create races
 *   - Market API down → no intent discovery at all
 *
 * Environment knobs:
 *   TRADER_E2E_SKIP_PREFLIGHT=1     — bypass the gate entirely (escape hatch)
 *   TRADER_E2E_PREFLIGHT_STRICT=1   — also fail on `degraded` (default: warn-only)
 *   TRADER_E2E_PREFLIGHT_NETWORK    — override the network (default: testnet)
 *   TRADER_E2E_PREFLIGHT_TIMEOUT_MS — per-probe ceiling (default: 30000)
 */

import { runProbes } from '@unicitylabs/infra-probe';

interface Check {
  readonly name: string;
  readonly status: 'pass' | 'warn' | 'fail';
  readonly latencyMs: number;
  readonly message: string;
}

interface Service {
  readonly service: string;
  readonly endpoint: string;
  readonly status: 'healthy' | 'degraded' | 'unreachable' | 'error';
  readonly latencyMs: number;
  readonly checks: Check[];
  readonly error?: string;
}

interface Report {
  readonly services: Service[];
  readonly summary: {
    readonly total: number;
    readonly healthy: number;
    readonly degraded: number;
    readonly unreachable: number;
  };
}

function statusIcon(status: Service['status']): string {
  if (status === 'healthy') return '✓';
  if (status === 'degraded') return '⚠';
  return '✗';
}

function checkIcon(status: Check['status']): string {
  if (status === 'pass') return '✓';
  if (status === 'warn') return '⚠';
  return '✗';
}

function logReport(report: Report): void {
  for (const svc of report.services) {
    console.log(
      `[preflight] ${statusIcon(svc.status)} ${svc.service.padEnd(11)} ${svc.endpoint} (${svc.status}, ${svc.latencyMs}ms)`,
    );
    if (svc.error) {
      console.log(`[preflight]     error: ${svc.error}`);
    }
    for (const c of svc.checks) {
      const icon = checkIcon(c.status);
      console.log(`[preflight]     ${icon} ${c.name.padEnd(20)} ${c.latencyMs}ms  ${c.message}`);
    }
  }
  const { total, healthy, degraded, unreachable } = report.summary;
  console.log(
    `[preflight] summary: ${healthy}/${total} healthy, ${degraded} degraded, ${unreachable} unreachable`,
  );
}

export async function runPreflight(): Promise<void> {
  if (process.env['TRADER_E2E_SKIP_PREFLIGHT'] === '1') {
    console.log('[preflight] SKIPPED (TRADER_E2E_SKIP_PREFLIGHT=1)');
    return;
  }

  // Validate network enum locally rather than blind-cast. The upstream
  // `runProbes` would also throw on an unknown network, but tightening here
  // makes the contract local and immune to upstream silent enum extensions.
  const VALID_NETWORKS = ['testnet', 'mainnet', 'dev'] as const;
  type Network = (typeof VALID_NETWORKS)[number];
  const rawNetwork = process.env['TRADER_E2E_PREFLIGHT_NETWORK'] ?? 'testnet';
  if (!(VALID_NETWORKS as readonly string[]).includes(rawNetwork)) {
    throw new Error(
      `Preflight: invalid TRADER_E2E_PREFLIGHT_NETWORK="${rawNetwork}". ` +
        `Must be one of: ${VALID_NETWORKS.join(', ')}.`,
    );
  }
  const network = rawNetwork as Network;

  // Validate timeoutMs. `Number('abc')` returns NaN; `Number('-1')` returns -1;
  // `Number('0')` returns 0. All of these would propagate to the upstream
  // probe's setTimeout and either fire immediately (NaN coerces to 1ms in Node)
  // or never fire (0 = no timeout in setTimeout's contract). Both produce
  // misleading "preflight failed" results from a typo. Reject loudly.
  const rawTimeoutMs = process.env['TRADER_E2E_PREFLIGHT_TIMEOUT_MS'] ?? '30000';
  const timeoutMs = Number(rawTimeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `Preflight: invalid TRADER_E2E_PREFLIGHT_TIMEOUT_MS="${rawTimeoutMs}". ` +
        `Must be a positive finite number (milliseconds).`,
    );
  }

  const strict = process.env['TRADER_E2E_PREFLIGHT_STRICT'] === '1';

  console.log(
    `[preflight] probing ${network} infrastructure (timeout=${timeoutMs}ms, strict=${strict})...`,
  );
  const startedAt = Date.now();

  const report = (await runProbes({ network, timeoutMs })) as Report;
  const elapsed = Date.now() - startedAt;

  logReport(report);
  console.log(`[preflight] completed in ${elapsed}ms`);

  const { unreachable, degraded } = report.summary;
  const downServices = report.services
    .filter((s) => s.status === 'unreachable' || s.status === 'error')
    .map((s) => `${s.service}=${s.status}`);
  const slowServices = report.services
    .filter((s) => s.status === 'degraded')
    .map((s) => `${s.service}=${s.status}`);

  if (unreachable > 0) {
    throw new Error(
      `Preflight failed: ${unreachable} service(s) unreachable [${downServices.join(', ')}]. ` +
        `Set TRADER_E2E_SKIP_PREFLIGHT=1 to bypass (not recommended — tests will likely hang).`,
    );
  }

  if (degraded > 0) {
    if (strict) {
      throw new Error(
        `Preflight failed (strict mode): ${degraded} service(s) degraded [${slowServices.join(', ')}]. ` +
          `Unset TRADER_E2E_PREFLIGHT_STRICT or set TRADER_E2E_SKIP_PREFLIGHT=1 to bypass.`,
      );
    }
    console.warn(
      `[preflight] WARNING: ${degraded} service(s) degraded [${slowServices.join(', ')}] — ` +
        `tests may be slow or intermittently fail. Set TRADER_E2E_PREFLIGHT_STRICT=1 to fail-fast on this.`,
    );
  }
}
