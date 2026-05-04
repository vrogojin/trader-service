import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  INTENT_STATES,
  VALID_INTENT_TRANSITIONS,
  TERMINAL_INTENT_STATES,
  DEAL_STATES,
  VALID_DEAL_TRANSITIONS,
  TERMINAL_DEAL_STATES,
} from './types.js';
import type { TradingIntent, DealTerms } from './types.js';
import {
  canonicalJson,
  computeIntentId,
  encodeDescription,
  parseDescription,
  validateIntentParams,
  validateDealTerms,
} from './utils.js';
import type { CreateIntentParams } from './acp-types.js';

// ---------------------------------------------------------------------------
// State machine transitions
// ---------------------------------------------------------------------------

describe('VALID_INTENT_TRANSITIONS', () => {
  it('has an entry for every intent state', () => {
    for (const state of INTENT_STATES) {
      expect(VALID_INTENT_TRANSITIONS).toHaveProperty(state);
    }
  });

  it('terminal intent states have empty transition arrays', () => {
    for (const state of TERMINAL_INTENT_STATES) {
      expect(VALID_INTENT_TRANSITIONS[state]).toEqual([]);
    }
  });

  it('non-terminal intent states have non-empty transition arrays', () => {
    for (const state of INTENT_STATES) {
      if (!(TERMINAL_INTENT_STATES as readonly string[]).includes(state)) {
        expect(VALID_INTENT_TRANSITIONS[state].length).toBeGreaterThan(0);
      }
    }
  });
});

describe('VALID_DEAL_TRANSITIONS', () => {
  it('has an entry for every deal state', () => {
    for (const state of DEAL_STATES) {
      expect(VALID_DEAL_TRANSITIONS).toHaveProperty(state);
    }
  });

  it('terminal deal states have empty transition arrays', () => {
    for (const state of TERMINAL_DEAL_STATES) {
      expect(VALID_DEAL_TRANSITIONS[state]).toEqual([]);
    }
  });

  it('non-terminal deal states have non-empty transition arrays', () => {
    for (const state of DEAL_STATES) {
      if (!(TERMINAL_DEAL_STATES as readonly string[]).includes(state)) {
        expect(VALID_DEAL_TRANSITIONS[state].length).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// canonicalJson
// ---------------------------------------------------------------------------

describe('canonicalJson', () => {
  it('sorts keys deterministically', () => {
    const a = canonicalJson({ z: 1, a: 2, m: 3 });
    const b = canonicalJson({ m: 3, z: 1, a: 2 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"m":3,"z":1}');
  });

  it('serializes bigint as string', () => {
    const result = canonicalJson({ amount: 999999999999999999n });
    expect(result).toBe('{"amount":"999999999999999999"}');
  });

  it('handles nested objects with sorted keys', () => {
    const result = canonicalJson({ b: { d: 1, c: 2 }, a: 0 });
    expect(result).toBe('{"a":0,"b":{"c":2,"d":1}}');
  });

  it('preserves arrays as-is', () => {
    const result = canonicalJson({ items: [3, 1, 2] });
    expect(result).toBe('{"items":[3,1,2]}');
  });

  it('handles null values', () => {
    const result = canonicalJson({ a: null });
    expect(result).toBe('{"a":null}');
  });
});

// ---------------------------------------------------------------------------
// computeIntentId
// ---------------------------------------------------------------------------

const sampleIntentFields = {
  agent_pubkey: 'deadbeef01',
  agent_address: 'addr_01',
  salt: 'salt_abc',
  direction: 'buy' as const,
  base_asset: 'ALPHA',
  quote_asset: 'BRAVO',
  rate_min: 100n,
  rate_max: 200n,
  volume_min: 500n,
  volume_max: 1000n,
  escrow_address: 'escrow_01',
  deposit_timeout_sec: 60,
  expiry_ms: 1700000000000,
  created_ms: 1700000000000,
};

describe('computeIntentId', () => {
  it('produces a valid SHA-256 hex string', () => {
    const id = computeIntentId(sampleIntentFields);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches manually computed SHA-256 for canonical JSON', () => {
    const expected = createHash('sha256')
      .update(canonicalJson({
        agent_address: sampleIntentFields.agent_address,
        agent_pubkey: sampleIntentFields.agent_pubkey,
        base_asset: sampleIntentFields.base_asset,
        created_ms: sampleIntentFields.created_ms,
        deposit_timeout_sec: sampleIntentFields.deposit_timeout_sec,
        direction: sampleIntentFields.direction,
        escrow_address: sampleIntentFields.escrow_address,
        expiry_ms: sampleIntentFields.expiry_ms,
        quote_asset: sampleIntentFields.quote_asset,
        rate_max: sampleIntentFields.rate_max,
        rate_min: sampleIntentFields.rate_min,
        salt: sampleIntentFields.salt,
        volume_max: sampleIntentFields.volume_max,
        volume_min: sampleIntentFields.volume_min,
      }))
      .digest('hex');
    expect(computeIntentId(sampleIntentFields)).toBe(expected);
  });

  it('different salt produces different hash', () => {
    const id1 = computeIntentId(sampleIntentFields);
    const id2 = computeIntentId({ ...sampleIntentFields, salt: 'salt_xyz' });
    expect(id1).not.toBe(id2);
  });

  it('same fields with different salt differ', () => {
    const a = computeIntentId({ ...sampleIntentFields, salt: 'A' });
    const b = computeIntentId({ ...sampleIntentFields, salt: 'B' });
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// encodeDescription / parseDescription round-trip
// ---------------------------------------------------------------------------

const sampleIntent: TradingIntent = {
  intent_id: 'id_01',
  market_intent_id: 'mkt_01',
  agent_pubkey: 'deadbeef01',
  agent_address: 'addr_01',
  salt: 'salt_abc',
  direction: 'sell',
  base_asset: 'ALPHA',
  quote_asset: 'BRAVO',
  rate_min: 100n,
  rate_max: 200n,
  volume_min: 500n,
  volume_max: 1000n,
  volume_filled: 0n,
  escrow_address: 'escrow_01',
  deposit_timeout_sec: 60,
  expiry_ms: 1700000000000,
  signature: 'sig_01',
};

describe('encodeDescription', () => {
  it('produces space-separated sentence format for sell intent', () => {
    const desc = encodeDescription(sampleIntent);
    // Sentences are joined by ' ' (each already ends with '.')
    expect(desc).toBe(
      'Selling 500-1000 ALPHA for BRAVO. Rate: 100-200 BRAVO per ALPHA. Escrow: escrow_01. Deposit timeout: 60s. Expires: 1700000000000.',
    );
  });

  it('produces space-separated sentence format for buy intent', () => {
    const buyIntent: TradingIntent = { ...sampleIntent, direction: 'buy' };
    const desc = encodeDescription(buyIntent);
    expect(desc.startsWith('Buying ')).toBe(true);
    expect(desc).not.toContain('\n');
  });
});

describe('parseDescription', () => {
  it('round-trips encodeDescription for sell intent', () => {
    const desc = encodeDescription(sampleIntent);
    const parsed = parseDescription(desc);
    expect(parsed).not.toBeNull();
    expect(parsed!.direction).toBe('sell');
    expect(parsed!.base_asset).toBe('ALPHA');
    expect(parsed!.quote_asset).toBe('BRAVO');
    expect(parsed!.volume_min).toBe(500n);
    expect(parsed!.volume_max).toBe(1000n);
    expect(parsed!.rate_min).toBe(100n);
    expect(parsed!.rate_max).toBe(200n);
    expect(parsed!.escrow_address).toBe('escrow_01');
    expect(parsed!.deposit_timeout_sec).toBe(60);
    expect(parsed!.expiry_ms).toBe(1700000000000);
  });

  it('round-trips encodeDescription for buy intent', () => {
    const buyIntent: TradingIntent = { ...sampleIntent, direction: 'buy' };
    const desc = encodeDescription(buyIntent);
    const parsed = parseDescription(desc);
    expect(parsed).not.toBeNull();
    expect(parsed!.direction).toBe('buy');
  });

  it('returns null for garbage input', () => {
    expect(parseDescription('not a valid description')).toBeNull();
  });

  it('returns null for incomplete input', () => {
    expect(parseDescription('Selling 500-1000 ALPHA for BRAVO. Rate: 100-200 BRAVO per ALPHA.')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validateIntentParams
// ---------------------------------------------------------------------------

const validParams: CreateIntentParams = {
  direction: 'buy',
  base_asset: 'ALPHA',
  quote_asset: 'BRAVO',
  rate_min: '100',
  rate_max: '200',
  volume_min: '500',
  volume_max: '1000',
  expiry_sec: 3600,
  deposit_timeout_sec: 60,
};

describe('validateIntentParams', () => {
  it('accepts valid params', () => {
    expect(validateIntentParams(validParams)).toBeNull();
  });

  it('rejects rate_min > rate_max', () => {
    const err = validateIntentParams({ ...validParams, rate_min: '300', rate_max: '200' });
    expect(err).toContain('rate_min');
  });

  it('rejects volume_min > volume_max', () => {
    const err = validateIntentParams({ ...validParams, volume_min: '2000', volume_max: '1000' });
    expect(err).toContain('volume_min');
  });

  it('rejects zero volume', () => {
    const err = validateIntentParams({ ...validParams, volume_min: '0' });
    expect(err).toContain('volume_min');
  });

  it('rejects negative rate', () => {
    const err = validateIntentParams({ ...validParams, rate_min: '-1' });
    expect(err).toContain('rate_min');
  });

  it('rejects Infinity expiry_sec', () => {
    const err = validateIntentParams({ ...validParams, expiry_sec: Infinity });
    expect(err).toContain('expiry_sec');
  });

  it('rejects NaN expiry_sec', () => {
    const err = validateIntentParams({ ...validParams, expiry_sec: NaN });
    expect(err).toContain('expiry_sec');
  });

  it('rejects expiry > 7 days', () => {
    const err = validateIntentParams({ ...validParams, expiry_sec: 7 * 24 * 3600 + 1 });
    expect(err).toContain('expiry_sec');
  });

  it('rejects negative expiry', () => {
    const err = validateIntentParams({ ...validParams, expiry_sec: -10 });
    expect(err).toContain('expiry_sec');
  });

  it('rejects same base and quote asset', () => {
    const err = validateIntentParams({ ...validParams, base_asset: 'ALPHA', quote_asset: 'ALPHA' });
    expect(err).toContain('differ');
  });
});

// ---------------------------------------------------------------------------
// validateDealTerms
// ---------------------------------------------------------------------------

// Steelman round-4 (M2): pubkey shape validation. Use real-shaped 64-hex
// secp256k1 keys (x-only) so the validator's isValidPubkey gate passes.
const VALID_PROPOSER_PUBKEY = 'a'.repeat(64);
const VALID_ACCEPTOR_PUBKEY = 'b'.repeat(64);

const validTerms: DealTerms = {
  deal_id: 'deal_01',
  proposer_intent_id: 'intent_01',
  acceptor_intent_id: 'intent_02',
  proposer_pubkey: VALID_PROPOSER_PUBKEY,
  acceptor_pubkey: VALID_ACCEPTOR_PUBKEY,
  proposer_address: 'addr_01',
  acceptor_address: 'addr_02',
  base_asset: 'ALPHA',
  quote_asset: 'BRAVO',
  rate: 150n,
  volume: 500n,
  proposer_direction: 'sell',
  escrow_address: 'escrow_01',
  deposit_timeout_sec: 60,
  created_ms: 1700000000000,
};

describe('validateDealTerms', () => {
  it('accepts valid terms', () => {
    expect(validateDealTerms(validTerms)).toBeNull();
  });

  it('rejects empty deal_id', () => {
    const err = validateDealTerms({ ...validTerms, deal_id: '' });
    expect(err).toContain('deal_id');
  });

  it('rejects zero rate', () => {
    const err = validateDealTerms({ ...validTerms, rate: 0n });
    expect(err).toContain('rate');
  });

  it('rejects zero volume', () => {
    const err = validateDealTerms({ ...validTerms, volume: 0n });
    expect(err).toContain('volume');
  });

  it('rejects deposit_timeout_sec out of range', () => {
    const err = validateDealTerms({ ...validTerms, deposit_timeout_sec: 10 });
    expect(err).toContain('deposit_timeout_sec');
  });

  it('rejects negative created_ms', () => {
    const err = validateDealTerms({ ...validTerms, created_ms: -1 });
    expect(err).toContain('created_ms');
  });

  // M2 — pubkey shape
  it('rejects proposer_pubkey with invalid shape', () => {
    const err = validateDealTerms({ ...validTerms, proposer_pubkey: 'pub_01' });
    expect(err).toContain('proposer_pubkey');
  });

  it('rejects acceptor_pubkey with invalid shape', () => {
    const err = validateDealTerms({ ...validTerms, acceptor_pubkey: 'not-hex' });
    expect(err).toContain('acceptor_pubkey');
  });

  // M3 — rate / volume upper bound (2^128)
  it('rejects rate > 2^128', () => {
    const err = validateDealTerms({ ...validTerms, rate: 2n ** 128n + 1n });
    expect(err).toContain('rate');
    expect(err).toContain('maximum');
  });

  it('rejects volume > 2^128', () => {
    const err = validateDealTerms({ ...validTerms, volume: 2n ** 128n + 1n });
    expect(err).toContain('volume');
    expect(err).toContain('maximum');
  });
});
