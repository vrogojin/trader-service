/**
 * Ambient declaration for @unicitylabs/infra-probe — the package ships
 * pure-ESM .mjs without bundled .d.ts. Only typed to the surface our
 * preflight uses; the full report shape is re-typed locally in preflight.ts
 * with `as Report` so changes upstream surface as type errors there.
 */
declare module '@unicitylabs/infra-probe' {
  export interface ProbeOptions {
    network?: 'testnet' | 'mainnet' | 'dev';
    only?: string[];
    timeoutMs?: number;
    aggregatorApiKey?: string;
  }
  export function runProbes(options?: ProbeOptions): Promise<unknown>;
  export function exitCodeForReport(report: unknown): number;
  export const SERVICES: readonly string[];
}
