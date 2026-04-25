/**
 * Built-in commands registered on the tenant command registry.
 *
 * Handlers here MUST be dependency-light — they run alongside every tenant
 * and can't pull in heavy imports (sphere-sdk, dockerode, etc.). Each is a
 * pure function of the parameters plus a small injected context.
 */

import type { CommandContext, CommandDefinition, CommandRegistry, Validator } from './command-registry.js';
import { noParams } from './command-registry.js';
import { SECRET_SUBSTRINGS } from './secrets.js';

// ---------------------------------------------------------------------------
// Shared state — the "tenant" surface area shared across builtins
// ---------------------------------------------------------------------------

export interface BuiltinContext {
  /** Process startup timestamp (ms since epoch). Used by `info` for uptime. */
  readonly startedAt: number;
  /** Tenant instance id (from env). */
  readonly instanceId: string;
  /** Human-readable instance name. */
  readonly instanceName: string;
  /** Template id the manager used to spawn this tenant. */
  readonly templateId: string | undefined;
  /** Package version string (SSoT read from package.json at startup). */
  readonly version: string;
  /**
   * Called when `shutdown` is invoked AND allowed by env. Host wires this to
   * the ACP listener's `shutdownRequested` flag so the process exits cleanly.
   */
  readonly requestShutdown: () => void;
  /**
   * Process env snapshot. Passed in (rather than read live) so tests can
   * control the view. Production wiring passes `process.env` directly.
   */
  readonly env: NodeJS.ProcessEnv;
}

// ---------------------------------------------------------------------------
// Env redaction rules — applied to `env` command output
// ---------------------------------------------------------------------------

/**
 * SECRET_SUBSTRINGS lives in `secrets.ts` so the same denylist can be reused
 * by `command-registry.ts` (round-2: redaction in `env_config_rejected`
 * warnings) without creating a circular import. Strict allowlist approach:
 * if a key matches ANY secret pattern (case-insensitive substring), it is
 * removed from the `env` command output.
 *
 * Round-1 hardening included CREDENTIAL, AUTH, BEARER, COOKIE, SESSION,
 * CERT, SIGNATURE, SIG to catch OAuth bearers, session ids, signed blobs,
 * and any auth artefact a tenant author might bind to UNICITY_*. The
 * matcher is `String.prototype.includes` on the upper-cased key, so e.g.
 * `UNICITY_OAUTH_BEARER` redacts via `BEARER`, `UNICITY_TLS_CERT` via
 * `CERT`, `UNICITY_TX_SIGNATURE` via `SIGNATURE` (and `SIG` as a shorter
 * fallback).
 */

/**
 * Explicit denylist — names that might slip past the substring filter but
 * must never be surfaced. `UNICITY_BOOT_TOKEN` is included explicitly for
 * emphasis even though `TOKEN` already catches it.
 */
const DENY_EXACT = new Set(['UNICITY_BOOT_TOKEN']);

/** Returns the safe subset of env: UNICITY_* prefix + NODE_ENV, minus secrets. */
export function safeEnvSnapshot(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    const allowed = upper === 'NODE_ENV' || upper.startsWith('UNICITY_');
    if (!allowed) continue;
    if (DENY_EXACT.has(upper)) continue;
    if (SECRET_SUBSTRINGS.some((s) => upper.includes(s))) continue;
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Individual command definitions
// ---------------------------------------------------------------------------

function buildPing(): CommandDefinition<Record<string, never>, { pong: true; ts: string }> {
  return {
    description: 'Liveness check — returns { pong: true, ts: <iso> }',
    paramsSchema: noParams,
    handler: async () => ({ pong: true as const, ts: new Date().toISOString() }),
  };
}

function buildInfo(ctx: BuiltinContext): CommandDefinition<Record<string, never>, {
  version: string;
  instance_id: string;
  uptime_seconds: number;
  template_id: string | null;
  instance_name: string;
}> {
  return {
    description: 'Tenant metadata — version, instance_id, uptime_seconds, template_id',
    paramsSchema: noParams,
    handler: async () => ({
      version: ctx.version,
      instance_id: ctx.instanceId,
      instance_name: ctx.instanceName,
      uptime_seconds: Math.floor((Date.now() - ctx.startedAt) / 1000),
      template_id: ctx.templateId ?? null,
    }),
  };
}

function buildShutdown(ctx: BuiltinContext): CommandDefinition<
  Record<string, never>,
  { acknowledged: true } | { error: string }
> {
  return {
    description: 'Remote shutdown (gated by UNICITY_ALLOW_REMOTE_SHUTDOWN=1)',
    paramsSchema: noParams,
    handler: async () => {
      // Evaluate the gate at invocation time, not registration time —
      // operators may hot-reload env under a process manager.
      if (ctx.env['UNICITY_ALLOW_REMOTE_SHUTDOWN'] !== '1') {
        return { error: 'remote_shutdown_disabled' as const };
      }
      ctx.requestShutdown();
      return { acknowledged: true as const };
    },
  };
}

function buildEnv(ctx: BuiltinContext): CommandDefinition<Record<string, never>, { env: Record<string, string> }> {
  return {
    description: 'Safe subset of UNICITY_* + NODE_ENV (secrets redacted)',
    paramsSchema: noParams,
    handler: async () => ({ env: safeEnvSnapshot(ctx.env) }),
  };
}

// ---------------------------------------------------------------------------
// Registration helper
// ---------------------------------------------------------------------------

export interface BuiltinNames {
  readonly ping: 'ping';
  readonly info: 'info';
  readonly shutdown: 'shutdown';
  readonly env: 'env';
}

/**
 * Register the four built-ins on the given registry. Idempotent-guarded by
 * the registry's duplicate detection — callers MUST supply a fresh
 * registry or call `unregister` first.
 */
export function registerBuiltinCommands(
  registry: CommandRegistry,
  ctx: BuiltinContext,
): void {
  registry.register('ping', buildPing());
  registry.register('info', buildInfo(ctx));
  registry.register('shutdown', buildShutdown(ctx));
  registry.register('env', buildEnv(ctx));
}

// Avoid unused imports warning — the Validator + CommandContext imports
// are used implicitly through type inference on CommandDefinition.
// Silence here keeps the import list documentary.
export type _unused = [Validator<unknown>, CommandContext];
