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

  const network = (process.env['TRADER_E2E_PREFLIGHT_NETWORK'] ?? 'testnet') as
    | 'testnet'
    | 'mainnet'
    | 'dev';
  const timeoutMs = Number(process.env['TRADER_E2E_PREFLIGHT_TIMEOUT_MS'] ?? '30000');
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
