/**
 * Live E2E — Surplus refund (Audit Claim 5a(d)).
 *
 * Verifies the trader's wiring to the SDK's auto-return-on-overpay mechanism:
 * `sphere.accounting.setAutoReturn('*', true)` is called at startup, so that
 * any payout invoice targeting this trader's wallet refunds surplus
 * (`coveredAmount > requestedAmount`) back to the over-paying party.
 *
 * ## Scope of this test
 *
 * This test confirms the trader's STARTUP WIRING by reading the
 * `accounting_auto_return_enabled` log line that PR #12 emits immediately
 * after `setAutoReturn('*', true)` succeeds. If the wiring is removed (e.g.
 * a regression that drops the call), this test fails.
 *
 * ## Known gap (deliberately deferred)
 *
 * A full end-to-end "over-pay → refund propagates back to original payer"
 * test requires either:
 *   (a) a trader fault-injection knob to deposit MORE than the required
 *       amount on a real swap (the deposit invoice would then accumulate
 *       surplus, the escrow's `closeInvoice({autoReturn:true})` would refund
 *       it, and the over-paying trader's balance would restore minus the
 *       legitimate swap amount), OR
 *   (b) a separate SDK-level e2e that creates an invoice via the controller's
 *       Sphere SDK directly, pays X+Y into it, closes it, and verifies the
 *       refund — bypassing the trader entirely.
 *
 * Both are larger fixtures than this commit. The wiring assertion below is
 * the minimum-viable proof that the auto-return MECHANISM is enabled on the
 * trader; the SDK's own unit tests cover the mechanism's correctness.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  provisionTrader,
  type ProvisionedTenant,
} from './helpers/tenant-fixture.js';
import { getContainerLogs } from './helpers/docker-helpers.js';
import { TESTNET, UCT_COIN_ID, USDU_COIN_ID } from './helpers/constants.js';

describe('Surplus refund — trader auto-return wiring', () => {
  let trader: ProvisionedTenant;
  const cleanups: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    trader = await provisionTrader({
      label: 'surplus-trader',
      image: TESTNET.TRADER_IMAGE,
      relayUrls: [...TESTNET.RELAYS],
      trustedEscrows: [],
      // Self-mint funding — gives the trader real on-chain UCT/USDU at startup.
      // Not strictly required for the wiring check but keeps the fixture
      // consistent with the other suites should this test grow into a true
      // end-to-end refund flow.
      selfMintFund: [
        { coinIdHex: UCT_COIN_ID, amount: 1000n },
        { coinIdHex: USDU_COIN_ID, amount: 1000n },
      ],
    });
    cleanups.push(() => trader.dispose());
  }, 120_000);

  afterAll(async () => {
    for (const fn of cleanups) {
      try {
        await fn();
      } catch (err) {
        console.error('[surplus-refund afterAll] cleanup error:', err);
      }
    }
  }, 120_000);

  it(
    'trader emits accounting_auto_return_enabled at startup (Claim 5a(d) wiring)',
    async () => {
      const logs = await getContainerLogs(trader.container.id, { lines: 500 });

      // PR #12 added `logger.info('accounting_auto_return_enabled')` immediately
      // after `sphere.accounting.setAutoReturn('*', true)` resolves. Search for
      // the structured log line in either pino-format JSON or plain emit.
      const hasEvent =
        logs.includes('"event":"accounting_auto_return_enabled"') ||
        logs.includes('accounting_auto_return_enabled') ||
        // Idempotent restart path — RATE_LIMITED swallowed; treat as wiring-OK.
        logs.includes('"event":"accounting_auto_return_already_enabled"');

      expect(
        hasEvent,
        `trader did not emit accounting_auto_return_enabled — auto-return wiring is ` +
          `missing or broken. Without this log line, surplus on the trader's payout ` +
          `invoices will NOT refund to the original payer (Audit Claim 5a(d)). Logs ` +
          `tail (last 500 lines): ${logs.slice(-3000)}`,
      ).toBe(true);
    },
    60_000,
  );
});
