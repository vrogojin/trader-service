/**
 * Mock PaymentsAdapter for Trader Agent unit tests.
 *
 * Simple Map<string, bigint>-backed mock that returns configurable
 * balances per coin ID. Defaults to 0n for unknown coins. Records every
 * send() call so tests can assert on the outgoing transfer.
 */

import type {
  PaymentsAdapter,
  SendTokenRequest,
  SendTokenResult,
} from '../../src/trader/types.js';

export interface MockPaymentsModule extends PaymentsAdapter {
  /** Set the confirmed balance for a given coin ID */
  setBalance(coinId: string, amount: bigint): void;
  /** Clear all configured balances */
  clearBalances(): void;
  /** Snapshot of every send() request — most recent last. */
  getSentTransfers(): readonly SendTokenRequest[];
  /**
   * Override the canned send() response. Pass either a fixed
   * SendTokenResult or a function that derives one from the request.
   */
  setSendResult(result: SendTokenResult | ((req: SendTokenRequest) => SendTokenResult)): void;
  /** Force send() to throw on the next call (one-shot). */
  failSendOnce(error: Error): void;
}

type SendResultFactory = SendTokenResult | ((req: SendTokenRequest) => SendTokenResult);

export function createMockPaymentsModule(): MockPaymentsModule {
  const balances = new Map<string, bigint>();
  const sentTransfers: SendTokenRequest[] = [];
  let sendCounter = 0;
  let pendingFailure: Error | null = null;
  let resultFactory: SendResultFactory = (): SendTokenResult => ({
    transferId: `mock-tx-${++sendCounter}`,
    status: 'success',
  });

  const mock: MockPaymentsModule = {
    // -- Configuration helpers --
    setBalance(coinId: string, amount: bigint): void {
      balances.set(coinId, amount);
    },

    clearBalances(): void {
      balances.clear();
    },

    getSentTransfers(): readonly SendTokenRequest[] {
      return sentTransfers;
    },

    setSendResult(result: SendResultFactory): void {
      resultFactory = result;
    },

    failSendOnce(error: Error): void {
      pendingFailure = error;
    },

    // -- PaymentsAdapter implementation --
    getConfirmedBalance(coinId: string): bigint {
      return balances.get(coinId) ?? 0n;
    },

    getAllBalances() {
      return Array.from(balances.entries()).map(([coinId, amount]) => ({
        coinId,
        symbol: coinId,
        confirmedAmount: amount,
        totalAmount: amount,
      }));
    },

    async refresh() {
      // No-op in mock
    },

    async send(request: SendTokenRequest): Promise<SendTokenResult> {
      sentTransfers.push(request);
      if (pendingFailure !== null) {
        const err = pendingFailure;
        pendingFailure = null;
        throw err;
      }
      return typeof resultFactory === 'function'
        ? resultFactory(request)
        : resultFactory;
    },
  };

  return mock;
}
