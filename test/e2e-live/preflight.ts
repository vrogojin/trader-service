/**
 * Preflight infrastructure check for the trader-service e2e-live suite.
 *
 * Wraps `@unicitylabs/infra-probe` to verify that every Unicity Network
 * service the live tests depend on (Nostr relay, L3 Aggregator, IPFS
 * gateway, L1 Fulcrum, Market API) is reachable and functional BEFORE
 * booting the host-manager binary or spawning any tenant containers.
 *
 * Failure modes the probe catches that the e2e suite would otherwise hit
 * as opaque timeouts deep into a run:
 *   - Nostr relay silently dropping kind:1059 publishes — controller's
 *     HMCP DM never reaches the manager; we'd time out on `hm.spawn`.
 *   - Aggregator API key rejection / rate-limit — Sphere.init hangs
 *     during nametag registration.
 *   - IPFS gateway 5xx — token-create races during nametag mint.
 *   - Fulcrum chain tip stale — L1-side identity publishes never resolve.
 *   - Market API down — traders post intents but no peer can find them.
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
