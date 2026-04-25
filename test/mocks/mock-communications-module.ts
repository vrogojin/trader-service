/**
 * Mock communications module for Trader Agent unit tests.
 *
 * Tracks sent DMs, allows injecting incoming DMs, and supports
 * registering/unregistering DM handlers.
 */

export interface MockCommsModule {
  /** All DMs sent via sendDm(), recorded for assertion */
  sentDms: Array<{ to: string; content: string }>;
  /** Send a DM (records the call, resolves immediately) */
  sendDm(recipientAddress: string, content: string): Promise<void>;
  /** Inject an incoming DM — triggers all registered handlers */
  injectDm(senderPubkey: string, senderAddress: string, content: string): void;
  /** Register a handler for incoming DMs. Returns an unsubscribe function. */
  onDm(handler: (senderPubkey: string, senderAddress: string, content: string) => void): () => void;
}

export function createMockCommsModule(): MockCommsModule {
  const handlers: Array<(senderPubkey: string, senderAddress: string, content: string) => void> = [];

  const mock: MockCommsModule = {
    sentDms: [],

    async sendDm(recipientAddress: string, content: string): Promise<void> {
      mock.sentDms.push({ to: recipientAddress, content });
    },

    injectDm(senderPubkey: string, senderAddress: string, content: string): void {
      // Snapshot to avoid mutation during iteration
      const snapshot = [...handlers];
      for (const handler of snapshot) {
        handler(senderPubkey, senderAddress, content);
      }
    },

    onDm(handler: (senderPubkey: string, senderAddress: string, content: string) => void): () => void {
      handlers.push(handler);
      return () => {
        const idx = handlers.indexOf(handler);
        if (idx >= 0) handlers.splice(idx, 1);
      };
    },
  };

  return mock;
}
