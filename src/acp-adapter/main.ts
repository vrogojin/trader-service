/**
 * Trader Service — ACP-wrapped entrypoint.
 *
 * This module is the entrypoint the agentic-hosting Host Manager invokes when
 * it spawns a trader tenant via Docker. The trader is unusual compared to the
 * escrow service: its standalone `src/trader/main.ts` ALREADY implements the
 * ACP-0 handshake (acp.hello / acp.hello_ack / heartbeat / acp.command) via
 * the in-tree AcpListener — there is no "standalone vs ACP-wrapped" duality
 * to bridge. So this module is intentionally a thin shim that delegates to
 * `startTrader()` and exists primarily to mirror the escrow-service Docker
 * layout (`dist/acp-adapter/main.js` as the default CMD).
 *
 * Spawn requirements (env vars injected by the Host Manager — see the
 * agentic-hosting Tenant Container Contract in
 * agentic-hosting/ref_materials/03-Tenant-CLI-Template.md):
 *   - UNICITY_MANAGER_PUBKEY
 *   - UNICITY_BOOT_TOKEN
 *   - UNICITY_INSTANCE_ID, UNICITY_INSTANCE_NAME, UNICITY_TEMPLATE_ID
 *   - UNICITY_NETWORK, UNICITY_DATA_DIR, UNICITY_TOKENS_DIR
 *
 * Optional env vars:
 *   - UNICITY_TRUSTED_ESCROWS — comma-separated list of escrow nametags or
 *     pubkeys the trader will accept as counterparties for swaps. See
 *     docs/configuration.md.
 *   - SPHERE_NAMETAG — the nametag the trader registers for itself.
 */

import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

import { startTrader } from '../trader/main.js';
import { createLogger } from '../shared/logger.js';

/**
 * Mirror trader/main.ts's `isMainModule` check so this shim can be
 * imported by tests (or other adapters) without unconditionally launching
 * the full Sphere bootstrap.
 */
function isMainModule(): boolean {
  try {
    const url = fileURLToPath(import.meta.url);
    const argv1 = process.argv[1];
    if (!argv1) return false;
    try {
      const realArgv1 = realpathSync(argv1);
      return url === realArgv1;
    } catch {
      return url === argv1 || url.endsWith(argv1) || argv1.endsWith(url);
    }
  } catch {
    return false;
  }
}

if (isMainModule()) {
  startTrader().catch((err) => {
    const logger = createLogger({ component: 'trader-acp-adapter' });
    logger.error('trader_acp_startup_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
