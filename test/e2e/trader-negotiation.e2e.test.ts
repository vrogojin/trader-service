/**
 * E2E tests for NP-0 negotiation protocol.
 *
 * Covers T3 (happy path), T4 (unhappy path), T15 (adversarial) from
 * test/trader-agent-test-specification.md.
 *
 * Uses two NegotiationHandler instances (Alice and Bob) with connected mock
 * comms: Alice's sendDm delivers to Bob's handleIncomingDm and vice versa.
 */

import { createHash } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  createNegotiationHandler,
  type NegotiationHandler,
  type NegotiationHandlerDeps,
} from '../../src/trader/negotiation-handler.js';
import { canonicalJson } from '../../src/trader/utils.js';
import type {
  DealRecord,
  IntentRecord,
  MarketSearchResult,
  TradingIntent,
  NpMessage,
} from '../../src/trader/types.js';
import { createLogger } from '../../src/shared/logger.js';
import { MAX_MESSAGE_SIZE } from '../../src/protocols/envelope.js';

// ---------------------------------------------------------------------------
// Test key material (66-char compressed secp256k1)
// ---------------------------------------------------------------------------

const PK_ALICE = '02' + 'a'.repeat(64);
const PK_BOB = '02' + 'b'.repeat(64);
const PK_CHARLIE = '02' + 'c'.repeat(64);

const ADDR_ALICE = 'DIRECT://alice';
const ADDR_BOB = 'DIRECT://bob';
const ADDR_CHARLIE = 'DIRECT://charlie';

// ---------------------------------------------------------------------------
// Two-agent test harness
// ---------------------------------------------------------------------------

interface TwoAgentContext {
  alice: NegotiationHandler;
  bob: NegotiationHandler;
  aliceSentDms: Array<{ to: string; content: string }>;
  bobSentDms: Array<{ to: string; content: string }>;
  aliceAcceptedDeals: DealRecord[];
  bobAcceptedDeals: DealRecord[];
}

/** Deterministic sign/verify using HMAC-like scheme keyed by agent pubkey. */
function makeSign(agentPubkey: string) {
  return (message: string): string => {
    return createHash('sha256').update(`${agentPubkey}:${message}`).digest('hex');
  };
}

function makeVerify() {
  return (signature: string, message: string, pubkey: string): boolean => {
    const expected = createHash('sha256').update(`${pubkey}:${message}`).digest('hex');
    return signature === expected;
  };
}

function createTwoAgentContext(): TwoAgentContext {
  const aliceSentDms: Array<{ to: string; content: string }> = [];
  const bobSentDms: Array<{ to: string; content: string }> = [];
  const aliceAcceptedDeals: DealRecord[] = [];
  const bobAcceptedDeals: DealRecord[] = [];

  const logger = createLogger({ component: 'np0-e2e', level: 'warn' });
  const verifyFn = makeVerify();

  // We create the handlers first, then wire sendDm to cross-deliver.
  // Use late-binding references so the closures capture the handler objects.
  // eslint-disable-next-line prefer-const -- late-binding: assigned after deps objects reference them
  let aliceHandler: NegotiationHandler;
  // eslint-disable-next-line prefer-const
  let bobHandler: NegotiationHandler;

  const aliceDeps: NegotiationHandlerDeps = {
    sendDm: async (recipientAddress: string, content: string) => {
      aliceSentDms.push({ to: recipientAddress, content });
      // Route to Bob if addressed to Bob
      if (recipientAddress === ADDR_BOB) {
        await bobHandler.handleIncomingDm(PK_ALICE, ADDR_ALICE, content);
      }
    },
    signMessage: makeSign(PK_ALICE),
    verifySignature: verifyFn,
    onDealAccepted: async (deal: DealRecord) => {
      aliceAcceptedDeals.push(deal);
    },
    onDealCancelled: () => {},
    agentPubkey: PK_ALICE,
    agentAddress: ADDR_ALICE,
    logger,
  };

  const bobDeps: NegotiationHandlerDeps = {
    sendDm: async (recipientAddress: string, content: string) => {
      bobSentDms.push({ to: recipientAddress, content });
      // Route to Alice if addressed to Alice
      if (recipientAddress === ADDR_ALICE) {
        await aliceHandler.handleIncomingDm(PK_BOB, ADDR_BOB, content);
      }
    },
    signMessage: makeSign(PK_BOB),
    verifySignature: verifyFn,
    onDealAccepted: async (deal: DealRecord) => {
      bobAcceptedDeals.push(deal);
    },
    onDealCancelled: () => {},
    agentPubkey: PK_BOB,
    agentAddress: ADDR_BOB,
    logger,
  };

  aliceHandler = createNegotiationHandler(aliceDeps);
  bobHandler = createNegotiationHandler(bobDeps);

  return {
    alice: aliceHandler,
    bob: bobHandler,
    aliceSentDms,
    bobSentDms,
    aliceAcceptedDeals,
    bobAcceptedDeals,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAliceIntent(): IntentRecord {
  const intent: TradingIntent = {
    intent_id: 'intent-alice-001',
    market_intent_id: 'market-alice-001',
    agent_pubkey: PK_ALICE,
    agent_address: ADDR_ALICE,
    salt: 'salt-alice',
    direction: 'sell',
    base_asset: 'ALPHA',
    quote_asset: 'USDC',
    rate_min: 400n,
    rate_max: 500n,
    volume_min: 100n,
    volume_max: 1000n,
    volume_filled: 0n,
    escrow_address: 'escrow-address-001',
    deposit_timeout_sec: 120,
    expiry_ms: Date.now() + 86_400_000,
    signature: 'sig-alice-intent',
  };
  return {
    intent,
    state: 'MATCHING',
    deal_ids: [],
    updated_at: Date.now(),
  };
}

function makeBobCounterparty(): MarketSearchResult {
  return {
    id: 'intent-bob-001',
    score: 0.95,
    agentPublicKey: PK_BOB,
    description: 'Buying ALPHA for USDC',
    intentType: 'buy',
    currency: 'USDC',
    contactHandle: ADDR_BOB,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  };
}

function sha256hex(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Compute the signature input for an NP message envelope. This mirrors
 * negotiation-handler.ts's computeSignatureInput: SHA-256 over canonical
 * JSON of the full envelope minus the `signature` field (C13).
 *
 * Tests must use this helper — the legacy `${dealId}:${msgId}:${type}`
 * scheme is no longer accepted because it allowed a MITM to tamper with
 * payload fields (e.g. proposer_swap_address) without invalidating the sig.
 */
function signatureInputFor(envelope: Omit<NpMessage, 'signature'>): string {
  return sha256hex(canonicalJson(envelope));
}

// Mirrors negotiation-handler.ts:142-162. Must include every field the handler
// hashes, in any order (canonicalJson sorts keys). Adding/removing fields in
// production must be reflected here or deal_id verification fails silently and
// the handler drops the proposal at np_propose_deal_id_mismatch.
function computeDealId(terms: {
  acceptor_intent_id: string;
  acceptor_pubkey: string;
  acceptor_address: string;
  base_asset: string;
  created_ms: number;
  deposit_timeout_sec: number;
  escrow_address: string;
  proposer_address: string;
  proposer_direction: 'buy' | 'sell';
  proposer_intent_id: string;
  proposer_pubkey: string;
  quote_asset: string;
  rate: bigint;
  volume: bigint;
}): string {
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

// ---------------------------------------------------------------------------
// T3: Happy Path
// ---------------------------------------------------------------------------

describe('NP-0 Negotiation E2E', () => {
  describe('T3: Happy Path', () => {
    let ctx: TwoAgentContext;

    beforeEach(() => {
      ctx = createTwoAgentContext();
    });

    afterEach(() => {
      ctx.alice.stop();
      ctx.bob.stop();
    });

    it('T3.1 — propose_deal -> accept_deal -> deal ACCEPTED', async () => {
      const aliceIntent = makeAliceIntent();
      const bobCounterparty = makeBobCounterparty();

      // Alice proposes a deal to Bob
      const dealRecord = await ctx.alice.proposeDeal(
        aliceIntent,
        bobCounterparty,
        475n,
        300n,
        'escrow-address-001',
      );

      // Alice should have sent a propose_deal DM to Bob
      expect(ctx.aliceSentDms.length).toBeGreaterThanOrEqual(1);
      const proposeDm = ctx.aliceSentDms[0]!;
      expect(proposeDm.to).toBe(ADDR_BOB);

      // Parse the propose message
      const proposeMsg: NpMessage = JSON.parse(proposeDm.content);
      expect(proposeMsg.np_version).toBe('0.1');
      expect(proposeMsg.type).toBe('np.propose_deal');
      expect(proposeMsg.sender_pubkey).toBe(PK_ALICE);

      // Bob auto-accepted and sent accept_deal back to Alice
      expect(ctx.bobSentDms.length).toBeGreaterThanOrEqual(1);
      const acceptDm = ctx.bobSentDms[0]!;
      expect(acceptDm.to).toBe(ADDR_ALICE);

      const acceptMsg: NpMessage = JSON.parse(acceptDm.content);
      expect(acceptMsg.type).toBe('np.accept_deal');
      expect(acceptMsg.deal_id).toBe(proposeMsg.deal_id);
      expect(acceptMsg.sender_pubkey).toBe(PK_BOB);

      // Alice's deal should now be ACCEPTED (Bob's accept was routed back)
      const aliceDeal = ctx.alice.getDeal(dealRecord.terms.deal_id);
      expect(aliceDeal).not.toBeNull();
      expect(aliceDeal!.state).toBe('ACCEPTED');

      // Bob's deal should also be ACCEPTED
      const bobDeal = ctx.bob.getDeal(dealRecord.terms.deal_id);
      expect(bobDeal).not.toBeNull();
      expect(bobDeal!.state).toBe('ACCEPTED');

      // Both onDealAccepted callbacks should have been invoked
      expect(ctx.aliceAcceptedDeals.length).toBe(1);
      expect(ctx.bobAcceptedDeals.length).toBe(1);
    });

    it('T3.2 — propose_deal -> reject_deal (RATE_UNACCEPTABLE) -> deal CANCELLED', async () => {
      // For this test, we create a standalone Bob that does NOT auto-accept.
      // Instead we manually inject a reject from Bob.
      const aliceSentDms: Array<{ to: string; content: string }> = [];
      const logger = createLogger({ component: 'np0-e2e-t3.2', level: 'warn' });

      const alice = createNegotiationHandler({
        sendDm: async (to, content) => { aliceSentDms.push({ to, content }); },
        signMessage: makeSign(PK_ALICE),
        verifySignature: makeVerify(),
        onDealAccepted: async () => {},
        onDealCancelled: () => {},
        agentPubkey: PK_ALICE,
        agentAddress: ADDR_ALICE,
        logger,
      });

      const aliceIntent = makeAliceIntent();
      const bobCounterparty = makeBobCounterparty();

      const deal = await alice.proposeDeal(aliceIntent, bobCounterparty, 475n, 300n, 'escrow-001');
      expect(deal.state).toBe('PROPOSED');

      // Parse the sent proposal to get deal_id and msg_id
      const proposeMsg: NpMessage = JSON.parse(aliceSentDms[0]!.content);
      const dealId = proposeMsg.deal_id;

      // Bob sends a reject_deal back to Alice
      const rejectMsgId = '12345678-1234-1234-1234-123456789abc';
      const rejectEnvelope: Omit<NpMessage, 'signature'> = {
        np_version: '0.1',
        msg_id: rejectMsgId,
        deal_id: dealId,
        sender_pubkey: PK_BOB,
        type: 'np.reject_deal',
        ts_ms: Date.now(),
        payload: {
          reason_code: 'RATE_UNACCEPTABLE',
          message: 'Rate 475 is below my minimum threshold',
        },
      };
      const signature = makeSign(PK_BOB)(signatureInputFor(rejectEnvelope));
      const rejectMsg: NpMessage = { ...rejectEnvelope, signature };

      await alice.handleIncomingDm(PK_BOB, ADDR_BOB, JSON.stringify(rejectMsg));

      // Deal should now be CANCELLED
      const updatedDeal = alice.getDeal(dealId);
      expect(updatedDeal).not.toBeNull();
      expect(updatedDeal!.state).toBe('CANCELLED');

      alice.stop();
    });

    it('T3.3 — deal_id is content-addressed SHA-256 of canonical DealTerms', async () => {
      const aliceIntent = makeAliceIntent();
      const bobCounterparty = makeBobCounterparty();

      const deal = await ctx.alice.proposeDeal(aliceIntent, bobCounterparty, 475n, 300n, 'escrow-001');

      // Independently compute the expected deal_id
      const expectedId = computeDealId({
        acceptor_intent_id: bobCounterparty.id,
        acceptor_pubkey: PK_BOB,
        acceptor_address: bobCounterparty.contactHandle ?? '',
        base_asset: aliceIntent.intent.base_asset,
        created_ms: deal.terms.created_ms,
        deposit_timeout_sec: aliceIntent.intent.deposit_timeout_sec,
        escrow_address: 'escrow-001',
        proposer_address: ADDR_ALICE,
        proposer_direction: aliceIntent.intent.direction,
        // DealTerms carries MARKET intent_id, not local — peers exchange the
        // ID they can see in market search results.
        proposer_intent_id: aliceIntent.intent.market_intent_id,
        proposer_pubkey: PK_ALICE,
        quote_asset: aliceIntent.intent.quote_asset,
        rate: 475n,
        volume: 300n,
      });

      expect(deal.terms.deal_id).toBe(expectedId);

      // Also verify the deal_id in the sent DM matches
      const proposeMsg: NpMessage = JSON.parse(ctx.aliceSentDms[0]!.content);
      expect(proposeMsg.deal_id).toBe(expectedId);
    });
  });

  // -------------------------------------------------------------------------
  // T4: Unhappy Path
  // -------------------------------------------------------------------------

  describe('T4: Unhappy Path', () => {
    it('T4.1 — proposal timeout (30s) -> deal CANCELLED', async () => {
      vi.useFakeTimers();
      try {
        const aliceSentDms: Array<{ to: string; content: string }> = [];
        const logger = createLogger({ component: 'np0-e2e-t4.1', level: 'warn' });

        // Alice with no cross-routing (Bob never responds)
        const alice = createNegotiationHandler({
          sendDm: async (to, content) => { aliceSentDms.push({ to, content }); },
          signMessage: makeSign(PK_ALICE),
          verifySignature: makeVerify(),
          onDealAccepted: async () => {},
          onDealCancelled: () => { /* no-op */ },
          agentPubkey: PK_ALICE,
          agentAddress: ADDR_ALICE,
          logger,
        });

        const deal = await alice.proposeDeal(
          makeAliceIntent(), makeBobCounterparty(), 475n, 300n, 'escrow-001',
        );
        expect(deal.state).toBe('PROPOSED');

        // Advance past the 30s proposal timeout
        vi.advanceTimersByTime(30_001);

        const updated = alice.getDeal(deal.terms.deal_id);
        expect(updated).not.toBeNull();
        expect(updated!.state).toBe('CANCELLED');

        alice.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it('T4.2 — ACCEPTED deal stays ACCEPTED (SwapExecutor owns timeouts)', async () => {
      vi.useFakeTimers();
      try {
        // The NegotiationHandler no longer has an acceptance timeout.
        // After acceptance, the deal stays ACCEPTED until the SwapExecutor
        // processes it (execution timeouts are deposit_timeout_sec + 60s).
        const ctx = createTwoAgentContext();

        const deal = await ctx.alice.proposeDeal(
          makeAliceIntent(), makeBobCounterparty(), 475n, 300n, 'escrow-001',
        );

        // After cross-routing, both should be ACCEPTED
        const aliceDeal = ctx.alice.getDeal(deal.terms.deal_id);
        expect(aliceDeal!.state).toBe('ACCEPTED');

        // Even after 60s, the deal remains ACCEPTED (no acceptance timeout)
        vi.advanceTimersByTime(60_001);

        const aliceUpdated = ctx.alice.getDeal(deal.terms.deal_id);
        expect(aliceUpdated!.state).toBe('ACCEPTED');

        ctx.alice.stop();
        ctx.bob.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it('T4.4 — invalid signature -> DM rejected', async () => {
      const aliceSentDms: Array<{ to: string; content: string }> = [];
      const logger = createLogger({ component: 'np0-e2e-t4.4', level: 'warn' });

      const alice = createNegotiationHandler({
        sendDm: async (to, content) => { aliceSentDms.push({ to, content }); },
        signMessage: makeSign(PK_ALICE),
        verifySignature: makeVerify(),
        onDealAccepted: async () => {},
        onDealCancelled: () => {},
        agentPubkey: PK_ALICE,
        agentAddress: ADDR_ALICE,
        logger,
      });

      await alice.proposeDeal(
        makeAliceIntent(), makeBobCounterparty(), 475n, 300n, 'escrow-001',
      );

      const proposeMsg: NpMessage = JSON.parse(aliceSentDms[0]!.content);
      const dealId = proposeMsg.deal_id;
      const acceptMsgId = '22345678-1234-1234-1234-123456789abc';

      // Build accept message with WRONG signature (forged)
      const acceptMsg: NpMessage = {
        np_version: '0.1',
        msg_id: acceptMsgId,
        deal_id: dealId,
        sender_pubkey: PK_BOB,
        type: 'np.accept_deal',
        ts_ms: Date.now(),
        payload: { acceptor_swap_address: ADDR_BOB, message: '' },
        signature: 'deadbeef'.repeat(8), // invalid signature
      };

      await alice.handleIncomingDm(PK_BOB, ADDR_BOB, JSON.stringify(acceptMsg));

      // Deal should remain PROPOSED (message rejected)
      const updated = alice.getDeal(dealId);
      expect(updated!.state).toBe('PROPOSED');

      alice.stop();
    });

    it('T4.6 — wrong sender_pubkey -> DM rejected', async () => {
      const aliceSentDms: Array<{ to: string; content: string }> = [];
      const logger = createLogger({ component: 'np0-e2e-t4.6', level: 'warn' });

      const alice = createNegotiationHandler({
        sendDm: async (to, content) => { aliceSentDms.push({ to, content }); },
        signMessage: makeSign(PK_ALICE),
        verifySignature: makeVerify(),
        onDealAccepted: async () => {},
        onDealCancelled: () => {},
        agentPubkey: PK_ALICE,
        agentAddress: ADDR_ALICE,
        logger,
      });

      await alice.proposeDeal(
        makeAliceIntent(), makeBobCounterparty(), 475n, 300n, 'escrow-001',
      );

      const proposeMsg: NpMessage = JSON.parse(aliceSentDms[0]!.content);
      const dealId = proposeMsg.deal_id;
      const msgId = '32345678-1234-1234-1234-123456789abc';

      // Charlie (PK_C) tries to send accept_deal — they are not a participant.
      // The envelope sender_pubkey says PK_CHARLIE but DM sender is also PK_CHARLIE.
      const fakeAcceptEnvelope: Omit<NpMessage, 'signature'> = {
        np_version: '0.1',
        msg_id: msgId,
        deal_id: dealId,
        sender_pubkey: PK_CHARLIE,
        type: 'np.accept_deal',
        ts_ms: Date.now(),
        payload: { acceptor_swap_address: ADDR_CHARLIE, message: '' },
      };
      const signature = makeSign(PK_CHARLIE)(signatureInputFor(fakeAcceptEnvelope));
      const fakeAccept: NpMessage = { ...fakeAcceptEnvelope, signature };

      await alice.handleIncomingDm(PK_CHARLIE, ADDR_CHARLIE, JSON.stringify(fakeAccept));

      // Deal should remain PROPOSED
      const updated = alice.getDeal(dealId);
      expect(updated!.state).toBe('PROPOSED');

      alice.stop();
    });

    it('T4.8 — message > 64 KiB -> rejected', async () => {
      const aliceSentDms: Array<{ to: string; content: string }> = [];
      const logger = createLogger({ component: 'np0-e2e-t4.8', level: 'warn' });

      const alice = createNegotiationHandler({
        sendDm: async (to, content) => { aliceSentDms.push({ to, content }); },
        signMessage: makeSign(PK_ALICE),
        verifySignature: makeVerify(),
        onDealAccepted: async () => {},
        onDealCancelled: () => {},
        agentPubkey: PK_ALICE,
        agentAddress: ADDR_ALICE,
        logger,
      });

      const deal = await alice.proposeDeal(
        makeAliceIntent(), makeBobCounterparty(), 475n, 300n, 'escrow-001',
      );

      // Create an oversized message (> 64 KiB)
      const oversized = 'x'.repeat(MAX_MESSAGE_SIZE + 1);
      await alice.handleIncomingDm(PK_BOB, ADDR_BOB, oversized);

      // Deal should remain PROPOSED
      const updated = alice.getDeal(deal.terms.deal_id);
      expect(updated!.state).toBe('PROPOSED');

      alice.stop();
    });

    it('T4.9 — malformed JSON -> rejected', async () => {
      const aliceSentDms: Array<{ to: string; content: string }> = [];
      const logger = createLogger({ component: 'np0-e2e-t4.9', level: 'warn' });

      const alice = createNegotiationHandler({
        sendDm: async (to, content) => { aliceSentDms.push({ to, content }); },
        signMessage: makeSign(PK_ALICE),
        verifySignature: makeVerify(),
        onDealAccepted: async () => {},
        onDealCancelled: () => {},
        agentPubkey: PK_ALICE,
        agentAddress: ADDR_ALICE,
        logger,
      });

      const deal = await alice.proposeDeal(
        makeAliceIntent(), makeBobCounterparty(), 475n, 300n, 'escrow-001',
      );

      // Deliver malformed JSON
      await alice.handleIncomingDm(PK_BOB, ADDR_BOB, '{not valid json');

      // Deal should remain PROPOSED, no crash
      const updated = alice.getDeal(deal.terms.deal_id);
      expect(updated!.state).toBe('PROPOSED');

      alice.stop();
    });

    it('T4.10 — dangerous keys (__proto__) -> rejected', async () => {
      const aliceSentDms: Array<{ to: string; content: string }> = [];
      const logger = createLogger({ component: 'np0-e2e-t4.10', level: 'warn' });

      const alice = createNegotiationHandler({
        sendDm: async (to, content) => { aliceSentDms.push({ to, content }); },
        signMessage: makeSign(PK_ALICE),
        verifySignature: makeVerify(),
        onDealAccepted: async () => {},
        onDealCancelled: () => {},
        agentPubkey: PK_ALICE,
        agentAddress: ADDR_ALICE,
        logger,
      });

      const deal = await alice.proposeDeal(
        makeAliceIntent(), makeBobCounterparty(), 475n, 300n, 'escrow-001',
      );

      // Construct message with __proto__ pollution key using raw string
      // (JSON.stringify strips __proto__ from object literals, so we build it manually)
      const poisoned = `{"np_version":"0.1","msg_id":"42345678-1234-1234-1234-123456789abc","deal_id":"${deal.terms.deal_id}","sender_pubkey":"${PK_BOB}","type":"np.accept_deal","ts_ms":${Date.now()},"payload":{"acceptor_swap_address":"${ADDR_BOB}","message":""},"signature":"anything","__proto__":{"isAdmin":true}}`;

      await alice.handleIncomingDm(PK_BOB, ADDR_BOB, poisoned);

      // Deal should remain PROPOSED
      const updated = alice.getDeal(deal.terms.deal_id);
      expect(updated!.state).toBe('PROPOSED');

      alice.stop();
    });
  });

  // -------------------------------------------------------------------------
  // T15: Adversarial
  // -------------------------------------------------------------------------

  describe('T15: Adversarial', () => {
    it('T15.1 / T4.7 — duplicate deal guard: second proposal for same intent -> AGENT_BUSY', async () => {
      // Bob has an active deal for intent-bob-001. A second proposal
      // referencing the same acceptor_intent_id should be rejected.
      const bobSentDms: Array<{ to: string; content: string }> = [];
      const logger = createLogger({ component: 'np0-e2e-t15.1', level: 'warn' });

      const bob = createNegotiationHandler({
        sendDm: async (to, content) => { bobSentDms.push({ to, content }); },
        signMessage: makeSign(PK_BOB),
        verifySignature: makeVerify(),
        onDealAccepted: async () => {},
        onDealCancelled: () => {},
        agentPubkey: PK_BOB,
        agentAddress: ADDR_BOB,
        logger,
      });

      // First: Alice sends a valid proposal that Bob accepts
      const now = Date.now();
      const terms1 = {
        acceptor_intent_id: 'intent-bob-001',
        acceptor_pubkey: PK_BOB,
        acceptor_address: ADDR_BOB,
        base_asset: 'ALPHA',
        created_ms: now,
        deposit_timeout_sec: 120,
        escrow_address: 'escrow-001',
        proposer_address: ADDR_ALICE,
        proposer_direction: 'sell' as const,
        proposer_intent_id: 'intent-alice-001',
        proposer_pubkey: PK_ALICE,
        quote_asset: 'USDC',
        rate: 475n,
        volume: 300n,
      };
      const dealId1 = computeDealId(terms1);

      const msgId1 = 'a1345678-1234-1234-1234-123456789abc';
      const propose1Envelope: Omit<NpMessage, 'signature'> = {
        np_version: '0.1',
        msg_id: msgId1,
        deal_id: dealId1,
        sender_pubkey: PK_ALICE,
        type: 'np.propose_deal',
        ts_ms: now,
        payload: {
          terms: {
            deal_id: dealId1,
            proposer_intent_id: 'intent-alice-001',
            acceptor_intent_id: 'intent-bob-001',
            proposer_pubkey: PK_ALICE,
            acceptor_pubkey: PK_BOB,
            proposer_address: ADDR_ALICE,
            acceptor_address: ADDR_BOB,
            base_asset: 'ALPHA',
            quote_asset: 'USDC',
            rate: '475',
            volume: '300',
            proposer_direction: 'sell',
            escrow_address: 'escrow-001',
            deposit_timeout_sec: 120,
            created_ms: now,
          },
          proposer_swap_address: ADDR_ALICE,
          message: '',
        },
      };
      const sig1 = makeSign(PK_ALICE)(signatureInputFor(propose1Envelope));
      const propose1: NpMessage = { ...propose1Envelope, signature: sig1 };

      await bob.handleIncomingDm(PK_ALICE, ADDR_ALICE, JSON.stringify(propose1));

      // Bob should have accepted the first proposal
      const deal1 = bob.getDeal(dealId1);
      expect(deal1).not.toBeNull();
      expect(deal1!.state).toBe('ACCEPTED');

      // Now Charlie sends a second proposal for the SAME acceptor_intent_id
      const now2 = Date.now() + 1;
      const terms2 = {
        acceptor_intent_id: 'intent-bob-001', // same intent
        acceptor_pubkey: PK_BOB,
        acceptor_address: ADDR_BOB,
        base_asset: 'ALPHA',
        created_ms: now2,
        deposit_timeout_sec: 120,
        escrow_address: 'escrow-002',
        proposer_address: ADDR_CHARLIE,
        proposer_direction: 'sell' as const,
        proposer_intent_id: 'intent-charlie-001',
        proposer_pubkey: PK_CHARLIE,
        quote_asset: 'USDC',
        rate: 480n,
        volume: 200n,
      };
      const dealId2 = computeDealId(terms2);

      const msgId2 = 'b1345678-1234-1234-1234-123456789abc';
      const propose2Envelope: Omit<NpMessage, 'signature'> = {
        np_version: '0.1',
        msg_id: msgId2,
        deal_id: dealId2,
        sender_pubkey: PK_CHARLIE,
        type: 'np.propose_deal',
        ts_ms: now2,
        payload: {
          terms: {
            deal_id: dealId2,
            proposer_intent_id: 'intent-charlie-001',
            acceptor_intent_id: 'intent-bob-001',
            proposer_pubkey: PK_CHARLIE,
            acceptor_pubkey: PK_BOB,
            proposer_address: ADDR_CHARLIE,
            acceptor_address: ADDR_BOB,
            base_asset: 'ALPHA',
            quote_asset: 'USDC',
            rate: '480',
            volume: '200',
            proposer_direction: 'sell',
            escrow_address: 'escrow-002',
            deposit_timeout_sec: 120,
            created_ms: now2,
          },
          proposer_swap_address: ADDR_CHARLIE,
          message: '',
        },
      };
      const sig2 = makeSign(PK_CHARLIE)(signatureInputFor(propose2Envelope));
      const propose2: NpMessage = { ...propose2Envelope, signature: sig2 };

      bobSentDms.length = 0; // clear previous sent DMs
      await bob.handleIncomingDm(PK_CHARLIE, ADDR_CHARLIE, JSON.stringify(propose2));

      // Bob should have rejected with AGENT_BUSY
      expect(bobSentDms.length).toBeGreaterThanOrEqual(1);
      const rejectDm = bobSentDms[bobSentDms.length - 1]!;
      const rejectMsg: NpMessage = JSON.parse(rejectDm.content);
      expect(rejectMsg.type).toBe('np.reject_deal');
      expect(rejectMsg.payload['reason_code']).toBe('AGENT_BUSY');

      // Second deal should NOT exist in Bob's state
      const deal2 = bob.getDeal(dealId2);
      expect(deal2).toBeNull();

      // First deal should be unaffected
      const deal1After = bob.getDeal(dealId1);
      expect(deal1After!.state).toBe('ACCEPTED');

      bob.stop();
    });

    it('T15.3 — per-counterparty rate limit: 4th proposal in 60s -> dropped silently', async () => {
      const bobSentDms: Array<{ to: string; content: string }> = [];
      const logger = createLogger({ component: 'np0-e2e-t15.3', level: 'warn' });

      const bob = createNegotiationHandler({
        sendDm: async (to, content) => { bobSentDms.push({ to, content }); },
        signMessage: makeSign(PK_BOB),
        verifySignature: makeVerify(),
        onDealAccepted: async () => {},
        onDealCancelled: () => {},
        agentPubkey: PK_BOB,
        agentAddress: ADDR_BOB,
        logger,
      });

      const baseTime = Date.now();

      // Send 4 proposals from Alice, each with a unique acceptor_intent_id
      // (to avoid the duplicate deal guard) and unique deal terms.
      for (let i = 0; i < 4; i++) {
        const acceptorIntentId = `intent-bob-rate-${i}`;
        const terms = {
          acceptor_intent_id: acceptorIntentId,
          acceptor_pubkey: PK_BOB,
          acceptor_address: ADDR_BOB,
          base_asset: 'ALPHA',
          created_ms: baseTime + i,
          deposit_timeout_sec: 120,
          escrow_address: `escrow-rate-${i}`,
          proposer_address: ADDR_ALICE,
          proposer_direction: 'sell' as const,
          proposer_intent_id: `intent-alice-rate-${i}`,
          proposer_pubkey: PK_ALICE,
          quote_asset: 'USDC',
          rate: BigInt(475 + i),
          volume: BigInt(300 + i),
        };
        const dealId = computeDealId(terms);
        const msgId = `f${i}345678-1234-1234-1234-123456789abc`;
        const proposeEnvelope: Omit<NpMessage, 'signature'> = {
          np_version: '0.1',
          msg_id: msgId,
          deal_id: dealId,
          sender_pubkey: PK_ALICE,
          type: 'np.propose_deal',
          ts_ms: baseTime + i,
          payload: {
            terms: {
              deal_id: dealId,
              proposer_intent_id: `intent-alice-rate-${i}`,
              acceptor_intent_id: acceptorIntentId,
              proposer_pubkey: PK_ALICE,
              acceptor_pubkey: PK_BOB,
              proposer_address: ADDR_ALICE,
              acceptor_address: ADDR_BOB,
              base_asset: 'ALPHA',
              quote_asset: 'USDC',
              rate: String(475 + i),
              volume: String(300 + i),
              proposer_direction: 'sell',
              escrow_address: `escrow-rate-${i}`,
              deposit_timeout_sec: 120,
              created_ms: baseTime + i,
            },
            proposer_swap_address: ADDR_ALICE,
            message: '',
          },
        };
        const sig = makeSign(PK_ALICE)(signatureInputFor(proposeEnvelope));
        const propose: NpMessage = { ...proposeEnvelope, signature: sig };

        await bob.handleIncomingDm(PK_ALICE, ADDR_ALICE, JSON.stringify(propose));
      }

      // F5: The first 3 proposals are accepted (one np.accept_deal DM each).
      // The 4th proposal is rate-limited and DROPPED SILENTLY — no outbound
      // DM at all. Previously the rate-limit path sent np.reject_deal back,
      // which created a 1:1 amplification vector for an attacker flooding
      // proposals. Asserting the number of outbound DMs equals the number
      // of accepted proposals verifies no amplification occurred.
      const acceptDms = bobSentDms.filter((dm) => {
        try {
          const msg: NpMessage = JSON.parse(dm.content);
          return msg.type === 'np.accept_deal';
        } catch {
          return false;
        }
      });
      const rejectDms = bobSentDms.filter((dm) => {
        try {
          const msg: NpMessage = JSON.parse(dm.content);
          return msg.type === 'np.reject_deal';
        } catch {
          return false;
        }
      });

      // The first 3 proposals produced 3 np.accept_deal DMs.
      expect(acceptDms.length).toBe(3);
      // The 4th (rate-limited) proposal was dropped silently — no reject DM.
      expect(rejectDms.length).toBe(0);
      // Total outbound DMs equals accepted proposals (no amplification).
      expect(bobSentDms.length).toBe(acceptDms.length);

      bob.stop();
    });

    it('T15.2 — NP-0 accept message after deal CANCELLED -> one-shot reject sent, no transition (F1)', async () => {
      const aliceSentDms: Array<{ to: string; content: string }> = [];
      const logger = createLogger({ component: 'np0-e2e-t15.2', level: 'warn' });

      const alice = createNegotiationHandler({
        sendDm: async (to, content) => { aliceSentDms.push({ to, content }); },
        signMessage: makeSign(PK_ALICE),
        verifySignature: makeVerify(),
        onDealAccepted: async () => {},
        onDealCancelled: () => {},
        agentPubkey: PK_ALICE,
        agentAddress: ADDR_ALICE,
        logger,
      });

      // Create a deal and force it to CANCELLED (terminal) state.
      const deal = await alice.proposeDeal(
        makeAliceIntent(), makeBobCounterparty(), 475n, 300n, 'escrow-001',
      );
      const dealId = deal.terms.deal_id;

      // Cancel pending deals to simulate reaching a terminal state
      alice.cancelPending();

      const cancelledDeal = alice.getDeal(dealId);
      expect(cancelledDeal!.state).toBe('CANCELLED');

      // Now try to send an accept_deal for this terminal deal
      const msgId = 'c1345678-1234-1234-1234-123456789abc';
      const lateAcceptEnvelope: Omit<NpMessage, 'signature'> = {
        np_version: '0.1',
        msg_id: msgId,
        deal_id: dealId,
        sender_pubkey: PK_BOB,
        type: 'np.accept_deal',
        ts_ms: Date.now(),
        payload: { acceptor_swap_address: ADDR_BOB, message: '' },
      };
      const signature = makeSign(PK_BOB)(signatureInputFor(lateAcceptEnvelope));
      const lateAccept: NpMessage = { ...lateAcceptEnvelope, signature };

      const dmCountBefore = aliceSentDms.length;
      await alice.handleIncomingDm(PK_BOB, ADDR_BOB, JSON.stringify(lateAccept));

      // Deal should still be CANCELLED (no transition — F1 terminal guard)
      const finalDeal = alice.getDeal(dealId);
      expect(finalDeal!.state).toBe('CANCELLED');

      // F1: Exactly one new DM sent — a one-shot np.reject_deal with reason
      // CANCELLED so the counterparty converges on the same terminal view
      // and does not proceed to proposeSwap.
      expect(aliceSentDms.length).toBe(dmCountBefore + 1);
      const sent = aliceSentDms[dmCountBefore]!;
      const parsed = JSON.parse(sent.content) as {
        type: string;
        deal_id: string;
        payload: { reason_code: string };
      };
      expect(parsed.type).toBe('np.reject_deal');
      expect(parsed.deal_id).toBe(dealId);
      expect(parsed.payload.reason_code).toBe('CANCELLED');

      alice.stop();
    });
  });
});
