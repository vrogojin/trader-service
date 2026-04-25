import { describe, it, expect } from 'vitest';
import { pubkeysEqual, isValidPubkey } from './crypto.js';

describe('acp-adapter / shared / pubkeysEqual', () => {
  // 32-byte (x-only) of a known sample
  const X_ONLY = '02020202020202020202020202020202020202020202020202020202020202bc';
  const COMPRESSED_02 = '02' + X_ONLY;
  const COMPRESSED_03 = '03' + X_ONLY;
  const UNCOMPRESSED = '04' + X_ONLY + 'd' + 'e'.repeat(63);

  it('matches identical 64-char x-only keys', () => {
    expect(pubkeysEqual(X_ONLY, X_ONLY)).toBe(true);
  });

  it('matches across formats: x-only vs 02-compressed (same x)', () => {
    expect(pubkeysEqual(X_ONLY, COMPRESSED_02)).toBe(true);
  });

  it('matches across formats: x-only vs 03-compressed (same x)', () => {
    expect(pubkeysEqual(X_ONLY, COMPRESSED_03)).toBe(true);
  });

  it('matches across formats: x-only vs uncompressed (same x)', () => {
    expect(pubkeysEqual(X_ONLY, UNCOMPRESSED)).toBe(true);
  });

  it('distinguishes 02-compressed from 03-compressed (same x, different y-parity)', () => {
    expect(pubkeysEqual(COMPRESSED_02, COMPRESSED_03)).toBe(false);
  });

  it('case-insensitive: upper vs lower hex compare equal', () => {
    expect(pubkeysEqual(X_ONLY, X_ONLY.toUpperCase())).toBe(true);
  });

  it('rejects malformed input', () => {
    expect(pubkeysEqual('not hex', X_ONLY)).toBe(false);
    expect(pubkeysEqual(X_ONLY, 'not hex')).toBe(false);
    expect(pubkeysEqual('', X_ONLY)).toBe(false);
  });

  it('isValidPubkey accepts all three encodings', () => {
    expect(isValidPubkey(X_ONLY)).toBe(true);
    expect(isValidPubkey(COMPRESSED_02)).toBe(true);
    expect(isValidPubkey(UNCOMPRESSED)).toBe(true);
    expect(isValidPubkey('xyz')).toBe(false);
  });
});
