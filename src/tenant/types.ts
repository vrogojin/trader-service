/**
 * Tenant-side type definitions and interfaces.
 */

/**
 * Abstraction for sending Sphere DMs — injected as a dependency.
 * Mirrors the interface in host-manager/acp-client.ts but is defined here
 * so the tenant code does not depend on host-manager modules.
 */
export interface SphereDmSender {
  sendDm(recipientAddress: string, content: string): Promise<void>;
}

/**
 * Callback invoked when a DM arrives.
 */
export interface DmSubscription {
  onMessage(callback: (senderPubkey: string, senderAddress: string, content: string) => void): void;
  unsubscribe(): void;
}

/**
 * Abstraction for subscribing to incoming Sphere DMs.
 */
export interface SphereDmReceiver {
  subscribeDm(): DmSubscription;
}
