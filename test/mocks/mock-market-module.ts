/**
 * Mock MarketAdapter for Trader Agent unit tests.
 *
 * Tracks all calls for assertion, returns configurable results,
 * and supports triggering feed listeners programmatically.
 */

import type {
  MarketAdapter,
  MarketPostRequest,
  MarketSearchOptions,
  MarketSearchResult,
  MarketFeedListing,
  MarketMyIntent,
} from '../../src/trader/types.js';

export interface MockMarketModule extends MarketAdapter {
  /** Recorded calls for assertion */
  postIntentCalls: MarketPostRequest[];
  searchCalls: Array<{ query: string; opts?: MarketSearchOptions }>;
  closeIntentCalls: string[];
  /** Configure search results returned by search() */
  setSearchResults(results: MarketSearchResult[]): void;
  /** Configure intents returned by getMyIntents() */
  setMyIntents(intents: MarketMyIntent[]): void;
  /** Configure listings returned by getRecentListings() */
  setRecentListings(listings: MarketFeedListing[]): void;
  /** Trigger all registered feed listeners with a listing */
  triggerFeed(listing: MarketFeedListing): void;
}

export function createMockMarketModule(): MockMarketModule {
  let searchResults: MarketSearchResult[] = [];
  let myIntents: MarketMyIntent[] = [];
  let recentListings: MarketFeedListing[] = [];
  const feedListeners: Array<(listing: MarketFeedListing) => void> = [];
  let nextIntentCounter = 1;

  const mock: MockMarketModule = {
    // -- Recorded calls --
    postIntentCalls: [],
    searchCalls: [],
    closeIntentCalls: [],

    // -- Configuration helpers --
    setSearchResults(results: MarketSearchResult[]): void {
      searchResults = results;
    },

    setMyIntents(intents: MarketMyIntent[]): void {
      myIntents = intents;
    },

    setRecentListings(listings: MarketFeedListing[]): void {
      recentListings = listings;
    },

    triggerFeed(listing: MarketFeedListing): void {
      // Snapshot to avoid mutation during iteration
      const snapshot = [...feedListeners];
      for (const listener of snapshot) {
        listener(listing);
      }
    },

    // -- MarketAdapter implementation --
    async postIntent(request: MarketPostRequest): Promise<{ intentId: string }> {
      mock.postIntentCalls.push(request);
      const intentId = `mock-intent-${String(nextIntentCounter++)}`;
      return { intentId };
    },

    async search(query: string, opts?: MarketSearchOptions): Promise<MarketSearchResult[]> {
      mock.searchCalls.push({ query, opts });
      return [...searchResults];
    },

    subscribeFeed(listener: (listing: MarketFeedListing) => void): () => void {
      feedListeners.push(listener);
      return () => {
        const idx = feedListeners.indexOf(listener);
        if (idx >= 0) feedListeners.splice(idx, 1);
      };
    },

    async getMyIntents(): Promise<MarketMyIntent[]> {
      return [...myIntents];
    },

    async closeIntent(intentId: string): Promise<void> {
      mock.closeIntentCalls.push(intentId);
    },

    async getRecentListings(): Promise<MarketFeedListing[]> {
      return [...recentListings];
    },
  };

  return mock;
}
