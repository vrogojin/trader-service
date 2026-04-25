import { describe, it, expect } from 'vitest';
import {
  createVolumeReservationLedger,
  loadVolumeReservationLedger,
} from './volume-reservation-ledger.js';
import type { GetConfirmedBalance } from './volume-reservation-ledger.js';

function fixedBalance(amount: bigint): GetConfirmedBalance {
  return () => amount;
}

// ---------------------------------------------------------------------------
// reserve + getAvailable
// ---------------------------------------------------------------------------

describe('VolumeReservationLedger', () => {
  it('reserve reduces available volume', async () => {
    const ledger = createVolumeReservationLedger(fixedBalance(1000n));
    const ok = await ledger.reserve('COIN_A', 500n, 'deal_1');
    expect(ok).toBe(true);
    expect(ledger.getAvailable('COIN_A')).toBe(500n);
  });

  // ---------------------------------------------------------------------------
  // release
  // ---------------------------------------------------------------------------

  it('release restores available volume', async () => {
    const ledger = createVolumeReservationLedger(fixedBalance(1000n));
    await ledger.reserve('COIN_A', 500n, 'deal_1');
    ledger.release('deal_1');
    expect(ledger.getAvailable('COIN_A')).toBe(1000n);
  });

  // ---------------------------------------------------------------------------
  // multiple reservations
  // ---------------------------------------------------------------------------

  it('multiple reservations reduce available cumulatively', async () => {
    const ledger = createVolumeReservationLedger(fixedBalance(1000n));
    expect(await ledger.reserve('COIN_A', 300n, 'deal_1')).toBe(true);
    expect(await ledger.reserve('COIN_A', 400n, 'deal_2')).toBe(true);
    expect(ledger.getAvailable('COIN_A')).toBe(300n);

    // Cannot reserve more than available
    expect(await ledger.reserve('COIN_A', 400n, 'deal_3')).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // insufficient balance
  // ---------------------------------------------------------------------------

  it('reserve fails when amount exceeds available', async () => {
    const ledger = createVolumeReservationLedger(fixedBalance(1000n));
    const ok = await ledger.reserve('COIN_A', 1500n, 'deal_1');
    expect(ok).toBe(false);
    expect(ledger.getAvailable('COIN_A')).toBe(1000n);
  });

  // ---------------------------------------------------------------------------
  // serialize / deserialize round-trip
  // ---------------------------------------------------------------------------

  it('serialize then loadVolumeReservationLedger round-trips', async () => {
    const ledger = createVolumeReservationLedger(fixedBalance(1000n));
    await ledger.reserve('COIN_A', 300n, 'deal_1');
    await ledger.reserve('COIN_B', 200n, 'deal_2');

    const serialized = ledger.serialize();
    const restored = loadVolumeReservationLedger(fixedBalance(1000n), serialized);

    const reservations = restored.getReservations();
    expect(reservations).toHaveLength(2);

    const byDeal = new Map(reservations.map((r) => [r.dealId, r]));
    expect(byDeal.get('deal_1')?.amount).toBe(300n);
    expect(byDeal.get('deal_1')?.coinId).toBe('COIN_A');
    expect(byDeal.get('deal_2')?.amount).toBe(200n);
    expect(byDeal.get('deal_2')?.coinId).toBe('COIN_B');

    expect(restored.getAvailable('COIN_A')).toBe(700n);
  });

  // ---------------------------------------------------------------------------
  // external balance drop
  // ---------------------------------------------------------------------------

  it('getAvailable returns 0 (not negative) when balance drops below reserved', async () => {
    let currentBalance = 1000n;
    const ledger = createVolumeReservationLedger(() => currentBalance);

    await ledger.reserve('COIN_A', 800n, 'deal_1');
    expect(ledger.getAvailable('COIN_A')).toBe(200n);

    // Simulate external balance drop
    currentBalance = 500n;
    expect(ledger.getAvailable('COIN_A')).toBe(0n);
  });

  // ---------------------------------------------------------------------------
  // concurrent reserve (mutex)
  // ---------------------------------------------------------------------------

  it('mutex serializes concurrent reserves — only one succeeds', async () => {
    const ledger = createVolumeReservationLedger(fixedBalance(1000n));

    // Fire both concurrently — each wants 600 from 1000, only one fits
    const [r1, r2] = await Promise.all([
      ledger.reserve('COIN_A', 600n, 'deal_1'),
      ledger.reserve('COIN_A', 600n, 'deal_2'),
    ]);

    // Exactly one should succeed
    expect([r1, r2].filter(Boolean)).toHaveLength(1);
    expect(ledger.getReservations()).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // release unknown dealId
  // ---------------------------------------------------------------------------

  it('releasing an unknown dealId is a no-op', () => {
    const ledger = createVolumeReservationLedger(fixedBalance(1000n));
    // Should not throw
    ledger.release('nonexistent_deal');
    expect(ledger.getAvailable('COIN_A')).toBe(1000n);
  });

  // ---------------------------------------------------------------------------
  // getReservations returns empty initially
  // ---------------------------------------------------------------------------

  it('getReservations returns empty array when no reservations exist', () => {
    const ledger = createVolumeReservationLedger(fixedBalance(1000n));
    expect(ledger.getReservations()).toEqual([]);
  });
});
