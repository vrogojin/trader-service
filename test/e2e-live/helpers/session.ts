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
  // Sanitize: lowercase, hex-only, max 16 chars. Refuse exotic characters
  // because the value gets concatenated into Docker container names which
  // have a strict allowed-character class ([a-zA-Z0-9_.-]).
  const cleaned = raw.toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, 16);
  return cleaned.length > 0 ? cleaned : null;
}

/** 8-hex-char session id (32 bits ≈ 4.3 billion distinct sessions). */
export const SESSION_ID: string = readSessionOverride() ?? randomBytes(4).toString('hex');

/**
 * Common prefix for every container/tmp-dir name produced by this run.
 * Two simultaneous test sessions will end up with distinct prefixes and
 * `docker ps --filter name=<sessionContainerPrefix()>` lists only the
 * current run's containers.
 */
export function sessionContainerPrefix(): string {
  return `trader-e2e-${SESSION_ID}`;
}
