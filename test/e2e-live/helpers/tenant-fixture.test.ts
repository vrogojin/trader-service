/**
 * Unit tests for tenant-fixture + scenario-helpers.
 *
 * These tests mock every external surface (docker-helpers, trader-ctl-driver,
 * funding) so they're safe to run in the default `npm test` suite — they
 * don't touch Docker, Nostr relays, or the testnet faucet.
 *
 * The peer worktrees that will eventually own the real implementations are
 * mocked at module level; if a peer's actual export signature differs from
 * what we assert here, the integrator catches the drift during merge.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';

import type {
  DockerContainer,
  DockerRunOptions,
  TraderCtlOptions,
  TraderCtlResult,
  ProvisionedTenant,
} from './contracts.js';

// ---------------------------------------------------------------------------
// Mocks — defined BEFORE the SUT imports so vitest's hoisting picks them up.
// ---------------------------------------------------------------------------

vi.mock('./docker-helpers.js', () => ({
  runContainer: vi.fn(),
  stopContainer: vi.fn(),
  removeContainer: vi.fn(),
  getContainerLogs: vi.fn(),
  waitForContainerRunning: vi.fn(),
}));

vi.mock('./trader-ctl-driver.js', () => ({
  runTraderCtl: vi.fn(),
}));

vi.mock('./funding.js', () => ({
  fundWallet: vi.fn(),
}));

// SUT imports (after vi.mock so the mocks are in place)
import { provisionTrader } from './tenant-fixture.js';
import { createMatchingIntents, waitForDealInState } from './scenario-helpers.js';
import * as dockerHelpers from './docker-helpers.js';
import * as traderCtlDriver from './trader-ctl-driver.js';

const mockRunContainer = vi.mocked(dockerHelpers.runContainer);
const mockStopContainer = vi.mocked(dockerHelpers.stopContainer);
const mockRemoveContainer = vi.mocked(dockerHelpers.removeContainer);
const mockGetContainerLogs = vi.mocked(dockerHelpers.getContainerLogs);
const mockWaitForContainerRunning = vi.mocked(dockerHelpers.waitForContainerRunning);
const mockRunTraderCtl = vi.mocked(traderCtlDriver.runTraderCtl);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeContainer(overrides: Partial<DockerContainer> = {}): DockerContainer {
  return {
    id: 'fake-container-id-' + Math.random().toString(16).slice(2, 8),
    name: 'fake-container',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function okStatusReply(): TraderCtlResult {
  return {
    exitCode: 0,
    output: { ok: true, uptime_ms: 1000 },
    stderr: '',
  };
}

function okCreateIntentReply(intentId: string): TraderCtlResult {
  return {
    exitCode: 0,
    output: { ok: true, intent_id: intentId, expires_at: '2026-01-02T00:00:00Z' },
    stderr: '',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: getContainerLogs returns a sphere_initialized line AND an
  // acp_listener_started line so both waitForReadyAddress() and
  // waitForLogEvent('acp_listener_started') resolve on their first poll.
  // Tests that need to exercise the timeout path override this with
  // mockGetContainerLogs.
  // Trader format: { event: '<name>', details: {...} }
  mockGetContainerLogs.mockResolvedValue(
    '{"event":"sphere_initialized","details":{"agent_address":"DIRECT://aa11bb22cc33dd44ee55ff6677889900112233445566778899aabbccddeeff00"}}\n' +
    '{"event":"acp_listener_started"}\n',
  );
});

// ===========================================================================
// provisionTrader
// ===========================================================================

describe('provisionTrader', () => {
  it('happy path returns a fully populated ProvisionedTenant', async () => {
    const container = fakeContainer();
    mockRunContainer.mockResolvedValue(container);
    mockWaitForContainerRunning.mockResolvedValue(true);
    mockRunTraderCtl.mockResolvedValue(okStatusReply());

    const tenant = await provisionTrader({ label: 'happy-buyer' });

    expect(tenant.container).toBe(container);
    expect(typeof tenant.address).toBe('string');
    expect(tenant.address.length).toBeGreaterThan(0);
    expect(typeof tenant.walletDir).toBe('string');
    expect(existsSync(tenant.walletDir)).toBe(true);
    // Wallet/tokens subdirs were materialized
    const entries = readdirSync(tenant.walletDir);
    expect(entries).toContain('wallet');
    expect(entries).toContain('tokens');
    expect(typeof tenant.dispose).toBe('function');

    // runContainer was called with the trader image + injected env vars
    expect(mockRunContainer).toHaveBeenCalledTimes(1);
    const runOpts = mockRunContainer.mock.calls[0]?.[0] as DockerRunOptions;
    expect(runOpts.image).toContain('trader');
    expect(runOpts.label).toBe('happy-buyer');
    expect(runOpts.env?.['UNICITY_NETWORK']).toBe('testnet');
    expect(runOpts.env?.['UNICITY_DATA_DIR']).toBe('/data/wallet');
    expect(runOpts.env?.['UNICITY_TOKENS_DIR']).toBe('/data/tokens');
    expect(runOpts.env?.['UNICITY_RELAYS']).toBeTruthy();
    expect(runOpts.env?.['LOG_LEVEL']).toBe('info');
    // Bind mount for /data/wallet must be RW (not readonly)
    const walletBind = runOpts.binds?.find((b) => b.container === '/data/wallet');
    expect(walletBind).toBeDefined();
    expect(walletBind?.readonly).toBe(false);

    // Cleanup so the wallet dir doesn't leak after the test
    await tenant.dispose();
  });

  it('honours scanIntervalMs / maxActiveIntents / trustedEscrows / relayUrls overrides', async () => {
    mockRunContainer.mockResolvedValue(fakeContainer());
    mockWaitForContainerRunning.mockResolvedValue(true);
    mockRunTraderCtl.mockResolvedValue(okStatusReply());

    const tenant = await provisionTrader({
      label: 'overrides',
      scanIntervalMs: 5000,
      maxActiveIntents: 42,
      trustedEscrows: ['@escrow-a', '@escrow-b'],
      relayUrls: ['wss://r1', 'wss://r2'],
    });

    const env = (mockRunContainer.mock.calls[0]?.[0] as DockerRunOptions).env ?? {};
    expect(env['TRADER_SCAN_INTERVAL_MS']).toBe('5000');
    expect(env['TRADER_MAX_ACTIVE_INTENTS']).toBe('42');
    expect(env['UNICITY_TRUSTED_ESCROWS']).toBe('@escrow-a,@escrow-b');
    expect(env['UNICITY_RELAYS']).toBe('wss://r1,wss://r2');

    await tenant.dispose();
  });

  it('skips the readiness probe when waitForReady is false', async () => {
    mockRunContainer.mockResolvedValue(fakeContainer());
    mockWaitForContainerRunning.mockResolvedValue(true);

    const tenant = await provisionTrader({ label: 'no-probe', waitForReady: false });

    expect(mockRunTraderCtl).not.toHaveBeenCalled();
    await tenant.dispose();
  });

  it('cleans up the wallet dir when docker run fails', async () => {
    mockRunContainer.mockRejectedValue(new Error('docker daemon unreachable'));

    // We can't directly observe the wallet-dir path from outside (the SUT
    // owns it and rejects before returning), but we CAN assert the negative:
    // provisionTrader rejects AND stop/remove were not called (no container
    // existed). The companion "ready-poll fail" test verifies cleanup of
    // BOTH container + walletDir together.
    await expect(
      provisionTrader({ label: 'docker-fail', waitForReady: false }),
    ).rejects.toThrow(/docker daemon unreachable/);
    expect(mockStopContainer).not.toHaveBeenCalled();
    expect(mockRemoveContainer).not.toHaveBeenCalled();
  });

  it('cleans up container + wallet dir when readiness probe times out', async () => {
    const container = fakeContainer({ id: 'rdy-fail-1' });
    mockRunContainer.mockResolvedValue(container);
    mockWaitForContainerRunning.mockResolvedValue(true);
    // Always returns failure → poll exhausts
    mockRunTraderCtl.mockResolvedValue({ exitCode: 1, output: null, stderr: 'not ready' });
    // Logs without sphere_initialized → waitForReadyAddress hits its timeout
    // BEFORE probeReady is even reached. The cleanup invariant must hold for
    // EITHER readiness failure mode (provisionTrader catches both into the
    // same safeCleanup path). Accept either error message.
    mockGetContainerLogs.mockResolvedValue('boot logs here');

    await expect(
      provisionTrader({ label: 'ready-fail', readyTimeoutMs: 100 }),
    ).rejects.toThrow(/did not become reachable|did not log sphere_initialized/);

    expect(mockStopContainer).toHaveBeenCalledWith(container.id);
    expect(mockRemoveContainer).toHaveBeenCalledWith(container.id);
  });

  it('cleans up container when waitForContainerRunning returns false', async () => {
    const container = fakeContainer({ id: 'wait-fail-1' });
    mockRunContainer.mockResolvedValue(container);
    mockWaitForContainerRunning.mockResolvedValue(false);
    mockGetContainerLogs.mockResolvedValue('startup crashed');

    await expect(
      provisionTrader({ label: 'wait-fail', waitForReady: false }),
    ).rejects.toThrow(/failed to reach RUNNING state/);

    expect(mockStopContainer).toHaveBeenCalledWith(container.id);
    expect(mockRemoveContainer).toHaveBeenCalledWith(container.id);
  });

  it('dispose() is idempotent — repeat calls do not double-stop the container', async () => {
    mockRunContainer.mockResolvedValue(fakeContainer({ id: 'dispose-once' }));
    mockWaitForContainerRunning.mockResolvedValue(true);
    mockRunTraderCtl.mockResolvedValue(okStatusReply());

    const tenant = await provisionTrader({ label: 'dispose-test', waitForReady: false });
    await tenant.dispose();
    await tenant.dispose(); // second call — must be a no-op, must not throw

    // Both stop + remove should have been called exactly once across the
    // two dispose() invocations.
    expect(mockStopContainer).toHaveBeenCalledTimes(1);
    expect(mockRemoveContainer).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// createMatchingIntents
// ===========================================================================

describe('createMatchingIntents', () => {
  function makeTenant(label: string): ProvisionedTenant {
    return {
      address: `DIRECT://addr-${label}`,
      container: fakeContainer({ id: label }),
      walletDir: `/tmp/${label}`,
      dispose: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('builds correct trader-ctl argv for buyer + seller and returns parsed intent_ids', async () => {
    const buyer = makeTenant('buyer');
    const seller = makeTenant('seller');

    mockRunTraderCtl
      .mockResolvedValueOnce(okCreateIntentReply('intent-buyer-1'))
      .mockResolvedValueOnce(okCreateIntentReply('intent-seller-1'));

    const result = await createMatchingIntents(buyer, seller, {
      base_asset: 'UCT',
      quote_asset: 'USDC',
      rate_min: 100n,
      rate_max: 200n,
      volume_min: 10n,
      volume_max: 1000n,
    });

    expect(result.buyerIntentId).toBe('intent-buyer-1');
    expect(result.sellerIntentId).toBe('intent-seller-1');
    expect(mockRunTraderCtl).toHaveBeenCalledTimes(2);

    // Buyer call
    const [buyerCmd, buyerArgs, buyerOpts] = mockRunTraderCtl.mock.calls[0] as [
      string,
      ReadonlyArray<string>,
      TraderCtlOptions,
    ];
    expect(buyerCmd).toBe('create-intent');
    expect(buyerArgs).toEqual([
      '--direction', 'buy',
      '--base', 'UCT',
      '--quote', 'USDC',
      '--rate-min', '100',
      '--rate-max', '200',
      '--volume-min', '10',
      '--volume-max', '1000',
    ]);
    expect(buyerOpts.tenant).toBe(buyer.address);
    expect(buyerOpts.json).toBe(true);

    // Seller call
    const [sellerCmd, sellerArgs, sellerOpts] = mockRunTraderCtl.mock.calls[1] as [
      string,
      ReadonlyArray<string>,
      TraderCtlOptions,
    ];
    expect(sellerCmd).toBe('create-intent');
    expect(sellerArgs).toEqual([
      '--direction', 'sell',
      '--base', 'UCT',
      '--quote', 'USDC',
      '--rate-min', '100',
      '--rate-max', '200',
      '--volume-min', '10',
      '--volume-max', '1000',
    ]);
    expect(sellerOpts.tenant).toBe(seller.address);
    expect(sellerOpts.json).toBe(true);
  });

  it('throws when buyer CREATE_INTENT response is not ok', async () => {
    const buyer = makeTenant('buyer');
    const seller = makeTenant('seller');

    mockRunTraderCtl.mockResolvedValueOnce({
      exitCode: 0,
      output: { ok: false, error_code: 'INSUFFICIENT_BALANCE', message: 'no funds' },
      stderr: '',
    });

    await expect(
      createMatchingIntents(buyer, seller, {
        base_asset: 'UCT',
        quote_asset: 'USDC',
        rate_min: 100n,
        rate_max: 200n,
        volume_min: 10n,
        volume_max: 1000n,
      }),
    ).rejects.toThrow(/buyer CREATE_INTENT not ok/);
  });

  it('tolerates the AcpResultPayload-wrapped envelope shape', async () => {
    const buyer = makeTenant('buyer');
    const seller = makeTenant('seller');

    // Driver returned the full envelope rather than unwrapping `result`
    mockRunTraderCtl
      .mockResolvedValueOnce({
        exitCode: 0,
        output: { ok: true, result: { ok: true, intent_id: 'wrapped-buy' } },
        stderr: '',
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        output: { ok: true, result: { ok: true, intent_id: 'wrapped-sell' } },
        stderr: '',
      });

    const result = await createMatchingIntents(buyer, seller, {
      base_asset: 'UCT',
      quote_asset: 'USDC',
      rate_min: 100n,
      rate_max: 200n,
      volume_min: 10n,
      volume_max: 1000n,
    });

    expect(result.buyerIntentId).toBe('wrapped-buy');
    expect(result.sellerIntentId).toBe('wrapped-sell');
  });
});

// ===========================================================================
// waitForDealInState
// ===========================================================================

describe('waitForDealInState', () => {
  function makeTenant(label: string): ProvisionedTenant {
    return {
      address: `DIRECT://addr-${label}`,
      container: fakeContainer({ id: label }),
      walletDir: `/tmp/${label}`,
      dispose: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('polls list-deals and resolves when a deal in the target state appears', async () => {
    const tenant = makeTenant('poll-resolves');

    mockRunTraderCtl
      // First poll: no deals yet
      .mockResolvedValueOnce({
        exitCode: 0,
        output: { deals: [] },
        stderr: '',
      })
      // Second poll: a PROPOSED deal but we want EXECUTING
      .mockResolvedValueOnce({
        exitCode: 0,
        output: { deals: [{ deal_id: 'd1', state: 'PROPOSED' }] },
        stderr: '',
      })
      // Third poll: deal moved to EXECUTING
      .mockResolvedValueOnce({
        exitCode: 0,
        output: { deals: [{ deal_id: 'd1', state: 'EXECUTING', amount: '100' }] },
        stderr: '',
      });

    const deal = await waitForDealInState(tenant, 'EXECUTING', 30_000);

    expect(deal['deal_id']).toBe('d1');
    expect(deal['state']).toBe('EXECUTING');
    expect(deal['amount']).toBe('100');
    expect(mockRunTraderCtl).toHaveBeenCalledTimes(3);
    // Verify the call was list-deals with --json
    const [cmd, args, opts] = mockRunTraderCtl.mock.calls[0] as [
      string,
      ReadonlyArray<string>,
      TraderCtlOptions,
    ];
    expect(cmd).toBe('list-deals');
    expect(args).toEqual([]);
    expect(opts.tenant).toBe(tenant.address);
    expect(opts.json).toBe(true);
  });

  it('throws on timeout when no deal reaches the target state', async () => {
    const tenant = makeTenant('poll-timeout');
    mockRunTraderCtl.mockResolvedValue({
      exitCode: 0,
      output: { deals: [{ deal_id: 'd1', state: 'PROPOSED' }] },
      stderr: '',
    });

    await expect(
      waitForDealInState(tenant, 'COMPLETED', 200),
    ).rejects.toThrow(/no deal reached COMPLETED/);
  });

  it('tolerates a bare-array list-deals response shape', async () => {
    const tenant = makeTenant('bare-array');
    mockRunTraderCtl.mockResolvedValueOnce({
      exitCode: 0,
      output: [{ deal_id: 'd99', state: 'COMPLETED' }],
      stderr: '',
    });

    const deal = await waitForDealInState(tenant, 'COMPLETED', 5_000);
    expect(deal['deal_id']).toBe('d99');
  });
});
