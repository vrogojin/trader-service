/**
 * Vitest globalSetup for the e2e-live suite.
 *
 * Runs ONCE before any test file. Two responsibilities:
 *
 *   1. Preflight gate — abort the run before spawning Docker tenants
 *      if any required testnet service (Nostr relay, L3 Aggregator,
 *      IPFS, Fulcrum, Market) is unreachable. Saves the 10-15-minute
 *      round trip we'd otherwise eat on an outage. Bypass:
 *      `TRADER_E2E_SKIP_PREFLIGHT=1`.
 *
 *   2. Local infra (opt-in) — when `TRADER_E2E_LOCAL_RELAY=1` is set,
 *      boot a Docker-hosted Nostr relay (see local-infra/relay.ts)
 *      and export `UNICITY_NOSTR_RELAYS` so every component that
 *      reads it (host-manager, escrow, trader, faucet) connects to
 *      the local relay instead of the public testnet. The relay
 *      binds to the host on 0.0.0.0:7777; HMA-spawned tenants reach
 *      it via the Docker bridge gateway IP (auto-discovered).
 *
 *      Tests that need to fan the URL into HMA-spawned tenants read
 *      `process.env['UNICITY_NOSTR_RELAYS']` and pass it via the
 *      `env` field on `hostSpawnAsync(...)`. The host-manager's own
 *      Sphere wallet picks it up automatically because spawnHostManager
 *      forwards the parent env (or the test sets it on the spawn env).
 *
 *      Local-relay mode SKIPS the preflight (the local relay is
 *      under our control; gating against the public testnet relay
 *      would defeat the purpose).
 */

import { runPreflight } from './preflight.js';
import { bootLocalRelay, getLocalRelayUrlForContainers, type RelayHandle } from './local-infra/relay.js';

let relayHandle: RelayHandle | null = null;

export async function setup(): Promise<void> {
  if (process.env['TRADER_E2E_LOCAL_RELAY'] === '1') {
    console.log('[global-setup] TRADER_E2E_LOCAL_RELAY=1 — booting local Nostr relay…');
    relayHandle = await bootLocalRelay({
      // Wipe by default so each `npm run test:e2e-live` starts from a clean
      // event log. Set TRADER_E2E_LOCAL_RELAY_KEEP=1 to preserve state
      // between runs (useful for post-mortem on a failing test).
      wipe: process.env['TRADER_E2E_LOCAL_RELAY_KEEP'] !== '1',
      timeoutMs: 60_000,
      logPrefix: '[global-setup] ',
    });
    const containerUrl = getLocalRelayUrlForContainers();
    process.env['UNICITY_NOSTR_RELAYS'] = containerUrl;
    process.env['TRADER_E2E_LOCAL_RELAY_HOST_URL'] = relayHandle.url;
    process.env['TRADER_E2E_LOCAL_RELAY_CONTAINER_URL'] = containerUrl;
    console.log(
      `[global-setup] local relay ready — host: ${relayHandle.url}, ` +
      `containers: ${containerUrl}`,
    );
    console.log('[global-setup] preflight SKIPPED (local relay supersedes testnet gate)');
    return;
  }
  await runPreflight();
}

export async function teardown(): Promise<void> {
  if (relayHandle) {
    console.log('[global-setup] stopping local Nostr relay…');
    try {
      await relayHandle.stop({ wipe: false });
    } catch (err) {
      console.error('[global-setup] relay stop error:', err);
    }
    relayHandle = null;
  }
}
