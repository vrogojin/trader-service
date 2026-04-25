# Trader Agent Test Suite Specification

**Version:** 0.1
**Date:** 2026-04-03
**Status:** Draft
**Covers:** TIP-0 v0.2, NP-0 v0.1, Extended ACP Commands, SwapModule Integration
**References:** [Protocol Spec](../docs/protocols/trader-agent-protocol-spec.md) | [Architecture](../docs/trader-agent-architecture.md) | [Integration Guide](../docs/trader-agent-integration-guide.md)

---

## Test Infrastructure Notes

All tests follow the patterns established in the existing E2E suite (`test/e2e/`). Key conventions:

- Tests use `vitest` with `describe`/`it`/`expect`.
- Each test group uses a `setup*()` helper that returns a context object with mocked dependencies.
- Cleanup runs in `afterEach` blocks, including stopping listeners, unsubscribing DMs, disposing managers, and checking for unexpected DM handler errors.
- Mock objects: `MockMarketModule`, `MockSwapModule`, `MockPaymentsModule`, `MockCommunicationsModule`, `MockVolumeReservationLedger`, `MockTraderStateStore`.
- Time control: Tests use `vi.useFakeTimers()` for timeout and expiry scenarios.
- Crypto stubs: Deterministic keypairs (`PK_TRADER_A`, `PK_TRADER_B`, `PK_TRADER_C`) with known pubkey ordering for proposer selection tests.

---

## Category 1: Intent Lifecycle (Happy Path)

### T1.1: Create intent and verify publication to MarketModule

**Test name:** `should create intent and publish to MarketModule via postIntent()`

**Preconditions:**
- Trader agent spawned and in RUNNING state.
- MockPaymentsModule returns balance of 1000 ALPHA.
- MockMarketModule.postIntent() returns `{ id: 'mkt-001' }`.

**Steps:**
1. Send ACP command `CREATE_INTENT` with params: `{ direction: 'sell', base_asset: 'ALPHA', quote_asset: 'USDC', rate_min: 450, rate_max: 500, volume_min: 100, volume_max: 1000, expiry_sec: 86400 }`.
2. Await `acp.result` response.

**Expected outcome:**
- Response contains `intent_id` (64 hex chars), `market_intent_id: 'mkt-001'`, `state: 'ACTIVE'`, `expiry_ms` approximately `now + 86400000`.
- MockMarketModule.postIntent() was called once with `intentType: 'sell'`, `category: 'ALPHA/USDC'`, `price: 475` (midpoint), `currency: 'USDC'`, `contactHandle` matching agent address, `expiresInDays: 1`.
- Description matches canonical format: `"Selling 100-1000 ALPHA for USDC. Rate: 450-500 USDC per ALPHA. Escrow: any. Deposit timeout: 300s."`.
- Intent persisted to TraderStateStore.

**Category:** Intent Lifecycle

---

### T1.2: Create intent with unique intent_id (salt ensures uniqueness)

**Test name:** `should produce unique intent_id for identical params due to random salt`

**Preconditions:**
- Trader agent spawned. Balance of 2000 ALPHA.
- MockMarketModule.postIntent() succeeds.

**Steps:**
1. Send `CREATE_INTENT` with identical params twice (same direction, assets, rates, volumes, expiry).
2. Collect both `intent_id` values from responses.

**Expected outcome:**
- Both intents created successfully.
- `intent_id_1 !== intent_id_2` (different salts produce different SHA-256 hashes).
- Both intents exist in TraderStateStore with state `ACTIVE`.

**Category:** Intent Lifecycle

---

### T1.3: Create intent with all optional fields specified

**Test name:** `should create intent with explicit escrow_address and deposit_timeout_sec`

**Preconditions:**
- Trader agent spawned. Balance of 500 ALPHA.
- A known escrow pubkey `ESCROW_PK` (valid secp256k1 compressed key).

**Steps:**
1. Send `CREATE_INTENT` with: `{ direction: 'sell', base_asset: 'ALPHA', quote_asset: 'USDC', rate_min: 450, rate_max: 500, volume_min: 100, volume_max: 500, escrow_address: ESCROW_PK, deposit_timeout_sec: 120, expiry_sec: 3600 }`.

**Expected outcome:**
- Intent created with `escrow_address: ESCROW_PK` (not `"any"`).
- `deposit_timeout_sec: 120`.
- Description includes `Escrow: <ESCROW_PK>. Deposit timeout: 120s.`.
- `expiry_ms` approximately `now + 3600000`.

**Category:** Intent Lifecycle

---

### T1.4: Cancel active intent

**Test name:** `should cancel active intent and close on MarketModule`

**Preconditions:**
- Trader agent spawned. Intent `I1` created and in `ACTIVE` state with `market_intent_id: 'mkt-001'`.

**Steps:**
1. Send `CANCEL_INTENT` with `{ intent_id: I1.intent_id, reason: 'no longer needed' }`.
2. Await `acp.result` response.

**Expected outcome:**
- Response: `{ intent_id: I1.intent_id, state: 'CANCELLED', volume_filled: 0 }`.
- MockMarketModule.closeIntent() called with `'mkt-001'`.
- Intent state in TraderStateStore is `CANCELLED`.
- No further matching attempts for this intent.

**Category:** Intent Lifecycle

---

### T1.5: Intent expires and is automatically removed

**Test name:** `should transition intent to EXPIRED when expiry_ms is reached`

**Preconditions:**
- Trader agent spawned. Intent `I1` created with `expiry_sec: 10` (expires in 10 seconds).
- `vi.useFakeTimers()`.

**Steps:**
1. Verify intent state is `ACTIVE`.
2. Advance time by 11 seconds.
3. Trigger or await expiry sweep (runs every 10 seconds per spec).
4. Query intent state.

**Expected outcome:**
- Intent state transitioned to `EXPIRED`.
- MockMarketModule.closeIntent() called with reason indicating expiry.
- Intent no longer considered for matching.

**Category:** Intent Lifecycle

---

### T1.6: List intents with various filters

**Test name:** `should filter intents by state via LIST_INTENTS command`

**Preconditions:**
- Trader agent spawned with 4 intents:
  - `I_ACTIVE`: state ACTIVE
  - `I_FILLED`: state FILLED (volume_filled === volume_max)
  - `I_CANCELLED`: state CANCELLED
  - `I_EXPIRED`: state EXPIRED

**Steps:**
1. Send `LIST_INTENTS` with `{ filter: 'active' }`. Assert result contains only `I_ACTIVE`.
2. Send `LIST_INTENTS` with `{ filter: 'filled' }`. Assert result contains only `I_FILLED`.
3. Send `LIST_INTENTS` with `{ filter: 'cancelled' }`. Assert result contains only `I_CANCELLED`.
4. Send `LIST_INTENTS` with `{ filter: 'expired' }`. Assert result contains only `I_EXPIRED`.
5. Send `LIST_INTENTS` with `{ filter: 'all' }`. Assert result contains all 4.
6. Send `LIST_INTENTS` with no filter. Assert result contains all 4 (default is `'all'`).

**Expected outcome:**
- Each filter returns exactly the matching intents.
- Response includes `total` count and `intents` array with `IntentSummary` fields.
- Pagination works: `LIST_INTENTS` with `{ filter: 'all', limit: 2, offset: 0 }` returns first 2; with `offset: 2` returns next 2.

**Category:** Intent Lifecycle

---

### T1.7: Create multiple intents for different asset pairs

**Test name:** `should support intents across multiple asset pairs simultaneously`

**Preconditions:**
- Trader agent spawned. Balance: 1000 ALPHA, 500 BTC_L2, 10000 USDC.

**Steps:**
1. Create intent: sell 500 ALPHA for USDC at rate 450-500.
2. Create intent: buy 100 BTC_L2 for USDC at rate 25000-26000.
3. Create intent: sell 200 BTC_L2 for ALPHA at rate 50-55.
4. Send `LIST_INTENTS` with `{ filter: 'active' }`.

**Expected outcome:**
- All 3 intents created with unique `intent_id` values.
- `LIST_INTENTS` returns 3 active intents with correct asset pairs.
- Each posted to MarketModule with correct `category` (`ALPHA/USDC`, `BTC_L2/USDC`, `BTC_L2/ALPHA`).

**Category:** Intent Lifecycle

---

## Category 2: Intent Matching

### T2.1: Buy intent matches counterparty sell intent via search()

**Test name:** `should match buy intent against counterparty sell intent found via search()`

**Preconditions:**
- Trader A spawned with buy intent: ALPHA/USDC, rate 450-500, volume 100-500.
- MockMarketModule.search() returns one result from Trader B: sell ALPHA/USDC, rate 460-490, volume 200-800, agent_pubkey = PK_TRADER_B.

**Steps:**
1. IntentEngine scan loop fires.
2. search() called with query derived from Trader A's buy intent.
3. Result parsed, client-side matching validates: opposite direction, same pair, overlapping rates [460, 490], volume sufficient.

**Expected outcome:**
- Match detected.
- Agreed rate = floor((460 + 490) / 2) = 475.
- Agreed volume = min(500, 800) = 500.
- Volume reserved via VolumeReservationLedger.
- Intent transitions ACTIVE -> MATCHING.
- NegotiationHandler invoked with match details.

**Category:** Intent Matching

---

### T2.2: Match with overlapping rate ranges computes midpoint correctly

**Test name:** `should compute agreed rate as floor of midpoint of overlapping range`

**Preconditions:**
- Intent A: buy, rate_min=400, rate_max=500.
- Intent B: sell, rate_min=450, rate_max=550.

**Steps:**
1. Evaluate match. Overlap: [450, 500].
2. Compute agreed_rate.

**Expected outcome:**
- `overlap_min = max(400, 450) = 450`.
- `overlap_max = min(500, 550) = 500`.
- `agreed_rate = floor((450 + 500) / 2) = 475`.

**Category:** Intent Matching

---

### T2.3: Match with exact rate overlap (single point)

**Test name:** `should match when rate ranges overlap at exactly one point`

**Preconditions:**
- Intent A: buy, rate_min=400, rate_max=450.
- Intent B: sell, rate_min=450, rate_max=500.

**Steps:**
1. Evaluate matching criteria.

**Expected outcome:**
- Overlap: [450, 450]. Single point.
- `agreed_rate = floor((450 + 450) / 2) = 450`.
- Match succeeds.

**Category:** Intent Matching

---

### T2.4: No match when volume is below volume_min

**Test name:** `should not match when available volume is below both intents volume_min`

**Preconditions:**
- Intent A: buy, volume_min=200, volume_max=500, volume_filled=400 (available=100).
- Intent B: sell, volume_min=150, volume_max=300 (available=300).

**Steps:**
1. Evaluate matching criteria. `min(100, 300) = 100 < max(200, 150) = 200`.

**Expected outcome:**
- Match fails criterion 4 (insufficient volume).
- No negotiation initiated.
- No volume reserved.

**Category:** Intent Matching

---

### T2.5: Partial volume coverage initiates partial fill

**Test name:** `should initiate partial fill when counterparty available volume < own volume_max`

**Preconditions:**
- Intent A: sell, volume_min=100, volume_max=1000, volume_filled=0.
- Intent B: buy, volume_min=50, volume_max=300, volume_filled=0.

**Steps:**
1. Match evaluates. `min(1000, 300) = 300 >= max(100, 50) = 100`. Match succeeds.

**Expected outcome:**
- `agreed_volume = 300`.
- Negotiation initiated for 300 units (partial fill of A's 1000).
- After successful swap, A transitions to PARTIALLY_FILLED with volume_filled=300.

**Category:** Intent Matching

---

### T2.6: Deterministic proposer selection (lower pubkey proposes)

**Test name:** `should select agent with lexicographically lower pubkey as proposer`

**Preconditions:**
- PK_TRADER_A = `"02aaa..."` (lexicographically lower).
- PK_TRADER_B = `"02bbb..."` (lexicographically higher).
- Both agents discover each other's intents simultaneously.

**Steps:**
1. Trader A evaluates match with Trader B's intent. A's pubkey < B's pubkey.
2. Trader B evaluates match with Trader A's intent. B's pubkey > A's pubkey.

**Expected outcome:**
- Trader A sends `np.propose_deal` (is proposer).
- Trader B does NOT send `np.propose_deal`; waits for incoming proposal.
- Only one `np.propose_deal` is sent for this intent pair.

**Category:** Intent Matching

---

### T2.7: Self-matching prevention

**Test name:** `should filter out own intents from search results`

**Preconditions:**
- Trader A has a sell intent and a buy intent for the same pair that overlap in rate.
- MockMarketModule.search() returns Trader A's own sell intent (same agent_pubkey).

**Steps:**
1. IntentEngine processes search results.

**Expected outcome:**
- Result with `agentPublicKey === agent_pubkey` is filtered out (criterion 8).
- No match initiated against own intent.

**Category:** Intent Matching

---

### T2.8: Match via subscribeFeed() real-time notification

**Test name:** `should detect match via MarketModule.subscribeFeed() callback`

**Preconditions:**
- Trader A has an active buy intent for ALPHA/USDC.
- subscribeFeed() registered with onIntent callback.

**Steps:**
1. Feed callback fires with FeedListing from Trader B (sell ALPHA/USDC).
2. IntentEngine calls search() to get full details.
3. Client-side matching validates the result.

**Expected outcome:**
- Match detected via feed path (not periodic scan).
- search() called after feed event to retrieve full intent details.
- Normal matching flow proceeds (reserve volume, start negotiation).

**Category:** Intent Matching

---

### T2.9: Match via periodic search() scan

**Test name:** `should discover matching intents via periodic search() scan loop`

**Preconditions:**
- Trader A has active sell intent for ALPHA/USDC.
- Scan loop interval: 5 seconds.
- MockMarketModule.search() returns a matching buy intent.

**Steps:**
1. Wait for scan loop to fire (or trigger manually).
2. search() returns matching result.

**Expected outcome:**
- IntentEngine called search() with correctly constructed query and filters.
- `intentType` filter set to opposite direction (`'buy'`).
- `category` filter set to `'ALPHA/USDC'`.
- `minPrice`/`maxPrice` filters set from own intent's rate range.
- Match detected and negotiation initiated.

**Category:** Intent Matching

---

## Category 3: NP-0 Negotiation (Happy Path)

### T3.1: Propose deal then accept deal leading to swap

**Test name:** `should complete NP-0 negotiation: propose_deal -> accept_deal -> proceed to swap`

**Preconditions:**
- Trader A matched with Trader B's intent. Volume reserved.
- Trader A is the proposer (lower pubkey).
- NP-0 DM transport mocked.

**Steps:**
1. Trader A sends `np.propose_deal` with DealTerms: `{ proposer_pubkey: PK_A, acceptor_pubkey: PK_B, rate: 475, volume: 300, escrow_address: 'any', deposit_timeout_sec: 300 }`.
2. Trader B receives proposal, validates terms, sends `np.accept_deal`.
3. Trader A receives acceptance.

**Expected outcome:**
- Deal state: PROPOSED -> ACCEPTED.
- `np.propose_deal` envelope has correct `np_version: '0.1'`, valid `msg_id`, `deal_id` matching SHA-256 of canonical DealTerms, valid signature.
- `np.accept_deal` envelope has matching `deal_id`, `sender_pubkey === PK_B`.
- After acceptance, SwapExecutor invoked (pingEscrow then proposeSwap).
- Intent transitions MATCHING -> NEGOTIATING.

**Category:** NP-0 Negotiation

---

### T3.2: Counter-proposal via reject then re-propose

**Test name:** `should handle counter-proposal flow: reject with reason then re-propose`

**Preconditions:**
- Trader A proposes deal at rate 475.
- Trader B's strategy requires min_profit_margin not met at 475.

**Steps:**
1. Trader A sends `np.propose_deal` at rate 475.
2. Trader B sends `np.reject_deal` with reason `RATE_UNACCEPTABLE`.
3. Trader A's intent returns to ACTIVE, volume released.
4. Trader A re-evaluates match with adjusted parameters.
5. (If rate range still overlaps) Trader A sends new `np.propose_deal` at a different rate.

**Expected outcome:**
- First deal enters CANCELLED state.
- Volume reservation released after rejection.
- Intent transitions NEGOTIATING -> ACTIVE.
- New deal created with fresh `deal_id`.
- Intent transitions ACTIVE -> MATCHING -> NEGOTIATING again.

**Category:** NP-0 Negotiation

---

### T3.3: Reject deal with each reason code

**Test name:** `should accept np.reject_deal with each valid DealRejectReason`

**Preconditions:**
- Active deal in PROPOSED state.

**Steps:**
1. For each reason code in `[RATE_UNACCEPTABLE, VOLUME_UNACCEPTABLE, ESCROW_UNACCEPTABLE, TIMEOUT_UNACCEPTABLE, INSUFFICIENT_BALANCE, STRATEGY_MISMATCH, AGENT_BUSY, OTHER]`:
   a. Send `np.reject_deal` with that `reason_code`.
   b. Verify deal transitions to CANCELLED.
   c. Verify volume released.

**Expected outcome:**
- All 8 reason codes are accepted as valid.
- Deal transitions to CANCELLED for each.
- Rejection logged with reason code and optional message.

**Category:** NP-0 Negotiation

---

## Category 4: NP-0 Negotiation (Unhappy Path)

### T4.1: Proposal timeout (30s)

**Test name:** `should cancel deal after 30s proposal timeout with no response`

**Preconditions:**
- Trader A sends `np.propose_deal`. Deal in PROPOSED state.
- `vi.useFakeTimers()`.

**Steps:**
1. Advance time by 30 seconds.
2. No `np.accept_deal` or `np.reject_deal` received.

**Expected outcome:**
- Deal transitions PROPOSED -> CANCELLED.
- Volume reservation released.
- Intent returns to ACTIVE for re-matching.
- Timeout logged.

**Category:** NP-0 Negotiation (Unhappy)

---

### T4.2: Acceptance timeout (60s)

**Test name:** `should cancel deal after 60s acceptance timeout`

**Preconditions:**
- Deal in ACCEPTED state (post np.accept_deal).
- `vi.useFakeTimers()`.

**Steps:**
1. Advance time by 60 seconds.
2. No pingEscrow/proposeSwap completion.

**Expected outcome:**
- Deal transitions ACCEPTED -> CANCELLED.
- Volume reservation released.
- Intent returns to ACTIVE.

**Category:** NP-0 Negotiation (Unhappy)

---

### T4.3: Counterparty goes offline mid-negotiation

**Test name:** `should handle counterparty going offline via timeout mechanism`

**Preconditions:**
- Deal in PROPOSED state. Counterparty DM delivery fails silently (Nostr relay best-effort).

**Steps:**
1. Wait for 30s proposal timeout to fire.

**Expected outcome:**
- Same as T4.1: deal cancelled via timeout.
- No crash or unhandled rejection.

**Category:** NP-0 Negotiation (Unhappy)

---

### T4.4: Invalid NP-0 message signature

**Test name:** `should reject NP-0 message with invalid ECDSA signature`

**Preconditions:**
- Deal in PROPOSED state.
- Incoming `np.accept_deal` with corrupted signature field.

**Steps:**
1. Receive NP-0 message with valid envelope but signature that does not verify against sender_pubkey.

**Expected outcome:**
- Message rejected silently (logged as warning).
- Deal state remains PROPOSED.
- No state transition.

**Category:** NP-0 Negotiation (Unhappy)

---

### T4.5: NP-0 message with wrong deal_id

**Test name:** `should reject NP-0 message referencing unknown deal_id`

**Preconditions:**
- Deal `D1` in PROPOSED state with `deal_id = 'aaa...'`.

**Steps:**
1. Receive `np.accept_deal` with `deal_id = 'bbb...'` (not matching any active deal).

**Expected outcome:**
- Message discarded. Logged as warning: unknown deal_id.
- No state change to any deal.

**Category:** NP-0 Negotiation (Unhappy)

---

### T4.6: NP-0 message from wrong sender_pubkey

**Test name:** `should reject NP-0 message from non-participant pubkey`

**Preconditions:**
- Deal between PK_A (proposer) and PK_B (acceptor) in PROPOSED state.
- PK_C is a third party.

**Steps:**
1. Receive `np.accept_deal` with `sender_pubkey = PK_C` (not a participant in the deal).

**Expected outcome:**
- Message rejected: sender_pubkey is not proposer or acceptor.
- Deal state unchanged.
- Security event logged.

**Category:** NP-0 Negotiation (Unhappy)

---

### T4.7: Duplicate proposal for same intent (AGENT_BUSY)

**Test name:** `should reject second proposal for intent with active deal`

**Preconditions:**
- Trader B has intent `I_B` with an active deal (state PROPOSED or EXECUTING).
- Trader C sends `np.propose_deal` referencing `I_B` as acceptor_intent_id.

**Steps:**
1. Receive `np.propose_deal` from Trader C for intent `I_B`.

**Expected outcome:**
- Trader B sends `np.reject_deal` with `reason_code: 'AGENT_BUSY'`.
- Existing deal remains unaffected.

**Category:** NP-0 Negotiation (Unhappy)

---

### T4.8: NP-0 message exceeding 64KB

**Test name:** `should reject NP-0 message exceeding 64 KiB size limit`

**Preconditions:**
- Deal in PROPOSED state.

**Steps:**
1. Construct an `np.accept_deal` with `message` field padded to exceed 64 KiB total.
2. Deliver to agent.

**Expected outcome:**
- Message rejected before parsing payload.
- Deal state unchanged.
- Size violation logged.

**Category:** NP-0 Negotiation (Unhappy)

---

### T4.9: Malformed NP-0 JSON

**Test name:** `should reject malformed JSON in NP-0 message`

**Preconditions:**
- DM transport delivers a message that is not valid JSON.

**Steps:**
1. Deliver `"{not valid json"` as NP-0 message body.

**Expected outcome:**
- Parse error caught. No crash.
- Warning logged.
- No state changes.

**Category:** NP-0 Negotiation (Unhappy)

---

### T4.10: NP-0 message with dangerous keys (__proto__)

**Test name:** `should reject NP-0 message containing prototype pollution keys`

**Preconditions:**
- Deal in PROPOSED state.

**Steps:**
1. Deliver `np.accept_deal` with injected key: `{ "__proto__": { "isAdmin": true }, ... }`.
2. Also test `constructor` and `prototype` keys at nested levels.

**Expected outcome:**
- Message rejected by dangerous key check (consistent with `hasDangerousKeys()` in envelope.ts).
- No prototype pollution.
- Security event logged.

**Category:** NP-0 Negotiation (Unhappy)

---

## Category 5: Swap Execution (Happy Path)

### T5.1: Full swap flow from negotiation to completion

**Test name:** `should complete full swap: negotiate -> pingEscrow -> proposeSwap -> acceptSwap -> deposit -> payout -> completed`

**Preconditions:**
- Deal in ACCEPTED state between Trader A (proposer) and Trader B (acceptor).
- MockSwapModule.pingEscrow() resolves successfully.
- MockSwapModule.proposeSwap() returns `{ swapId: 'swap-001' }`.

**Steps:**
1. SwapExecutor calls pingEscrow(escrowAddress, 10000). Succeeds.
2. Deal transitions ACCEPTED -> EXECUTING.
3. SwapExecutor calls proposeSwap(deal).
4. Counterparty receives `swap:proposal_received`, calls acceptSwap().
5. MockSwapModule emits `swap:completed` with `{ swapId: 'swap-001', payoutVerified: true }`.

**Expected outcome:**
- Deal transitions EXECUTING -> COMPLETED.
- Volume reservation released via VolumeReservationLedger.
- Intent `volume_filled` updated by agreed volume amount.
- Deal persisted to TraderStateStore with terminal state COMPLETED.

**Category:** Swap Execution

---

### T5.2: Payout verification passes (payoutVerified === true)

**Test name:** `should only update volume_filled when payoutVerified is true`

**Preconditions:**
- Deal in EXECUTING state. Agreed volume = 300.

**Steps:**
1. MockSwapModule emits `swap:completed` with `payoutVerified: true`.

**Expected outcome:**
- `volume_filled` increases by 300.
- Reservation released.
- Deal enters COMPLETED.

**Category:** Swap Execution

---

### T5.3: Volume_filled updated correctly after completion

**Test name:** `should correctly accumulate volume_filled across multiple partial fills`

**Preconditions:**
- Intent with volume_max=1000, volume_filled=0.
- First deal: volume=400. Second deal: volume=300.

**Steps:**
1. Complete first swap (payoutVerified=true, volume=400).
2. Verify volume_filled=400, intent state=PARTIALLY_FILLED.
3. Complete second swap (payoutVerified=true, volume=300).
4. Verify volume_filled=700, intent state=PARTIALLY_FILLED.

**Expected outcome:**
- volume_filled is cumulative: 0 -> 400 -> 700.
- Intent remains PARTIALLY_FILLED (700 < 1000).
- Available volume for next match: 300.

**Category:** Swap Execution

---

### T5.4: VolumeReservationLedger released after completion

**Test name:** `should release volume reservation upon swap completion`

**Preconditions:**
- Balance: 1000 ALPHA. Reservation of 400 for deal D1.
- getAvailable('ALPHA') returns 600.

**Steps:**
1. Deal D1 swap completes (swap:completed, payoutVerified=true).
2. Check getAvailable('ALPHA').

**Expected outcome:**
- Reservation for D1 released.
- getAvailable('ALPHA') returns 1000 (full balance minus no reservations).
- getReservations() does not contain D1.

**Category:** Swap Execution

---

### T5.5: Intent transitions to FILLED when fully filled

**Test name:** `should transition intent to FILLED when volume_filled reaches volume_max`

**Preconditions:**
- Intent with volume_max=500, volume_filled=200.
- Deal for remaining 300 completes.

**Steps:**
1. Swap completes with volume=300, payoutVerified=true.
2. volume_filled = 200 + 300 = 500 = volume_max.

**Expected outcome:**
- Intent state transitions to FILLED.
- MockMarketModule.closeIntent() called.
- No further matching attempted for this intent.

**Category:** Swap Execution

---

### T5.6: MarketModule.closeIntent() called on full fill

**Test name:** `should call MarketModule.closeIntent() when intent is fully filled`

**Preconditions:**
- Intent with market_intent_id='mkt-001'. About to be fully filled.

**Steps:**
1. Swap completes, volume_filled reaches volume_max.

**Expected outcome:**
- MockMarketModule.closeIntent() called exactly once with `'mkt-001'`.
- Intent state is FILLED.

**Category:** Swap Execution

---

## Category 6: Swap Execution (Unhappy Path)

### T6.1: pingEscrow fails leading to FAILED with ESCROW_UNREACHABLE

**Test name:** `should fail deal with ESCROW_UNREACHABLE when pingEscrow() rejects`

**Preconditions:**
- Deal in ACCEPTED state.
- MockSwapModule.pingEscrow() rejects with timeout error.

**Steps:**
1. SwapExecutor calls pingEscrow(escrowAddress, 10000).
2. Call rejects/times out.

**Expected outcome:**
- Deal transitions ACCEPTED -> FAILED with reason `ESCROW_UNREACHABLE`.
- Volume reservation released.
- Intent returns to ACTIVE for re-matching.
- Failure logged.

**Category:** Swap Execution (Unhappy)

---

### T6.2: proposeSwap times out

**Test name:** `should fail deal when SwapModule.proposeSwap() times out`

**Preconditions:**
- Deal in EXECUTING state. proposeSwap() called but no completion event within deadline.
- `vi.useFakeTimers()`.

**Steps:**
1. Advance time by `deposit_timeout_sec + 60` seconds.

**Expected outcome:**
- Deal transitions EXECUTING -> FAILED.
- Volume reservation released.
- Intent returns to ACTIVE.

**Category:** Swap Execution (Unhappy)

---

### T6.3: Counterparty rejects swap proposal

**Test name:** `should handle counterparty swap rejection gracefully`

**Preconditions:**
- Deal in EXECUTING state. proposeSwap() called.

**Steps:**
1. MockSwapModule emits `swap:failed` event.

**Expected outcome:**
- Deal transitions EXECUTING -> FAILED.
- Volume reservation released.
- Intent returns to ACTIVE (if not in terminal state).

**Category:** Swap Execution (Unhappy)

---

### T6.4: Deposit fails (insufficient balance after reservation)

**Test name:** `should handle deposit failure when balance is insufficient at execution time`

**Preconditions:**
- Volume was reserved when balance was 1000. External send reduced balance to 200. Reservation was for 500.

**Steps:**
1. SwapModule attempts deposit. PaymentsModule.send() fails with insufficient balance.
2. swap:failed event emitted.

**Expected outcome:**
- Deal transitions to FAILED.
- Reservation released.
- Intent returns to ACTIVE.
- Error logged with balance details.

**Category:** Swap Execution (Unhappy)

---

### T6.5: Counterparty never deposits (escrow timeout)

**Test name:** `should handle escrow deposit timeout when counterparty never deposits`

**Preconditions:**
- Deal in EXECUTING state. Agent deposited. Counterparty does not deposit.
- `vi.useFakeTimers()`.

**Steps:**
1. Advance time past deposit_timeout_sec.
2. Escrow triggers timeout, emits `swap:cancelled` event.

**Expected outcome:**
- Deal transitions EXECUTING -> FAILED.
- Volume reservation released.
- Agent's deposited tokens refunded by escrow.
- Intent returns to ACTIVE.

**Category:** Swap Execution (Unhappy)

---

### T6.6: Escrow returns error on announce

**Test name:** `should fail deal when escrow returns error during swap announcement`

**Preconditions:**
- Deal in EXECUTING state.
- SwapModule's announce to escrow fails.

**Steps:**
1. MockSwapModule emits `swap:failed` with escrow error.

**Expected outcome:**
- Deal transitions to FAILED.
- Reservation released.
- Intent returns to ACTIVE.

**Category:** Swap Execution (Unhappy)

---

### T6.7: swap:failed event releases reservation and restores intent

**Test name:** `should release reservation and restore intent to ACTIVE on swap:failed`

**Preconditions:**
- Intent in NEGOTIATING state. Deal in EXECUTING state. Reservation for 500 ALPHA.

**Steps:**
1. MockSwapModule emits `swap:failed`.

**Expected outcome:**
- Reservation released: getAvailable('ALPHA') increases by 500.
- volume_filled NOT updated (no fill occurred).
- Intent transitions back to ACTIVE.
- Intent available for re-matching.

**Category:** Swap Execution (Unhappy)

---

### T6.8: swap:cancelled event releases reservation and restores intent

**Test name:** `should release reservation and restore intent to ACTIVE on swap:cancelled`

**Preconditions:**
- Intent in NEGOTIATING state. Deal in EXECUTING state. Reservation for 300 ALPHA.

**Steps:**
1. MockSwapModule emits `swap:cancelled`.

**Expected outcome:**
- Reservation released.
- volume_filled NOT updated.
- Intent transitions back to ACTIVE.

**Category:** Swap Execution (Unhappy)

---

## Category 7: Partial Fill Scenarios

### T7.1: Partial fill then remaining re-posted

**Test name:** `should handle partial fill of 400 out of 1000, leaving 600 for re-matching`

**Preconditions:**
- Intent: sell 1000 ALPHA, volume_min=100.
- Match with Trader B for 400 units.

**Steps:**
1. Negotiate and complete swap for 400 units.
2. volume_filled = 400. remaining = 600 >= volume_min (100).

**Expected outcome:**
- Intent transitions to PARTIALLY_FILLED.
- Old market intent closed via closeIntent().
- New market intent posted with adjusted volume (600 remaining).
- Intent returns to ACTIVE for re-matching.
- volume_filled = 400 persisted.

**Category:** Partial Fill

---

### T7.2: Multiple partial fills until fully filled

**Test name:** `should accumulate multiple partial fills until intent is fully filled`

**Preconditions:**
- Intent: sell 1000 ALPHA, volume_min=100.

**Steps:**
1. Fill 1: 300 units -> volume_filled=300, PARTIALLY_FILLED, re-posted.
2. Fill 2: 400 units -> volume_filled=700, PARTIALLY_FILLED, re-posted.
3. Fill 3: 300 units -> volume_filled=1000, FILLED.

**Expected outcome:**
- Three sequential deals complete successfully.
- After fill 3: intent state = FILLED.
- MarketModule.closeIntent() called after fill 3.
- No further matching.

**Category:** Partial Fill

---

### T7.3: Partial fill leaves remaining below volume_min

**Test name:** `should treat intent as FILLED when remaining volume < volume_min`

**Preconditions:**
- Intent: sell 1000 ALPHA, volume_min=200.
- First fill: 850 units. Remaining = 150 < volume_min (200).

**Steps:**
1. Complete swap for 850 units.
2. volume_filled = 850. remaining = 150 < 200.

**Expected outcome:**
- Intent transitions to FILLED (not PARTIALLY_FILLED).
- MarketModule.closeIntent() called.
- The 150-unit shortfall accepted as rounding residual.
- No re-posting or further matching.

**Category:** Partial Fill

---

### T7.4: Partial fill swap fails, volume restored

**Test name:** `should restore full available volume when partial fill swap fails`

**Preconditions:**
- Intent: sell 1000 ALPHA, volume_filled=300 (from previous fill).
- Current deal negotiating for 400 units. Reservation of 400.

**Steps:**
1. Swap fails (swap:failed event).

**Expected outcome:**
- volume_filled remains 300 (NOT updated because no fill occurred).
- Reservation of 400 released.
- getAvailable('ALPHA') restores the 400.
- Intent returns to ACTIVE (actually PARTIALLY_FILLED since volume_filled > 0).
- Available for matching = 1000 - 300 = 700.

**Category:** Partial Fill

---

## Category 8: Volume Reservation

### T8.1: Reserve volume decreases getAvailable()

**Test name:** `should decrease getAvailable() when volume is reserved`

**Preconditions:**
- Balance: 1000 ALPHA. No existing reservations.

**Steps:**
1. `reserve('ALPHA', 400n, 'deal-1')` -> returns true.
2. Check `getAvailable('ALPHA')`.

**Expected outcome:**
- `getAvailable('ALPHA') === 600n` (1000 - 400).

**Category:** Volume Reservation

---

### T8.2: Release reservation increases getAvailable()

**Test name:** `should increase getAvailable() when reservation is released`

**Preconditions:**
- Balance: 1000 ALPHA. Reservation: 400 for deal-1.

**Steps:**
1. `release('deal-1')`.
2. Check `getAvailable('ALPHA')`.

**Expected outcome:**
- `getAvailable('ALPHA') === 1000n`.
- `getReservations()` no longer contains deal-1.

**Category:** Volume Reservation

---

### T8.3: Reserve more than available returns false

**Test name:** `should return false when attempting to reserve more than available`

**Preconditions:**
- Balance: 500 ALPHA. No reservations.

**Steps:**
1. `reserve('ALPHA', 600n, 'deal-1')`.

**Expected outcome:**
- Returns `false`.
- No reservation created.
- `getAvailable('ALPHA') === 500n` (unchanged).

**Category:** Volume Reservation

---

### T8.4: Concurrent reservations (no over-commitment via mutex)

**Test name:** `should serialize concurrent reserve() calls to prevent over-commitment`

**Preconditions:**
- Balance: 1000 ALPHA. No reservations.

**Steps:**
1. Fire two concurrent calls: `reserve('ALPHA', 700n, 'deal-1')` and `reserve('ALPHA', 700n, 'deal-2')` simultaneously.

**Expected outcome:**
- Exactly one call returns `true`, the other returns `false`.
- Total reservations <= 1000.
- Invariant: `sum(reservations['ALPHA']) <= getBalance('ALPHA')`.
- Mutex serialization prevents both from reading 1000 and both reserving 700.

**Category:** Volume Reservation

---

### T8.5: External balance decrease causes negative available

**Test name:** `should handle external balance decrease making getAvailable() go negative`

**Preconditions:**
- Balance: 1000 ALPHA. Reservation: 800 for deal-1.
- External event reduces balance to 500 (e.g., owner withdrew via external wallet).

**Steps:**
1. MockPaymentsModule.getBalance('ALPHA') now returns 500.
2. `getAvailable('ALPHA')` = 500 - 800 = -300.
3. Attempt `reserve('ALPHA', 100n, 'deal-2')`.

**Expected outcome:**
- `getAvailable('ALPHA')` returns negative value (-300n or similar).
- New `reserve()` call returns `false` (available < requested).
- Existing reservation for deal-1 remains (cannot retroactively cancel).
- Warning logged about over-commitment state.

**Category:** Volume Reservation

---

## Category 9: State Persistence

### T9.1: Intent state persists across stop/restart

**Test name:** `should preserve active intent state across agent stop and restart`

**Preconditions:**
- Trader agent with MockFilesystem for persistence.
- Intent I1 created and in ACTIVE state.

**Steps:**
1. Send `hm.stop` to stop the trader container.
2. Send `hm.start` to restart.
3. Send `LIST_INTENTS` command.

**Expected outcome:**
- Intent I1 appears in the list with state ACTIVE.
- Intent fields (direction, rates, volumes, etc.) match pre-stop values.
- TraderStateStore loaded from `/data/wallet/trader/intents/`.

**Category:** State Persistence

---

### T9.2: Mid-negotiation state persists across restart

**Test name:** `should preserve deal state when stopped during NP-0 negotiation`

**Preconditions:**
- Deal D1 in PROPOSED state between Trader A and Trader B.

**Steps:**
1. Stop agent.
2. Restart agent.
3. Query deal state.

**Expected outcome:**
- Deal D1 restored from `/data/wallet/trader/deals/`.
- Deal state is PROPOSED (or timed out to CANCELLED if restart took > 30s).
- Volume reservation restored.

**Category:** State Persistence

---

### T9.3: Mid-swap (EXECUTING) state recovered via SwapModule.load()

**Test name:** `should recover in-flight swaps via SwapModule.load() on restart`

**Preconditions:**
- Deal D1 in EXECUTING state with swap_id='swap-001'.

**Steps:**
1. Stop agent.
2. Restart agent. SwapModule.load() called during startup.
3. MockSwapModule.load() restores swap-001.

**Expected outcome:**
- SwapModule.load() called during startup.
- In-flight swap resumed.
- Event listeners re-registered for swap:completed/failed/cancelled.
- Deal D1 state restored as EXECUTING.

**Category:** State Persistence

---

### T9.4: Volume reservations persist across restart

**Test name:** `should restore volume reservations from persisted state after restart`

**Preconditions:**
- Reservation: 500 ALPHA for deal-1.
- VolumeReservationLedger serialized in `/data/wallet/trader/strategy.json`.

**Steps:**
1. Stop agent.
2. Restart agent.
3. Call `getAvailable('ALPHA')` and `getReservations()`.

**Expected outcome:**
- Reservation for deal-1 (500 ALPHA) restored.
- `getAvailable('ALPHA')` reflects the reservation.
- `getReservations()` returns `[{ dealId: 'deal-1', coinId: 'ALPHA', amount: 500n }]`.

**Category:** State Persistence

---

### T9.5: Strategy settings persist across restart

**Test name:** `should restore SET_STRATEGY configuration after restart`

**Preconditions:**
- Strategy set: `{ auto_match: true, auto_negotiate: true, max_concurrent_swaps: 5, min_search_score: 0.7 }`.

**Steps:**
1. Stop agent.
2. Restart agent.
3. Query strategy (via STATUS or GET_PORTFOLIO).

**Expected outcome:**
- All strategy fields restored from `/data/wallet/trader/strategy.json`.
- `auto_match: true`, `auto_negotiate: true`, `max_concurrent_swaps: 5`, `min_search_score: 0.7`.

**Category:** State Persistence

---

## Category 10: ACP Command Validation

### T10.1: CREATE_INTENT with missing required fields

**Test name:** `should return INVALID_PARAM when required fields are missing from CREATE_INTENT`

**Preconditions:**
- Trader agent spawned.

**Steps:**
1. Send `CREATE_INTENT` with `{ direction: 'sell' }` (missing base_asset, quote_asset, rates, volumes, expiry_sec).

**Expected outcome:**
- `acp.error` response with error code `INVALID_PARAM`.
- Message indicates which field is missing.
- No intent created.

**Category:** ACP Command Validation

---

### T10.2: CREATE_INTENT with negative rate

**Test name:** `should reject CREATE_INTENT with negative rate_min or rate_max`

**Preconditions:**
- Trader agent spawned.

**Steps:**
1. Send `CREATE_INTENT` with `rate_min: -10, rate_max: 500`.

**Expected outcome:**
- Error: `INVALID_PARAM` -- `rate_min` must be positive.

**Category:** ACP Command Validation

---

### T10.3: CREATE_INTENT with zero volume

**Test name:** `should reject CREATE_INTENT with zero volume_min or volume_max`

**Preconditions:**
- Trader agent spawned.

**Steps:**
1. Send `CREATE_INTENT` with `volume_min: 0, volume_max: 1000`.

**Expected outcome:**
- Error: `INVALID_PARAM` -- `volume_min` must be positive.

**Category:** ACP Command Validation

---

### T10.4: CREATE_INTENT with already-expired timestamp

**Test name:** `should reject CREATE_INTENT with expiry_sec that results in past expiry`

**Preconditions:**
- Trader agent spawned.

**Steps:**
1. Send `CREATE_INTENT` with `expiry_sec: 0` or `expiry_sec: -100`.

**Expected outcome:**
- Error: `INVALID_PARAM` -- expiry must be in the future.

**Category:** ACP Command Validation

---

### T10.5: CREATE_INTENT with rate_min > rate_max

**Test name:** `should reject CREATE_INTENT when rate_min exceeds rate_max`

**Preconditions:**
- Trader agent spawned.

**Steps:**
1. Send `CREATE_INTENT` with `rate_min: 600, rate_max: 400`.

**Expected outcome:**
- Error: `INVALID_PARAM` -- `rate_min` must be <= `rate_max`.

**Category:** ACP Command Validation

---

### T10.6: CREATE_INTENT with same base_asset and quote_asset

**Test name:** `should reject CREATE_INTENT when base_asset equals quote_asset`

**Preconditions:**
- Trader agent spawned.

**Steps:**
1. Send `CREATE_INTENT` with `base_asset: 'ALPHA', quote_asset: 'ALPHA'`.

**Expected outcome:**
- Error: `INVALID_PARAM` -- base_asset and quote_asset must differ.

**Category:** ACP Command Validation

---

### T10.7: CREATE_INTENT with invalid asset name format

**Test name:** `should reject CREATE_INTENT with asset name not matching /^[A-Z0-9_]{1,32}$/`

**Preconditions:**
- Trader agent spawned.

**Steps:**
1. Send `CREATE_INTENT` with `base_asset: 'alpha'` (lowercase).
2. Send `CREATE_INTENT` with `base_asset: 'A'.repeat(33)` (too long).
3. Send `CREATE_INTENT` with `base_asset: 'AL-PHA'` (hyphen not allowed).

**Expected outcome:**
- All three return `INVALID_PARAM` with message about asset name format.

**Category:** ACP Command Validation

---

### T10.8: CREATE_INTENT when max_active_intents reached

**Test name:** `should return MAX_INTENTS_REACHED when intent cap is hit`

**Preconditions:**
- Strategy: `max_active_intents: 3`.
- Already 3 active intents.

**Steps:**
1. Send `CREATE_INTENT` for a 4th intent.

**Expected outcome:**
- Error: `MAX_INTENTS_REACHED`.
- No new intent created.

**Category:** ACP Command Validation

---

### T10.9: CREATE_INTENT with insufficient balance

**Test name:** `should return INSUFFICIENT_BALANCE when agent lacks tokens for sell intent`

**Preconditions:**
- Balance: 100 ALPHA. No reservations.

**Steps:**
1. Send `CREATE_INTENT` with `direction: 'sell', volume_max: 500`.

**Expected outcome:**
- Error: `INSUFFICIENT_BALANCE`.
- No intent created.

**Category:** ACP Command Validation

---

### T10.10: CANCEL_INTENT for non-existent intent

**Test name:** `should return INTENT_NOT_FOUND for unknown intent_id`

**Preconditions:**
- Trader agent spawned.

**Steps:**
1. Send `CANCEL_INTENT` with `intent_id: 'nonexistent0000...'` (64 hex chars).

**Expected outcome:**
- Error: `INTENT_NOT_FOUND`.

**Category:** ACP Command Validation

---

### T10.11: CANCEL_INTENT for already-filled intent

**Test name:** `should return INTENT_NOT_ACTIVE for filled intent`

**Preconditions:**
- Intent I1 in FILLED state.

**Steps:**
1. Send `CANCEL_INTENT` with `intent_id: I1.intent_id`.

**Expected outcome:**
- Error: `INTENT_NOT_ACTIVE` -- intent is in terminal state.

**Category:** ACP Command Validation

---

### T10.12: CANCEL_INTENT for intent with active deal

**Test name:** `should return DEAL_IN_PROGRESS when intent has non-terminal deal`

**Preconditions:**
- Intent I1 in NEGOTIATING state with active deal D1 (state PROPOSED).

**Steps:**
1. Send `CANCEL_INTENT` with `intent_id: I1.intent_id`.

**Expected outcome:**
- Error: `DEAL_IN_PROGRESS` -- cannot cancel intent while deal is active.

**Category:** ACP Command Validation

---

### T10.13: SET_STRATEGY with invalid values

**Test name:** `should reject SET_STRATEGY with out-of-range values`

**Preconditions:**
- Trader agent spawned.

**Steps:**
1. Send `SET_STRATEGY` with `max_concurrent_swaps: 11` (max is 10).
2. Send `SET_STRATEGY` with `max_concurrent_swaps: 0` (must be positive).
3. Send `SET_STRATEGY` with `min_search_score: 1.5` (max is 1.0).
4. Send `SET_STRATEGY` with `min_search_score: -0.1` (min is 0).
5. Send `SET_STRATEGY` with `max_active_intents: 101` (max is 100).

**Expected outcome:**
- All return `INVALID_PARAM` with descriptive message.
- Strategy unchanged.

**Category:** ACP Command Validation

---

### T10.14: GET_PORTFOLIO returns correct available/reserved breakdown

**Test name:** `should return accurate portfolio with available and reserved balances`

**Preconditions:**
- Balance: 1000 ALPHA (confirmed: 900, unconfirmed: 100).
- Reservation: 300 ALPHA for deal-1, 200 ALPHA for deal-2.

**Steps:**
1. Send `GET_PORTFOLIO` command.

**Expected outcome:**
- Response contains:
  - `balances`: `[{ asset: 'ALPHA', total: 1000, confirmed: 900, unconfirmed: 100, available: 500 }]` (1000 - 300 - 200 = 500 available).
  - `reserved`: `[{ asset: 'ALPHA', amount: 300, deal_id: 'deal-1' }, { asset: 'ALPHA', amount: 200, deal_id: 'deal-2' }]`.
  - `agent_pubkey` and `agent_address` present.

**Category:** ACP Command Validation

---

### T10.15: WITHDRAW_TOKEN with amount exceeding available

**Test name:** `should reject WITHDRAW_TOKEN when amount exceeds available (reserved volume blocks)`

**Preconditions:**
- Balance: 1000 ALPHA. Reservation: 800 for deal-1. Available: 200.

**Steps:**
1. Send `WITHDRAW_TOKEN` with `{ asset: 'ALPHA', amount: '500', to_address: OWNER_ADDRESS }`.

**Expected outcome:**
- Error: `INSUFFICIENT_BALANCE` -- only 200 available after reservations.
- No transfer initiated.

**Category:** ACP Command Validation

---

### T10.16: WITHDRAW_TOKEN succeeds within available balance

**Test name:** `should successfully withdraw tokens within available balance`

**Preconditions:**
- Balance: 1000 ALPHA. Reservation: 300 for deal-1. Available: 700.

**Steps:**
1. Send `WITHDRAW_TOKEN` with `{ asset: 'ALPHA', amount: '500', to_address: OWNER_ADDRESS }`.

**Expected outcome:**
- MockPaymentsModule.send() called with `{ coinId: 'ALPHA', amount: '500', to: OWNER_ADDRESS }`.
- Response: `{ asset: 'ALPHA', amount: '500', to_address: OWNER_ADDRESS, transfer_id: '...', remaining_balance: '500' }`.

**Category:** ACP Command Validation

---

### T10.17: STATUS returns trader-specific fields

**Test name:** `should include trader-specific fields in STATUS response`

**Preconditions:**
- Trader agent running. 3 active intents, 1 pending swap, strategy configured.

**Steps:**
1. Send `STATUS` ACP command.

**Expected outcome:**
- Response includes standard fields (status: 'RUNNING', message_count, etc.).
- Response also includes trader-specific fields: `active_intents: 3`, `pending_swaps: 1`, `completed_swaps: <count>`, `strategy` summary.

**Category:** ACP Command Validation

---

### T10.18: CREATE_INTENT with deposit_timeout_sec out of range

**Test name:** `should reject CREATE_INTENT with deposit_timeout_sec outside 30-300 range`

**Preconditions:**
- Trader agent spawned.

**Steps:**
1. Send `CREATE_INTENT` with `deposit_timeout_sec: 10` (below 30).
2. Send `CREATE_INTENT` with `deposit_timeout_sec: 500` (above 300).

**Expected outcome:**
- Both return `INVALID_PARAM` -- deposit_timeout_sec must be between 30 and 300.

**Category:** ACP Command Validation

---

## Category 11: Security Scenarios

### T11.1: swap:completed with payoutVerified=false must NOT update volume_filled (Section 7.9.2)

**Test name:** `CRITICAL: should NOT update volume_filled when payoutVerified is false`

**Preconditions:**
- Deal D1 in EXECUTING state. Agreed volume = 500.

**Steps:**
1. MockSwapModule emits `swap:completed` with `{ swapId: 'swap-001', payoutVerified: false }`.

**Expected outcome:**
- volume_filled is NOT updated (remains at previous value).
- Deal remains in EXECUTING state (not COMPLETED).
- Retry mechanism triggered: verifyPayout() called periodically (every 30s, max 10 retries).
- Reservation NOT released (deal still active).

**Category:** Security

---

### T11.2: payoutVerified=false followed by successful retry

**Test name:** `should complete deal after payoutVerified succeeds on retry`

**Preconditions:**
- Deal D1 in EXECUTING state. First swap:completed had payoutVerified=false.
- `vi.useFakeTimers()`.

**Steps:**
1. Receive swap:completed with payoutVerified=false.
2. verifyPayout() returns false on first 3 retries.
3. Advance time by 30s intervals.
4. verifyPayout() returns true on retry 4.

**Expected outcome:**
- Deal transitions to COMPLETED after successful verification.
- volume_filled updated.
- Reservation released.

**Category:** Security

---

### T11.3: payoutVerified=false exhausts all retries

**Test name:** `should escalate to owner and FAIL deal after max payout verification retries`

**Preconditions:**
- Deal D1 in EXECUTING state.
- `vi.useFakeTimers()`.

**Steps:**
1. Receive swap:completed with payoutVerified=false.
2. verifyPayout() returns false on all 10 retries.
3. Advance time by 300+ seconds.

**Expected outcome:**
- Deal transitions to FAILED after 10th retry fails.
- ACP status message sent to owner about payout verification failure.
- volume_filled NOT updated.
- Reservation released.

**Category:** Security

---

### T11.4: Counterparty proposes SwapDeal with different terms than NP-0 (Section 7.9.4)

**Test name:** `CRITICAL: should reject swap proposal with terms diverging from NP-0 agreement`

**Preconditions:**
- Deal D1 agreed via NP-0: rate=475, volume=300, base_asset='ALPHA', quote_asset='USDC'.
- Counterparty is the acceptor.

**Steps:**
1. Trader receives `swap:proposal_received` event.
2. SwapDeal in the event has `partyAAmount: '500'` (instead of expected '300').
3. SwapExecutor compares received SwapDeal fields against stored DealTerms.

**Expected outcome:**
- SwapExecutor detects term mismatch: partyAAmount '500' != expected '300'.
- Swap rejected via rejectSwap().
- Deal transitions to FAILED with reason indicating term mismatch.
- Security event logged.
- Volume reservation released.

**Category:** Security

---

### T11.5: Reject v1 protocol proposal (Section 7.9.5)

**Test name:** `CRITICAL: should reject swap proposal with protocolVersion !== 2`

**Preconditions:**
- Deal in ACCEPTED state. Awaiting swap execution.

**Steps:**
1. Trader receives `swap:proposal_received` with `protocolVersion: 1`.

**Expected outcome:**
- SwapExecutor checks protocolVersion.
- Calls rejectSwap() for the v1 proposal.
- Deal transitions to FAILED.
- Security warning logged: v1 protocol lacks mutual consent and is vulnerable to MITM.

**Category:** Security

---

### T11.6: Concurrent reserve() calls (no over-commitment) (Section 7.9.6)

**Test name:** `CRITICAL: should prevent over-commitment when concurrent matches try to reserve simultaneously`

**Preconditions:**
- Balance: 1000 ALPHA. No reservations.
- Two match evaluations run concurrently, each trying to reserve 800.

**Steps:**
1. Concurrently call `reserve('ALPHA', 800n, 'deal-A')` and `reserve('ALPHA', 800n, 'deal-B')`.

**Expected outcome:**
- Exactly one succeeds (returns true), one fails (returns false).
- Total reserved <= 1000.
- Async mutex ensures serialization.
- `sum(reservations['ALPHA']) <= PaymentsModule.getBalance('ALPHA')`.

**Category:** Security

---

### T11.7: SIGTERM during active swap triggers graceful shutdown (Section 7.9.8)

**Test name:** `should persist all state on SIGTERM during active swap`

**Preconditions:**
- Deal D1 in EXECUTING state. Intent I1 in NEGOTIATING state. Reservation active.
- MockFilesystem for persistence.

**Steps:**
1. Send `hm.stop` to container (which sends SHUTDOWN_GRACEFUL ACP command, then SIGTERM).
2. Agent processes shutdown: persists TraderStateStore, VolumeReservationLedger.

**Expected outcome:**
- All state persisted to `/data/wallet/trader/`.
- Deals, intents, strategy, reservations written atomically.
- On restart, all state recovered.
- SwapModule.load() recovers in-flight swap.

**Category:** Security

---

### T11.8: NP-0 message replay detection

**Test name:** `should reject replayed NP-0 message with duplicate msg_id`

**Preconditions:**
- Agent maintains deduplication window of 600s / 10000 entries.
- Previous message received with `msg_id: 'uuid-1'`.

**Steps:**
1. Resend identical NP-0 message with same `msg_id: 'uuid-1'`.

**Expected outcome:**
- Second message rejected as duplicate.
- No state change.
- Replay attempt logged.

**Category:** Security

---

### T11.9: NP-0 message with stale timestamp (clock skew > 300s)

**Test name:** `should reject NP-0 message with ts_ms older than 300s`

**Preconditions:**
- Current time = T.

**Steps:**
1. Receive NP-0 message with `ts_ms = T - 301000` (301 seconds old).

**Expected outcome:**
- Message rejected due to clock skew tolerance exceeded (300s / 300000ms).
- No state change.

**Category:** Security

---

### T11.10: Intent signature verification on search results

**Test name:** `should verify ECDSA signature on discovered intents before matching`

**Preconditions:**
- Search result contains intent with valid fields but corrupted signature.

**Steps:**
1. IntentEngine parses search result.
2. Recomputes intent_id from canonical JSON of extracted fields.
3. Verifies ECDSA signature against agentPublicKey.
4. Signature verification fails.

**Expected outcome:**
- Intent discarded from match candidates.
- Warning logged: signature verification failed.
- No negotiation initiated.

**Category:** Security

---

### T11.11: Deposit idempotency check on crash recovery (Section 7.9.3)

**Test name:** `should check escrow status before re-depositing on crash recovery`

**Preconditions:**
- Deal D1 in EXECUTING state. `deposit_attempted: true` persisted. `localDepositTransferId` missing.

**Steps:**
1. Agent restarts. SwapModule.load() recovers swap.
2. Agent checks `deposit_attempted` flag.
3. Queries escrow via `getSwapStatus({ queryEscrow: true })`.
4. Escrow confirms deposit was received.

**Expected outcome:**
- Agent does NOT re-deposit (avoids double payment).
- Swap continues from post-deposit state.
- If escrow confirms NOT received, then re-deposit proceeds.

**Category:** Security

---

## Category 12: MarketModule Integration

### T12.1: postIntent() failure (API down)

**Test name:** `should keep intent in DRAFT state when MarketModule.postIntent() fails`

**Preconditions:**
- MockMarketModule.postIntent() rejects with network error.

**Steps:**
1. Send `CREATE_INTENT` command.

**Expected outcome:**
- `acp.error` returned to owner with appropriate error.
- Intent not persisted as ACTIVE (stays in DRAFT or discarded).
- No market_intent_id assigned.

**Category:** MarketModule Integration

---

### T12.2: search() returns no results

**Test name:** `should handle empty search results gracefully`

**Preconditions:**
- Active intent exists. MockMarketModule.search() returns empty array.

**Steps:**
1. IntentEngine scan loop fires.
2. search() returns `[]`.

**Expected outcome:**
- No match initiated.
- Intent remains ACTIVE.
- No errors logged (empty results are normal).

**Category:** MarketModule Integration

---

### T12.3: search() results with score below minScore filtered

**Test name:** `should filter search results below min_search_score threshold`

**Preconditions:**
- Strategy: `min_search_score: 0.7`.
- search() returns results with scores: [0.9, 0.75, 0.65, 0.5].

**Steps:**
1. IntentEngine processes results.

**Expected outcome:**
- Only results with score >= 0.7 considered: [0.9, 0.75].
- Results with score 0.65 and 0.5 filtered out.
- Note: minScore is passed to search() as server-side filter, but client-side re-check is a defense-in-depth measure.

**Category:** MarketModule Integration

---

### T12.4: subscribeFeed() disconnects then falls back to periodic search()

**Test name:** `should fall back to periodic search() when WebSocket feed disconnects`

**Preconditions:**
- subscribeFeed() initially connected.

**Steps:**
1. subscribeFeed() onError callback fires (WebSocket disconnection).
2. IntentEngine continues to run periodic search() scan loop.

**Expected outcome:**
- Feed disconnection logged as warning.
- Periodic search() continues at configured interval (5s).
- Matching still works via search()-based discovery.
- Feed reconnection attempted (if supported by SDK).

**Category:** MarketModule Integration

---

### T12.5: closeIntent() failure

**Test name:** `should log warning but not crash when MarketModule.closeIntent() fails`

**Preconditions:**
- Intent fully filled, needs to be closed.
- MockMarketModule.closeIntent() rejects.

**Steps:**
1. Intent transitions to FILLED.
2. closeIntent() called but fails.

**Expected outcome:**
- Warning logged about closeIntent() failure.
- Intent state still transitions to FILLED locally.
- Agent does not crash.
- Stale intent may remain in search index (acceptable: it will expire server-side).

**Category:** MarketModule Integration

---

### T12.6: getMyIntents() on startup reconciles local state

**Test name:** `should reconcile local intent state against MarketModule on startup`

**Preconditions:**
- Local state has 3 intents: I1 (ACTIVE), I2 (ACTIVE), I3 (PARTIALLY_FILLED).
- MockMarketModule.getMyIntents() returns only I1 and I3 (I2 was closed server-side).

**Steps:**
1. Agent starts up. TraderStateStore loaded.
2. getMyIntents() called for reconciliation.

**Expected outcome:**
- I1: remains ACTIVE (present in both local and server).
- I2: transitions to CANCELLED or EXPIRED (present locally but not on server -- was closed externally).
- I3: remains PARTIALLY_FILLED (present in both).
- Reconciliation logged.

**Category:** MarketModule Integration

---

## Category 13: Multi-Agent Scenarios

### T13.1: Two trader agents discover each other and complete a swap

**Test name:** `should complete full trading flow between two trader agents`

**Preconditions:**
- Trader A spawned with 1000 ALPHA. Posts sell intent: ALPHA/USDC, rate 450-500, volume 500.
- Trader B spawned with 250000 USDC. Posts buy intent: ALPHA/USDC, rate 460-490, volume 300.
- Both connected to same MockMarketModule and MockSphereNetwork.

**Steps:**
1. A's scan discovers B's buy intent. Match found.
2. A (lower pubkey) proposes deal: rate=475, volume=300.
3. B receives proposal, validates, sends accept.
4. A pings escrow (success), proposes swap.
5. B receives swap proposal, validates terms match NP-0, accepts.
6. Both deposit to escrow.
7. Escrow confirms, releases tokens.
8. swap:completed emitted to both.

**Expected outcome:**
- Both deals in COMPLETED state.
- A: volume_filled=300, intent PARTIALLY_FILLED (had 500 offered).
- B: volume_filled=300, intent FILLED (had 300 offered).
- Reservations released on both sides.
- B's intent closed on MarketModule (fully filled).
- A's intent re-posted with remaining 200.

**Category:** Multi-Agent

---

### T13.2: Three agents, two match same counterparty (deterministic selection)

**Test name:** `should allow only one of two competing agents to propose against same intent`

**Preconditions:**
- Trader A posts sell intent.
- Trader B and Trader C both discover A's intent simultaneously.
- PK_B < PK_C (B has lower pubkey).

**Steps:**
1. B evaluates match with A: B's pubkey < A's pubkey? Determines proposer role.
2. C evaluates match with A: C's pubkey vs A's pubkey.
3. Both attempt to initiate negotiation with A.

**Expected outcome:**
- Whichever agent has lower pubkey than A becomes proposer.
- If both B and C propose, A will accept the first and reject the second with AGENT_BUSY.
- Only one deal proceeds to completion for intent A.
- The rejected agent releases its reservation and can try matching again.

**Category:** Multi-Agent

---

### T13.3: Simultaneous complementary intents

**Test name:** `should resolve race when A and B post complementary intents simultaneously`

**Preconditions:**
- Trader A posts sell ALPHA/USDC at same time Trader B posts buy ALPHA/USDC.
- Both agents' scan loops detect the other's intent.

**Steps:**
1. Both IntentEngines find a match in the same scan cycle.
2. Proposer selection: agent with lower pubkey proposes.
3. Higher-pubkey agent waits for incoming proposal.

**Expected outcome:**
- Exactly one np.propose_deal sent (from lower pubkey agent).
- Higher pubkey agent receives and processes the proposal.
- Normal negotiation and swap flow follows.
- No duplicate deals created.

**Category:** Multi-Agent

---

### T13.4: Agent cannot trade with itself (same pubkey filtered)

**Test name:** `should prevent agent from matching its own intents (same pubkey)`

**Preconditions:**
- Trader A has both a buy and sell intent for ALPHA/USDC with overlapping rates.
- Both intents discoverable via search().

**Steps:**
1. IntentEngine scans for matches.
2. search() returns A's own sell intent when scanning for A's buy intent matches.

**Expected outcome:**
- Criterion 8 (different agents) filters out the result.
- `agent_pubkey === own_pubkey` -> skip.
- No self-negotiation attempted.

**Category:** Multi-Agent

---

## Category 14: Edge Cases

### TA.1: CREATE_INTENT for buy intent does not check sell-side balance

**Test name:** `should not require base_asset balance for buy intents`

**Preconditions:**
- Balance: 50000 USDC, 0 ALPHA.

**Steps:**
1. Send `CREATE_INTENT` with `direction: 'buy', base_asset: 'ALPHA', quote_asset: 'USDC', volume_max: 100, rate_max: 500`.

**Expected outcome:**
- Intent created successfully. Buy intents require quote_asset balance (USDC), not base_asset.
- Agent needs USDC to pay, not ALPHA.
- Balance check: 100 * 500 = 50000 USDC needed. Balance is 50000. Passes.

**Category:** Edge Case

---

### TA.2: NP-0 message with NaN or Infinity in numeric fields

**Test name:** `should reject NP-0 message with non-finite numeric values`

**Preconditions:**
- Deal in negotiation.

**Steps:**
1. Receive np.propose_deal with `terms.rate: NaN`.
2. Receive np.propose_deal with `terms.volume: Infinity`.

**Expected outcome:**
- Both rejected during DealTerms validation (rate and volume must be positive finite).

**Category:** Edge Case

---

### TA.3: Intent with volume_min === volume_max (exact amount only)

**Test name:** `should support intents where volume_min equals volume_max`

**Preconditions:**
- Trader agent spawned.

**Steps:**
1. Send `CREATE_INTENT` with `volume_min: 500, volume_max: 500`.

**Expected outcome:**
- Intent created. Only exact 500-unit fills accepted.
- Partial fills below 500 would fail criterion 4.

**Category:** Edge Case

---

### TA.4: Rapid intent create/cancel/create cycle

**Test name:** `should handle rapid intent lifecycle transitions without state corruption`

**Preconditions:**
- Trader agent spawned.

**Steps:**
1. CREATE_INTENT -> get intent_id I1.
2. CANCEL_INTENT I1.
3. CREATE_INTENT (same params) -> get intent_id I2.
4. LIST_INTENTS.

**Expected outcome:**
- I1 in CANCELLED state.
- I2 in ACTIVE state with different intent_id (different salt).
- Two intents in list.
- MarketModule: postIntent called twice, closeIntent called once.

**Category:** Edge Case

---

### TA.5: LIST_INTENTS and LIST_SWAPS pagination boundary

**Test name:** `should respect limit and offset pagination boundaries`

**Preconditions:**
- 5 intents created.

**Steps:**
1. `LIST_INTENTS { limit: 3, offset: 0 }` -> 3 results, total: 5.
2. `LIST_INTENTS { limit: 3, offset: 3 }` -> 2 results, total: 5.
3. `LIST_INTENTS { limit: 3, offset: 5 }` -> 0 results, total: 5.
4. `LIST_INTENTS { limit: 201 }` -> error (max 200).

**Expected outcome:**
- Pagination works correctly.
- Offset beyond total returns empty array.
- Limit > 200 returns INVALID_PARAM.

**Category:** Edge Case

---

### TA.6: Escrow address validation

**Test name:** `should validate escrow_address as 'any' or valid secp256k1 compressed pubkey`

**Preconditions:**
- Trader agent spawned.

**Steps:**
1. `CREATE_INTENT` with `escrow_address: 'any'` -> success.
2. `CREATE_INTENT` with `escrow_address: '02' + 'a'.repeat(64)` -> success (valid format).
3. `CREATE_INTENT` with `escrow_address: 'invalid'` -> error.
4. `CREATE_INTENT` with `escrow_address: '04' + 'a'.repeat(128)` -> error (uncompressed not accepted).

**Expected outcome:**
- Cases 1-2 succeed.
- Cases 3-4 return INVALID_PARAM.

**Category:** Edge Case

---

### TA.7: Blocked counterparty filtering

**Test name:** `should filter out intents from blocked counterparties during matching`

**Preconditions:**
- Strategy: `blocked_counterparties: [PK_BLOCKED]`.
- search() returns intent from PK_BLOCKED agent.

**Steps:**
1. IntentEngine processes search results.

**Expected outcome:**
- Intent from PK_BLOCKED filtered out.
- No match initiated with blocked counterparty.

**Category:** Edge Case

---

### TA.8: Trusted escrow filtering during matching

**Test name:** `should reject matches proposing untrusted escrow when trusted_escrows is configured`

**Preconditions:**
- Strategy: `trusted_escrows: [ESCROW_PK_1]`.
- Counterparty intent has `escrow_address: ESCROW_PK_2` (not in trusted list).

**Steps:**
1. Evaluate match. Escrow compatibility check.

**Expected outcome:**
- Match fails escrow compatibility (criterion 7 extended by strategy).
- If counterparty says "any" and we have trusted_escrows, we use our preferred escrow.
- If counterparty specifies an untrusted escrow, match is rejected.

**Category:** Edge Case

---

### TA.9: Intent expiry during active negotiation

**Test name:** `should handle intent expiring while deal is in progress`

**Preconditions:**
- Intent I1 with expiry_ms approaching. Deal D1 in PROPOSED state.
- `vi.useFakeTimers()`.

**Steps:**
1. Advance time past expiry_ms.
2. Expiry sweep runs.

**Expected outcome:**
- If deal is in non-terminal state, intent should not transition to EXPIRED mid-deal.
- The deal's own timeouts handle cancellation.
- Intent transitions to EXPIRED only after deal reaches terminal state (or EXPIRED takes priority per implementation).
- Implementation note: verify which takes precedence -- deal timeout or intent expiry.

**Category:** Edge Case

---

### TA.10: Description parsing of non-standard format

**Test name:** `should skip intents with unparseable description format`

**Preconditions:**
- search() returns result with description: "Random text that does not match canonical format".

**Steps:**
1. IntentEngine attempts to parse description.
2. Parser fails to extract rate/volume/escrow fields.

**Expected outcome:**
- Result skipped (per spec: "Unrecognized description formats SHOULD be skipped").
- No error thrown.
- Matching continues with remaining results.

**Category:** Edge Case

---

## Category 15: Adversarial Counterparty Attacks

### T15.1: Forged NP-0 signature from known counterparty

**Test name:** `should reject NP-0 message with forged ECDSA signature even when sender_pubkey is valid participant`

**Preconditions:**
- Deal in PROPOSED state between PK_A (proposer) and PK_B (acceptor).
- Attacker has PK_B's pubkey but not private key.

**Steps:**
1. Construct `np.accept_deal` with correct `sender_pubkey: PK_B` and valid `deal_id`, but sign with a different private key (forged signature).
2. Deliver message to Trader A.

**Expected outcome:**
- ECDSA signature verification fails against PK_B.
- Message rejected silently (logged as warning).
- Deal state remains PROPOSED.
- No state transition occurs.

**Category:** Adversarial Counterparty

**Note:** Extends T4.4 (which tests corrupted signatures). This test specifically validates that a valid participant pubkey with a forged signature is caught.

---

### T15.2: NP-0 messages after deal reaches terminal state

**Test name:** `should ignore NP-0 messages referencing a deal in terminal state`

**Preconditions:**
- Deal D1 between PK_A and PK_B completed (state COMPLETED).
- Valid signatures from PK_B.

**Steps:**
1. Send `np.accept_deal` with `deal_id = D1.deal_id` and valid signature.
2. Send `np.reject_deal` with `deal_id = D1.deal_id` and valid signature.
3. Send `np.propose_deal` with `deal_id = D1.deal_id` and valid signature.

**Expected outcome:**
- All three messages ignored.
- Deal state remains COMPLETED.
- Warning logged: "NP-0 message for terminal deal".
- No volume reservation changes.

**Category:** Adversarial Counterparty

---

### T15.3: Proposal flood to exhaust max_concurrent_swaps

**Test name:** `should reject proposals beyond max_concurrent_swaps limit`

**Preconditions:**
- Strategy: `max_concurrent_swaps: 3`.
- Trader B has 5 active intents matching Trader A's intents.
- 3 deals already in non-terminal state (PROPOSED, ACCEPTED, or EXECUTING).

**Steps:**
1. Trader C sends `np.propose_deal` for Trader A's 4th intent.
2. Trader D sends `np.propose_deal` for Trader A's 5th intent.

**Expected outcome:**
- Both proposals rejected with `reason_code: 'AGENT_BUSY'`.
- No new deals created beyond the limit of 3.
- Existing deals unaffected.
- Rejection logged with rate-limit context.

**Category:** Adversarial Counterparty

---

### T15.4: Wrong currency deposit bounced by escrow

**Test name:** `should detect wrong currency in escrow deposit and fail deal`

**Preconditions:**
- Deal agreed: sell 300 ALPHA for USDC. Escrow expects ALPHA deposit from seller.
- MockSwapModule emits `swap:failed` with error indicating currency mismatch from escrow.

**Steps:**
1. SwapExecutor proceeds with deposit.
2. Escrow rejects deposit due to wrong currency.
3. `swap:failed` event emitted with error details.

**Expected outcome:**
- Deal transitions EXECUTING -> FAILED with reason indicating currency mismatch.
- Volume reservation released.
- Intent returns to ACTIVE.
- Error logged with currency details for debugging.

**Category:** Adversarial Counterparty

---

### T15.5: Forged announce_result from non-escrow sender

**Test name:** `should reject announce_result message from sender that is not the designated escrow`

**Preconditions:**
- Deal in EXECUTING state with `escrow_address: ESCROW_PK`.
- Attacker sends a fake `announce_result` from `PK_ATTACKER` (not ESCROW_PK).

**Steps:**
1. MockSwapModule receives announce_result from PK_ATTACKER.
2. SwapModule verifies sender matches expected escrow_address.

**Expected outcome:**
- Message rejected: sender is not the designated escrow.
- Deal state unchanged (remains EXECUTING).
- Security event logged: "announce_result from non-escrow sender".
- No payout processed.

**Category:** Adversarial Counterparty

---

### T15.6: Deposit invoice amount mismatch detected

**Test name:** `should detect and reject escrow deposit invoice with mismatched amount`

**Preconditions:**
- Deal agreed: sell 300 ALPHA at rate 475. Expected deposit: 300 ALPHA.
- Escrow returns invoice requesting 350 ALPHA (inflated amount).

**Steps:**
1. SwapExecutor receives deposit invoice from escrow.
2. Compares invoice amount against agreed DealTerms.

**Expected outcome:**
- Invoice amount 350 does not match expected 300.
- Deposit not initiated.
- Deal transitions to FAILED with reason: "deposit invoice amount mismatch".
- Volume reservation released.
- Security warning logged.

**Category:** Adversarial Counterparty

---

### T15.7: Escrow payout wrong currency caught by verifyPayout

**Test name:** `should catch escrow payout in wrong currency via verifyPayout()`

**Preconditions:**
- Deal completed: Trader A sold 300 ALPHA, expects USDC payout.
- MockSwapModule emits `swap:completed` with `payoutVerified: false`.
- verifyPayout() detects payout currency is ALPHA (not expected USDC).

**Steps:**
1. Receive `swap:completed` with `payoutVerified: false`.
2. verifyPayout() inspects payout transaction details.
3. Currency mismatch detected.

**Expected outcome:**
- volume_filled NOT updated.
- verifyPayout() retries fail (currency remains wrong).
- After max retries, deal transitions to FAILED.
- Owner notified via ACP status message about payout currency mismatch.
- Reservation released.

**Category:** Adversarial Counterparty

---

### T15.8: Escrow payout insufficient amount caught by verifyPayout

**Test name:** `should catch escrow payout with insufficient amount via verifyPayout()`

**Preconditions:**
- Deal completed: Trader A expects 142500 USDC (300 * 475). 
- MockSwapModule emits `swap:completed` with `payoutVerified: false`.
- verifyPayout() detects payout amount is only 100000 USDC (underpayment).

**Steps:**
1. Receive `swap:completed` with `payoutVerified: false`.
2. verifyPayout() inspects payout amount.
3. Amount insufficient: 100000 < expected 142500.

**Expected outcome:**
- volume_filled NOT updated.
- verifyPayout() retries fail (amount remains insufficient).
- After max retries, deal transitions to FAILED.
- Owner notified about payout amount discrepancy.
- Reservation released.

**Category:** Adversarial Counterparty

---

## Category 16: State Machine Violation Tests

### T16.1: FILLED to ACTIVE transition rejected

**Test name:** `should reject state transition from FILLED to ACTIVE`

**Preconditions:**
- Intent I1 in FILLED state (volume_filled === volume_max).

**Steps:**
1. Attempt to transition I1 from FILLED to ACTIVE (e.g., via internal state machine call or by receiving a match event for the filled intent).
2. Verify state machine guard rejects the transition.

**Expected outcome:**
- Transition rejected. Intent remains in FILLED state.
- Error logged: "invalid state transition FILLED -> ACTIVE".
- No volume reservation created.
- No market intent re-posted.

**Category:** State Machine Violation

---

### T16.2: CANCELLED to any transition rejected

**Test name:** `should reject all state transitions from CANCELLED state`

**Preconditions:**
- Intent I1 in CANCELLED state.

**Steps:**
1. Attempt transition CANCELLED -> ACTIVE (via re-activation).
2. Attempt transition CANCELLED -> MATCHING (via match event).
3. Attempt transition CANCELLED -> NEGOTIATING (via incoming proposal).
4. Attempt transition CANCELLED -> FILLED (via swap completion event).

**Expected outcome:**
- All four transitions rejected.
- Intent remains in CANCELLED state for each attempt.
- Error logged for each invalid transition attempt.
- No side effects (no reservations, no NP-0 messages, no MarketModule calls).

**Category:** State Machine Violation

---

### T16.3: Double completion of same deal prevented

**Test name:** `should prevent double completion of the same deal`

**Preconditions:**
- Deal D1 in EXECUTING state. Agreed volume = 300.
- Intent volume_filled = 200.

**Steps:**
1. MockSwapModule emits `swap:completed` with `payoutVerified: true` for D1.
2. Deal transitions to COMPLETED. volume_filled = 500.
3. MockSwapModule emits a second `swap:completed` with `payoutVerified: true` for same D1 (duplicate event).

**Expected outcome:**
- First completion processed normally: volume_filled = 500, deal COMPLETED.
- Second completion ignored: deal already in terminal state COMPLETED.
- volume_filled remains 500 (not 800).
- Warning logged: "duplicate swap:completed for terminal deal".

**Category:** State Machine Violation

---

### T16.4: Negotiation on expired intent rejected

**Test name:** `should reject incoming NP-0 proposal for an expired intent`

**Preconditions:**
- Intent I1 created with `expiry_sec: 60`. Intent has transitioned to EXPIRED.
- Trader B sends `np.propose_deal` referencing I1.

**Steps:**
1. Receive `np.propose_deal` with `acceptor_intent_id` matching I1.
2. Agent checks intent state.

**Expected outcome:**
- Proposal rejected with `np.reject_deal` and reason_code `OTHER` (or implementation-specific reason indicating intent expired).
- No deal created.
- No volume reserved.
- Rejection logged with context: "proposal for expired intent".

**Category:** State Machine Violation

---

## Category 17: Unicity SDK Integration

### T17.1: Balance change from external deposit during active reservation

**Test name:** `should correctly reflect external deposit in available balance while reservations are active`

**Preconditions:**
- Balance: 1000 ALPHA. Reservation: 600 for deal-1. Available: 400.
- External deposit of 500 ALPHA arrives (balance increases to 1500).

**Steps:**
1. MockPaymentsModule.getBalance('ALPHA') now returns 1500.
2. Check `getAvailable('ALPHA')`.
3. Attempt `reserve('ALPHA', 800n, 'deal-2')`.

**Expected outcome:**
- `getAvailable('ALPHA')` = 1500 - 600 = 900.
- New reservation of 800 succeeds (800 <= 900).
- Total reservations: 600 + 800 = 1400 <= 1500.
- No warning logged (balance increase is healthy).

**Category:** Unicity SDK Integration

**Note:** Extends T8.5 (which tests balance decrease). This tests the positive case of external deposits.

---

### T17.2: Token invalidated by L3 decreases available volume

**Test name:** `should decrease available volume when token is invalidated by L3 aggregator`

**Preconditions:**
- Balance: 1000 ALPHA (composed of 3 tokens: 400 + 300 + 300).
- L3 aggregator invalidates the 400 token (inclusion proof revoked).
- MockPaymentsModule.getBalance('ALPHA') drops to 600.

**Steps:**
1. Balance callback fires with new balance 600.
2. Existing reservation of 500 for deal-1.
3. Check `getAvailable('ALPHA')`.

**Expected outcome:**
- `getAvailable('ALPHA')` = 600 - 500 = 100.
- Warning logged: "balance decreased due to token invalidation".
- New reservations limited to 100 available.
- Existing deal-1 reservation remains (cannot retroactively cancel).

**Category:** Unicity SDK Integration

---

### T17.3: Token split succeeds during deposit and swap completes

**Test name:** `should complete swap when token split is required for deposit amount`

**Preconditions:**
- Trader A holds single 1000 ALPHA token. Deal requires deposit of 300 ALPHA.
- MockPaymentsModule.send() internally splits the 1000 token into 300 + 700.

**Steps:**
1. SwapExecutor initiates deposit of 300 ALPHA to escrow.
2. PaymentsModule performs token split via state-transition-sdk.
3. Split succeeds. 300 token deposited to escrow.
4. Swap completes normally.

**Expected outcome:**
- Token split transparent to SwapExecutor.
- Deposit succeeds with correct amount.
- swap:completed emitted with payoutVerified: true.
- Remaining balance: 700 ALPHA + payout.

**Category:** Unicity SDK Integration

---

### T17.4: Token split fails (aggregator unreachable) and swap times out

**Test name:** `should time out swap when token split fails due to unreachable aggregator`

**Preconditions:**
- Trader A holds single 1000 ALPHA token. Deal requires deposit of 300 ALPHA.
- MockPaymentsModule.send() fails because L3 aggregator is unreachable for split operation.
- `vi.useFakeTimers()`.

**Steps:**
1. SwapExecutor initiates deposit.
2. PaymentsModule.send() rejects with aggregator timeout error.
3. Advance time past deposit_timeout_sec.

**Expected outcome:**
- Deposit fails. swap:failed event emitted.
- Deal transitions EXECUTING -> FAILED.
- Volume reservation released.
- Intent returns to ACTIVE for re-matching.
- Error logged: "token split failed: aggregator unreachable".

**Category:** Unicity SDK Integration

---

### T17.5: Tokens in transferring status excluded from reservations

**Test name:** `should exclude tokens with 'transferring' status from available balance for reservations`

**Preconditions:**
- Balance: 1000 ALPHA total, but 300 ALPHA in 'transferring' status (pending L3 confirmation).
- MockPaymentsModule.getBalance('ALPHA') returns 700 (only confirmed tokens).

**Steps:**
1. Check `getAvailable('ALPHA')`.
2. Attempt `reserve('ALPHA', 800n, 'deal-1')`.

**Expected outcome:**
- `getAvailable('ALPHA')` = 700 (transferring tokens excluded by PaymentsModule).
- Reservation of 800 fails (800 > 700).
- Returns false.
- No over-commitment against unconfirmed tokens.

**Category:** Unicity SDK Integration

---

### T17.6: SwapModule.load() recovers orphaned swaps with stale state

**Test name:** `should recover orphaned swaps via SwapModule.load() and reconcile against escrow`

**Preconditions:**
- Deal D1 was in EXECUTING state when agent crashed.
- Swap swap-001 has no local completion event recorded.
- Escrow has already completed the swap (both parties deposited, payouts sent).

**Steps:**
1. Agent restarts. SwapModule.load() called.
2. MockSwapModule.load() restores swap-001 in 'pending' state.
3. Agent queries escrow status: escrow reports swap completed.
4. verifyPayout() confirms payout received.

**Expected outcome:**
- SwapModule.load() recovers the orphaned swap.
- Escrow query reveals completed status.
- verifyPayout() succeeds.
- Deal transitions to COMPLETED. volume_filled updated.
- Reservation released.

**Category:** Unicity SDK Integration

**Note:** Extends T9.3 (which tests basic load recovery). This tests recovery when escrow state has advanced beyond local state.

---

### T17.7: maxPendingSwaps limit reached rejects new proposals

**Test name:** `should reject new swap proposals when maxPendingSwaps limit is reached`

**Preconditions:**
- Strategy: `max_concurrent_swaps: 3`.
- 3 swaps currently in EXECUTING state.
- New match found with Trader B.

**Steps:**
1. IntentEngine detects match with Trader B.
2. Checks concurrent swap count: 3 === max_concurrent_swaps.
3. Match evaluation skipped.

**Expected outcome:**
- No `np.propose_deal` sent to Trader B.
- Match deferred until a current swap completes.
- Intent remains ACTIVE (not transitioned to MATCHING).
- Debug log: "max_concurrent_swaps reached, deferring match".

**Category:** Unicity SDK Integration

---

### T17.8: Nametag resolution failure causes swap proposal failure

**Test name:** `should fail swap proposal when nametag resolution fails for escrow address`

**Preconditions:**
- Deal agreed with `escrow_address` specified as a nametag (human-readable identifier).
- Nametag resolution via Nostr relay fails (relay unreachable or nametag not found).

**Steps:**
1. SwapExecutor attempts to resolve escrow nametag to secp256k1 pubkey.
2. Resolution fails with timeout or not-found error.
3. pingEscrow() cannot proceed without resolved address.

**Expected outcome:**
- Deal transitions ACCEPTED -> FAILED with reason: "escrow address resolution failed".
- Volume reservation released.
- Intent returns to ACTIVE.
- Error logged with nametag and resolution failure details.

**Category:** Unicity SDK Integration

---

### T17.9: Consent signature verification on acceptor side

**Test name:** `should verify consent signature in swap proposal matches NP-0 agreed terms`

**Preconditions:**
- Deal D1 agreed via NP-0 between PK_A (proposer) and PK_B (acceptor).
- PK_A sends swap proposal via SwapModule with consent signature.

**Steps:**
1. PK_B receives `swap:proposal_received` event.
2. SwapExecutor extracts consent signature from SwapDeal.
3. Verifies signature covers the canonical DealTerms (rate, volume, escrow, parties).
4. Signature is valid and matches PK_A.

**Expected outcome:**
- Consent signature verified successfully.
- Swap accepted (acceptSwap() called).
- Deal proceeds to deposit phase.

**Category:** Unicity SDK Integration

---

### T17.10: Consent signature verification fails on acceptor side

**Test name:** `should reject swap proposal when consent signature verification fails`

**Preconditions:**
- Deal D1 agreed via NP-0. PK_A sends swap proposal with invalid consent signature.

**Steps:**
1. PK_B receives `swap:proposal_received` event.
2. SwapExecutor verifies consent signature.
3. Signature does not match expected DealTerms or PK_A pubkey.

**Expected outcome:**
- Consent signature verification fails.
- Swap rejected via rejectSwap().
- Deal transitions to FAILED with reason: "consent signature verification failed".
- Security event logged.
- Volume reservation released.

**Category:** Unicity SDK Integration

---

### T17.11: L2 BFT consensus delay does not cause false timeout

**Test name:** `should not falsely time out swap when L2 BFT consensus is delayed`

**Preconditions:**
- Deal in EXECUTING state. Deposit sent.
- L2 BFT consensus delayed (block confirmation takes longer than usual but within tolerance).
- `vi.useFakeTimers()`.
- deposit_timeout_sec = 300.

**Steps:**
1. Deposit transaction submitted.
2. L2 consensus delayed by 60 seconds (normal round is ~1 second).
3. Advance time by 60 seconds.
4. Consensus completes. Deposit confirmed.
5. Swap proceeds normally.

**Expected outcome:**
- Swap NOT timed out (60s delay is well within 300s deposit_timeout_sec).
- Deposit confirmed after consensus delay.
- swap:completed emitted normally.
- No false failure due to consensus latency.

**Category:** Unicity SDK Integration

---

### T17.12: Stale L3 inclusion proof triggers retry verification

**Test name:** `should retry payout verification when L3 inclusion proof is stale`

**Preconditions:**
- Deal completed. verifyPayout() called.
- First verification attempt returns stale inclusion proof (proof references old SMT root).
- `vi.useFakeTimers()`.

**Steps:**
1. verifyPayout() called. Returns false due to stale proof.
2. Advance time by 30 seconds.
3. verifyPayout() called again. L3 aggregator returns fresh inclusion proof.
4. Verification succeeds.

**Expected outcome:**
- First attempt: payoutVerified = false (stale proof).
- Second attempt: payoutVerified = true (fresh proof).
- Deal transitions to COMPLETED.
- volume_filled updated.
- Retry mechanism handles transient L3 staleness gracefully.

**Category:** Unicity SDK Integration

---

### T17.13: Agent pubkey matches posted intent contactHandle

**Test name:** `should ensure agent pubkey matches contactHandle in posted market intent`

**Preconditions:**
- Trader agent spawned with known pubkey PK_AGENT.

**Steps:**
1. Send `CREATE_INTENT` with valid params.
2. Inspect MockMarketModule.postIntent() call arguments.

**Expected outcome:**
- `contactHandle` in postIntent() call matches PK_AGENT's Sphere address.
- Counterparties can reach the agent via the contactHandle.
- contactHandle is deterministically derived from the agent's secp256k1 identity.

**Category:** Unicity SDK Integration

---

### T17.14: HD-derived address consistency in intents

**Test name:** `should produce consistent HD-derived addresses across agent restarts`

**Preconditions:**
- Agent uses BIP-32 HD key derivation from stored mnemonic.
- Agent restarted with same mnemonic.

**Steps:**
1. Record agent pubkey and Sphere address before restart.
2. Stop and restart agent (same wallet, same mnemonic).
3. Create a new intent.
4. Inspect contactHandle in postIntent() call.

**Expected outcome:**
- Agent pubkey after restart matches pre-restart pubkey.
- contactHandle in postIntent() matches pre-restart contactHandle.
- HD derivation path produces deterministic results from same seed.
- Existing counterparty connections remain valid.

**Category:** Unicity SDK Integration

---

## Category 18: Semantic Search Verification

### T18.1: Canonical description round-trips correctly

**Test name:** `should produce and parse canonical description format without data loss`

**Preconditions:**
- Intent params: direction='sell', base_asset='ALPHA', quote_asset='USDC', rate_min=450, rate_max=500, volume_min=100, volume_max=1000, escrow_address='any', deposit_timeout_sec=300.

**Steps:**
1. Generate canonical description from intent params.
2. Parse the generated description back into structured fields.
3. Compare parsed fields against original params.

**Expected outcome:**
- Generated description: `"Selling 100-1000 ALPHA for USDC. Rate: 450-500 USDC per ALPHA. Escrow: any. Deposit timeout: 300s."`.
- Parsed fields match originals: direction='sell', volumes=[100,1000], assets=['ALPHA','USDC'], rates=[450,500], escrow='any', timeout=300.
- No data lost in round-trip.

**Category:** Semantic Search Verification

---

### T18.2: Semantic search matches meaning not exact keywords

**Test name:** `should match intents via semantic meaning rather than exact keyword matching`

**Preconditions:**
- Posted intent description: `"Selling 100-1000 ALPHA for USDC. Rate: 450-500 USDC per ALPHA."`.
- Search query: `"buying ALPHA tokens with USDC stablecoin"` (different wording, same semantic meaning).

**Steps:**
1. MockMarketModule.search() called with semantic query derived from buy intent.
2. Search engine matches by meaning (opposite direction, same asset pair).

**Expected outcome:**
- Search returns the posted sell intent as a match.
- Score >= min_search_score threshold.
- Client-side matching validates the result (opposite direction, overlapping rates).
- Semantic matching enables discovery even when exact description format differs.

**Category:** Semantic Search Verification

---

### T18.3: search() results with own pubkey filtered out

**Test name:** `should filter out search results where agentPublicKey matches own pubkey`

**Preconditions:**
- Trader A has pubkey PK_A.
- MockMarketModule.search() returns 3 results: one from PK_A (own intent), one from PK_B, one from PK_C.

**Steps:**
1. IntentEngine processes search results.
2. Filters applied including self-match prevention.

**Expected outcome:**
- Result from PK_A filtered out (criterion 8: different agents).
- Only results from PK_B and PK_C considered for matching.
- No self-negotiation attempted.

**Category:** Semantic Search Verification

**Note:** Extends T2.7 (self-matching prevention). This test validates the filtering at the search result level specifically.

---

### T18.4: subscribeFeed() reconnection after disconnect

**Test name:** `should reconnect subscribeFeed() after WebSocket disconnection`

**Preconditions:**
- subscribeFeed() initially connected and receiving feed events.
- `vi.useFakeTimers()`.

**Steps:**
1. subscribeFeed() onError callback fires (WebSocket disconnection).
2. Reconnection timer starts.
3. Advance time by reconnection interval.
4. subscribeFeed() re-invoked.
5. New feed event arrives on reconnected subscription.

**Expected outcome:**
- Disconnection detected and logged as warning.
- Automatic reconnection attempted after backoff interval.
- New subscription established successfully.
- Feed events resume on reconnected subscription.
- Periodic search() continues as fallback during disconnection gap.

**Category:** Semantic Search Verification

**Note:** Extends T12.4 (which tests fallback to periodic search). This test validates the reconnection behavior.

---

### T18.5: Stale search result gracefully rejected during negotiation

**Test name:** `should gracefully handle stale search result where counterparty intent no longer exists`

**Preconditions:**
- search() returned a result from Trader B 5 seconds ago.
- Trader B has since cancelled their intent.
- Trader A initiates negotiation based on stale result.

**Steps:**
1. Trader A sends `np.propose_deal` to Trader B.
2. Trader B receives proposal but intent is CANCELLED.
3. Trader B sends `np.reject_deal` with reason_code `OTHER` or does not respond (timeout).

**Expected outcome:**
- If Trader B responds with rejection: deal transitions to CANCELLED, volume released, intent returns to ACTIVE.
- If Trader B does not respond (offline/cancelled): 30s proposal timeout fires, deal cancelled, volume released.
- No crash or unhandled error from stale data.
- Intent returns to ACTIVE for re-matching with fresh search results.

**Category:** Semantic Search Verification

---

## Test Count Summary

| Category | Count |
|---|---|
| 1. Intent Lifecycle (Happy Path) | 7 |
| 2. Intent Matching | 9 |
| 3. NP-0 Negotiation (Happy Path) | 3 |
| 4. NP-0 Negotiation (Unhappy Path) | 10 |
| 5. Swap Execution (Happy Path) | 6 |
| 6. Swap Execution (Unhappy Path) | 8 |
| 7. Partial Fill Scenarios | 4 |
| 8. Volume Reservation | 5 |
| 9. State Persistence | 5 |
| 10. ACP Command Validation | 18 |
| 11. Security Scenarios | 11 |
| 12. MarketModule Integration | 6 |
| 13. Multi-Agent Scenarios | 4 |
| Appendix: Edge Cases | 10 |
| 15. Adversarial Counterparty Attacks | 8 |
| 16. State Machine Violation Tests | 4 |
| 17. Unicity SDK Integration | 14 |
| 18. Semantic Search Verification | 5 |
| **Total** | **137** |
