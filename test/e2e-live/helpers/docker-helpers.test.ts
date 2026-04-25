/**
 * Unit tests for docker-helpers — input validation + argv shape.
 *
 * The daemon-touching paths are e2e-live by definition (see contracts.ts);
 * here we only exercise:
 *   - validation rejections that happen BEFORE any process starts
 *   - the exact argv produced when execFile IS invoked, to confirm no
 *     shell-injection vector exists
 *   - error parsing (running-container, no-such-container)
 *
 * These run in the default `npm test` because they don't touch a daemon.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DockerError,
  __setExecFileForTests,
  buildRunArgs,
  getContainerLogs,
  inspectContainer,
  removeContainer,
  runContainer,
  stopContainer,
  waitForContainerRunning,
} from './docker-helpers.js';

type ExecFileMock = ReturnType<typeof vi.fn>;

function fakeExecOk(stdout = '', stderr = ''): ExecFileMock {
  return vi.fn().mockResolvedValue({ stdout, stderr });
}

function fakeExecFail(message: string): ExecFileMock {
  return vi.fn().mockRejectedValue(new Error(message));
}

/** Returns a 64-char lowercase hex id. */
function fakeId(): string {
  return 'a'.repeat(64);
}

describe('runContainer', () => {
  let mock: ExecFileMock;

  beforeEach(() => {
    mock = fakeExecOk(`${fakeId()}\n`);
    __setExecFileForTests(mock);
  });

  afterEach(() => {
    __setExecFileForTests(null);
  });

  it('rejects label containing shell metacharacters', async () => {
    await expect(
      runContainer({
        image: 'unicity/trader:0.1',
        label: 'foo;rm -rf /',
      }),
    ).rejects.toBeInstanceOf(DockerError);
    expect(mock).not.toHaveBeenCalled();
  });

  it('rejects label containing whitespace', async () => {
    await expect(
      runContainer({ image: 'unicity/trader:0.1', label: 'foo bar' }),
    ).rejects.toThrow(/invalid label/i);
    expect(mock).not.toHaveBeenCalled();
  });

  it('rejects label containing slashes (path-injection guard)', async () => {
    await expect(
      runContainer({ image: 'unicity/trader:0.1', label: '../etc/passwd' }),
    ).rejects.toThrow(/invalid label/i);
    expect(mock).not.toHaveBeenCalled();
  });

  it('rejects empty label', async () => {
    await expect(
      runContainer({ image: 'unicity/trader:0.1', label: '' }),
    ).rejects.toThrow(/invalid label/i);
  });

  it('rejects label exceeding 64 chars', async () => {
    await expect(
      runContainer({ image: 'unicity/trader:0.1', label: 'a'.repeat(65) }),
    ).rejects.toThrow(/invalid label/i);
  });

  it('accepts valid labels (alphanumeric, _, ., -)', async () => {
    await expect(
      runContainer({ image: 'unicity/trader:0.1', label: 'alice_bot.v1-2' }),
    ).resolves.toBeDefined();
  });

  it('rejects relative bind-mount host path', async () => {
    await expect(
      runContainer({
        image: 'unicity/trader:0.1',
        binds: [{ host: 'data/wallet', container: '/data/wallet' }],
      }),
    ).rejects.toThrow(/absolute/i);
    expect(mock).not.toHaveBeenCalled();
  });

  it('rejects "./relative" host paths', async () => {
    await expect(
      runContainer({
        image: 'unicity/trader:0.1',
        binds: [{ host: './data', container: '/data' }],
      }),
    ).rejects.toThrow(/absolute/i);
  });

  it('accepts absolute host paths', async () => {
    await expect(
      runContainer({
        image: 'unicity/trader:0.1',
        binds: [{ host: '/tmp/wallet', container: '/data/wallet' }],
      }),
    ).resolves.toBeDefined();
  });

  it('rejects missing image', async () => {
    await expect(
      runContainer({ image: '' } as unknown as Parameters<typeof runContainer>[0]),
    ).rejects.toThrow(/image is required/i);
  });

  it('produces argv with image as the LAST arg (no flag injection)', async () => {
    await runContainer({
      image: 'unicity/trader:0.1',
      env: { FOO: '--rm' }, // Even values that look like flags must be safe.
      label: 'demo',
    });

    expect(mock).toHaveBeenCalledTimes(1);
    const [bin, argv] = mock.mock.calls[0] as [string, string[]];
    expect(bin).toBe('docker');
    expect(argv[0]).toBe('run');
    expect(argv[1]).toBe('-d');
    // Image is positional and last.
    expect(argv[argv.length - 1]).toBe('unicity/trader:0.1');
    // Env value containing "--rm" is a SINGLE argv element (KEY=VALUE form).
    expect(argv).toContain('FOO=--rm');
  });

  it('throws if docker run output is not a container id', async () => {
    __setExecFileForTests(fakeExecOk('not-an-id\n'));
    await expect(
      runContainer({ image: 'unicity/trader:0.1' }),
    ).rejects.toThrow(/did not return a container ID/i);
  });

  it('wraps docker run failures in DockerError', async () => {
    __setExecFileForTests(fakeExecFail('Unable to find image'));
    await expect(
      runContainer({ image: 'unicity/trader:0.1' }),
    ).rejects.toBeInstanceOf(DockerError);
  });
});

describe('buildRunArgs', () => {
  it('emits resource caps even when caller omits them', () => {
    const args = buildRunArgs({ image: 'img:1' }, 'name-x');
    expect(args).toContain('--memory=256m');
    expect(args).toContain('--pids-limit=128');
  });

  it('respects caller-supplied resource caps', () => {
    const args = buildRunArgs(
      { image: 'img:1', resources: { memoryMb: 512, pidsLimit: 256 } },
      'name-x',
    );
    expect(args).toContain('--memory=512m');
    expect(args).toContain('--pids-limit=256');
  });

  it('defaults network to bridge', () => {
    const args = buildRunArgs({ image: 'img:1' }, 'name-x');
    expect(args).toContain('--network=bridge');
  });

  it('honours network=host', () => {
    const args = buildRunArgs({ image: 'img:1', network: 'host' }, 'name-x');
    expect(args).toContain('--network=host');
  });

  it('encodes env as separate --env KEY=VALUE pairs', () => {
    const args = buildRunArgs(
      { image: 'img:1', env: { A: '1', B: 'two words' } },
      'n',
    );
    const envIdxA = args.indexOf('A=1');
    const envIdxB = args.indexOf('B=two words');
    expect(envIdxA).toBeGreaterThan(0);
    expect(envIdxB).toBeGreaterThan(0);
    // Each env value is in a SINGLE argv slot — no splitting on whitespace.
    expect(args[envIdxA - 1]).toBe('--env');
    expect(args[envIdxB - 1]).toBe('--env');
  });

  it('encodes bind mounts with :ro suffix when readonly', () => {
    const args = buildRunArgs(
      {
        image: 'img:1',
        binds: [
          { host: '/abs/rw', container: '/data' },
          { host: '/abs/ro', container: '/cfg', readonly: true },
        ],
      },
      'n',
    );
    expect(args).toContain('/abs/rw:/data');
    expect(args).toContain('/abs/ro:/cfg:ro');
  });

  it('places --name immediately after run -d', () => {
    const args = buildRunArgs({ image: 'img:1' }, 'my-name');
    expect(args.slice(0, 4)).toEqual(['run', '-d', '--name', 'my-name']);
  });
});

describe('stopContainer', () => {
  let mock: ExecFileMock;

  beforeEach(() => {
    mock = fakeExecOk();
    __setExecFileForTests(mock);
  });

  afterEach(() => {
    __setExecFileForTests(null);
  });

  it('accepts a valid container id and emits docker stop with timeout', async () => {
    await stopContainer(fakeId(), 5000);
    expect(mock).toHaveBeenCalledWith('docker', ['stop', '--time=5', fakeId()]);
  });

  it('rejects non-hex container ids', async () => {
    await expect(stopContainer('rm -rf /')).rejects.toThrow(/invalid container id/i);
    await expect(stopContainer('ABCDEF123456')).rejects.toThrow(/invalid container id/i);
    await expect(stopContainer('zzzzzzzzzzzz')).rejects.toThrow(/invalid container id/i);
  });

  it('rejects ids shorter than 12 chars', async () => {
    await expect(stopContainer('abc')).rejects.toThrow(/invalid container id/i);
  });

  it('uses default timeout of 10s when none provided', async () => {
    await stopContainer(fakeId());
    expect(mock).toHaveBeenCalledWith('docker', ['stop', '--time=10', fakeId()]);
  });

  it('falls back to docker kill when stop fails', async () => {
    const calls: Array<[string, string[]]> = [];
    __setExecFileForTests(
      vi.fn().mockImplementation((file: string, args: string[]) => {
        calls.push([file, args]);
        if (args[0] === 'stop') {
          return Promise.reject(new Error('Error response from daemon: stop hung'));
        }
        return Promise.resolve({ stdout: '', stderr: '' });
      }),
    );

    await stopContainer(fakeId(), 1000);

    expect(calls.length).toBe(2);
    expect(calls[0]?.[1]?.[0]).toBe('stop');
    expect(calls[1]?.[1]?.[0]).toBe('kill');
    expect(calls[1]?.[1]?.[1]).toBe(fakeId());
  });

  it('treats "no such container" on stop as success (idempotent)', async () => {
    __setExecFileForTests(fakeExecFail('Error: No such container: abc'));
    await expect(stopContainer(fakeId())).resolves.toBeUndefined();
  });

  it('wraps repeated failures in DockerError with both messages', async () => {
    __setExecFileForTests(
      vi.fn().mockImplementation((_file: string, args: string[]) => {
        if (args[0] === 'stop') return Promise.reject(new Error('stop boom'));
        return Promise.reject(new Error('kill boom'));
      }),
    );
    await expect(stopContainer(fakeId())).rejects.toThrow(/stop boom.*kill boom/);
  });
});

describe('removeContainer', () => {
  let mock: ExecFileMock;

  beforeEach(() => {
    mock = fakeExecOk();
    __setExecFileForTests(mock);
  });

  afterEach(() => {
    __setExecFileForTests(null);
  });

  it('emits docker rm with the container id', async () => {
    await removeContainer(fakeId());
    expect(mock).toHaveBeenCalledWith('docker', ['rm', fakeId()]);
  });

  it('rejects invalid container ids', async () => {
    await expect(removeContainer('not-an-id')).rejects.toThrow(/invalid container id/i);
  });

  it('throws DockerError when container is still running', async () => {
    __setExecFileForTests(
      fakeExecFail(
        'Error response from daemon: You cannot remove a running container abc. Stop the container before attempting removal or force remove',
      ),
    );
    await expect(removeContainer(fakeId())).rejects.toThrow(/still running/i);
    await expect(removeContainer(fakeId())).rejects.toBeInstanceOf(DockerError);
  });

  it('parses "container is running" variant', async () => {
    __setExecFileForTests(fakeExecFail('Error: container is running'));
    await expect(removeContainer(fakeId())).rejects.toThrow(/still running/i);
  });

  it('treats "no such container" as success (already removed)', async () => {
    __setExecFileForTests(fakeExecFail('Error: No such container: abc'));
    await expect(removeContainer(fakeId())).resolves.toBeUndefined();
  });

  it('wraps unknown daemon errors in DockerError', async () => {
    __setExecFileForTests(fakeExecFail('Error: cannot connect to daemon'));
    await expect(removeContainer(fakeId())).rejects.toBeInstanceOf(DockerError);
  });
});

describe('getContainerLogs', () => {
  let mock: ExecFileMock;

  beforeEach(() => {
    mock = fakeExecOk('line1\nline2\n', 'err1\n');
    __setExecFileForTests(mock);
  });

  afterEach(() => {
    __setExecFileForTests(null);
  });

  it('emits docker logs --tail=N <id>', async () => {
    await getContainerLogs(fakeId(), 50);
    expect(mock).toHaveBeenCalledWith('docker', ['logs', '--tail=50', fakeId()]);
  });

  it('defaults to 200 lines when not specified', async () => {
    await getContainerLogs(fakeId());
    expect(mock).toHaveBeenCalledWith('docker', ['logs', '--tail=200', fakeId()]);
  });

  it('concatenates stdout and stderr (the 2>&1 idiom without a shell)', async () => {
    const out = await getContainerLogs(fakeId());
    expect(out).toBe('line1\nline2\nerr1\n');
  });

  it('rejects negative line counts', async () => {
    await expect(getContainerLogs(fakeId(), -1)).rejects.toThrow(/non-negative/);
  });

  it('rejects invalid container ids', async () => {
    await expect(getContainerLogs('bad id')).rejects.toThrow(/invalid container id/i);
  });

  it('wraps daemon errors in DockerError', async () => {
    __setExecFileForTests(fakeExecFail('boom'));
    await expect(getContainerLogs(fakeId())).rejects.toBeInstanceOf(DockerError);
  });
});

describe('waitForContainerRunning', () => {
  afterEach(() => {
    __setExecFileForTests(null);
  });

  it('returns true once docker inspect reports State.Running == true', async () => {
    __setExecFileForTests(fakeExecOk('true\n'));
    const ok = await waitForContainerRunning(fakeId(), 1000);
    expect(ok).toBe(true);
  });

  it('returns false on timeout when container never reaches running', async () => {
    __setExecFileForTests(fakeExecOk('false\n'));
    const ok = await waitForContainerRunning(fakeId(), 50);
    expect(ok).toBe(false);
  });

  it('returns false on timeout when docker inspect keeps erroring', async () => {
    __setExecFileForTests(fakeExecFail('No such container'));
    const ok = await waitForContainerRunning(fakeId(), 50);
    expect(ok).toBe(false);
  });

  it('rejects invalid container ids', async () => {
    await expect(waitForContainerRunning('nope')).rejects.toThrow(/invalid container id/i);
  });

  it('emits the inspect argv with --format=… (no shell)', async () => {
    const mock = fakeExecOk('true\n');
    __setExecFileForTests(mock);
    await waitForContainerRunning(fakeId(), 1000);
    expect(mock).toHaveBeenCalledWith('docker', [
      'inspect',
      '--format={{.State.Running}}',
      fakeId(),
    ]);
  });
});

describe('inspectContainer', () => {
  afterEach(() => {
    __setExecFileForTests(null);
  });

  it('returns true when daemon prints "true"', async () => {
    __setExecFileForTests(fakeExecOk('true\n'));
    expect(await inspectContainer(fakeId())).toBe(true);
  });

  it('returns false on errors', async () => {
    __setExecFileForTests(fakeExecFail('boom'));
    expect(await inspectContainer(fakeId())).toBe(false);
  });
});
