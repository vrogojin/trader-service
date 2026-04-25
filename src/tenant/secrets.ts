/**
 * Shared secret-substring patterns for env-key redaction.
 *
 * Used by:
 *   - `builtin-commands.ts#safeEnvSnapshot` (filters output of the `env`
 *     command so secrets never leave the tenant)
 *   - `command-registry.ts#parsePositiveInt` (round-2: redacts the raw value
 *     when an env-config-rejected log line would otherwise echo a secret).
 *     None of the parsePositiveInt-managed env vars are sensitive today; this
 *     is defense-in-depth for any future operator-tunable knob whose name
 *     happens to match a secret pattern.
 *
 * Matching rule: case-insensitive `String.prototype.includes` against the
 * upper-cased key. So `UNICITY_OAUTH_BEARER` redacts via `BEARER`,
 * `UNICITY_TLS_CERT` via `CERT`, `UNICITY_TX_SIGNATURE` via `SIGNATURE`
 * (and `SIG` as a shorter fallback).
 */
export const SECRET_SUBSTRINGS: readonly string[] = [
  'SECRET',
  'TOKEN',
  'KEY',
  'PASSWORD',
  'PASS',
  'PRIV',
  'MNEMONIC',
  'NSEC',
  'CREDENTIAL',
  'AUTH',
  'BEARER',
  'COOKIE',
  'SESSION',
  'CERT',
  'SIGNATURE',
  'SIG',
];

/** Returns true iff `name` (case-insensitive) contains any secret substring. */
export function isSecretEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return SECRET_SUBSTRINGS.some((s) => upper.includes(s));
}
