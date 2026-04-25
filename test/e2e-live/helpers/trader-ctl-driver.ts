/**
 * trader-ctl-driver — STUB.
 *
 * Owns: invoking the bundled trader-ctl as a subprocess to drive a running
 * trader tenant via DM. The full implementation is being authored in a peer
 * worktree; this stub exists solely so the helpers that depend on it can
 * compile against the contract shapes pinned by `./contracts.ts`.
 *
 * Throws on call so accidental real-CLI invocation is loud and obvious.
 * Tests substitute this via `vi.mock(...)`.
 */

import type { TraderCtlOptions, TraderCtlResult } from './contracts.js';

export async function runTraderCtl(
  _command: string,
  _args: ReadonlyArray<string>,
  _opts: TraderCtlOptions,
): Promise<TraderCtlResult> {
  throw new Error(
    'trader-ctl-driver stub: runTraderCtl() not implemented in this worktree. ' +
      'The peer worktree authoring trader-ctl-driver.ts owns the real impl.',
  );
}
