/**
 * Unit tests for trader-ctl-driver. Mocks `node:child_process.execFile` so
 * we can assert the exact argv shape, env-var injection, and the various
 * failure-mode branches without ever spawning a child process.
 *
 * These tests are unit-level (mocked subprocess) and run as part of the
 * default `npm test` suite. The live e2e harness that uses the real driver
 * lives elsewhere under test/e2e-live/ and is opt-in via `npm run
 * test:e2e-live`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock node:child_process. We capture the argv/options/callback so each test
// can stage a custom child outcome (stdout, stderr, exit code, spawn error)
// without involving a real process.
// ---------------------------------------------------------------------------

interface CapturedCall {
  file: string;
  args: string[];
  options: {
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    maxBuffer?: number;
    killSignal?: string | number;
  };
}

type ExecFileCallback = (
  err: (Error & { code?: number | string; signal?: string; killed?: boolean }) | null,
  stdout: string | Buffer,
  stderr: string | Buffer,
) => void;

interface ChildOutcome {
  err: (Error & { code?: number | string; signal?: string; killed?: boolean }) | null;
  stdout: string;
  stderr: string;
}

const calls: CapturedCall[] = [];
let nextOutcome: ChildOutcome = { err: null, stdout: '', stderr: '' };

vi.mock('node:child_process', () => {
  return {
    execFile: vi.fn(
      (file: string, args: string[], options: CapturedCall['options'], cb: ExecFileCallback) => {
        calls.push({ file, args: [...args], options });
        // Defer to a microtask so the caller's Promise wiring is in place.
        queueMicrotask(() => {
          cb(nextOutcome.err, nextOutcome.stdout, nextOutcome.stderr);
        });
      },
    ),
  };
});

// Import AFTER vi.mock so the module-under-test gets the mocked execFile.
const { runTraderCtl, MIN_TIMEOUT_MS } = await import('./trader-ctl-driver.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stageChildSuccess(stdout: string, stderr = ''): void {
  nextOutcome = { err: null, stdout, stderr };
}

function stageChildExit(code: number, stdout: string, stderr: string): void {
  const err = Object.assign(new Error(`Command failed with exit code ${code}`), {
    code,
  });
  nextOutcome = { err, stdout, stderr };
}

function stageSpawnFailure(errnoCode: string, message: string): void {
  const err = Object.assign(new Error(message), { code: errnoCode });
  nextOutcome = { err, stdout: '', stderr: '' };
}

beforeEach(() => {
  calls.length = 0;
  nextOutcome = { err: null, stdout: '', stderr: '' };
});

// ---------------------------------------------------------------------------
// Argv shape
// ---------------------------------------------------------------------------

describe('runTraderCtl — argv shape', () => {
  it('passes command, positional args, and --tenant when only tenant is set', async () => {
    stageChildSuccess('ok\n');

    await runTraderCtl('list-intents', ['--state', 'active'], { tenant: '@alice' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual([
      'list-intents',
      '--state',
      'active',
      '--tenant',
      '@alice',
    ]);
  });

  it('appends --json when opts.json is true', async () => {
    stageChildSuccess('{}');

    await runTraderCtl('status', [], { tenant: '@bob', json: true });

    expect(calls[0]!.args).toEqual(['status', '--tenant', '@bob', '--json']);
  });

  it('appends --timeout <ms> when opts.timeoutMs is set', async () => {
    stageChildSuccess('ok\n');

    await runTraderCtl('status', [], { tenant: '@bob', timeoutMs: 5_000 });

    expect(calls[0]!.args).toEqual(['status', '--tenant', '@bob', '--timeout', '5000']);
  });

  it('appends --data-dir and --tokens-dir when set', async () => {
    stageChildSuccess('ok\n');

    await runTraderCtl('portfolio', [], {
      tenant: '@carol',
      dataDir: '/tmp/wallet',
      tokensDir: '/tmp/tokens',
    });

    expect(calls[0]!.args).toEqual([
      'portfolio',
      '--tenant',
      '@carol',
      '--data-dir',
      '/tmp/wallet',
      '--tokens-dir',
      '/tmp/tokens',
    ]);
  });

  it('passes all flags together in deterministic order', async () => {
    stageChildSuccess('{}');

    await runTraderCtl('list-intents', ['--limit', '10'], {
      tenant: 'DIRECT://abcd',
      json: true,
      timeoutMs: 1_500,
      dataDir: '/d',
      tokensDir: '/t',
    });

    expect(calls[0]!.args).toEqual([
      'list-intents',
      '--limit',
      '10',
      '--tenant',
      'DIRECT://abcd',
      '--json',
      '--timeout',
      '1500',
      '--data-dir',
      '/d',
      '--tokens-dir',
      '/t',
    ]);
  });

  it('invokes the absolute path to bin/trader-ctl resolved at module load', async () => {
    stageChildSuccess('ok\n');

    await runTraderCtl('status', [], { tenant: '@alice' });

    expect(calls[0]!.file).toMatch(/\/bin\/trader-ctl$/);
    // Sanity-check it's an absolute path (begins with /).
    expect(calls[0]!.file.startsWith('/')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pre-validation
// ---------------------------------------------------------------------------

describe('runTraderCtl — pre-validation', () => {
  it('rejects timeoutMs below MIN_TIMEOUT_MS with /minimum 100ms/', async () => {
    await expect(
      runTraderCtl('status', [], { tenant: '@a', timeoutMs: 50 }),
    ).rejects.toThrow(/minimum 100ms/);

    expect(calls).toHaveLength(0);
  });

  it('accepts timeoutMs at exactly MIN_TIMEOUT_MS (boundary)', async () => {
    stageChildSuccess('ok\n');

    await runTraderCtl('status', [], { tenant: '@a', timeoutMs: MIN_TIMEOUT_MS });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toContain('--timeout');
  });

  it('rejects non-integer timeoutMs', async () => {
    await expect(
      runTraderCtl('status', [], { tenant: '@a', timeoutMs: 100.5 }),
    ).rejects.toThrow(/minimum 100ms/);
  });

  it('rejects empty tenant', async () => {
    await expect(
      runTraderCtl('status', [], { tenant: '' }),
    ).rejects.toThrow(/tenant/);
  });

  it('rejects empty command', async () => {
    await expect(
      runTraderCtl('', [], { tenant: '@a' }),
    ).rejects.toThrow(/command/);
  });
});

// ---------------------------------------------------------------------------
// Output handling
// ---------------------------------------------------------------------------

describe('runTraderCtl — output parsing', () => {
  it('parses stdout as JSON when json=true and child exits 0', async () => {
    stageChildSuccess('{"ok": true, "result": {"intent_id": "abc"}}');

    const res = await runTraderCtl('create-intent', [], { tenant: '@a', json: true });

    expect(res.exitCode).toBe(0);
    expect(res.output).toEqual({ ok: true, result: { intent_id: 'abc' } });
    expect(res.stderr).toBe('');
  });

  it('throws when json=true, exit=0, but stdout is not valid JSON', async () => {
    stageChildSuccess('not-json-output\n');

    await expect(
      runTraderCtl('status', [], { tenant: '@a', json: true }),
    ).rejects.toThrow(/non-JSON on success/);
  });

  it('returns raw stdout string when json is unset', async () => {
    stageChildSuccess('plain stdout text');

    const res = await runTraderCtl('status', [], { tenant: '@a' });

    expect(res.output).toBe('plain stdout text');
    expect(res.exitCode).toBe(0);
  });

  it('does NOT throw on invalid JSON when child exits non-zero, even if json=true', async () => {
    // Caller decides whether to surface the error; we just hand back the bytes.
    stageChildExit(1, 'not-json', 'Error: command rejected\n');

    const res = await runTraderCtl('create-intent', [], { tenant: '@a', json: true });

    expect(res.exitCode).toBe(1);
    expect(res.output).toBe('not-json'); // unparsed
    expect(res.stderr).toBe('Error: command rejected\n');
  });
});

// ---------------------------------------------------------------------------
// Exit code & stream propagation
// ---------------------------------------------------------------------------

describe('runTraderCtl — exit codes and streams', () => {
  it('returns non-zero exit code without throwing', async () => {
    stageChildExit(2, '', 'Error: --timeout must be a positive integer\n');

    const res = await runTraderCtl('status', [], { tenant: '@a' });

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toBe('Error: --timeout must be a positive integer\n');
  });

  it('captures stdout and stderr separately', async () => {
    stageChildSuccess('the result\n', 'a warning to stderr\n');

    const res = await runTraderCtl('status', [], { tenant: '@a' });

    expect(res.output).toBe('the result\n');
    expect(res.stderr).toBe('a warning to stderr\n');
  });

  it('throws on subprocess launch failure (ENOENT)', async () => {
    stageSpawnFailure('ENOENT', 'spawn /nope/trader-ctl ENOENT');

    await expect(
      runTraderCtl('status', [], { tenant: '@a' }),
    ).rejects.toThrow(/failed to launch/);
  });

  it('throws on subprocess launch failure (EACCES)', async () => {
    stageSpawnFailure('EACCES', 'spawn EACCES');

    await expect(
      runTraderCtl('status', [], { tenant: '@a' }),
    ).rejects.toThrow(/failed to launch/);
  });
});

// ---------------------------------------------------------------------------
// Env-var injection
// ---------------------------------------------------------------------------

describe('runTraderCtl — env vars', () => {
  it('sets UNICITY_DATA_DIR and UNICITY_TOKENS_DIR when both opts are provided', async () => {
    stageChildSuccess('ok\n');

    await runTraderCtl('status', [], {
      tenant: '@a',
      dataDir: '/wallet',
      tokensDir: '/tokens',
    });

    expect(calls[0]!.options.env).toBeDefined();
    expect(calls[0]!.options.env!['UNICITY_DATA_DIR']).toBe('/wallet');
    expect(calls[0]!.options.env!['UNICITY_TOKENS_DIR']).toBe('/tokens');
  });

  it('inherits process.env baseline (e.g. PATH) so node can find binaries', async () => {
    stageChildSuccess('ok\n');

    await runTraderCtl('status', [], { tenant: '@a' });

    // PATH is virtually guaranteed to be set in any sane test environment.
    expect(calls[0]!.options.env!['PATH']).toBe(process.env['PATH']);
  });

  it('does NOT set UNICITY_DATA_DIR when opts.dataDir is undefined', async () => {
    stageChildSuccess('ok\n');
    const original = process.env['UNICITY_DATA_DIR'];
    delete process.env['UNICITY_DATA_DIR'];

    try {
      await runTraderCtl('status', [], { tenant: '@a' });
      expect(calls[0]!.options.env!['UNICITY_DATA_DIR']).toBeUndefined();
    } finally {
      if (original !== undefined) process.env['UNICITY_DATA_DIR'] = original;
    }
  });
});

// ---------------------------------------------------------------------------
// Subprocess safety net
// ---------------------------------------------------------------------------

describe('runTraderCtl — subprocess timeout safety net', () => {
  it('passes a non-zero outer subprocess timeout to execFile', async () => {
    stageChildSuccess('ok\n');

    await runTraderCtl('status', [], { tenant: '@a' });

    // Default safety-net timeout is 60s; we just assert it's set & generous.
    expect(calls[0]!.options.timeout).toBeGreaterThanOrEqual(30_000);
    expect(calls[0]!.options.killSignal).toBe('SIGKILL');
  });
});
