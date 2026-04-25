import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createFsTraderStateStore,
  createNullTraderStateStore,
} from './trader-state-store.js';
import type {
  IntentRecord,
  DealRecord,
  TraderStrategy,
} from './types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sampleIntent: IntentRecord = {
  intent: {
    intent_id: 'int-001',
    market_intent_id: 'mkt-001',
    agent_pubkey: '02abcdef',
    agent_address: 'addr-a',
    salt: 'salt1',
    direction: 'buy',
    base_asset: 'ALPHA',
    quote_asset: 'USD',
    rate_min: 100n,
    rate_max: 200n,
    volume_min: 10n,
    volume_max: 50n,
    volume_filled: 0n,
    escrow_address: 'escrow-1',
    deposit_timeout_sec: 300,
    expiry_ms: 9999999999999,
    signature: 'sig-a',
  },
  state: 'ACTIVE',
  deal_ids: ['deal-x'],
  updated_at: 1700000000000,
};

const sampleDeal: DealRecord = {
  terms: {
    deal_id: 'deal-001',
    proposer_intent_id: 'int-001',
    acceptor_intent_id: 'int-002',
    proposer_pubkey: '02aaa',
    acceptor_pubkey: '02bbb',
    proposer_address: 'addr-p',
    acceptor_address: 'addr-q',
    base_asset: 'ALPHA',
    quote_asset: 'USD',
    rate: 150n,
    volume: 25n,
    proposer_direction: 'sell',
    escrow_address: 'escrow-2',
    deposit_timeout_sec: 600,
    created_ms: 1700000000000,
  },
  state: 'PROPOSED',
  swap_id: null,
  acceptor_swap_address: null,
  updated_at: 1700000000000,
};

const sampleStrategy: TraderStrategy = {
  auto_match: true,
  auto_negotiate: false,
  max_concurrent_swaps: 5,
  max_active_intents: 10,
  min_search_score: 0.7,
  scan_interval_ms: 3000,
  market_api_url: 'https://example.com/api',
  trusted_escrows: ['escrow-a'],
  blocked_counterparties: [],
};

// ---------------------------------------------------------------------------
// Null store
// ---------------------------------------------------------------------------

describe('createNullTraderStateStore', () => {
  it('loadIntent returns null', async () => {
    const store = createNullTraderStateStore();
    expect(await store.loadIntent('any')).toBeNull();
  });

  it('loadIntents returns empty array', async () => {
    const store = createNullTraderStateStore();
    expect(await store.loadIntents()).toEqual([]);
  });

  it('loadStrategy returns null', async () => {
    const store = createNullTraderStateStore();
    expect(await store.loadStrategy()).toBeNull();
  });

  it('save operations do not throw', async () => {
    const store = createNullTraderStateStore();
    await expect(store.saveIntent(sampleIntent)).resolves.toBeUndefined();
    await expect(store.saveDeal(sampleDeal)).resolves.toBeUndefined();
    await expect(store.saveStrategy(sampleStrategy)).resolves.toBeUndefined();
    await expect(store.saveReservations('data')).resolves.toBeUndefined();
    await expect(store.deleteIntent('x')).resolves.toBeUndefined();
    await expect(store.deleteDeal('x')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Filesystem-backed store
// ---------------------------------------------------------------------------

describe('createFsTraderStateStore', () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  // -- Intents --

  it('saveIntent + loadIntent round-trip', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'trader-state-'));
    const store = createFsTraderStateStore(tmpDir);
    await store.saveIntent(sampleIntent);
    const loaded = await store.loadIntent('int-001');
    expect(loaded).not.toBeNull();
    expect(loaded!.intent.intent_id).toBe('int-001');
    expect(loaded!.state).toBe('ACTIVE');
    // Verify bigint round-trip
    expect(loaded!.intent.rate_min).toBe(100n);
    expect(loaded!.intent.rate_max).toBe(200n);
  });

  it('saveIntent + loadIntents with filter', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'trader-state-'));
    const store = createFsTraderStateStore(tmpDir);

    await store.saveIntent(sampleIntent); // ACTIVE
    const filled: IntentRecord = {
      ...sampleIntent,
      intent: { ...sampleIntent.intent, intent_id: 'int-002' },
      state: 'FILLED',
    };
    await store.saveIntent(filled);

    const all = await store.loadIntents();
    expect(all).toHaveLength(2);

    const active = await store.loadIntents({ state: 'ACTIVE' });
    expect(active).toHaveLength(1);
    expect(active[0]!.intent.intent_id).toBe('int-001');

    const multi = await store.loadIntents({ state: ['ACTIVE', 'FILLED'] });
    expect(multi).toHaveLength(2);

    const none = await store.loadIntents({ state: 'CANCELLED' });
    expect(none).toHaveLength(0);
  });

  it('loadIntent returns null for non-existent', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'trader-state-'));
    const store = createFsTraderStateStore(tmpDir);
    expect(await store.loadIntent('does-not-exist')).toBeNull();
  });

  it('deleteIntent removes file', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'trader-state-'));
    const store = createFsTraderStateStore(tmpDir);
    await store.saveIntent(sampleIntent);
    expect(await store.loadIntent('int-001')).not.toBeNull();
    await store.deleteIntent('int-001');
    expect(await store.loadIntent('int-001')).toBeNull();
  });

  // -- Deals --

  it('saveDeal + loadDeal round-trip', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'trader-state-'));
    const store = createFsTraderStateStore(tmpDir);
    await store.saveDeal(sampleDeal);
    const loaded = await store.loadDeal('deal-001');
    expect(loaded).not.toBeNull();
    expect(loaded!.terms.deal_id).toBe('deal-001');
    expect(loaded!.state).toBe('PROPOSED');
    // Verify bigint round-trip
    expect(loaded!.terms.rate).toBe(150n);
    expect(loaded!.terms.volume).toBe(25n);
  });

  it('saveDeal + loadDeals with state filter', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'trader-state-'));
    const store = createFsTraderStateStore(tmpDir);

    await store.saveDeal(sampleDeal); // PROPOSED
    const completed: DealRecord = {
      ...sampleDeal,
      terms: { ...sampleDeal.terms, deal_id: 'deal-002' },
      state: 'COMPLETED',
    };
    await store.saveDeal(completed);

    const all = await store.loadDeals();
    expect(all).toHaveLength(2);

    const proposed = await store.loadDeals({ state: 'PROPOSED' });
    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.terms.deal_id).toBe('deal-001');

    const multi = await store.loadDeals({ state: ['PROPOSED', 'COMPLETED'] });
    expect(multi).toHaveLength(2);
  });

  it('deleteDeal removes file', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'trader-state-'));
    const store = createFsTraderStateStore(tmpDir);
    await store.saveDeal(sampleDeal);
    expect(await store.loadDeal('deal-001')).not.toBeNull();
    await store.deleteDeal('deal-001');
    expect(await store.loadDeal('deal-001')).toBeNull();
  });

  // -- Strategy --

  it('saveStrategy + loadStrategy round-trip', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'trader-state-'));
    const store = createFsTraderStateStore(tmpDir);
    await store.saveStrategy(sampleStrategy);
    const loaded = await store.loadStrategy();
    expect(loaded).toEqual(sampleStrategy);
  });

  // -- Reservations --

  it('saveReservations + loadReservations round-trip', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'trader-state-'));
    const store = createFsTraderStateStore(tmpDir);
    const payload = JSON.stringify({ ledger: [1, 2, 3] });
    await store.saveReservations(payload);
    const loaded = await store.loadReservations();
    expect(loaded).toBe(payload);
  });

  // -- Corrupt JSON --

  it('corrupt JSON returns null on load', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'trader-state-'));
    const store = createFsTraderStateStore(tmpDir);

    // Write corrupt intent file
    const intentsDir = join(tmpDir, 'intents');
    await mkdir(intentsDir, { recursive: true });
    await writeFile(join(intentsDir, 'bad.json'), '{not valid json!!!');
    expect(await store.loadIntent('bad')).toBeNull();

    // Write corrupt deal file
    const dealsDir = join(tmpDir, 'deals');
    await mkdir(dealsDir, { recursive: true });
    await writeFile(join(dealsDir, 'bad.json'), '{not valid json!!!');
    expect(await store.loadDeal('bad')).toBeNull();

    // Write corrupt strategy file
    await writeFile(join(tmpDir, 'strategy.json'), '{not valid json!!!');
    expect(await store.loadStrategy()).toBeNull();
  });

  // -- Round-21 F3: dangerous-key coverage on every layer --

  it('rejects deal record with __proto__ at the ROOT (round-21 F3)', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'trader-state-'));
    const store = createFsTraderStateStore(tmpDir);

    const dealsDir = join(tmpDir, 'deals');
    await mkdir(dealsDir, { recursive: true });
    // Craft a record with a top-level __proto__ key. A later code path
    // that spread-copies this object would leak prototype pollution.
    const poisoned = `{
      "__proto__": { "polluted": true },
      "terms": { "deal_id": "deal-001" },
      "state": "PROPOSED",
      "updated_at": 1700000000000
    }`;
    await writeFile(join(dealsDir, 'deal-001.json'), poisoned);
    expect(await store.loadDeal('deal-001')).toBeNull();
  });

  it('rejects deal record with __proto__ nested inside terms (round-21 F3)', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'trader-state-'));
    const store = createFsTraderStateStore(tmpDir);

    const dealsDir = join(tmpDir, 'deals');
    await mkdir(dealsDir, { recursive: true });
    const poisoned = `{
      "terms": {
        "deal_id": "deal-001",
        "__proto__": { "polluted": true }
      },
      "state": "PROPOSED",
      "updated_at": 1700000000000
    }`;
    await writeFile(join(dealsDir, 'deal-001.json'), poisoned);
    expect(await store.loadDeal('deal-001')).toBeNull();
  });

  it('rejects deal record with constructor key at the ROOT (round-21 F3)', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'trader-state-'));
    const store = createFsTraderStateStore(tmpDir);

    const dealsDir = join(tmpDir, 'deals');
    await mkdir(dealsDir, { recursive: true });
    const poisoned = `{
      "constructor": { "polluted": true },
      "terms": { "deal_id": "deal-001" },
      "state": "PROPOSED",
      "updated_at": 1700000000000
    }`;
    await writeFile(join(dealsDir, 'deal-001.json'), poisoned);
    expect(await store.loadDeal('deal-001')).toBeNull();
  });
});
