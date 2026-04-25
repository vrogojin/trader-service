/**
 * Shared timeout constants used by both the HMCP layer (host manager) and
 * the tenant command registry.
 *
 * Why this lives in `shared/`: prior to round-2 hardening, the HMCP-layer
 * timeout validator accepted any positive finite number while the tenant-side
 * registry rejected anything below 100ms. This split meant a controller could
 * send `timeout_ms: 50` past the manager and only learn it was rejected once
 * the tenant produced a confusing two-hop `invalid_params` reply. Aligning
 * both layers on a single constant guarantees a single rejection point at the
 * earliest layer that sees the value.
 *
 * MIN_TIMEOUT_MS is the smallest caller-supplied timeout we accept. Anything
 * finer-grained is treated as malformed input — a sub-millisecond timeout is
 * functionally a guaranteed `handler_timeout` on every dispatch, which a
 * malicious controller could use to drain the registry's concurrency slots
 * without doing useful work (see also `command-registry.ts`).
 */

/** Minimum caller-supplied timeout in ms. Enforced at HMCP and tenant layers. */
export const MIN_TIMEOUT_MS = 100;

/** Absolute ceiling — caller-supplied timeouts above this are rejected. */
export const MAX_TIMEOUT_MS = 300_000;
