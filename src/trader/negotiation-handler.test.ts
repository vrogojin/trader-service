import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { createNegotiationHandler } from './negotiation-handler.js';
import type { NegotiationHandler, NegotiationHandlerDeps } from './negotiation-handler.js';
import type {
  DealRecord,
  DealTerms,
  IntentRecord,
  MarketSearchResult,
  NpMessage,
} from './types.js';
import { canonicalJson } from './utils.js';
import type { Logger } from '../shared/logger.js';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

// Valid 66-char compressed secp256k1 pubkeys (02 prefix + 64 hex chars)
const AGENT_PUBKEY = '02' + 'aa'.repeat(32);
const COUNTERPARTY_PUBKEY = '02' + 'bb'.repeat(32);
const THIRD_PARTY_PUBKEY = '02' + 'cc'.repeat(32);

const AGENT_ADDRESS = 'agent-address-1';
const COUNTERPARTY_ADDRESS = 'counterparty-address-1';

const FIXED_SIGNATURE = 'fixed-test-signature';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

function createDeps(overrides: Partial<NegotiationHandlerDeps> = {}): NegotiationHandlerDeps {
  return {
    sendDm: vi.fn<(addr: string, content: string) => Promise<void>>().mockResolvedValue(undefined),
    signMessage: vi.fn<(msg: string) => string>().mockReturnValue(FIXED_SIGNATURE),
    verifySignature: vi.fn<(sig: string, msg: string, pubkey: string) => boolean>().mockReturnValue(true),
    onDealAccepted: vi.fn<(deal: DealRecord) => Promise<void>>().mockResolvedValue(undefined),
    onDealCancelled: vi.fn<(deal: DealRecord) => void>(),
    agentPubkey: AGENT_PUBKEY,
    agentAddress: AGENT_ADDRESS,
    logger: createMockLogger(),
    ...overrides,
  };
}

function makeOwnIntent(): IntentRecord {
  return {
    intent: {
      intent_id: 'intent-proposer-001',
      market_intent_id: 'market-001',
      agent_pubkey: AGENT_PUBKEY,
      agent_address: AGENT_ADDRESS,
      salt: 'salt-1',
      direction: 'sell',
      base_asset: 'ALPHA',
      quote_asset: 'BRAVO',
      rate_min: 100n,
      rate_max: 200n,
      volume_min: 10n,
      volume_max: 100n,
      volume_filled: 0n,
      escrow_address: 'escrow-addr-1',
      deposit_timeout_sec: 60,
      expiry_ms: Date.now() + 3_600_000,
      signature: 'intent-sig',
    },
    state: 'ACTIVE',
    deal_ids: [],
    updated_at: Date.now(),
  };
}

function makeCounterparty(): MarketSearchResult {
  return {
    id: 'intent-acceptor-001',
    score: 0.9,
    agentPublicKey: COUNTERPARTY_PUBKEY,
    description: 'Buying ALPHA for BRAVO',
    intentType: 'buy',
    currency: 'BRAVO',
    contactHandle: COUNTERPARTY_ADDRESS,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

function sha256hex(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

function computeDealId(terms: DealTerms): string {
  const obj = {
    acceptor_intent_id: terms.acceptor_intent_id,
    acceptor_pubkey: terms.acceptor_pubkey,
    base_asset: terms.base_asset,
    created_ms: terms.created_ms,
    deposit_timeout_sec: terms.deposit_timeout_sec,
    escrow_address: terms.escrow_address,
    proposer_address: terms.proposer_address,
    acceptor_address: terms.acceptor_address,
    proposer_direction: terms.proposer_direction,
    proposer_intent_id: terms.proposer_intent_id,
    proposer_pubkey: terms.proposer_pubkey,
    quote_asset: terms.quote_asset,
    rate: terms.rate,
    volume: terms.volume,
  };
  return sha256hex(canonicalJson(obj));
}

/** Build a valid NpMessage for testing incoming DMs. */
function buildNpMessage(
  dealId: string,
  type: NpMessage['type'],
  senderPubkey: string,
  payload: Record<string, unknown>,
): NpMessage {
  const msgId = crypto.randomUUID();
  return {
    np_version: '0.1',
    msg_id: msgId,
    deal_id: dealId,
    sender_pubkey: senderPubkey,
    type,
    ts_ms: Date.now(),
    payload,
    signature: FIXED_SIGNATURE,
  };
}

function buildProposeDealTerms(overrides: Partial<DealTerms> = {}): DealTerms {
  const base: DealTerms = {
    deal_id: '', // computed below
    proposer_intent_id: 'intent-remote-001',
    acceptor_intent_id: 'intent-local-001',
    proposer_pubkey: COUNTERPARTY_PUBKEY,
    acceptor_pubkey: AGENT_PUBKEY,
    proposer_address: COUNTERPARTY_ADDRESS,
    acceptor_address: AGENT_ADDRESS,
    base_asset: 'ALPHA',
    quote_asset: 'BRAVO',
    rate: 150n,
    volume: 50n,
    proposer_direction: 'sell',
    escrow_address: 'escrow-addr-1',
    deposit_timeout_sec: 60,
    created_ms: Date.now(),
    ...overrides,
  };
  const id = computeDealId(base);
  return { ...base, deal_id: id };
}

function buildProposeDealMessage(terms: DealTerms): NpMessage {
  return buildNpMessage(terms.deal_id, 'np.propose_deal', terms.proposer_pubkey, {
    terms: {
      ...terms,
      rate: terms.rate.toString(),
      volume: terms.volume.toString(),
    },
    proposer_swap_address: COUNTERPARTY_ADDRESS,
    message: '',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NegotiationHandler', () => {
  let deps: NegotiationHandlerDeps;
  let handler: NegotiationHandler;

  beforeEach(() => {
    deps = createDeps();
    handler = createNegotiationHandler(deps);
  });

  afterEach(() => {
    handler.stop();
  });

  // =========================================================================
  // 1. proposeDeal()
  // =========================================================================

  describe('proposeDeal()', () => {
    it('creates a deal with correct DealTerms and content-addressed deal_id', async () => {
      const ownIntent = makeOwnIntent();
      const counterparty = makeCounterparty();
      const deal = await handler.proposeDeal(ownIntent, counterparty, 150n, 50n, 'escrow-1');

      expect(deal.terms.proposer_pubkey).toBe(AGENT_PUBKEY);
      expect(deal.terms.acceptor_pubkey).toBe(COUNTERPARTY_PUBKEY);
      expect(deal.terms.proposer_intent_id).toBe(ownIntent.intent.intent_id);
      expect(deal.terms.acceptor_intent_id).toBe(counterparty.id);
      expect(deal.terms.base_asset).toBe('ALPHA');
      expect(deal.terms.quote_asset).toBe('BRAVO');
      expect(deal.terms.rate).toBe(150n);
      expect(deal.terms.volume).toBe(50n);
      expect(deal.terms.escrow_address).toBe('escrow-1');

      // deal_id is content-addressed
      const expectedId = computeDealId(deal.terms);
      expect(deal.terms.deal_id).toBe(expectedId);
      expect(deal.terms.deal_id).toMatch(/^[0-9a-f]{64}$/);
    });

    it('sends np.propose_deal DM with correct NpMessage envelope', async () => {
      const deal = await handler.proposeDeal(
        makeOwnIntent(), makeCounterparty(), 150n, 50n, 'escrow-1',
      );

      expect(deps.sendDm).toHaveBeenCalledTimes(1);
      const [recipientAddr, content] = (deps.sendDm as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
      expect(recipientAddr).toBe(COUNTERPARTY_ADDRESS);

      const parsed = JSON.parse(content) as NpMessage;
      expect(parsed.np_version).toBe('0.1');
      expect(parsed.type).toBe('np.propose_deal');
      expect(parsed.deal_id).toBe(deal.terms.deal_id);
      expect(parsed.sender_pubkey).toBe(AGENT_PUBKEY);
      expect(parsed.signature).toBe(FIXED_SIGNATURE);
      expect(parsed.payload).toHaveProperty('terms');
    });

    it('transitions to PROPOSED state', async () => {
      const deal = await handler.proposeDeal(
        makeOwnIntent(), makeCounterparty(), 150n, 50n, 'escrow-1',
      );

      expect(deal.state).toBe('PROPOSED');
      const fetched = handler.getDeal(deal.terms.deal_id);
      expect(fetched).not.toBeNull();
      expect(fetched!.state).toBe('PROPOSED');
    });

    it('sets a 30s timeout', async () => {
      vi.useFakeTimers();
      try {
        const localHandler = createNegotiationHandler(createDeps());
        const deal = await localHandler.proposeDeal(
          makeOwnIntent(), makeCounterparty(), 150n, 50n, 'escrow-1',
        );

        // Before timeout: still PROPOSED
        vi.advanceTimersByTime(29_999);
        expect(localHandler.getDeal(deal.terms.deal_id)!.state).toBe('PROPOSED');

        // After timeout: CANCELLED
        vi.advanceTimersByTime(2);
        expect(localHandler.getDeal(deal.terms.deal_id)!.state).toBe('CANCELLED');

        localHandler.stop();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // =========================================================================
  // 2. handleIncomingDm() — np.propose_deal
  // =========================================================================

  describe('handleIncomingDm() — np.propose_deal', () => {
    it('validates signature and creates ACCEPTED deal', async () => {
      const terms = buildProposeDealTerms();
      const msg = buildProposeDealMessage(terms);

      await handler.handleIncomingDm(COUNTERPARTY_PUBKEY, COUNTERPARTY_ADDRESS, JSON.stringify(msg));

      const deal = handler.getDeal(terms.deal_id);
      expect(deal).not.toBeNull();
      expect(deal!.state).toBe('ACCEPTED');
      expect(deps.verifySignature).toHaveBeenCalled();
    });

    it('sends np.accept_deal DM back to proposer', async () => {
      const terms = buildProposeDealTerms();
      const msg = buildProposeDealMessage(terms);

      await handler.handleIncomingDm(COUNTERPARTY_PUBKEY, COUNTERPARTY_ADDRESS, JSON.stringify(msg));

      expect(deps.sendDm).toHaveBeenCalledTimes(1);
      const [addr, content] = (deps.sendDm as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
      expect(addr).toBe(COUNTERPARTY_ADDRESS);
      const parsed = JSON.parse(content) as NpMessage;
      expect(parsed.type).toBe('np.accept_deal');
      expect(parsed.deal_id).toBe(terms.deal_id);
    });

    it('calls onDealAccepted callback', async () => {
      const terms = buildProposeDealTerms();
      const msg = buildProposeDealMessage(terms);

      await handler.handleIncomingDm(COUNTERPARTY_PUBKEY, COUNTERPARTY_ADDRESS, JSON.stringify(msg));

      expect(deps.onDealAccepted).toHaveBeenCalledTimes(1);
      const callArg = (deps.onDealAccepted as ReturnType<typeof vi.fn>).mock.calls[0]![0] as DealRecord;
      expect(callArg.state).toBe('ACCEPTED');
      expect(callArg.terms.deal_id).toBe(terms.deal_id);
    });

    it('rejects duplicate deal for same acceptor_intent_id (spec 5.7)', async () => {
      // First proposal — accepted
      const terms1 = buildProposeDealTerms({ created_ms: Date.now() - 1000 });
      const msg1 = buildProposeDealMessage(terms1);
      await handler.handleIncomingDm(COUNTERPARTY_PUBKEY, COUNTERPARTY_ADDRESS, JSON.stringify(msg1));
      expect(handler.getDeal(terms1.deal_id)!.state).toBe('ACCEPTED');

      // Second proposal with same acceptor_intent_id but different created_ms
      const terms2 = buildProposeDealTerms({ created_ms: Date.now() });
      const msg2 = buildProposeDealMessage(terms2);
      await handler.handleIncomingDm(COUNTERPARTY_PUBKEY, COUNTERPARTY_ADDRESS, JSON.stringify(msg2));

      // Second deal should not exist — rejected
      expect(handler.getDeal(terms2.deal_id)).toBeNull();
      // Rejection DM should be sent
      expect(deps.sendDm).toHaveBeenCalledTimes(2); // accept + reject
      const lastContent = (deps.sendDm as ReturnType<typeof vi.fn>).mock.calls[1]![1] as string;
      const rejectMsg = JSON.parse(lastContent) as NpMessage;
      expect(rejectMsg.type).toBe('np.reject_deal');
    });

    it('drops silently if per-counterparty rate limit exceeded (3/60s)', async () => {
      // F5: the rate-limit gate now runs at the very top of handleProposeDeal
      // and DROPS SILENTLY (no outbound reject DM) so it cannot be used as a
      // 1:1 DM amplifier. This test used to assert a np.reject_deal was sent
      // back; that behavior was removed.

      // Send 3 proposals (all accepted). Each successful accept sends ONE
      // np.accept_deal DM.
      for (let i = 0; i < 3; i++) {
        const terms = buildProposeDealTerms({
          acceptor_intent_id: `intent-local-${i}`,
          created_ms: Date.now() + i,
        });
        const msg = buildProposeDealMessage(terms);
        await handler.handleIncomingDm(COUNTERPARTY_PUBKEY, COUNTERPARTY_ADDRESS, JSON.stringify(msg));
      }
      const acceptCount = (deps.sendDm as ReturnType<typeof vi.fn>).mock.calls.length;

      // 4th proposal from same counterparty — rate limited, dropped silently.
      const terms4 = buildProposeDealTerms({
        acceptor_intent_id: 'intent-local-rl',
        created_ms: Date.now() + 100,
      });
      const msg4 = buildProposeDealMessage(terms4);
      await handler.handleIncomingDm(COUNTERPARTY_PUBKEY, COUNTERPARTY_ADDRESS, JSON.stringify(msg4));

      // No deal was created for the 4th proposal.
      expect(handler.getDeal(terms4.deal_id)).toBeNull();
      // No additional DM was sent — the rate-limited proposal was dropped
      // silently. Prevents 1:1 DoS amplification via this handler.
      expect((deps.sendDm as ReturnType<typeof vi.fn>).mock.calls.length).toBe(acceptCount);
    });
  });

  // =========================================================================
  // 3. handleIncomingDm() — np.accept_deal
  // =========================================================================

  describe('handleIncomingDm() — np.accept_deal', () => {
    it('validates sender is acceptor and transitions PROPOSED -> ACCEPTED', async () => {
      // First, propose a deal (our agent is proposer)
      const deal = await handler.proposeDeal(
        makeOwnIntent(), makeCounterparty(), 150n, 50n, 'escrow-1',
      );
      expect(deal.state).toBe('PROPOSED');

      // Counterparty sends accept
      const acceptMsg = buildNpMessage(
        deal.terms.deal_id,
        'np.accept_deal',
        COUNTERPARTY_PUBKEY,
        { acceptor_swap_address: 'swap-addr-1', message: '' },
      );

      await handler.handleIncomingDm(COUNTERPARTY_PUBKEY, COUNTERPARTY_ADDRESS, JSON.stringify(acceptMsg));

      const updated = handler.getDeal(deal.terms.deal_id);
      expect(updated).not.toBeNull();
      expect(updated!.state).toBe('ACCEPTED');
      expect(updated!.acceptor_swap_address).toBe('swap-addr-1');
    });

    it('calls onDealAccepted callback', async () => {
      const deal = await handler.proposeDeal(
        makeOwnIntent(), makeCounterparty(), 150n, 50n, 'escrow-1',
      );

      const acceptMsg = buildNpMessage(
        deal.terms.deal_id,
        'np.accept_deal',
        COUNTERPARTY_PUBKEY,
        { acceptor_swap_address: 'swap-addr-1', message: '' },
      );
      await handler.handleIncomingDm(COUNTERPARTY_PUBKEY, COUNTERPARTY_ADDRESS, JSON.stringify(acceptMsg));

      // onDealAccepted called for the accept
      expect(deps.onDealAccepted).toHaveBeenCalled();
      const lastCall = (deps.onDealAccepted as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as DealRecord;
      expect(lastCall.state).toBe('ACCEPTED');
    });

    it('rejects accept from non-acceptor pubkey', async () => {
      const deal = await handler.proposeDeal(
        makeOwnIntent(), makeCounterparty(), 150n, 50n, 'escrow-1',
      );

      const acceptMsg = buildNpMessage(
        deal.terms.deal_id,
        'np.accept_deal',
        THIRD_PARTY_PUBKEY,
        { message: '' },
      );
      await handler.handleIncomingDm(THIRD_PARTY_PUBKEY, 'third-addr', JSON.stringify(acceptMsg));

      // Should still be PROPOSED
      expect(handler.getDeal(deal.terms.deal_id)!.state).toBe('PROPOSED');
    });
  });

  // =========================================================================
  // 4. handleIncomingDm() — np.reject_deal
  // =========================================================================

  describe('handleIncomingDm() — np.reject_deal', () => {
    it('transitions PROPOSED deal to CANCELLED', async () => {
      const deal = await handler.proposeDeal(
        makeOwnIntent(), makeCounterparty(), 150n, 50n, 'escrow-1',
      );

      const rejectMsg = buildNpMessage(
        deal.terms.deal_id,
        'np.reject_deal',
        COUNTERPARTY_PUBKEY,
        { reason_code: 'NOT_INTERESTED', message: 'no thanks' },
      );
      await handler.handleIncomingDm(COUNTERPARTY_PUBKEY, COUNTERPARTY_ADDRESS, JSON.stringify(rejectMsg));

      expect(handler.getDeal(deal.terms.deal_id)!.state).toBe('CANCELLED');
    });

    it('transitions ACCEPTED deal to CANCELLED', async () => {
      // Create an accepted incoming deal
      const terms = buildProposeDealTerms();
      const propMsg = buildProposeDealMessage(terms);
      await handler.handleIncomingDm(COUNTERPARTY_PUBKEY, COUNTERPARTY_ADDRESS, JSON.stringify(propMsg));
      expect(handler.getDeal(terms.deal_id)!.state).toBe('ACCEPTED');

      // Proposer rejects
      const rejectMsg = buildNpMessage(
        terms.deal_id,
        'np.reject_deal',
        COUNTERPARTY_PUBKEY,
        { reason_code: 'CHANGED_MIND', message: '' },
      );
      await handler.handleIncomingDm(COUNTERPARTY_PUBKEY, COUNTERPARTY_ADDRESS, JSON.stringify(rejectMsg));

      expect(handler.getDeal(terms.deal_id)!.state).toBe('CANCELLED');
    });
  });

  // =========================================================================
  // 5. Security validation
  // =========================================================================

  describe('Security validation', () => {
    it('rejects message > 64 KiB', async () => {
      const huge = 'x'.repeat(65 * 1024);
      await handler.handleIncomingDm(COUNTERPARTY_PUBKEY, COUNTERPARTY_ADDRESS, huge);

      expect(deps.logger.warn).toHaveBeenCalledWith(
        'np_message_too_large',
        expect.objectContaining({ sender: COUNTERPARTY_PUBKEY }),
      );
    });

    it('rejects invalid signature', async () => {
      const failDeps = createDeps({
        verifySignature: vi.fn().mockReturnValue(false),
      });
      const localHandler = createNegotiationHandler(failDeps);

      const terms = buildProposeDealTerms();
      const msg = buildProposeDealMessage(terms);
      await localHandler.handleIncomingDm(COUNTERPARTY_PUBKEY, COUNTERPARTY_ADDRESS, JSON.stringify(msg));

      expect(localHandler.getDeal(terms.deal_id)).toBeNull();
      expect(failDeps.logger.warn).toHaveBeenCalledWith(
        'np_message_signature_invalid',
        expect.objectContaining({ deal_id: terms.deal_id }),
      );

      localHandler.stop();
    });

    it('rejects wrong sender_pubkey (not matching DM sender)', async () => {
      const terms = buildProposeDealTerms();
      const msg = buildProposeDealMessage(terms);

      // DM sender doesn't match envelope sender_pubkey
      await handler.handleIncomingDm(THIRD_PARTY_PUBKEY, 'third-addr', JSON.stringify(msg));

      expect(handler.getDeal(terms.deal_id)).toBeNull();
      expect(deps.logger.warn).toHaveBeenCalledWith(
        'np_message_pubkey_mismatch',
        expect.anything(),
      );
    });

    it('rejects duplicate msg_id (dedup)', async () => {
      const terms = buildProposeDealTerms();
      const msg = buildProposeDealMessage(terms);
      const content = JSON.stringify(msg);

      // First call succeeds
      await handler.handleIncomingDm(COUNTERPARTY_PUBKEY, COUNTERPARTY_ADDRESS, content);
      expect(handler.getDeal(terms.deal_id)!.state).toBe('ACCEPTED');

      // Second call with same msg_id is silently deduped
      await handler.handleIncomingDm(COUNTERPARTY_PUBKEY, COUNTERPARTY_ADDRESS, content);
      expect(deps.logger.debug).toHaveBeenCalledWith(
        'np_message_duplicate',
        expect.objectContaining({ msg_id: msg.msg_id }),
      );
    });

    it('rejects ts_ms > 300s from now', async () => {
      const terms = buildProposeDealTerms();
      const msg = buildProposeDealMessage(terms);
      // Set ts_ms far in the future
      const tampered = { ...msg, ts_ms: Date.now() + 400_000 };

      await handler.handleIncomingDm(COUNTERPARTY_PUBKEY, COUNTERPARTY_ADDRESS, JSON.stringify(tampered));

      expect(handler.getDeal(terms.deal_id)).toBeNull();
      expect(deps.logger.warn).toHaveBeenCalledWith(
        'np_message_clock_skew',
        expect.anything(),
      );
    });

    it('rejects messages with __proto__ keys (hasDangerousKeys)', async () => {
      // JSON.parse preserves "__proto__" as a regular enumerable key in nested objects
      // when created via JSON string literal (not object literal assignment).
      const malicious = '{"np_version":"0.1","msg_id":"' + crypto.randomUUID() + '","deal_id":"' + 'a'.repeat(64) + '","sender_pubkey":"' + COUNTERPARTY_PUBKEY + '","type":"np.propose_deal","ts_ms":' + Date.now() + ',"payload":{"nested":{"__proto__":{"evil":true}}},"signature":"' + FIXED_SIGNATURE + '"}';

      await handler.handleIncomingDm(COUNTERPARTY_PUBKEY, COUNTERPARTY_ADDRESS, malicious);

      expect(deps.logger.warn).toHaveBeenCalledWith(
        'np_message_dangerous_keys',
        expect.anything(),
      );
    });

    it('rejects invalid JSON', async () => {
      await handler.handleIncomingDm(COUNTERPARTY_PUBKEY, COUNTERPARTY_ADDRESS, '{not valid json');

      expect(deps.logger.debug).toHaveBeenCalledWith(
        'np_message_not_json',
        expect.objectContaining({ sender: COUNTERPARTY_PUBKEY }),
      );
    });
  });

  // =========================================================================
  // 6. Timeouts
  // =========================================================================

  describe('Timeouts', () => {
    it('PROPOSED times out after 30s -> CANCELLED', async () => {
      vi.useFakeTimers();
      try {
        const localDeps = createDeps();
        const localHandler = createNegotiationHandler(localDeps);
        const deal = await localHandler.proposeDeal(
          makeOwnIntent(), makeCounterparty(), 150n, 50n, 'escrow-1',
        );

        expect(localHandler.getDeal(deal.terms.deal_id)!.state).toBe('PROPOSED');

        vi.advanceTimersByTime(30_000);
        expect(localHandler.getDeal(deal.terms.deal_id)!.state).toBe('CANCELLED');

        localHandler.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it('ACCEPTED deal stays ACCEPTED (SwapExecutor owns execution timeouts)', async () => {
      vi.useFakeTimers();
      try {
        const localDeps = createDeps();
        const localHandler = createNegotiationHandler(localDeps);

        const terms = buildProposeDealTerms({ created_ms: Date.now() });
        const msg = buildProposeDealMessage(terms);
        await localHandler.handleIncomingDm(COUNTERPARTY_PUBKEY, COUNTERPARTY_ADDRESS, JSON.stringify(msg));
        expect(localHandler.getDeal(terms.deal_id)!.state).toBe('ACCEPTED');

        // After 60s — no accept timeout, deal stays ACCEPTED
        vi.advanceTimersByTime(60_001);
        expect(localHandler.getDeal(terms.deal_id)!.state).toBe('ACCEPTED');

        localHandler.stop();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // =========================================================================
  // 7. cancelPending() / stop()
  // =========================================================================

  describe('cancelPending() / stop()', () => {
    it('cancelPending() cancels all non-terminal deals', async () => {
      // Create a PROPOSED deal
      const deal1 = await handler.proposeDeal(
        makeOwnIntent(), makeCounterparty(), 150n, 50n, 'escrow-1',
      );

      // Create an ACCEPTED deal (via incoming propose)
      const terms2 = buildProposeDealTerms({ acceptor_intent_id: 'intent-cp-2', created_ms: Date.now() + 1 });
      const msg2 = buildProposeDealMessage(terms2);
      await handler.handleIncomingDm(COUNTERPARTY_PUBKEY, COUNTERPARTY_ADDRESS, JSON.stringify(msg2));

      expect(handler.getDeal(deal1.terms.deal_id)!.state).toBe('PROPOSED');
      expect(handler.getDeal(terms2.deal_id)!.state).toBe('ACCEPTED');

      handler.cancelPending();

      expect(handler.getDeal(deal1.terms.deal_id)!.state).toBe('CANCELLED');
      expect(handler.getDeal(terms2.deal_id)!.state).toBe('CANCELLED');
    });

    it('cancelPending() does not touch terminal deals', async () => {
      // Create and then reject a deal so it becomes CANCELLED
      const deal = await handler.proposeDeal(
        makeOwnIntent(), makeCounterparty(), 150n, 50n, 'escrow-1',
      );
      const rejectMsg = buildNpMessage(
        deal.terms.deal_id,
        'np.reject_deal',
        COUNTERPARTY_PUBKEY,
        { reason_code: 'NOT_INTERESTED', message: '' },
      );
      await handler.handleIncomingDm(COUNTERPARTY_PUBKEY, COUNTERPARTY_ADDRESS, JSON.stringify(rejectMsg));
      expect(handler.getDeal(deal.terms.deal_id)!.state).toBe('CANCELLED');

      // cancelPending should not error or change state
      handler.cancelPending();
      expect(handler.getDeal(deal.terms.deal_id)!.state).toBe('CANCELLED');
    });

    it('stop() clears all timers without errors', async () => {
      vi.useFakeTimers();
      try {
        const localDeps = createDeps();
        const localHandler = createNegotiationHandler(localDeps);

        await localHandler.proposeDeal(
          makeOwnIntent(), makeCounterparty(), 150n, 50n, 'escrow-1',
        );

        // stop() should clear the timer — advancing time should not cause transition
        localHandler.stop();

        const deals = await localHandler.listDeals({ state: 'PROPOSED' });
        expect(deals.length).toBe(1);

        vi.advanceTimersByTime(60_000);

        // Still PROPOSED because timer was cleared
        const dealsAfter = await localHandler.listDeals({ state: 'PROPOSED' });
        expect(dealsAfter.length).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // =========================================================================
  // 8. Round-17 F1 — hydrateDeal envelope verification
  // =========================================================================

  describe('hydrateDeal() — counterparty envelope verification (round-17 F1)', () => {
    function makeAcceptorDealRecord(
      withEnvelope: boolean,
      envelopeOverride?: NpMessage,
    ): DealRecord {
      const terms = buildProposeDealTerms();
      const proposeMsg = buildProposeDealMessage(terms);
      const base: DealRecord = {
        terms,
        state: 'ACCEPTED',
        swap_id: null,
        acceptor_swap_address: 'swap-addr-1',
        updated_at: Date.now(),
      };
      if (!withEnvelope) return base;
      return { ...base, counterparty_envelope: envelopeOverride ?? proposeMsg };
    }

    it('rejects record with missing counterparty_envelope (legacy record)', () => {
      const deal = makeAcceptorDealRecord(false);
      handler.hydrateDeal(deal);
      expect(handler.getDeal(deal.terms.deal_id)).toBeNull();
      expect(deps.logger.warn).toHaveBeenCalledWith(
        'hydrate_deal_missing_envelope_legacy_record',
        expect.objectContaining({ deal_id: deal.terms.deal_id }),
      );
    });

    it('rejects record whose envelope has wrong sender_pubkey', () => {
      const deal = makeAcceptorDealRecord(true);
      // Tamper: swap sender_pubkey to a different party
      const tampered: DealRecord = {
        ...deal,
        counterparty_envelope: {
          ...deal.counterparty_envelope!,
          sender_pubkey: THIRD_PARTY_PUBKEY,
        },
      };
      handler.hydrateDeal(tampered);
      expect(handler.getDeal(deal.terms.deal_id)).toBeNull();
      expect(deps.logger.warn).toHaveBeenCalledWith(
        'hydrate_deal_envelope_wrong_sender',
        expect.objectContaining({ deal_id: deal.terms.deal_id }),
      );
    });

    it('rejects record whose envelope signature fails verification', () => {
      const failVerify = createDeps({
        verifySignature: vi.fn().mockReturnValue(false),
      });
      const localHandler = createNegotiationHandler(failVerify);
      const deal = makeAcceptorDealRecord(true);
      localHandler.hydrateDeal(deal);
      expect(localHandler.getDeal(deal.terms.deal_id)).toBeNull();
      expect(failVerify.logger.warn).toHaveBeenCalledWith(
        'hydrate_deal_envelope_bad_signature',
        expect.objectContaining({ deal_id: deal.terms.deal_id }),
      );
      localHandler.stop();
    });

    it('rejects record whose envelope terms hash does not match deal_id', () => {
      const deal = makeAcceptorDealRecord(true);
      // Tamper: inject different terms into the envelope payload — hash won't match
      const tamperedPayload = { ...deal.counterparty_envelope!.payload };
      const termsClone = { ...(tamperedPayload['terms'] as Record<string, unknown>) };
      termsClone['volume'] = '99999999';
      tamperedPayload['terms'] = termsClone;
      const tampered: DealRecord = {
        ...deal,
        counterparty_envelope: { ...deal.counterparty_envelope!, payload: tamperedPayload },
      };
      handler.hydrateDeal(tampered);
      expect(handler.getDeal(deal.terms.deal_id)).toBeNull();
      expect(deps.logger.warn).toHaveBeenCalledWith(
        'hydrate_deal_envelope_terms_mismatch',
        expect.objectContaining({ deal_id: deal.terms.deal_id }),
      );
    });

    it('accepts record with valid counterparty_envelope', () => {
      const deal = makeAcceptorDealRecord(true);
      handler.hydrateDeal(deal);
      const hydrated = handler.getDeal(deal.terms.deal_id);
      expect(hydrated).not.toBeNull();
      expect(hydrated!.state).toBe('ACCEPTED');
    });
  });

  describe('counterparty_envelope attachment (round-17 F1)', () => {
    it('handleProposeDeal attaches received np.propose_deal as counterparty_envelope', async () => {
      const terms = buildProposeDealTerms();
      const msg = buildProposeDealMessage(terms);

      await handler.handleIncomingDm(COUNTERPARTY_PUBKEY, COUNTERPARTY_ADDRESS, JSON.stringify(msg));

      const deal = handler.getDeal(terms.deal_id);
      expect(deal).not.toBeNull();
      expect(deal!.counterparty_envelope).toBeDefined();
      expect(deal!.counterparty_envelope!.type).toBe('np.propose_deal');
      expect(deal!.counterparty_envelope!.sender_pubkey).toBe(COUNTERPARTY_PUBKEY);
      expect(deal!.counterparty_envelope!.deal_id).toBe(terms.deal_id);
    });

    it('handleAcceptDeal attaches received np.accept_deal as counterparty_envelope', async () => {
      const deal = await handler.proposeDeal(
        makeOwnIntent(), makeCounterparty(), 150n, 50n, 'escrow-1',
      );
      const acceptMsg = buildNpMessage(
        deal.terms.deal_id,
        'np.accept_deal',
        COUNTERPARTY_PUBKEY,
        { acceptor_swap_address: 'swap-addr-2', message: '' },
      );

      await handler.handleIncomingDm(COUNTERPARTY_PUBKEY, COUNTERPARTY_ADDRESS, JSON.stringify(acceptMsg));

      const updated = handler.getDeal(deal.terms.deal_id);
      expect(updated).not.toBeNull();
      expect(updated!.state).toBe('ACCEPTED');
      expect(updated!.counterparty_envelope).toBeDefined();
      expect(updated!.counterparty_envelope!.type).toBe('np.accept_deal');
      expect(updated!.counterparty_envelope!.sender_pubkey).toBe(COUNTERPARTY_PUBKEY);
    });

    it('PROPOSED deal created via proposeDeal has NO counterparty_envelope (intentional)', async () => {
      // As proposer, we sign propose_deal ourselves. There is no counterparty
      // envelope until np.accept_deal arrives. hydrateDeal will refuse to
      // trust this record on restart — reconciliation must skip the reject.
      const deal = await handler.proposeDeal(
        makeOwnIntent(), makeCounterparty(), 150n, 50n, 'escrow-1',
      );
      expect(deal.counterparty_envelope).toBeUndefined();
    });
  });

  // =========================================================================
  // 9. Round-21 F1 — hydrateDealAttempt() discriminated result
  // =========================================================================

  describe('hydrateDealAttempt() — discriminated result (round-21 F1)', () => {
    /** Build a persisted record where WE are the proposer, no envelope. */
    function makeProposerCrashRecord(state: DealRecord['state'] = 'PROPOSED'): DealRecord {
      // Flip the term roles: we=proposer, counterparty=acceptor.
      const terms = buildProposeDealTerms({
        proposer_intent_id: 'intent-own-001',
        acceptor_intent_id: 'intent-remote-001',
        proposer_pubkey: AGENT_PUBKEY,
        acceptor_pubkey: COUNTERPARTY_PUBKEY,
        proposer_address: AGENT_ADDRESS,
        acceptor_address: COUNTERPARTY_ADDRESS,
      });
      return {
        terms,
        state,
        swap_id: null,
        acceptor_swap_address: null,
        updated_at: Date.now(),
        // Intentionally no counterparty_envelope.
      };
    }

    /** Build a persisted record where WE are the acceptor, no envelope. */
    function makeAcceptorNoEnvelopeRecord(): DealRecord {
      const terms = buildProposeDealTerms();
      return {
        terms,
        state: 'ACCEPTED',
        swap_id: null,
        acceptor_swap_address: 'swap-addr-1',
        updated_at: Date.now(),
      };
    }

    /** Build a valid proposer record with counterparty_envelope attached. */
    function makeProposerRecordWithEnvelope(state: DealRecord['state'] = 'ACCEPTED'): DealRecord {
      // terms: we=proposer, counterparty=acceptor.
      const terms = buildProposeDealTerms({
        proposer_intent_id: 'intent-own-001',
        acceptor_intent_id: 'intent-remote-001',
        proposer_pubkey: AGENT_PUBKEY,
        acceptor_pubkey: COUNTERPARTY_PUBKEY,
        proposer_address: AGENT_ADDRESS,
        acceptor_address: COUNTERPARTY_ADDRESS,
      });
      // Envelope is np.accept_deal from the counterparty (acceptor).
      const acceptEnv = buildNpMessage(terms.deal_id, 'np.accept_deal', COUNTERPARTY_PUBKEY, {
        acceptor_swap_address: 'swap-addr-2',
        message: '',
      });
      return {
        terms,
        state,
        swap_id: null,
        acceptor_swap_address: 'swap-addr-2',
        updated_at: Date.now(),
        counterparty_envelope: acceptEnv,
      };
    }

    it('returns no_envelope_proposer_record for PROPOSED proposer record without envelope (proposer-crash case)', () => {
      const deal = makeProposerCrashRecord('PROPOSED');
      const result = handler.hydrateDealAttempt(deal);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('no_envelope_proposer_record');
        // Round-23 F4: the returned record is a CANCELLED copy of the
        // input (not the input itself). The handler installs this
        // CANCELLED copy in memory so a late np.accept_deal hits the
        // terminal-state guard in handleAcceptDeal — independent of
        // whatever the caller does next.
        expect(result.record).not.toBe(deal);
        expect(result.record.state).toBe('CANCELLED');
        expect(result.record.terms.deal_id).toBe(deal.terms.deal_id);
      }
      // The record IS installed in the in-memory map (as CANCELLED) so a
      // late np.accept_deal from the counterparty finds a known deal and
      // hits the terminal-state guard.
      const installed = handler.getDeal(deal.terms.deal_id);
      expect(installed).not.toBeNull();
      expect(installed?.state).toBe('CANCELLED');
    });

    it('returns no_envelope_proposer_record even for non-PROPOSED state (defensive)', () => {
      // An acceptor record that somehow reaches reconciliation without an
      // envelope AND where we are the proposer should still be treated as
      // "proposer-crash abandon." The record was originated by us; we own
      // the signing key for the terms, so self-signing a reject is safe.
      const deal = makeProposerCrashRecord('ACCEPTED');
      const result = handler.hydrateDealAttempt(deal);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('no_envelope_proposer_record');
      }
    });

    it('returns no_envelope_acceptor_record for ACCEPTOR-side record without envelope', () => {
      // Acceptor records always attach the envelope atomically with their
      // creation. A missing envelope here is either legacy or attacker-
      // crafted; do NOT hydrate.
      const deal = makeAcceptorNoEnvelopeRecord();
      const result = handler.hydrateDealAttempt(deal);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('no_envelope_acceptor_record');
      }
      // Must NOT be installed in the in-memory map — the record is untrusted.
      expect(handler.getDeal(deal.terms.deal_id)).toBeNull();
    });

    it('returns ok=true for proposer record with valid np.accept_deal envelope', () => {
      const deal = makeProposerRecordWithEnvelope('ACCEPTED');
      const result = handler.hydrateDealAttempt(deal);

      expect(result.ok).toBe(true);
      expect(handler.getDeal(deal.terms.deal_id)).not.toBeNull();
    });

    it('returns bad_signature for proposer record whose envelope fails signature verification', () => {
      const failVerify = createDeps({
        verifySignature: vi.fn().mockReturnValue(false),
      });
      const localHandler = createNegotiationHandler(failVerify);
      const deal = makeProposerRecordWithEnvelope('ACCEPTED');
      const result = localHandler.hydrateDealAttempt(deal);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('bad_signature');
      }
      expect(localHandler.getDeal(deal.terms.deal_id)).toBeNull();
      localHandler.stop();
    });

    it('returns non_participant for record where we are neither proposer nor acceptor', () => {
      const terms = buildProposeDealTerms({
        proposer_pubkey: COUNTERPARTY_PUBKEY,
        acceptor_pubkey: THIRD_PARTY_PUBKEY,
      });
      const deal: DealRecord = {
        terms,
        state: 'PROPOSED',
        swap_id: null,
        acceptor_swap_address: null,
        updated_at: Date.now(),
      };
      const result = handler.hydrateDealAttempt(deal);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('non_participant');
      }
      expect(handler.getDeal(terms.deal_id)).toBeNull();
    });

    it('returns invalid_shape when the persisted deal_id does not match computeDealId(terms)', () => {
      const terms = buildProposeDealTerms({
        proposer_pubkey: AGENT_PUBKEY,
        acceptor_pubkey: COUNTERPARTY_PUBKEY,
        proposer_address: AGENT_ADDRESS,
        acceptor_address: COUNTERPARTY_ADDRESS,
      });
      // Tamper: replace deal_id with a bogus-but-syntactically-valid hash.
      const tampered: DealRecord = {
        terms: { ...terms, deal_id: 'ff'.repeat(32) },
        state: 'PROPOSED',
        swap_id: null,
        acceptor_swap_address: null,
        updated_at: Date.now(),
      };
      const result = handler.hydrateDealAttempt(tampered);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('invalid_shape');
      }
    });

    it('returns stale_envelope when deal.updated_at is older than env.ts_ms minus tolerance (round-21 F5)', () => {
      // Attacker-crafted: envelope is freshly-signed but updated_at is
      // stamped far BEFORE ts_ms. Legitimate records always satisfy
      // updated_at >= ts_ms - CLOCK_SKEW_TOLERANCE_MS because we
      // receive the envelope then persist.
      const deal = makeProposerRecordWithEnvelope('ACCEPTED');
      const envTs = deal.counterparty_envelope!.ts_ms;
      // 10 minutes before envelope (well past the 5-minute tolerance).
      const tampered: DealRecord = {
        ...deal,
        updated_at: envTs - 10 * 60 * 1000,
      };
      const result = handler.hydrateDealAttempt(tampered);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('stale_envelope');
      }
      expect(deps.logger.warn).toHaveBeenCalledWith(
        'hydrate_deal_updated_at_precedes_envelope',
        expect.objectContaining({ deal_id: deal.terms.deal_id }),
      );
    });

    it('returns oversized when the persisted envelope exceeds MAX_HYDRATE_ENVELOPE_SIZE_CODEUNITS', () => {
      const deal = makeProposerRecordWithEnvelope('ACCEPTED');
      const originalEnv = deal.counterparty_envelope!;
      // Inflate the payload so JSON.stringify exceeds 64KB.
      const inflated = {
        ...originalEnv,
        payload: { ...originalEnv.payload, junk: 'x'.repeat(70 * 1024) },
      };
      const tampered: DealRecord = { ...deal, counterparty_envelope: inflated };
      const result = handler.hydrateDealAttempt(tampered);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('oversized');
      }
    });

    // F5 (round-23): the updated_at cross-check is only meaningful when the
    // caller passes the PERSISTED record (carrying the on-disk updated_at)
    // rather than a rewritten copy where updated_at has been overwritten
    // with Date.now(). Reconciliation in trader-main.ts used to build a
    // `cancelled = { ...persisted, updated_at: Date.now() }` and hand that
    // to hydrateDealAttempt, making the cross-check a no-op — any attacker-
    // crafted envelope with updated_at < env.ts_ms - tolerance would still
    // pass. These two tests pin the invariant: hydrate on `persisted`
    // respects the on-disk updated_at, and rebuilding with Date.now()
    // masks the staleness (the regression that round-22 left in place).
    it('F5: hydrate on persisted record respects on-disk updated_at (cross-check fires)', () => {
      const deal = makeProposerRecordWithEnvelope('ACCEPTED');
      const envTs = deal.counterparty_envelope!.ts_ms;
      // Simulate the disk record — updated_at predates the envelope by
      // more than the clock-skew tolerance; a legitimate record can never
      // look like this because the envelope arrives BEFORE we persist.
      const persisted: DealRecord = {
        ...deal,
        updated_at: envTs - 10 * 60 * 1000, // 10m before (tolerance is 5m)
      };
      const result = handler.hydrateDealAttempt(persisted);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('stale_envelope');
      }
    });

    it('F5: rewriting updated_at to Date.now() before hydrate defeats the cross-check (documented regression)', () => {
      // Proof of the round-22 regression: if the caller builds a new
      // DealRecord copy with updated_at = Date.now() and passes THAT to
      // hydrateDealAttempt, the cross-check trivially passes even though
      // the on-disk updated_at was stale. This test documents the
      // unwanted behaviour at the handler boundary so round-23's
      // trader-main fix (pass `persisted` first, rebuild only after ok)
      // remains the enforcement point.
      const deal = makeProposerRecordWithEnvelope('ACCEPTED');
      const envTs = deal.counterparty_envelope!.ts_ms;
      const rewritten: DealRecord = {
        ...deal,
        // This is what trader-main USED to do — always-now stamp that
        // bypasses the invariant.
        updated_at: Date.now(),
        // Original on-disk updated_at would have been envTs - 10min.
      };
      // With the fake-now updated_at, the cross-check passes and ok=true.
      const result = handler.hydrateDealAttempt(rewritten);
      expect(result.ok).toBe(true);
      // The same envelope with the REAL persisted updated_at would be
      // rejected — see the previous test. This is the bug the F5 fix
      // closes: the caller must not rewrite updated_at before the
      // hydrate decision.
      expect(envTs).toBeGreaterThan(0);
    });
  });
});
