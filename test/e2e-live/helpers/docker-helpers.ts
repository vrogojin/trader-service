/**
 * docker-helpers — STUB.
 *
 * Owns: provisioning + lifecycle of a single Docker container for e2e-live tests.
 * The full implementation is being authored in a peer worktree; this stub exists
 * solely so `tenant-fixture.ts` and its tests can compile against the contract
 * shapes pinned by `./contracts.ts`. The integrator replaces the stub during
 * merge with the peer worktree's real implementation.
 *
 * All functions throw NotImplementedError so accidental real-Docker invocation
 * is loud and obvious. Tests substitute these via `vi.mock(...)`.
 */

import type {
  DockerRunOptions,
  DockerContainer,
} from './contracts.js';

class NotImplementedError extends Error {
  constructor(name: string) {
    super(
      `docker-helpers stub: ${name}() not implemented in this worktree. ` +
        `The peer worktree authoring docker-helpers.ts owns the real impl.`,
    );
    this.name = 'NotImplementedError';
  }
}

export async function runContainer(_opts: DockerRunOptions): Promise<DockerContainer> {
  throw new NotImplementedError('runContainer');
}

export async function stopContainer(_id: string, _timeoutMs?: number): Promise<void> {
  throw new NotImplementedError('stopContainer');
}

export async function removeContainer(_id: string): Promise<void> {
  throw new NotImplementedError('removeContainer');
}

export async function getContainerLogs(_id: string, _lines?: number): Promise<string> {
  throw new NotImplementedError('getContainerLogs');
}

export async function waitForContainerRunning(_id: string, _timeoutMs?: number): Promise<boolean> {
  throw new NotImplementedError('waitForContainerRunning');
}
