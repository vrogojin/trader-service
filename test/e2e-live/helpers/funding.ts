/**
 * funding — STUB.
 *
 * Owns: requesting testnet tokens from the configured faucet for a freshly
 * created wallet. The full implementation is being authored in a peer
 * worktree; this stub exists so callers compile against the contract shape
 * pinned by `./contracts.ts:FundWallet`. The integrator replaces the stub
 * during merge.
 *
 * Throws on call so accidental real-faucet invocation is loud and obvious.
 * Tests substitute this via `vi.mock(...)`.
 */

export async function fundWallet(
  _walletAddress: string,
  _amount: bigint,
  _coinId?: string,
): Promise<{ tx_id: string }> {
  throw new Error(
    'funding stub: fundWallet() not implemented in this worktree. ' +
      'The peer worktree authoring funding.ts owns the real impl.',
  );
}
