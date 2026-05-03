/**
 * session — process-wide identifier for a single `npm run test:e2e-live` run.
 *
 * Two independent invocations of the e2e-live suite (concurrent CI shards,
 * two developers on the same host, etc.) MUST NOT interfere. The shared
 * resources at risk are:
 *
 *   - Docker container names (one daemon, flat name space)
 *   - /tmp directory layout (test-only, but `ls /tmp/trader-e2e-*` should
 *     scope cleanly to a single run)
 *   - Diagnostic queries that filter by name prefix
 *     (see scenario-helpers `listContainersByNamePrefix`)
 *
 * The Nostr-side identifiers (per-trader secp256k1 keypair, nametag derived
 * from the instance UUID) already have ≥10⁹ entropy per resource so they
 * do not need a session prefix to remain non-colliding — adding one would
 * only reduce the 9-hex randomness in the nametag slice.
 *
 * SESSION_ID is generated ONCE at module load. Every helper that constructs
 * a name targeting a shared resource must read it from here so it is
 * uniformly attached.
 *
 * Override via `TRADER_E2E_SESSION_ID=...` if a CI driver wants to tag the
 * run with its own job id for cross-tool log correlation. The override is
 * sanitized to lowercase hex; non-hex characters are stripped. Empty values
 * are ignored — a fresh ID is generated.
 */

import { randomBytes } from 'node:crypto';

function readSessionOverride(): string | null {
  const raw = process.env['TRADER_E2E_SESSION_ID'];
  if (typeof raw !== 'string') return null;
  // Sanitize: lowercase, [a-z0-9-] (hex + dash), max 32 chars. We accept `-`
  // because Docker container names allow it and CI drivers commonly tag with
  // values like "ci-job-1234-abc" — silently stripping the dashes would mangle
  // a meaningful identifier into an indecipherable hex blob (review feedback
  // PR-10 W6). Stripping characters that ARE invalid for Docker names (e.g.
  // `/`, `:`, spaces) is still required to prevent injection through the
  // value into the docker argv.
  const cleaned = raw.toLowerCase().replace(/[^0-9a-z-]/g, '').slice(0, 32);
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * 16-hex-char session id (64 bits ≈ 1.8e19 distinct sessions).
 *
 * Increased from 32 bits per PR-10 review (W4): with 100-shard CI matrices the
 * birthday-bound collision probability at 32 bits (~1.2e-6) was small but
 * non-zero. 64 bits drops it to ~5e-15 even at thousands of concurrent runs —
 * effectively impossible for any realistic deployment. The cost is 4 additional
 * random bytes; trivial.
 */
export const SESSION_ID: string = readSessionOverride() ?? randomBytes(8).toString('hex');

/**
 * Common prefix for every container/tmp-dir name produced by this run.
 * Two simultaneous test sessions will end up with distinct prefixes and
 * `docker ps --filter name=<sessionContainerPrefix()>` lists only the
 * current run's containers.
 */
export function sessionContainerPrefix(): string {
  return `trader-e2e-${SESSION_ID}`;
}
