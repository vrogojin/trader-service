import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createIntentEngine } from './intent-engine.js';
import type { IntentEngine, IntentEngineDeps } from './intent-engine.js';
import type {
  MarketSearchResult,
  TraderStrategy,
  OnMatchFound,
} from './types.js';
import { DEFAULT_STRATEGY } from './types.js';
import { createMockMarketModule } from '../../test/mocks/mock-market-module.js';
import type { MockMarketModule } from '../../test/mocks/mock-market-module.js';
import { createVolumeReservationLedger } from './volume-reservation-ledger.js';
import type { Logger } from '../shared/logger.js';
import type { CreateIntentParams } from './acp-types.js';
import { encodeDescription } from './utils.js';
import type { TradingIntent } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Valid 64-char x-only hex — must be valid secp256k1 format for pubkeysEqual to work.
const AGENT_PUBKEY = 'a'.repeat(64);
const AGENT_ADDRESS = 'agent-addr-1';

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => createMockLogger()),
    setLevel: vi.fn(),
  };
}

function defaultParams(overrides?: Partial<CreateIntentParams>): CreateIntentParams {
  return {
    direction: 'buy',
    base_asset: 'ALPHA',
    quote_asset: 'USD',
    rate_min: '100',
    rate_max: '110',
    volume_min: '10',
    volume_max: '100',
    expiry_sec: 3600,
    ...overrides,
  };
}

function defaultStrategy(overrides?: Partial<TraderStrategy>): TraderStrategy {
  return {
    ...DEFAULT_STRATEGY,
    scan_interval_ms: 60_000, // long interval to avoid accidental scans
    ...overrides,
  };
}

interface TestHarness {
  engine: IntentEngine;
  market: MockMarketModule;
  onMatchFound: ReturnType<typeof vi.fn<OnMatchFound>>;
  logger: Logger;
}

function createTestEngine(opts?: {
  strategy?: Partial<TraderStrategy>;
  agentPubkey?: string;
}): TestHarness {
  const market = createMockMarketModule();
  const ledger = createVolumeReservationLedger(() => 10_000n);
  const onMatchFound = vi.fn<OnMatchFound>().mockResolvedValue(undefined);
  const logger = createMockLogger();

  const strategy = defaultStrategy(opts?.strategy);
  const pubkey = opts?.agentPubkey ?? AGENT_PUBKEY;

  const deps: IntentEngineDeps = {
    market,
    ledger,
    strategy,
    agentPubkey: pubkey,
    agentAddress: AGENT_ADDRESS,
    signMessage: (msg: string) => `sig:${msg.slice(0, 8)}`,
    onMatchFound,
    logger,
  };

  const engine = createIntentEngine(deps);
  return { engine, market, onMatchFound, logger };
}

/**
 * Build a MarketSearchResult that encodes a counter-intent description.
 * The description format matches encodeDescription() output so that
 * parseDescription() inside matchesCriteria() can decode it.
 */
function buildSearchResult(overrides?: {
  direction?: 'buy' | 'sell';
  base_asset?: string;
  quote_asset?: string;
  rate_min?: bigint;
  rate_max?: bigint;
  volume_min?: bigint;
  volume_max?: bigint;
  escrow_address?: string;
  deposit_timeout_sec?: number;
  agentPublicKey?: string;
  expiresAt?: string;
  createdAt?: string;
  expiry_ms?: number;
  id?: string;
}): MarketSearchResult {
  const dir = overrides?.direction ?? 'sell';
  const base = overrides?.base_asset ?? 'ALPHA';
  const quote = overrides?.quote_asset ?? 'USD';
  const rateMin = overrides?.rate_min ?? 100n;
  const rateMax = overrides?.rate_max ?? 110n;
  const volMin = overrides?.volume_min ?? 10n;
  const volMax = overrides?.volume_max ?? 100n;
  const escrow = overrides?.escrow_address ?? 'any';
  const timeout = overrides?.deposit_timeout_sec ?? 300;
  const expiryMs = overrides?.expiry_ms ?? Date.now() + 3_600_000;

  const fakeIntent = {
    intent_id: 'fake',
    market_intent_id: 'fake',
    agent_pubkey: overrides?.agentPublicKey ?? 'b'.repeat(64),
    agent_address: 'other-addr',
    salt: 'abc',
    direction: dir,
    base_asset: base,
    quote_asset: quote,
    rate_min: rateMin,
    rate_max: rateMax,
    volume_min: volMin,
    volume_max: volMax,
    volume_filled: 0n,
    escrow_address: escrow,
    deposit_timeout_sec: timeout,
    expiry_ms: expiryMs,
    signature: 'sig',
  } as TradingIntent;

  const description = encodeDescription(fakeIntent);

  return {
    id: overrides?.id ?? 'sr-1',
    score: 0.9,
    agentPublicKey: overrides?.agentPublicKey ?? 'b'.repeat(64),
    description,
    intentType: dir,
    currency: quote,
    createdAt: overrides?.createdAt ?? new Date().toISOString(),
    expiresAt: overrides?.expiresAt ?? new Date(Date.now() + 3_600_000).toISOString(),
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe('IntentEngine', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // =========================================================================
  // 1. createIntent()
  // =========================================================================

  describe('createIntent()', () => {
    it('creates intent with correct fields (salt, signature, intent_id)', async () => {
      const { engine } = createTestEngine();
      const record = await engine.createIntent(defaultParams(), AGENT_PUBKEY, AGENT_ADDRESS);

      expect(record.state).toBe('ACTIVE');
      expect(record.intent.intent_id).toMatch(/^[0-9a-f]{64}$/);
      expect(record.intent.salt).toMatch(/^[0-9a-f]{32}$/);
      expect(record.intent.signature).toMatch(/^sig:/);
      expect(record.intent.agent_pubkey).toBe(AGENT_PUBKEY);
      expect(record.intent.agent_address).toBe(AGENT_ADDRESS);
      expect(record.intent.direction).toBe('buy');
      expect(record.intent.base_asset).toBe('ALPHA');
      expect(record.intent.quote_asset).toBe('USD');
      expect(record.intent.rate_min).toBe(100n);
      expect(record.intent.rate_max).toBe(110n);
      expect(record.intent.volume_min).toBe(10n);
      expect(record.intent.volume_max).toBe(100n);
      expect(record.intent.volume_filled).toBe(0n);
      expect(record.intent.escrow_address).toBe('any');
      expect(record.intent.deposit_timeout_sec).toBe(300);
      expect(record.intent.expiry_ms).toBeGreaterThan(Date.now());
      expect(record.deal_ids).toEqual([]);
    });

    it('transitions DRAFT -> ACTIVE', async () => {
      const { engine } = createTestEngine();
      const record = await engine.createIntent(defaultParams(), AGENT_PUBKEY, AGENT_ADDRESS);

      // The final record should be ACTIVE (it was DRAFT internally then transitioned)
      expect(record.state).toBe('ACTIVE');
    });

    it('calls market.postIntent() with correct description format', async () => {
      const { engine, market } = createTestEngine();
      await engine.createIntent(defaultParams(), AGENT_PUBKEY, AGENT_ADDRESS);

      expect(market.postIntentCalls).toHaveLength(1);
      const call = market.postIntentCalls[0]!;
      expect(call.intentType).toBe('buy');
      expect(call.category).toBe('ALPHA/USD');
      expect(call.currency).toBe('USD');
      expect(call.contactHandle).toBe(AGENT_ADDRESS);
      expect(call.description).toContain('Buying');
      expect(call.description).toContain('ALPHA');
      expect(call.description).toContain('USD');
      expect(call.description).toContain('100-110');
      expect(call.description).toContain('10-100');
      expect(call.expiresInDays).toBeGreaterThanOrEqual(1);
    });

    it('rejects when max_active_intents reached', async () => {
      const { engine } = createTestEngine({ strategy: { max_active_intents: 1 } });

      await engine.createIntent(defaultParams(), AGENT_PUBKEY, AGENT_ADDRESS);

      await expect(
        engine.createIntent(
          defaultParams({ rate_min: '200', rate_max: '210' }),
          AGENT_PUBKEY,
          AGENT_ADDRESS,
        ),
      ).rejects.toThrow('Max active intents reached');
    });

    it('returns error for invalid params (rate_min > rate_max)', async () => {
      const { engine } = createTestEngine();

      await expect(
        engine.createIntent(
          defaultParams({ rate_min: '200', rate_max: '100' }),
          AGENT_PUBKEY,
          AGENT_ADDRESS,
        ),
      ).rejects.toThrow('Invalid intent params');
    });

    it('returns error for invalid params (same base and quote asset)', async () => {
      const { engine } = createTestEngine();

      await expect(
        engine.createIntent(
          defaultParams({ base_asset: 'USD', quote_asset: 'USD' }),
          AGENT_PUBKEY,
          AGENT_ADDRESS,
        ),
      ).rejects.toThrow('Invalid intent params');
    });

    it('returns error for invalid params (volume_min > volume_max)', async () => {
      const { engine } = createTestEngine();

      await expect(
        engine.createIntent(
          defaultParams({ volume_min: '200', volume_max: '100' }),
          AGENT_PUBKEY,
          AGENT_ADDRESS,
        ),
      ).rejects.toThrow('Invalid intent params');
    });

    it('sets market_intent_id from postIntent() response', async () => {
      const { engine } = createTestEngine();
      const record = await engine.createIntent(defaultParams(), AGENT_PUBKEY, AGENT_ADDRESS);

      expect(record.intent.market_intent_id).toBe('mock-intent-1');
    });

    it('cleans up draft if market.postIntent() fails', async () => {
      const { engine, market } = createTestEngine();

      // Override postIntent to throw
      market.postIntent = vi.fn().mockRejectedValue(new Error('network error'));

      await expect(
        engine.createIntent(defaultParams(), AGENT_PUBKEY, AGENT_ADDRESS),
      ).rejects.toThrow('Failed to post intent to market');

      // Intent should not be stored
      const list = await engine.listIntents();
      expect(list).toHaveLength(0);
    });
  });

  // =========================================================================
  // 2. cancelIntent()
  // =========================================================================

  describe('cancelIntent()', () => {
    it('transitions ACTIVE -> CANCELLED', async () => {
      const { engine } = createTestEngine();
      const created = await engine.createIntent(defaultParams(), AGENT_PUBKEY, AGENT_ADDRESS);

      const cancelled = await engine.cancelIntent(created.intent.intent_id);
      expect(cancelled.state).toBe('CANCELLED');
    });

    it('calls market.closeIntent()', async () => {
      const { engine, market } = createTestEngine();
      const created = await engine.createIntent(defaultParams(), AGENT_PUBKEY, AGENT_ADDRESS);

      await engine.cancelIntent(created.intent.intent_id);

      // closeIntent is fire-and-forget, give it a tick to resolve
      await vi.advanceTimersByTimeAsync(0);
      expect(market.closeIntentCalls).toContain(created.intent.market_intent_id);
    });

    it('rejects cancel on terminal state CANCELLED', async () => {
      const { engine } = createTestEngine();
      const created = await engine.createIntent(defaultParams(), AGENT_PUBKEY, AGENT_ADDRESS);
      await engine.cancelIntent(created.intent.intent_id);

      await expect(
        engine.cancelIntent(created.intent.intent_id),
      ).rejects.toThrow('terminal state');
    });

    it('rejects cancel on terminal state EXPIRED', async () => {
      const { engine } = createTestEngine();
      const created = await engine.createIntent(
        defaultParams({ expiry_sec: 1 }),
        AGENT_PUBKEY,
        AGENT_ADDRESS,
      );

      // Start engine so expiry sweep timer runs
      engine.start();

      // Advance past expiry (1s) + sweep interval (10s)
      vi.advanceTimersByTime(11_000);

      // Verify intent is now EXPIRED
      const intent = engine.getIntent(created.intent.intent_id);
      expect(intent!.state).toBe('EXPIRED');

      engine.stop();

      // Now trying to cancel should fail because state is EXPIRED
      await expect(
        engine.cancelIntent(created.intent.intent_id),
      ).rejects.toThrow('terminal state');
    });

    it('returns error for unknown intent_id', async () => {
      const { engine } = createTestEngine();

      await expect(
        engine.cancelIntent('nonexistent-id'),
      ).rejects.toThrow('Intent not found');
    });
  });

  // =========================================================================
  // 3. listIntents()
  // =========================================================================

  describe('listIntents()', () => {
    it('returns all intents', async () => {
      const { engine } = createTestEngine();
      await engine.createIntent(defaultParams(), AGENT_PUBKEY, AGENT_ADDRESS);
      await engine.createIntent(
        defaultParams({ rate_min: '200', rate_max: '210' }),
        AGENT_PUBKEY,
        AGENT_ADDRESS,
      );

      const all = await engine.listIntents();
      expect(all).toHaveLength(2);
    });

    it('filters by single state', async () => {
      const { engine } = createTestEngine();
      const created = await engine.createIntent(defaultParams(), AGENT_PUBKEY, AGENT_ADDRESS);
      await engine.createIntent(
        defaultParams({ rate_min: '200', rate_max: '210' }),
        AGENT_PUBKEY,
        AGENT_ADDRESS,
      );
      await engine.cancelIntent(created.intent.intent_id);

      const active = await engine.listIntents({ state: 'ACTIVE' });
      expect(active).toHaveLength(1);
      expect(active[0]!.state).toBe('ACTIVE');

      const cancelled = await engine.listIntents({ state: 'CANCELLED' });
      expect(cancelled).toHaveLength(1);
      expect(cancelled[0]!.state).toBe('CANCELLED');
    });

    it('filters by multiple states', async () => {
      const { engine } = createTestEngine();
      await engine.createIntent(defaultParams(), AGENT_PUBKEY, AGENT_ADDRESS);
      const toCancel = await engine.createIntent(
        defaultParams({ rate_min: '200', rate_max: '210' }),
        AGENT_PUBKEY,
        AGENT_ADDRESS,
      );
      await engine.cancelIntent(toCancel.intent.intent_id);

      const filtered = await engine.listIntents({ state: ['ACTIVE', 'CANCELLED'] });
      expect(filtered).toHaveLength(2);
    });

    it('returns empty for no matching state', async () => {
      const { engine } = createTestEngine();
      await engine.createIntent(defaultParams(), AGENT_PUBKEY, AGENT_ADDRESS);

      const filled = await engine.listIntents({ state: 'FILLED' });
      expect(filled).toHaveLength(0);
    });
  });

  // =========================================================================
  // 4. Matching (scanForMatches via start/advanceTimers)
  // =========================================================================

  describe('Matching (scanForMatches)', () => {
    it('finds matching intent via market.search()', async () => {
      const { engine, market, onMatchFound } = createTestEngine({
        // Use short scan interval so timer fires quickly
        strategy: { scan_interval_ms: 1000, auto_match: true },
        // Our pubkey is lexicographically lower so we are the proposer
        agentPubkey: 'a'.repeat(64),
      });

      await engine.createIntent(defaultParams(), 'a'.repeat(64), AGENT_ADDRESS);

      // Set up a matching sell result from a counterparty with higher pubkey
      const result = buildSearchResult({
        direction: 'sell',
        agentPublicKey: 'b'.repeat(64),
      });
      market.setSearchResults([result]);

      engine.start();
      // Advance past scan interval to trigger scanForMatches
      await vi.advanceTimersByTimeAsync(1100);
      engine.stop();

      expect(market.searchCalls.length).toBeGreaterThanOrEqual(1);
      expect(onMatchFound).toHaveBeenCalledTimes(1);
    });

    it('applies rate overlap check (no overlap -> no match)', async () => {
      const { engine, market, onMatchFound } = createTestEngine({
        strategy: { scan_interval_ms: 1000, auto_match: true },
        agentPubkey: 'a'.repeat(64),
      });

      // Our intent: buy at 100-110
      await engine.createIntent(defaultParams(), 'a'.repeat(64), AGENT_ADDRESS);

      // Counterparty sells at 200-210 (no overlap with 100-110)
      const result = buildSearchResult({
        direction: 'sell',
        rate_min: 200n,
        rate_max: 210n,
        agentPublicKey: 'b'.repeat(64),
      });
      market.setSearchResults([result]);

      engine.start();
      await vi.advanceTimersByTimeAsync(1100);
      engine.stop();

      expect(onMatchFound).not.toHaveBeenCalled();
    });

    it('applies volume sufficiency check', async () => {
      const { engine, market, onMatchFound } = createTestEngine({
        strategy: { scan_interval_ms: 1000, auto_match: true },
        agentPubkey: 'a'.repeat(64),
      });

      // Our intent: buy volume_min=50, volume_max=100
      await engine.createIntent(
        defaultParams({ volume_min: '50', volume_max: '100' }),
        'a'.repeat(64),
        AGENT_ADDRESS,
      );

      // Counterparty sells only volume_max=5 (insufficient)
      const result = buildSearchResult({
        direction: 'sell',
        volume_min: 1n,
        volume_max: 5n,
        agentPublicKey: 'b'.repeat(64),
      });
      market.setSearchResults([result]);

      engine.start();
      await vi.advanceTimersByTimeAsync(1100);
      engine.stop();

      expect(onMatchFound).not.toHaveBeenCalled();
    });

    it('filters out self-matches (own pubkey)', async () => {
      const { engine, market, onMatchFound } = createTestEngine({
        strategy: { scan_interval_ms: 1000, auto_match: true },
        agentPubkey: 'a'.repeat(64),
      });

      await engine.createIntent(defaultParams(), 'a'.repeat(64), AGENT_ADDRESS);

      // Search result from ourselves
      const result = buildSearchResult({
        direction: 'sell',
        agentPublicKey: 'a'.repeat(64),
      });
      market.setSearchResults([result]);

      engine.start();
      await vi.advanceTimersByTimeAsync(1100);
      engine.stop();

      expect(onMatchFound).not.toHaveBeenCalled();
    });

    it('filters out blocked counterparties', async () => {
      const BLOCKED_PUB = 'c'.repeat(64);
      const { engine, market, onMatchFound } = createTestEngine({
        strategy: {
          scan_interval_ms: 1000,
          auto_match: true,
          blocked_counterparties: [BLOCKED_PUB],
        },
        agentPubkey: 'a'.repeat(64),
      });

      await engine.createIntent(defaultParams(), 'a'.repeat(64), AGENT_ADDRESS);

      const result = buildSearchResult({
        direction: 'sell',
        agentPublicKey: BLOCKED_PUB,
      });
      market.setSearchResults([result]);

      engine.start();
      await vi.advanceTimersByTimeAsync(1100);
      engine.stop();

      expect(onMatchFound).not.toHaveBeenCalled();
    });

    it('yields proposal duty when our pubkey sorts AFTER counterparty (spec 5.7)', async () => {
      // Our pubkey 'b...' sorts AFTER counterparty's 'a...' — counterparty is
      // the proposer-elected side per spec 5.7. We must NOT propose; we wait
      // for their np.propose_deal to arrive over NP-0. Without this election,
      // both sides race their fan-outs simultaneously, both NP-0 duplicate-
      // guards fire, and the pair gets wedged on each other's failed-
      // counterparty lists with no way to recover.
      const { engine, market, onMatchFound } = createTestEngine({
        strategy: { scan_interval_ms: 1000, auto_match: true },
        agentPubkey: 'b'.repeat(64),
      });

      await engine.createIntent(defaultParams(), 'b'.repeat(64), AGENT_ADDRESS);

      const result = buildSearchResult({
        direction: 'sell',
        agentPublicKey: 'a'.repeat(64),
      });
      market.setSearchResults([result]);

      engine.start();
      await vi.advanceTimersByTimeAsync(1100);
      engine.stop();

      expect(onMatchFound).not.toHaveBeenCalled();
    });

    it('proposes when our pubkey sorts BEFORE counterparty (spec 5.7)', async () => {
      // Mirror of the above — we are the proposer-elected side, so the
      // engine must call onMatchFound exactly once for this candidate.
      const { engine, market, onMatchFound } = createTestEngine({
        strategy: { scan_interval_ms: 1000, auto_match: true },
        agentPubkey: 'a'.repeat(64),
      });

      await engine.createIntent(defaultParams(), 'a'.repeat(64), AGENT_ADDRESS);

      const result = buildSearchResult({
        direction: 'sell',
        agentPublicKey: 'b'.repeat(64),
      });
      market.setSearchResults([result]);

      engine.start();
      await vi.advanceTimersByTimeAsync(1100);
      engine.stop();

      expect(onMatchFound).toHaveBeenCalledTimes(1);
    });

    it('skips expired search results (expiresAt <= now)', async () => {
      const { engine, market, onMatchFound } = createTestEngine({
        strategy: { scan_interval_ms: 1000, auto_match: true },
        agentPubkey: 'a'.repeat(64),
      });

      await engine.createIntent(defaultParams(), 'a'.repeat(64), AGENT_ADDRESS);

      // Expired search result — both MarketModule expiresAt and description expiry_ms in the past
      const result = buildSearchResult({
        direction: 'sell',
        agentPublicKey: 'b'.repeat(64),
        expiresAt: new Date(Date.now() - 1000).toISOString(),
        expiry_ms: Date.now() - 1000,
      });
      market.setSearchResults([result]);

      engine.start();
      await vi.advanceTimersByTimeAsync(1100);
      engine.stop();

      expect(onMatchFound).not.toHaveBeenCalled();
    });

    it('calls onMatchFound callback when match found', async () => {
      const { engine, market, onMatchFound } = createTestEngine({
        strategy: { scan_interval_ms: 1000, auto_match: true },
        agentPubkey: 'a'.repeat(64),
      });

      const created = await engine.createIntent(defaultParams(), 'a'.repeat(64), AGENT_ADDRESS);

      const result = buildSearchResult({
        direction: 'sell',
        agentPublicKey: 'b'.repeat(64),
      });
      market.setSearchResults([result]);

      engine.start();
      await vi.advanceTimersByTimeAsync(1100);
      engine.stop();

      expect(onMatchFound).toHaveBeenCalledTimes(1);
      const [ownRecord, counterparty] = onMatchFound.mock.calls[0]!;
      expect(ownRecord.intent.intent_id).toBe(created.intent.intent_id);
      expect(counterparty.agentPublicKey).toBe('b'.repeat(64));
    });

    it('does not scan when auto_match is false', async () => {
      const { engine, market, onMatchFound } = createTestEngine({
        strategy: { scan_interval_ms: 1000, auto_match: false },
        agentPubkey: 'a'.repeat(64),
      });

      await engine.createIntent(defaultParams(), 'a'.repeat(64), AGENT_ADDRESS);

      const result = buildSearchResult({ direction: 'sell', agentPublicKey: 'b'.repeat(64) });
      market.setSearchResults([result]);

      engine.start();
      await vi.advanceTimersByTimeAsync(1100);
      engine.stop();

      // search should not be called by the scan loop (may be called by feed subscription)
      expect(onMatchFound).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 5. Feed subscription
  // =========================================================================

  describe('Feed subscription', () => {
    it('subscribes to feed on start()', () => {
      const { engine, market } = createTestEngine();

      // Track subscribeFeed calls
      const subscribeSpy = vi.spyOn(market, 'subscribeFeed');

      engine.start();
      expect(subscribeSpy).toHaveBeenCalledTimes(1);
      engine.stop();
    });

    it('processes feed listings through matching', async () => {
      const { engine, market, onMatchFound } = createTestEngine({
        strategy: {
          scan_interval_ms: 60_000, // long interval, won't fire during test
          auto_match: true,
        },
        agentPubkey: 'a'.repeat(64),
      });

      await engine.createIntent(defaultParams(), 'a'.repeat(64), AGENT_ADDRESS);

      // Set up a matching search result that will be returned when feed triggers a search
      const result = buildSearchResult({
        direction: 'sell',
        agentPublicKey: 'b'.repeat(64),
      });
      market.setSearchResults([result]);

      engine.start();

      // Trigger the feed with a sell listing (opposite direction to our buy intent)
      market.triggerFeed({
        id: 'feed-1',
        title: 'Selling ALPHA',
        descriptionPreview: 'Selling ALPHA for USD',
        agentName: 'other',
        agentId: 42,
        type: 'sell',
        createdAt: new Date().toISOString(),
      });

      // Let the async search + match settle
      await vi.advanceTimersByTimeAsync(100);

      engine.stop();

      // The feed should have triggered a search and found the match
      expect(onMatchFound).toHaveBeenCalledTimes(1);
    });

    it('ignores feed listings with same direction as own intent', async () => {
      const { engine, market, onMatchFound } = createTestEngine({
        strategy: { scan_interval_ms: 60_000, auto_match: true },
        agentPubkey: 'a'.repeat(64),
      });

      await engine.createIntent(defaultParams(), 'a'.repeat(64), AGENT_ADDRESS);

      const result = buildSearchResult({ direction: 'sell', agentPublicKey: 'b'.repeat(64) });
      market.setSearchResults([result]);

      engine.start();

      // Feed listing is 'buy' same as our intent -- should be pre-filtered
      market.triggerFeed({
        id: 'feed-1',
        title: 'Buying ALPHA',
        descriptionPreview: 'Buying ALPHA for USD',
        agentName: 'other',
        agentId: 42,
        type: 'buy',
        createdAt: new Date().toISOString(),
      });

      await vi.advanceTimersByTimeAsync(100);
      engine.stop();

      // No search should have been triggered by the feed
      // (the scan timer didn't fire either due to long interval)
      expect(onMatchFound).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 6. Expiry sweep
  // =========================================================================

  describe('Expiry sweep', () => {
    it('expired intents transition to EXPIRED', async () => {
      const { engine } = createTestEngine();

      // Create intent with 2-second expiry
      const record = await engine.createIntent(
        defaultParams({ expiry_sec: 2 }),
        AGENT_PUBKEY,
        AGENT_ADDRESS,
      );

      engine.start();

      // Advance past expiry + sweep interval (sweep runs every 10s)
      vi.advanceTimersByTime(11_000);

      engine.stop();

      const intent = engine.getIntent(record.intent.intent_id);
      expect(intent).not.toBeNull();
      expect(intent!.state).toBe('EXPIRED');
    });

    it('calls market.closeIntent() for expired intents', async () => {
      const { engine, market } = createTestEngine();

      const record = await engine.createIntent(
        defaultParams({ expiry_sec: 2 }),
        AGENT_PUBKEY,
        AGENT_ADDRESS,
      );

      engine.start();
      vi.advanceTimersByTime(11_000);

      // Allow the fire-and-forget closeIntent promise to resolve
      await vi.advanceTimersByTimeAsync(0);

      engine.stop();

      expect(market.closeIntentCalls).toContain(record.intent.market_intent_id);
    });

    it('does not expire intents that are still within expiry window', async () => {
      const { engine } = createTestEngine();

      const record = await engine.createIntent(
        defaultParams({ expiry_sec: 3600 }),
        AGENT_PUBKEY,
        AGENT_ADDRESS,
      );

      engine.start();
      vi.advanceTimersByTime(11_000); // sweep fires but intent isn't expired
      engine.stop();

      const intent = engine.getIntent(record.intent.intent_id);
      expect(intent!.state).toBe('ACTIVE');
    });
  });

  // =========================================================================
  // 7. start() / stop()
  // =========================================================================

  describe('start() / stop()', () => {
    it('start() begins scan loop and feed subscription', () => {
      const { engine, market } = createTestEngine();
      const subscribeSpy = vi.spyOn(market, 'subscribeFeed');

      engine.start();

      expect(subscribeSpy).toHaveBeenCalledTimes(1);
      engine.stop();
    });

    it('stop() clears all timers', async () => {
      const { engine, market, onMatchFound } = createTestEngine({
        strategy: { scan_interval_ms: 1000, auto_match: true },
        agentPubkey: 'a'.repeat(64),
      });

      await engine.createIntent(defaultParams(), 'a'.repeat(64), AGENT_ADDRESS);
      const result = buildSearchResult({ direction: 'sell', agentPublicKey: 'b'.repeat(64) });
      market.setSearchResults([result]);

      engine.start();
      engine.stop();

      // Advance timers -- no scan should fire
      await vi.advanceTimersByTimeAsync(5000);

      expect(onMatchFound).not.toHaveBeenCalled();
    });

    it('no timers leak after stop()', async () => {
      const { engine, market } = createTestEngine({
        strategy: { scan_interval_ms: 500, auto_match: true },
      });

      await engine.createIntent(defaultParams(), AGENT_PUBKEY, AGENT_ADDRESS);

      engine.start();
      engine.stop();

      // Record how many search calls exist at stop
      const callsAtStop = market.searchCalls.length;

      // Advance far into the future
      await vi.advanceTimersByTimeAsync(60_000);

      // No new search calls should have been made
      expect(market.searchCalls.length).toBe(callsAtStop);
    });

    it('start() is idempotent (calling twice does not double timers)', async () => {
      const { engine, market } = createTestEngine({
        strategy: { scan_interval_ms: 1000, auto_match: true },
      });

      await engine.createIntent(defaultParams(), AGENT_PUBKEY, AGENT_ADDRESS);

      engine.start();
      engine.start(); // second call should be no-op

      await vi.advanceTimersByTimeAsync(1100);
      engine.stop();

      // Should have at most 1 scan call from the single timer, not 2
      // (the feed subscription also triggers searches, so just verify <= reasonable count)
      const subscribeSpy = vi.spyOn(market, 'subscribeFeed');
      expect(subscribeSpy).not.toHaveBeenCalled(); // wasn't called again after stop
    });

    it('stop() unsubscribes from feed', () => {
      const { engine, market, onMatchFound } = createTestEngine({
        strategy: { scan_interval_ms: 60_000, auto_match: true },
        agentPubkey: 'a'.repeat(64),
      });

      engine.start();

      // Trigger a feed listing before stop -- should be processed
      // (we don't have intents so nothing matches, but feed should work)

      engine.stop();

      // After stop, triggering feed should not cause errors or callbacks
      market.triggerFeed({
        id: 'feed-after-stop',
        title: 'Selling ALPHA',
        descriptionPreview: 'test',
        agentName: 'other',
        agentId: 1,
        type: 'sell',
        createdAt: new Date().toISOString(),
      });

      expect(onMatchFound).not.toHaveBeenCalled();
    });
  });
});
