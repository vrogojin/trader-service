/**
 * polling — minimal helper.
 *
 * Provides `pollUntil(predicate, opts)` matching the shape pinned in
 * `./contracts.ts:PollUntil`. This is a real implementation — it has no
 * external side effects and is small enough that we ship it directly rather
 * than stubbing it. The integrator may replace it during merge if a peer
 * worktree authored a richer version.
 */

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_INTERVAL_MS = 2_000;

export async function pollUntil(
  predicate: () => Promise<boolean>,
  opts?: { timeoutMs?: number; intervalMs?: number; description?: string },
): Promise<boolean> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = opts?.intervalMs ?? DEFAULT_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ok = await predicate();
      if (ok) return true;
    } catch {
      // Predicate threw — treat as "not yet" and keep polling.
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const sleep = Math.min(intervalMs, remaining);
    await new Promise((resolve) => setTimeout(resolve, sleep));
  }
  return false;
}
