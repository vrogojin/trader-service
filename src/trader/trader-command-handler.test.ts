/**
 * Unit tests for the TRADER address validator.
 *
 * Locks in the contract for `isValidAddress` — the gate that
 * WITHDRAW_TOKEN uses to reject malformed `to_address` inputs before
 * they reach `payments.send`. The contract diverges from sphere-sdk's
 * lax `isValidAddress` (which is prefix-presence only); the trader's
 * stricter check is documented inline in trader-command-handler.ts.
 *
 * Why a dedicated test file: the validator went through 5 rounds of
 * steelman review with bugs found in every round (alphanumeric-only
 * regex rejected nametags; SDK isValidAddress was too permissive;
 * isValidNametag wrong overload; uppercase hex normalization). A
 * future "simplification" reverting any of those fixes would silently
 * regress without these assertions.
 */

import { describe, it, expect } from 'vitest';
import { isValidAddress } from './trader-command-handler.js';

describe('isValidAddress (WITHDRAW_TOKEN gate)', () => {
  describe('@nametag', () => {
    it('accepts canonical lowercase nametag', () => {
      expect(isValidAddress('@alice')).toBe(true);
      expect(isValidAddress('@trader-bob')).toBe(true);
      expect(isValidAddress('@my_handle_42')).toBe(true);
    });

    it('rejects uppercase characters in nametag', () => {
      // Sphere's relay binding regex is lowercase-only; the trader gate
      // matches that contract. An operator submitting @ALICE would have
      // their command accepted but resolution would fail at relay time;
      // catching at the gate gives a clean local error.
      expect(isValidAddress('@ALICE')).toBe(false);
      expect(isValidAddress('@Alice')).toBe(false);
      expect(isValidAddress('@aliceBob')).toBe(false);
    });

    it('rejects non-alphanumeric/_/- characters', () => {
      expect(isValidAddress('@alice.bob')).toBe(false);
      expect(isValidAddress('@alice bob')).toBe(false);
      expect(isValidAddress('@alice/bob')).toBe(false);
      expect(isValidAddress('@alice!')).toBe(false);
    });

    it('rejects nametags shorter than 3 chars (SDK relay constraint)', () => {
      // SDK's exported isValidNametag uses /^[a-z0-9_-]{3,20}$/.
      expect(isValidAddress('@a')).toBe(false);
      expect(isValidAddress('@ab')).toBe(false);
    });

    it('accepts the 3-char minimum boundary', () => {
      expect(isValidAddress('@aaa')).toBe(true);
      expect(isValidAddress('@a_b')).toBe(true);
      expect(isValidAddress('@123')).toBe(true);
    });

    it('rejects nametags longer than 20 chars (SDK relay constraint)', () => {
      expect(isValidAddress('@' + 'a'.repeat(21))).toBe(false);
      expect(isValidAddress('@' + 'a'.repeat(30))).toBe(false);
    });

    it('accepts the 20-char maximum boundary', () => {
      expect(isValidAddress('@' + 'a'.repeat(20))).toBe(true);
    });

    it('rejects empty / whitespace nametag', () => {
      expect(isValidAddress('@')).toBe(false);
      expect(isValidAddress('@   ')).toBe(false);
    });

    it('accepts phone-number nametags (E.164) — intentional, SDK supports', () => {
      // The SDK's isValidNametag has an explicit isPhoneNumber escape
      // hatch. Phone numbers are canonical Unicity identities. This
      // test pins that we don't accidentally restrict the gate
      // tighter than the SDK relay's binding rules.
      expect(isValidAddress('@+12025551234')).toBe(true);
    });
  });

  describe('DIRECT://hex', () => {
    const HEX64 = 'a'.repeat(64);
    const HEX80 = 'b'.repeat(80);
    const HEX63 = 'c'.repeat(63);
    const HEX81 = 'd'.repeat(81);

    it('accepts 64-80 lowercase hex chars', () => {
      expect(isValidAddress(`DIRECT://${HEX64}`)).toBe(true);
      expect(isValidAddress(`DIRECT://${HEX80}`)).toBe(true);
    });

    it('accepts mixed-case hex (normalizes via toLowerCase)', () => {
      expect(isValidAddress(`DIRECT://${HEX64.toUpperCase()}`)).toBe(true);
      expect(isValidAddress('DIRECT://' + 'A'.repeat(32) + 'a'.repeat(32))).toBe(true);
    });

    it('rejects hex shorter than 64 chars', () => {
      expect(isValidAddress(`DIRECT://${HEX63}`)).toBe(false);
      expect(isValidAddress('DIRECT://abc')).toBe(false);
    });

    it('rejects hex longer than 80 chars', () => {
      expect(isValidAddress(`DIRECT://${HEX81}`)).toBe(false);
      expect(isValidAddress('DIRECT://' + 'e'.repeat(130))).toBe(false);
    });

    it('rejects non-hex content', () => {
      expect(isValidAddress('DIRECT://garbage')).toBe(false);
      expect(isValidAddress('DIRECT://' + 'g'.repeat(64))).toBe(false); // 'g' not hex
      expect(isValidAddress('DIRECT://' + 'a'.repeat(63) + 'z')).toBe(false);
    });

    it('rejects empty body', () => {
      expect(isValidAddress('DIRECT://')).toBe(false);
    });
  });

  describe('PROXY://hex', () => {
    const HEX64 = 'a'.repeat(64);

    it('accepts well-formed PROXY://hex', () => {
      expect(isValidAddress(`PROXY://${HEX64}`)).toBe(true);
    });

    it('rejects malformed PROXY://hex (length and char checks)', () => {
      expect(isValidAddress('PROXY://abc')).toBe(false);
      expect(isValidAddress('PROXY://garbage')).toBe(false);
    });
  });

  describe('rejected forms', () => {
    it('rejects bare hex pubkey — intentionally stricter than payments.send', () => {
      // payments.send accepts bare 64+ char hex / 66-char compressed
      // pubkey, but the trader gate requires an explicit Sphere address
      // prefix to keep WITHDRAW_TOKEN destinations unambiguous in logs
      // and audit trails.
      expect(isValidAddress('a'.repeat(64))).toBe(false);
      expect(isValidAddress('02' + 'a'.repeat(64))).toBe(false); // compressed
    });

    it('rejects unknown prefixes', () => {
      expect(isValidAddress('SUBSPACE://abc')).toBe(false);
      expect(isValidAddress('http://example.com')).toBe(false);
      expect(isValidAddress('garbage')).toBe(false);
    });

    it('rejects empty / non-string inputs', () => {
      expect(isValidAddress('')).toBe(false);
      expect(isValidAddress(undefined)).toBe(false);
      expect(isValidAddress(null)).toBe(false);
      expect(isValidAddress(42)).toBe(false);
      expect(isValidAddress({ x: 1 })).toBe(false);
      expect(isValidAddress([])).toBe(false);
    });
  });

  describe('whitespace handling', () => {
    it('parseAddress trims; valid input with leading/trailing space is accepted', () => {
      // The CLI also trims, so this is defense-in-depth: even if a
      // future code path forwards untrimmed, parseAddress trims and
      // the validator still works.
      expect(isValidAddress('  @alice  ')).toBe(true);
      expect(isValidAddress('  DIRECT://' + 'a'.repeat(64) + '  ')).toBe(true);
    });
  });
});
