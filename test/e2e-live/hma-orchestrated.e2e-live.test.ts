/**
 * Live e2e: HMA-orchestrated tenant lifecycle (escrow + 2 traders).
 *
 * Demonstrates the architecture the user actually wants for partner
 * demos and production: a Host Manager Agent (HMA) spawns and manages
 * every tenant container, controllers talk to the HMA via HMCP DMs,
 * and trade ops go controller→tenant directly via ACP DMs (host-
 * agnostic). NO direct `docker run` calls — the HMA owns lifecycle.
 *
 * Flow:
 *   1. Probe sphere-cli's binary and the agentic-hosting build. Skip
 *      gracefully if either is missing — both repos move
 *      independently and an upstream regression shouldn't fail this
 *      branch's CI.
 *   2. Bootstrap a controller wallet via `sphere wallet init`.
 *   3. Boot the host-manager binary with the controller pubkey in
 *      AUTHORIZED_CONTROLLERS.
 *   4. `sphere host spawn` for the escrow agent.
 *   5. `sphere host spawn` for trader Alice.
 *   6. `sphere host spawn` for trader Bob.
 *   7. `sphere host list` returns 3 RUNNING instances.
 *   8. Cleanup: `sphere host stop` for each, then stop the manager.
 *
 * This is the foundation test for the HMA-orchestrated e2e suite.
 * Subsequent PRs (PR-C in the migration plan) layer trade ops on top:
 * `sphere trader create-intent`, portfolio assertions, swap settlement.
 *
 * Performance target: ~3-4 minutes end-to-end on a healthy testnet
 * (manager boot ~30s, three spawn round-trips ~30s each including
 * `acp.hello`, three teardowns ~5s each).
 *
 * Skip semantics:
 *   describe.skipIf(!preconditions) — if either sphere-cli or
 *   agentic-hosting is unavailable, the suite skips with a clear
 *   diagnostic. The DM transport itself is covered by agentic-hosting's
 *   own live tests; this file specifically covers the trader-service
 *   integration seam.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  probeSphereCli,
  createSphereCliEnv,
  bootstrapControllerWallet,
  type SphereCliProbe,
} from './helpers/sphere-cli.js';
import { spawnHostManager, type HostManagerProcess } from './helpers/manager-process.js';
import {
  hostSpawn,
  hostStop,
  hostList,
  type SpawnedTenant,
} from './helpers/hma-spawn.js';

// ---------------------------------------------------------------------------
// Preconditions: sphere-cli runnable + agentic-hosting binary built.
// Evaluated at module-load time so describe.skipIf can short-circuit
// the entire suite without spending a second on Sphere.init.
// ---------------------------------------------------------------------------

const cliProbe: SphereCliProbe = probeSphereCli();

const agenticPath = (process.env['AGENTIC_HOSTING_PATH']?.trim()
  || '/home/vrogojin/agentic_hosting');
const managerBinPath = join(agenticPath, 'dist', 'host-manager.js');
const agenticReady = existsSync(managerBinPath);

const skip = !cliProbe.ok || !agenticReady;
const skipReason = !cliProbe.ok
  ? `sphere-cli not runnable: ${cliProbe.ok ? '' : cliProbe.reason}`
  : !agenticReady
    ? `agentic-hosting binary missing at ${managerBinPath}. Build it (cd ${agenticPath} && npm run build) or set AGENTIC_HOSTING_PATH.`
    : '';

interface SuiteState {
  cliPath: string;
  cliHome: string;
  controllerPubkey: string;
  manager: HostManagerProcess;
  spawned: SpawnedTenant[];
}

describe.skipIf(skip)('HMA-orchestrated tenant lifecycle (live testnet)', () => {
  if (skip) {
     
    console.warn(`[hma-orchestrated] SKIPPED: ${skipReason}`);
  }

  let state: SuiteState | null = null;

  beforeAll(async () => {
    if (skip) return;
    if (!cliProbe.ok) throw new Error('precondition gate inverted'); // type narrowing
    const cliPath = cliProbe.path;
    const { home: cliHome } = createSphereCliEnv('hma-test');
     
    console.log('[hma-orchestrated] bootstrapping controller wallet...');
    const controller = bootstrapControllerWallet(cliPath, cliHome);
     
    console.log(`[hma-orchestrated] controller pubkey ${controller.pubkey.slice(0, 16)}...`);

     
    console.log('[hma-orchestrated] booting host-manager...');
    const manager = await spawnHostManager({ controllerPubkey: controller.pubkey });
    await manager.ready;
     
    console.log(`[hma-orchestrated] manager ready @ ${manager.nametag ?? manager.directAddress}`);

    state = {
      cliPath,
      cliHome,
      controllerPubkey: controller.pubkey,
      manager,
      spawned: [],
    };
  }, 540_000); // 9 min — wallet bootstrap + manager boot can each be 60-90s on slow testnet

  afterAll(async () => {
    if (!state) return;
    // Stop all tenants in parallel — best-effort. The manager will
    // also force-remove on its own shutdown, but explicit stop keeps
    // tenants from leaking into the next run if the manager hangs.
    await Promise.allSettled(
      state.spawned.map((t) =>
        Promise.resolve(hostStop({
          cliPath: state!.cliPath,
          cliHome: state!.cliHome,
          managerAddress: state!.manager.pubkey,
          target: t.instanceName,
          timeoutMs: 60_000,
        })),
      ),
    );
    await state.manager.stop();
    try { rmSync(state.cliHome, { recursive: true, force: true }); }
    catch { /* best effort */ }
  }, 240_000);

  it('spawns escrow + 2 traders through the HMA and lists them as RUNNING', () => {
    if (!state) throw new Error('beforeAll did not initialize state');
    const s = state;

    // Use the manager's @nametag if available — otherwise fall back to
    // raw pubkey. sphere-cli accepts either.
    const managerAddr = s.manager.nametag ? `@${s.manager.nametag}` : s.manager.pubkey;

    // Unique suffix so concurrent runs don't collide on Docker labels.
    const runId = randomUUID().slice(0, 6);

     
    console.log('[hma-orchestrated] spawning escrow...');
    const escrow = hostSpawn({
      cliPath: s.cliPath,
      cliHome: s.cliHome,
      managerAddress: managerAddr,
      templateId: 'escrow-service',
      instanceName: `escrow-${runId}`,
      timeoutMs: 180_000,
    });
    s.spawned.push(escrow);
    expect(escrow.state).toBe('RUNNING');
    expect(escrow.tenantPubkey).toMatch(/^[0-9a-fA-F]{64,130}$/);
    expect(escrow.tenantDirectAddress).toMatch(/^DIRECT:\/\//);

     
    console.log(`[hma-orchestrated] escrow up: ${escrow.tenantNametag ?? escrow.tenantDirectAddress}`);

     
    console.log('[hma-orchestrated] spawning trader Alice...');
    // Note: not configuring TRUSTED_ESCROWS at spawn-time. The HMA
    // forbids UNICITY_* prefixes in controller-supplied env (security
    // policy: only the manager itself injects UNICITY_* boot vars).
    // Strategy/trust configuration belongs to runtime trade-ops via
    // `sphere trader set-strategy` — covered by PR-C, not the
    // lifecycle foundation test.
    const alice = hostSpawn({
      cliPath: s.cliPath,
      cliHome: s.cliHome,
      managerAddress: managerAddr,
      templateId: 'trader-agent',
      instanceName: `alice-${runId}`,
      timeoutMs: 180_000,
    });
    s.spawned.push(alice);
    expect(alice.state).toBe('RUNNING');


    console.log('[hma-orchestrated] spawning trader Bob...');
    const bob = hostSpawn({
      cliPath: s.cliPath,
      cliHome: s.cliHome,
      managerAddress: managerAddr,
      templateId: 'trader-agent',
      instanceName: `bob-${runId}`,
      timeoutMs: 180_000,
    });
    s.spawned.push(bob);
    expect(bob.state).toBe('RUNNING');

    // Verify all three are listed by the HMA as RUNNING.
     
    console.log('[hma-orchestrated] verifying via sphere host list...');
    const listed = hostList(s.cliPath, s.cliHome, managerAddr);
    const ourSpawns = listed.filter((i) => [escrow.instanceId, alice.instanceId, bob.instanceId].includes(i.instance_id));
    expect(ourSpawns).toHaveLength(3);
    for (const inst of ourSpawns) {
      expect(inst.state).toBe('RUNNING');
      expect(inst.tenant_pubkey).toMatch(/^[0-9a-fA-F]{64,130}$/);
    }
  }, 720_000); // 12 min — three real spawns × ~3min each on slow testnet
});
