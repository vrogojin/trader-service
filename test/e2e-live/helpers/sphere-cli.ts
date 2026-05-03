/**
 * Helper: locate, probe, and invoke the `sphere-cli` binary against a
 * live host-manager.
 *
 * sphere-cli lives in its own repo (github.com/unicity-sphere/sphere-cli).
 * This helper resolves the binary at runtime via `SPHERE_CLI_BIN`
 * (default: `/home/vrogojin/sphere-cli-work/sphere-cli/bin/sphere.mjs`).
 * The probe runs `sphere --help` with a 10s budget and reports the exit
 * code + stderr so an upstream regression can be diagnosed without
 * reading container logs.
 *
 * Tests use `probeSphereCli()` once in `beforeAll` and gate the suite
 * with `describe.skipIf(!probe.ok)` if sphere-cli isn't runnable.
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_CLI_PATH = '/home/vrogojin/sphere-cli-work/sphere-cli/bin/sphere.mjs';

export type SphereCliProbe =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: string };

export function probeSphereCli(): SphereCliProbe {
  const cliPath = process.env['SPHERE_CLI_BIN']?.trim() || DEFAULT_CLI_PATH;
  if (!existsSync(cliPath)) {
    return {
      ok: false,
      reason: `sphere-cli binary not found at ${cliPath}. ` +
        `Set SPHERE_CLI_BIN to override, or build sphere-cli ` +
        `(github.com/unicity-sphere/sphere-cli).`,
    };
  }
  const r = spawnSync('node', [cliPath, '--help'], {
    encoding: 'utf8',
    timeout: 10_000,
    killSignal: 'SIGKILL',
  });
  if (r.error) {
    return { ok: false, reason: `sphere-cli launch error: ${r.error.message}` };
  }
  if (r.status !== 0) {
    const stderr = (r.stderr || '').slice(0, 500).trim();
    return {
      ok: false,
      reason: `sphere-cli --help exited ${r.status}. stderr: ${stderr || '(empty)'}`,
    };
  }
  return { ok: true, path: cliPath };
}

/**
 * Create an isolated CWD with a pre-seeded `.sphere-cli/config.json`.
 * sphere-cli reads its config relative to cwd, so spawning the CLI with
 * `cwd: home` isolates each test's wallet directory.
 *
 * Caller MUST eventually `rmSync(home, { recursive: true })` — the
 * wallet contains a testnet mnemonic; leaving it on disk after the run
 * is a leak even on testnet.
 */
export function createSphereCliEnv(label: string): { home: string } {
  const safeLabel = label.replace(/[^a-zA-Z0-9-_]/g, '-').slice(0, 24);
  const home = mkdtempSync(join(tmpdir(), `trader-e2e-sphere-${safeLabel}-`));
  const cfgDir = join(home, '.sphere-cli');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(
    join(cfgDir, 'config.json'),
    JSON.stringify({
      network: 'testnet',
      dataDir: cfgDir,
      tokensDir: join(cfgDir, 'tokens'),
    }),
    'utf8',
  );
  return { home };
}

export interface SphereRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
}

/**
 * Invoke the sphere CLI with `cwd` set to a SphereCliEnv home so the
 * wallet/config directory is isolated. Returns stdout/stderr/status.
 *
 * Non-zero exit codes are NORMAL for sphere-cli (e.g. timeout, hm.error
 * response, manager rejected). Caller decides whether to assert or
 * inspect.
 *
 * `extraEnv` overlays on top of the minimal env we forward. The default
 * is intentionally minimal (PATH + UNICITY_API_KEY if set) — we don't
 * leak the parent's env into the CLI's logs.
 */
export function runSphere(
  cliPath: string,
  cwd: string,
  args: readonly string[],
  opts?: { timeoutMs?: number; extraEnv?: Record<string, string> },
): SphereRunResult {
  const r: SpawnSyncReturns<string> = spawnSync('node', [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: opts?.timeoutMs ?? 180_000,
    killSignal: 'SIGKILL',
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: process.env['HOME'] ?? cwd,
      ...(process.env['UNICITY_API_KEY'] ? { UNICITY_API_KEY: process.env['UNICITY_API_KEY'] } : {}),
      CI: '1',
      FORCE_COLOR: '0',
      ...(opts?.extraEnv ?? {}),
    },
  });
  return {
    stdout: r.stdout?.toString() ?? '',
    stderr: r.stderr?.toString() ?? '',
    status: r.status,
    signal: r.signal,
  };
}

/**
 * Bootstrap a fresh wallet via `sphere wallet init --network testnet`.
 * Captures the chainPubkey and directAddress from the JSON identity
 * block emitted to stdout. Used to set up a controller wallet for HMA
 * tests.
 *
 * Timeout: 240s — wallet creation does an aggregator round-trip (nametag
 * mint) plus IPFS publish; typical happy path is ~60-90s but we give
 * generous slack for a slow relay.
 */
export function bootstrapControllerWallet(cliPath: string, home: string): {
  pubkey: string;
  directAddress: string;
} {
  const init = runSphere(cliPath, home, ['wallet', 'init', '--network', 'testnet'], {
    timeoutMs: 240_000,
  });
  if (init.status !== 0) {
    throw new Error(
      `sphere wallet init failed (status=${init.status}, signal=${init.signal}). ` +
      `stderr (first 500): ${init.stderr.slice(0, 500)}\n` +
      `stdout (last 500): ${init.stdout.slice(-500)}`,
    );
  }
  // Lenient regex matching either chainPubkey or directAddress JSON fields.
  const pkMatch = init.stdout.match(/"chainPubkey":\s*"([0-9a-fA-F]{64,130})"/);
  const addrMatch = init.stdout.match(/"directAddress":\s*"(DIRECT:\/\/[0-9a-fA-F]+)"/);
  if (!pkMatch || !pkMatch[1]) {
    throw new Error(`chainPubkey not found in sphere wallet init output:\n${init.stdout.slice(-1500)}`);
  }
  return {
    pubkey: pkMatch[1],
    directAddress: addrMatch?.[1] ?? `DIRECT://${pkMatch[1]}`,
  };
}
