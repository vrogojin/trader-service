/**
 * MessageHandler — handles non-ACP DMs from external senders (not the manager).
 */

import type { Logger } from '../shared/logger.js';

export interface MessageHandler {
  handleDm(senderPubkey: string, senderAddress: string, content: string): Promise<void>;
  handlePayment(senderPubkey: string, amount: string, txId: string): Promise<void>;
}

export function createMessageHandler(
  logger: Logger,
): MessageHandler {
  return {
    async handleDm(senderPubkey: string, senderAddress: string, content: string): Promise<void> {
      // Log the DM for audit but do NOT respond — responding leaks instance identity
      // (instance_id, instance_name, status) to any Nostr user who DMs the tenant.
      logger.info('dm_received', {
        sender_pubkey: senderPubkey,
        sender_address: senderAddress,
        content_length: content.length,
      });
    },

    async handlePayment(senderPubkey: string, amount: string, txId: string): Promise<void> {
      // Log for audit but do NOT respond — responding leaks instance identity
      // (instance_id, instance_name) to any Nostr user who triggers a payment event.
      logger.info('payment_received', {
        sender_pubkey: senderPubkey,
        amount,
        tx_id: txId,
      });
    },
  };
}
