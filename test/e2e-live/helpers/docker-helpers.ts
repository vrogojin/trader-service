/**
 * docker-helpers — daemon lifecycle wrappers for e2e-live tests.
 *
 * Implements the contract pinned in `./contracts.ts`. All daemon interaction
 * goes through `execFile('docker', argv, ...)` — never through a shell — so
 * caller-supplied labels and env values cannot inject extra arguments. Inputs
 * that would shape the argv (label, bind-mount host paths) are validated up
 * front and rejected on shape violations.
 *
 * Exports are wired to the `RunContainer`, `StopContainer`, `RemoveContainer`,
 * `GetContainerLogs`, and `WaitForContainerRunning` types in contracts.ts.
 *
 * The module exposes a private hook (`__setExecFileForTests`) for unit tests
 * to substitute the execFile implementation. Production callers never touch
 * it — vitest mocks via vi.mock would also work but the explicit hook keeps
 * argv-assertions trivial without ESM mocking gymnastics.
 */

import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute } from 'node:path';

import type {
  DockerContainer,
  DockerRunOptions,
  GetContainerLogs,
  RemoveContainer,
  RunContainer,
  StopContainer,
  WaitForContainerRunning,
} from './contracts.js';

// ----------------------------------------------------------------------------
// Errors
// ----------------------------------------------------------------------------

/**
 * Failures interacting with the Docker daemon — both validation rejections
 * (before any process starts) and propagated daemon errors.
 *
 * Self-contained on purpose: the helpers live under test/ and pulling
 * src/shared/errors.ts here would couple test fixtures to production code.
 */
export class DockerError extends Error {
  public readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'DockerError';
    this.cause = cause;
  }
}

// ----------------------------------------------------------------------------
// execFile injection (private — for tests)
// ----------------------------------------------------------------------------

interface ExecFileOpts {
  /** Maximum wall-clock time for the child process, ms. */
  timeoutMs?: number;
}

type ExecFileFn = (
  file: string,
  args: ReadonlyArray<string>,
  opts?: ExecFileOpts,
) => Promise<{ stdout: string; stderr: string }>;

const defaultExecFile: ExecFileFn = (() => {
  const promised = promisify(nodeExecFile);
  return async (file, args, opts) => {
    // execFile accepts a readonly array but its types want string[]; copy to
    // satisfy the signature without mutating the caller's array.
    const out = await promised(file, [...args], {
      timeout: opts?.timeoutMs,
      // 4 MiB cap per stream — enough for log dumps, prevents memory blowup
      // from a stuck-in-tight-loop container.
      maxBuffer: 4 * 1024 * 1024,
    });
    return { stdout: out.stdout.toString(), stderr: out.stderr.toString() };
  };
})();

let execFileImpl: ExecFileFn = defaultExecFile;

/**
 * Test-only override. Pass `null` to restore the real execFile. Not exported
 * from the public surface — tests import it via the file path directly.
 */
export function __setExecFileForTests(impl: ExecFileFn | null): void {
  execFileImpl = impl ?? defaultExecFile;
}

// ----------------------------------------------------------------------------
// Validation
// ----------------------------------------------------------------------------

/** Allowlist for caller-supplied labels — preserves docker name rules. */
const LABEL_RE = /^[a-zA-Z0-9_.-]{1,64}$/;

function assertValidLabel(label: string): void {
  if (!LABEL_RE.test(label)) {
    throw new DockerError(
      `Invalid label "${label}": must match ${LABEL_RE.source} (alphanumeric, _.-, 1-64 chars)`,
    );
  }
}

function assertAbsoluteHostPath(hostPath: string): void {
  if (!isAbsolute(hostPath)) {
    throw new DockerError(
      `Bind-mount host path must be absolute, got "${hostPath}". ` +
        `Relative bind mounts are a Compose-only feature; the daemon API requires absolute paths.`,
    );
  }
}

// ----------------------------------------------------------------------------
// Defaults
// ----------------------------------------------------------------------------

const DEFAULT_MEMORY_MB = 256;
const DEFAULT_PIDS_LIMIT = 128;
const DEFAULT_LOG_LINES = 200;
const DEFAULT_START_TIMEOUT_MS = 30_000;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 250;

// ----------------------------------------------------------------------------
// runContainer
// ----------------------------------------------------------------------------

/** Build the argv passed to `docker run -d ...`. Pure for testability. */
export function buildRunArgs(opts: DockerRunOptions, name: string): string[] {
  const args: string[] = ['run', '-d', '--name', name];

  // Resources — always set, even when caller omits, so partner-demo containers
  // are bounded by default.
  const memMb = opts.resources?.memoryMb ?? DEFAULT_MEMORY_MB;
  const pids = opts.resources?.pidsLimit ?? DEFAULT_PIDS_LIMIT;
  args.push(`--memory=${memMb}m`);
  args.push(`--pids-limit=${pids}`);

  // Network mode — default bridge.
  args.push(`--network=${opts.network ?? 'bridge'}`);

  // Env vars — explicit `--env KEY=VALUE` pairs (NOT --env-file; we want them
  // visible in the daemon log line for partner-demo postmortems).
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      args.push('--env', `${k}=${v}`);
    }
  }

  // Bind mounts — host path MUST be absolute (validated by caller).
  if (opts.binds) {
    for (const bind of opts.binds) {
      const spec = `${bind.host}:${bind.container}${bind.readonly ? ':ro' : ''}`;
      args.push('-v', spec);
    }
  }

  // Image is positional and goes LAST so any --flag interpretation stops here.
  args.push(opts.image);

  return args;
}

function buildName(label: string | undefined): string {
  // Docker container names: [a-zA-Z0-9][a-zA-Z0-9_.-]+
  // Label has already been validated against LABEL_RE if provided.
  const suffix = Math.random().toString(36).slice(2, 8);
  const stem = label ? `trader-e2e-${label}` : 'trader-e2e';
  return `${stem}-${suffix}`;
}

export const runContainer: RunContainer = async (
  opts: DockerRunOptions,
): Promise<DockerContainer> => {
  if (!opts.image || typeof opts.image !== 'string') {
    throw new DockerError('runContainer: opts.image is required');
  }
  if (opts.label !== undefined) {
    assertValidLabel(opts.label);
  }
  if (opts.binds) {
    for (const bind of opts.binds) {
      assertAbsoluteHostPath(bind.host);
    }
  }

  const name = buildName(opts.label);
  const args = buildRunArgs(opts, name);
  const createdAt = new Date();
  const startTimeoutMs = opts.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;

  let stdout: string;
  try {
    const result = await execFileImpl('docker', args, { timeoutMs: startTimeoutMs });
    stdout = result.stdout;
  } catch (err) {
    throw new DockerError(
      `docker run failed for image "${opts.image}": ${errMsg(err)}`,
      err,
    );
  }

  const id = stdout.trim();
  if (!/^[0-9a-f]{12,}$/.test(id)) {
    throw new DockerError(
      `docker run did not return a container ID; got: ${JSON.stringify(stdout)}`,
    );
  }

  return { id, name, createdAt };
};

// ----------------------------------------------------------------------------
// stopContainer
// ----------------------------------------------------------------------------

export const stopContainer: StopContainer = async (
  id: string,
  timeoutMs: number = DEFAULT_STOP_TIMEOUT_MS,
): Promise<void> => {
  assertValidContainerId(id);
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));

  try {
    await execFileImpl('docker', ['stop', `--time=${seconds}`, id]);
    return;
  } catch (stopErr) {
    // Idempotent: if the container is already gone, treat as success.
    const msg = errMsg(stopErr).toLowerCase();
    if (msg.includes('no such container')) {
      return;
    }

    // Fall back to SIGKILL.
    try {
      await execFileImpl('docker', ['kill', id]);
      return;
    } catch (killErr) {
      const killMsg = errMsg(killErr).toLowerCase();
      if (killMsg.includes('no such container') || killMsg.includes('is not running')) {
        return;
      }
      throw new DockerError(
        `Failed to stop container ${id}: stop=${errMsg(stopErr)}, kill=${errMsg(killErr)}`,
        killErr,
      );
    }
  }
};

// ----------------------------------------------------------------------------
// removeContainer
// ----------------------------------------------------------------------------

export const removeContainer: RemoveContainer = async (id: string): Promise<void> => {
  assertValidContainerId(id);

  try {
    await execFileImpl('docker', ['rm', id]);
  } catch (err) {
    const msg = errMsg(err);
    const lower = msg.toLowerCase();

    // Per contract: `docker rm` on a still-running container should throw
    // with a clear, contract-stable message. We DO NOT silently force-remove.
    if (
      lower.includes('cannot remove') ||
      lower.includes('is running') ||
      lower.includes('cannot kill') ||
      lower.includes('container is running')
    ) {
      throw new DockerError(
        `Cannot remove container ${id}: still running. Stop it first.`,
        err,
      );
    }

    // Already-gone container is not an error — removal is the desired state.
    if (lower.includes('no such container')) {
      return;
    }

    throw new DockerError(`docker rm failed for ${id}: ${msg}`, err);
  }
};

// ----------------------------------------------------------------------------
// getContainerLogs
// ----------------------------------------------------------------------------

export const getContainerLogs: GetContainerLogs = async (
  id: string,
  lines: number = DEFAULT_LOG_LINES,
): Promise<string> => {
  assertValidContainerId(id);
  if (!Number.isFinite(lines) || lines < 0) {
    throw new DockerError(`getContainerLogs: lines must be a non-negative integer (got ${lines})`);
  }

  try {
    // `docker logs` writes the container's stdout to our stdout and the
    // container's stderr to our stderr. Concatenate both streams so callers
    // get the full diagnostic picture (matches `2>&1` shell idiom without a
    // shell).
    const result = await execFileImpl('docker', ['logs', `--tail=${lines}`, id]);
    return `${result.stdout}${result.stderr}`;
  } catch (err) {
    throw new DockerError(`docker logs failed for ${id}: ${errMsg(err)}`, err);
  }
};

// ----------------------------------------------------------------------------
// waitForContainerRunning
// ----------------------------------------------------------------------------

export const waitForContainerRunning: WaitForContainerRunning = async (
  id: string,
  timeoutMs: number = DEFAULT_WAIT_TIMEOUT_MS,
): Promise<boolean> => {
  assertValidContainerId(id);
  const deadline = Date.now() + timeoutMs;

  // First poll runs immediately so containers that started instantly don't
  // wait the full interval.
  for (;;) {
    const running = await isRunning(id);
    if (running) return true;
    if (Date.now() >= deadline) return false;
    await sleep(POLL_INTERVAL_MS);
  }
};

/**
 * Single inspect call. Exposed for ad-hoc use; tests rely on argv shape.
 *
 * Returns true iff `docker inspect --format='{{.State.Running}}'` prints
 * "true". Any other output (including missing-container errors) yields false
 * so the caller can decide how to react via timeout.
 */
export async function inspectContainer(id: string): Promise<boolean> {
  return isRunning(id);
}

/**
 * List running container IDs (12-char hex prefix form) for containers whose
 * name matches `docker ps --filter name=<prefix>`. IDs (not names) are
 * returned because every downstream consumer (`getContainerLogs`,
 * `stopContainer`, `removeContainer`) validates the input through
 * `assertValidContainerId`, which enforces a hex-only regex. Names would be
 * rejected — every log fetch in the diagnostic-dump path used to silently
 * throw and get swallowed.
 *
 * @param namePrefix - Prefix to match against container names.
 * @returns Array of container IDs (oldest first).
 */
export async function listContainersByNamePrefix(
  namePrefix: string,
): Promise<string[]> {
  if (typeof namePrefix !== 'string' || namePrefix.length === 0) {
    throw new DockerError('listContainersByNamePrefix: namePrefix must be a non-empty string');
  }
  // Docker name rule: must start with [a-zA-Z0-9] and may contain `._-` after.
  // The leading-char restriction also means a prefix of just `.` or `-`
  // (which would degenerate to "match every container") is rejected.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(namePrefix)) {
    throw new DockerError(
      `listContainersByNamePrefix: invalid name prefix '${namePrefix}' (must start with [A-Za-z0-9] and contain only [A-Za-z0-9._-])`,
    );
  }
  try {
    const { stdout } = await execFileImpl('docker', [
      'ps',
      '--filter', `name=${namePrefix}`,
      '--format', '{{.ID}}',
    ]);
    return stdout.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
  } catch (err) {
    throw new DockerError(`docker ps failed for prefix ${namePrefix}: ${errMsg(err)}`, err);
  }
}

async function isRunning(id: string): Promise<boolean> {
  try {
    const { stdout } = await execFileImpl('docker', [
      'inspect',
      '--format={{.State.Running}}',
      id,
    ]);
    return stdout.trim() === 'true';
  } catch {
    // Container not found / daemon hiccup → treat as "not running yet".
    return false;
  }
}

// ----------------------------------------------------------------------------
// Internals
// ----------------------------------------------------------------------------

/** Docker IDs are hex; accept short (12) or full (64). Defends against argv
 * injection via the id parameter — only [0-9a-f] passes. */
function assertValidContainerId(id: string): void {
  if (!/^[0-9a-f]{12,64}$/.test(id)) {
    throw new DockerError(`Invalid container id "${id}": expected 12-64 hex chars`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
