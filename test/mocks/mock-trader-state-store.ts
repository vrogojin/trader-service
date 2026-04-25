/**
 * In-memory mock of TraderStateStore for unit tests.
 *
 * Exposes both the object-shaped synchronous accessors used by the
 * trader-command-handler tests (`getIntent`, `setIntent`, `getAllIntents`,
 * `getDealsByIntentId`, ...) and the async `TraderStateStore` interface used
 * by the filesystem-backed store.
 *
 * All state lives in memory; `load()` / `save()` are no-ops.
 */

import type {
  IntentRecord,
  DealRecord,
  TraderStrategy,
  IntentState,
  DealState,
} from '../../src/trader/types.js';
import { DEFAULT_STRATEGY } from '../../src/trader/types.js';
import type { TraderStateStore } from '../../src/trader/trader-state-store.js';

export class MockTraderStateStore implements TraderStateStore {
  public intents = new Map<string, IntentRecord>();
  public deals = new Map<string, DealRecord>();
  public strategy: TraderStrategy = { ...DEFAULT_STRATEGY };
  public reservations: string | null = null;

  // ---------------------------------------------------------------------------
  // Synchronous accessors (used by unit-level tests that manipulate state
  // directly before invoking the component under test).
  // ---------------------------------------------------------------------------

  load = async (): Promise<void> => {};
  save = async (): Promise<void> => {};

  getIntent(id: string): IntentRecord | undefined {
    return this.intents.get(id);
  }

  getAllIntents(): IntentRecord[] {
    return [...this.intents.values()];
  }

  getIntentsByState(state: IntentState): IntentRecord[] {
    return [...this.intents.values()].filter((r) => r.state === state);
  }

  setIntent(r: IntentRecord): void {
    this.intents.set(r.intent.intent_id, r);
  }

  deleteIntentSync(id: string): void {
    this.intents.delete(id);
  }

  getDeal(id: string): DealRecord | undefined {
    return this.deals.get(id);
  }

  getAllDeals(): DealRecord[] {
    return [...this.deals.values()];
  }

  getDealsByIntentId(intentId: string): DealRecord[] {
    return [...this.deals.values()].filter(
      (d) =>
        d.terms.proposer_intent_id === intentId ||
        d.terms.acceptor_intent_id === intentId,
    );
  }

  setDeal(r: DealRecord): void {
    this.deals.set(r.terms.deal_id, r);
  }

  getStrategy(): TraderStrategy {
    return this.strategy;
  }

  setStrategy(s: TraderStrategy): void {
    this.strategy = s;
  }

  // ---------------------------------------------------------------------------
  // TraderStateStore async interface — delegates to the in-memory maps.
  // ---------------------------------------------------------------------------

  async saveIntent(record: IntentRecord): Promise<void> {
    this.setIntent(record);
  }

  async loadIntent(intentId: string): Promise<IntentRecord | null> {
    return this.intents.get(intentId) ?? null;
  }

  async loadIntents(
    filter?: { state?: IntentState | IntentState[] },
  ): Promise<IntentRecord[]> {
    const matches = (s: IntentState): boolean => {
      if (filter?.state === undefined) return true;
      if (Array.isArray(filter.state)) return filter.state.includes(s);
      return filter.state === s;
    };
    return [...this.intents.values()].filter((r) => matches(r.state));
  }

  async deleteIntent(intentId: string): Promise<void> {
    this.intents.delete(intentId);
  }

  async saveDeal(record: DealRecord): Promise<void> {
    this.setDeal(record);
  }

  async loadDeal(dealId: string): Promise<DealRecord | null> {
    return this.deals.get(dealId) ?? null;
  }

  async loadDeals(
    filter?: { state?: DealState | DealState[] },
  ): Promise<DealRecord[]> {
    const matches = (s: DealState): boolean => {
      if (filter?.state === undefined) return true;
      if (Array.isArray(filter.state)) return filter.state.includes(s);
      return filter.state === s;
    };
    return [...this.deals.values()].filter((r) => matches(r.state));
  }

  async deleteDeal(dealId: string): Promise<void> {
    this.deals.delete(dealId);
  }

  async saveStrategy(strategy: TraderStrategy): Promise<void> {
    this.strategy = strategy;
  }

  async loadStrategy(): Promise<TraderStrategy | null> {
    return this.strategy;
  }

  async saveReservations(serialized: string): Promise<void> {
    this.reservations = serialized;
  }

  async loadReservations(): Promise<string | null> {
    return this.reservations;
  }
}

/**
 * Factory helper — preserves the existing `createMockTraderStateStore()`
 * call sites that return the async `TraderStateStore` interface.
 */
export function createMockTraderStateStore(): MockTraderStateStore {
  return new MockTraderStateStore();
}
