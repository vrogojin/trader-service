/**
 * trader-ctl-driver — subprocess wrapper around `bin/trader-ctl`.
 *
 * Implements `RunTraderCtl` from contracts.ts. This module is the single
 * place in the e2e-live harness that knows how to invoke the canonical
 * controller CLI; everything above it (scenario-helpers, test files) talks
 * to a trader through this driver only, so that any future changes to the
 * CLI surface (commands, flags, env-var contract) land here once.
 *
 * Design notes:
 *  - We use `node:child_process.execFile` (NOT `exec`) so the `bin/trader-ctl`
 *    path and the user-supplied `args` are passed as discrete argv elements,
 *    bypassing shell parsing.
 *  - A non-zero exit code is NORMAL for trader-ctl (e.g. command rejected,
 *    timeout, transport error). The driver returns those as `exitCode > 0`
 *    without throwing — the caller decides whether stderr or non-zero exit
 *    is fatal for its scenario.
 *  - The driver throws ONLY on subprocess launch failure (e.g. ENOENT, EACCES
 *    on `bin/trader-ctl`). This matches the contract's "throws only on
 *    launch failure" promise.
 *  - We always pass `--tenant` (it's required by the CLI). Optional flags
 *    (`--json`, `--timeout`, `--data-dir`, `--tokens-dir`) are appended only
 *    when set, so the driver doesn't perturb defaults the CLI itself owns
 *    (e.g. the `UNICITY_DATA_DIR` env var the user may have set).
 *  - `dataDir` / `tokensDir` are passed as env vars (not flags) because
 *    sphere-cli/sphere-sdk read those env vars unconditionally; passing them
 *    via env keeps a single config path inside the child.
 */

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { TraderCtlOptions, TraderCtlResult } from './contracts.js';

/**
 * Floor for `--timeout` enforced by the tenant's command-registry. The CLI
 * itself rounds sub-floor values up with a stderr warning, but the driver
 * pre-validates so callers see a fast TypeError-shaped failure instead of a
 * fuzzy CLI warning + accidental re-rounding.
 */
export const MIN_TIMEOUT_MS = 100;

/**
 * Default wall-clock budget for the subprocess as a whole. The CLI's own
 * `--timeout` governs ACP-level request/response timing; this is the outer
 * safety net so a hung CLI process doesn't hold a vitest worker forever.
 */
const DEFAULT_SUBPROCESS_TIMEOUT_MS = 60_000;

/**
 * Generous max-buffer for stdout/stderr — `LIST_INTENTS` against a busy
 * trader can dump 100s of records when --json is set.
 */
const MAX_BUFFER_BYTES = 8 * 1024 * 1024; // 8 MiB

/**
 * Resolved absolute path to `bin/trader-ctl`. Computed once at module load
 * so the test runner's CWD has no effect on what gets invoked.
 */
const TRADER_CTL_BIN = fileURLToPath(new URL('../../../bin/trader-ctl', import.meta.url));

interface ExecResult {
  /**
   * 0 on success; positive on a clean non-zero exit; -1 if we couldn't
   * read an exit code at all (process killed by signal). The contract
   * exposes a `number`, so we coerce signal-kills to a sentinel.
   */
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Set when execFile failed BEFORE the child produced output (ENOENT etc). */
  spawnError?: NodeJS.ErrnoException;
}

function runChild(argv: ReadonlyArray<string>, env: NodeJS.ProcessEnv): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      TRADER_CTL_BIN,
      [...argv],
      {
        env,
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: DEFAULT_SUBPROCESS_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        // Inherit stdin (not used — CLI is non-interactive), capture stdout & stderr.
        windowsHide: true,
      },
      (err, stdoutBuf: string | Buffer, stderrBuf: string | Buffer) => {
        const stdout =
          typeof stdoutBuf === 'string' ? stdoutBuf : Buffer.isBuffer(stdoutBuf) ? stdoutBuf.toString('utf8') : '';
        const stderr =
          typeof stderrBuf === 'string' ? stderrBuf : Buffer.isBuffer(stderrBuf) ? stderrBuf.toString('utf8') : '';

        if (err === null) {
          resolve({ exitCode: 0, stdout, stderr });
          return;
        }

        // execFile's callback err carries one of:
        //   - errno-style code on spawn failure (e.g. err.code === 'ENOENT')
        //   - numeric exit code on non-zero exit (err.code === <number>)
        //   - signal info when killed (err.signal set, err.killed true)
        const errno = err as NodeJS.ErrnoException;
        const codeField: unknown = errno.code;

        // Spawn failure: errno is a string ('ENOENT', 'EACCES', etc.)
        if (typeof codeField === 'string') {
          resolve({ exitCode: -1, stdout, stderr, spawnError: errno });
          return;
        }

        // Killed by signal (timeout firing, SIGKILL): no exit code, surface as -1.
        if (typeof codeField !== 'number') {
          resolve({ exitCode: -1, stdout, stderr });
          return;
        }

        resolve({ exitCode: codeField, stdout, stderr });
      },
    );
  });
}

/**
 * Build the argv array for the CLI from the user's command + args + opts.
 *
 * Always-present:
 *   trader-ctl <command> [...args] --tenant <tenant>
 *
 * Optional (appended in deterministic order so tests can match exactly):
 *   --json
 *   --timeout <ms>
 *   --data-dir <path>
 *   --tokens-dir <path>
 *
 * Note: `dataDir` and `tokensDir` are ALSO mirrored into env vars below.
 * The CLI prefers explicit flags over env vars, so when both are set the
 * flag wins — which is exactly what we want for test isolation.
 */
function buildArgv(
  command: string,
  args: ReadonlyArray<string>,
  opts: TraderCtlOptions,
): string[] {
  const argv: string[] = [command, ...args, '--tenant', opts.tenant];
  if (opts.json === true) argv.push('--json');
  if (opts.timeoutMs !== undefined) argv.push('--timeout', String(opts.timeoutMs));
  if (opts.dataDir !== undefined) argv.push('--data-dir', opts.dataDir);
  if (opts.tokensDir !== undefined) argv.push('--tokens-dir', opts.tokensDir);
  return argv;
}

function buildEnv(opts: TraderCtlOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (opts.dataDir !== undefined) env['UNICITY_DATA_DIR'] = opts.dataDir;
  if (opts.tokensDir !== undefined) env['UNICITY_TOKENS_DIR'] = opts.tokensDir;
  return env;
}

/**
 * Drive `bin/trader-ctl` as a subprocess. See module-level doc-comment for
 * semantics; see contracts.ts for the public type signature.
 */
export async function runTraderCtl(
  command: string,
  args: ReadonlyArray<string>,
  opts: TraderCtlOptions,
): Promise<TraderCtlResult> {
  if (typeof command !== 'string' || command === '') {
    throw new TypeError('runTraderCtl: command must be a non-empty string');
  }
  if (typeof opts.tenant !== 'string' || opts.tenant === '') {
    throw new TypeError('runTraderCtl: opts.tenant must be a non-empty string');
  }
  if (opts.timeoutMs !== undefined) {
    if (!Number.isFinite(opts.timeoutMs) || !Number.isInteger(opts.timeoutMs) || opts.timeoutMs < MIN_TIMEOUT_MS) {
      throw new RangeError(
        `runTraderCtl: opts.timeoutMs must be an integer >= minimum 100ms (got ${String(opts.timeoutMs)})`,
      );
    }
  }

  const argv = buildArgv(command, args, opts);
  const env = buildEnv(opts);

  let child: ExecResult;
  try {
    child = await runChild(argv, env);
  } catch (err) {
    // runChild never rejects — but if execFile is monkey-patched in a test
    // and throws synchronously, surface it as a launch failure.
    throw new Error(
      `runTraderCtl: failed to launch ${TRADER_CTL_BIN}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  if (child.spawnError !== undefined) {
    throw new Error(
      `runTraderCtl: failed to launch ${TRADER_CTL_BIN}: ${child.spawnError.message}`,
      { cause: child.spawnError },
    );
  }

  let output: unknown = child.stdout;
  if (opts.json === true && child.exitCode === 0) {
    try {
      output = JSON.parse(child.stdout);
    } catch {
      throw new Error(`trader-ctl returned non-JSON on success: ${child.stdout}`);
    }
  }

  return {
    exitCode: child.exitCode,
    output,
    stderr: child.stderr,
  };
}
