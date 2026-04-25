/**
 * Unit tests for the testnet constants. These are static values, but we
 * still want a regression net against accidental edits — wrong faucet URL
 * or a typoed protocol scheme would only be caught when the live test
 * suite runs against testnet, by which time CI is already red.
 */

import { describe, it, expect } from 'vitest';
import {
  TESTNET,
  RELAYS,
  AGGREGATOR_URL,
  IPFS_GATEWAY,
  FAUCET_URL,
  TRADER_IMAGE,
  ESCROW_IMAGE,
  DEFAULT_TIMEOUT_MS,
  SWAP_TIMEOUT_MS,
} from './constants.js';

describe('TESTNET constants', () => {
  it('exposes the same values via TESTNET aggregate and named exports', () => {
    expect(TESTNET.RELAYS).toBe(RELAYS);
    expect(TESTNET.AGGREGATOR_URL).toBe(AGGREGATOR_URL);
    expect(TESTNET.IPFS_GATEWAY).toBe(IPFS_GATEWAY);
    expect(TESTNET.FAUCET_URL).toBe(FAUCET_URL);
    expect(TESTNET.TRADER_IMAGE).toBe(TRADER_IMAGE);
    expect(TESTNET.ESCROW_IMAGE).toBe(ESCROW_IMAGE);
    expect(TESTNET.DEFAULT_TIMEOUT_MS).toBe(DEFAULT_TIMEOUT_MS);
    expect(TESTNET.SWAP_TIMEOUT_MS).toBe(SWAP_TIMEOUT_MS);
  });

  describe('RELAYS', () => {
    it('is non-empty', () => {
      expect(RELAYS.length).toBeGreaterThan(0);
    });

    it('every relay is a wss:// URL', () => {
      for (const relay of RELAYS) {
        expect(() => new URL(relay)).not.toThrow();
        expect(new URL(relay).protocol).toBe('wss:');
      }
    });
  });

  describe('HTTP URLs are well-formed', () => {
    it('AGGREGATOR_URL is https', () => {
      const u = new URL(AGGREGATOR_URL);
      expect(u.protocol).toBe('https:');
      expect(u.hostname.length).toBeGreaterThan(0);
    });

    it('IPFS_GATEWAY is https', () => {
      const u = new URL(IPFS_GATEWAY);
      expect(u.protocol).toBe('https:');
      expect(u.hostname.length).toBeGreaterThan(0);
    });

    it('FAUCET_URL is https and points at the canonical faucet path', () => {
      const u = new URL(FAUCET_URL);
      expect(u.protocol).toBe('https:');
      expect(u.hostname).toBe('faucet.unicity.network');
      expect(u.pathname).toBe('/api/v1/faucet/request');
    });
  });

  describe('image refs', () => {
    it('TRADER_IMAGE includes a tag', () => {
      expect(TRADER_IMAGE).toMatch(/:\S+$/);
    });

    it('ESCROW_IMAGE includes a tag', () => {
      expect(ESCROW_IMAGE).toMatch(/:\S+$/);
    });
  });

  describe('timeouts', () => {
    it('DEFAULT_TIMEOUT_MS is positive and < SWAP_TIMEOUT_MS', () => {
      expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
      expect(DEFAULT_TIMEOUT_MS).toBeLessThan(SWAP_TIMEOUT_MS);
    });

    it('SWAP_TIMEOUT_MS allows for slow testnet settlement', () => {
      // At least 5 minutes — anything less guarantees flakes.
      expect(SWAP_TIMEOUT_MS).toBeGreaterThanOrEqual(300_000);
    });
  });
});
