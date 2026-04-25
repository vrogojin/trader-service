import { describe, it, expect } from 'vitest';
import { createMessageHandler } from './message-handler.js';
import { createLogger } from '../shared/logger.js';

describe('MessageHandler', () => {
  describe('handleDm', () => {
    it('logs the incoming DM without sending a response', async () => {
      const logLines: string[] = [];
      const logger = createLogger({
        component: 'test',
        writer: (line) => { logLines.push(line); },
      });
      const handler = createMessageHandler(logger);

      await handler.handleDm('02aabbcc', 'DIRECT://sender', 'Hello there');

      // Verify a log was emitted with the DM details
      expect(logLines.length).toBeGreaterThan(0);
      const infoLog = logLines.find((l) => l.includes('dm_received'));
      expect(infoLog).toBeDefined();
      expect(infoLog).toContain('02aabbcc');
    });
  });

  describe('handlePayment', () => {
    it('logs the payment without sending a response', async () => {
      const logLines: string[] = [];
      const logger = createLogger({
        component: 'test',
        writer: (line) => { logLines.push(line); },
      });
      const handler = createMessageHandler(logger);

      await handler.handlePayment('02aabbcc', '1000', 'tx-abc');

      // Verify a log was emitted
      const paymentLog = logLines.find((l) => l.includes('payment_received'));
      expect(paymentLog).toBeDefined();
      expect(paymentLog).toContain('tx-abc');
    });

    it('does not leak instance identity to external senders', async () => {
      const logLines: string[] = [];
      const logger = createLogger({
        component: 'test',
        writer: (line) => { logLines.push(line); },
      });
      const handler = createMessageHandler(logger);

      await handler.handlePayment('02ff', '500', 'tx-xyz');

      // Verify payment was logged but no DM was sent (no sender dependency)
      const paymentLog = logLines.find((l) => l.includes('payment_received'));
      expect(paymentLog).toBeDefined();
    });
  });
});
