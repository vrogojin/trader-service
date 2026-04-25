/**
 * VolumeReservationLedger — prevents over-commitment of tradeable volume
 * across concurrent deals. Operates one layer above the SDK's
 * TokenReservationLedger (which handles token-level double-spend).
 *
 * The ledger tracks how much of each asset is committed to active deals
 * that haven't deposited yet. This prevents the agent from promising
 * more than it can deliver.
 */

export interface VolumeReservation {
  readonly dealId: string;
  readonly coinId: string;
  readonly amount: bigint;
}

export interface VolumeReservationLedger {
  /**
   * Reserve volume for a deal. Returns false if insufficient available volume.
   * Thread-safe: serialized via async mutex. Re-checks available after lock.
   */
  reserve(coinId: string, amount: bigint, dealId: string): Promise<boolean>;

  /** Release reservation when deal completes, fails, or is cancelled. */
  release(dealId: string): void;

  /**
   * Available volume = getBalance(coinId) - sum of active reservations.
   * Uses confirmedAmount from PaymentsAdapter (not totalAmount).
   */
  getAvailable(coinId: string): bigint;

  /** List all active reservations. */
  getReservations(): VolumeReservation[];

  /** Serialize for persistence. */
  serialize(): string;
}

export type GetConfirmedBalance = (coinId: string) => bigint;

interface StoredReservation {
  readonly coinId: string;
  readonly amount: bigint;
}

interface SerializedEntry {
  readonly dealId: string;
  readonly coinId: string;
  readonly amount: string;
}

function buildLedger(
  getBalance: GetConfirmedBalance,
  reservations: Map<string, StoredReservation>,
): VolumeReservationLedger {
  // Async mutex via promise chain (same pattern as withInstanceLock in manager.ts)
  let mutexTail: Promise<void> = Promise.resolve();

  function sumReservations(coinId: string): bigint {
    let total = 0n;
    for (const entry of reservations.values()) {
      if (entry.coinId === coinId) {
        total += entry.amount;
      }
    }
    return total;
  }

  function getAvailable(coinId: string): bigint {
    const balance = getBalance(coinId);
    const reserved = sumReservations(coinId);
    const available = balance - reserved;
    return available < 0n ? 0n : available;
  }

  return {
    reserve(coinId: string, amount: bigint, dealId: string): Promise<boolean> {
      const result = new Promise<boolean>((resolve) => {
        mutexTail = mutexTail.then(
          () => {
            // Re-check available after acquiring lock (spec 7.9.6)
            if (getAvailable(coinId) >= amount) {
              reservations.set(dealId, { coinId, amount });
              resolve(true);
            } else {
              resolve(false);
            }
          },
          () => {
            // Run even if previous chain entry rejected
            if (getAvailable(coinId) >= amount) {
              reservations.set(dealId, { coinId, amount });
              resolve(true);
            } else {
              resolve(false);
            }
          },
        );
      });
      return result;
    },

    release(dealId: string): void {
      reservations.delete(dealId);
    },

    getAvailable,

    getReservations(): VolumeReservation[] {
      const result: VolumeReservation[] = [];
      for (const [dealId, entry] of reservations) {
        result.push({ dealId, coinId: entry.coinId, amount: entry.amount });
      }
      return result;
    },

    serialize(): string {
      const entries: SerializedEntry[] = [];
      for (const [dealId, entry] of reservations) {
        entries.push({ dealId, coinId: entry.coinId, amount: entry.amount.toString() });
      }
      return JSON.stringify(entries);
    },
  };
}

export function createVolumeReservationLedger(
  getBalance: GetConfirmedBalance,
): VolumeReservationLedger {
  return buildLedger(getBalance, new Map());
}

/**
 * Deserialize from persisted state.
 */
export function loadVolumeReservationLedger(
  getBalance: GetConfirmedBalance,
  serialized: string,
): VolumeReservationLedger {
  const parsed: unknown = JSON.parse(serialized);
  if (!Array.isArray(parsed)) {
    throw new Error('VolumeReservationLedger: invalid serialized data — expected array');
  }
  const reservations = new Map<string, StoredReservation>();
  for (const entry of parsed as SerializedEntry[]) {
    if (
      typeof entry.dealId !== 'string' ||
      typeof entry.coinId !== 'string' ||
      typeof entry.amount !== 'string'
    ) {
      throw new Error('VolumeReservationLedger: invalid entry in serialized data');
    }
    reservations.set(entry.dealId, { coinId: entry.coinId, amount: BigInt(entry.amount) });
  }
  return buildLedger(getBalance, reservations);
}
