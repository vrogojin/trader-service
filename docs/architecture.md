# Trader Agent Architecture

**Version:** 0.1 (Draft)
**Date:** 2026-04-03
**Status:** Proposed
**Related:** [Trader Agent Protocol Spec](protocols/trader-agent-protocol-spec.md)

---

## 1. System Overview

```
Owner (human / controller)
    |  HMCP-0: hm.spawn, hm.command (CREATE_INTENT, SET_STRATEGY, ...)
    v
Host Manager Agent
    |  Docker API (local socket)
    |  ACP-0: acp.command relay
    v
+================================================================+
|  Trader Container (Docker)                                     |
|                                                                |
|  +------------------+     +---------------+                    |
|  | ACP Listener     |---->| Trader        |                    |
|  | (PID 1)          |     | CommandHandler|                    |
|  +------------------+     +-------+-------+                    |
|                                   |                            |
|          +------------------------+------------------------+   |
|          |              |              |            |       |   |
|          v              v              v            v       |   |
|  +-------------+ +-------------+ +-----------+ +--------+  |  |
|  | Intent      | | Negotiation | | Swap      | |Volume  |  |  |
|  | Engine      | | Handler     | | Executor  | |Ledger  |  |  |
|  +------+------+ +------+------+ +-----+-----+ +---+----+  |  |
|         |               |              |            |       |   |
|         v               |              v            v       |   |
|  +-------------+        |        +-----------+ +--------+  |   |
|  | Trader      |<-------+------->| Sphere SDK| | /data/ |  |   |
|  | State Store |                 | Payments  | | tokens |  |   |
|  |             |                 | Swap/Mkt. | |        |  |   |
|  +-------------+                 +-----------+ +--------+  |   |
+================================================================+
    |                 |                    |
    v                 v                    v
Market API       Other Trader        Escrow Service
(Qdrant +        Agents (NIP-17 DMs) (SwapModule)
 embeddings)
```

**Key actors:**

- **Owner** sends ACP commands (CREATE_INTENT, CANCEL_INTENT, etc.) through
  the Host Manager, which relays them to the container via ACP-0.
- **Other Trader Agents** interact via TIP-0 (MarketModule API for intent
  publication and discovery) and NP-0 (NIP-17 encrypted DMs) for deal
  negotiation.
- **Market API** is the Sphere SDK MarketModule's centralized intent
  database, backed by Qdrant vector DB with OpenAI embeddings for
  semantic search.
- **Escrow Service** is the Sphere SDK SwapModule's escrow mechanism,
  holding tokens in transit during atomic swaps.

---

## 2. Component Breakdown

### TraderCommandHandler

Wraps the base ACP `CommandHandler` to intercept trader-specific commands
(CREATE_INTENT, SET_STRATEGY, GET_PORTFOLIO, etc.) while delegating standard
ACP commands (acp.ping, acp.heartbeat) to the base handler. Each command is
validated, dispatched to the appropriate subsystem, and the result or error
is returned as an `acp.result` or `acp.error` message. The handler enforces
that only the owner (verified via the manager pubkey chain) can issue
commands.

**Implementation prerequisite:** The current `AcpListener` creates its own
`CommandHandler` internally. To support the trader template,
`AcpListenerDeps` must be extended with an optional
`commandHandlerFactory` parameter. When provided, the listener uses it
instead of the default `createCommandHandler()`. This is a one-line change
to the existing codebase -- adding `commandHandlerFactory?:
(deps: CommandHandlerDeps) => CommandHandler` to the `AcpListenerDeps`
interface and using it in the constructor when present.

### IntentEngine

Manages the full intent lifecycle: creation, validation, signing,
publication via `MarketModule.postIntent()`, and local storage. Runs a
background scan loop (default: every 5 seconds) that calls
`MarketModule.search()` with semantic queries derived from each ACTIVE
and PARTIALLY_FILLED intent, then applies client-side matching rules from
the protocol spec (opposite direction, overlapping rates, compatible
escrow, sufficient volume) to validate candidates. Additionally subscribes
to `MarketModule.subscribeFeed()` for real-time new intent notifications
(the feed callback receives `FeedMessage` with `FeedListing` objects; after
receiving a feed event, the engine calls `search()` to get full intent
details for matching). As a REST fallback when the WebSocket feed is
unavailable, `MarketModule.getRecentListings()` can be used. When a match
is found, the engine reserves the relevant volume via the
VolumeReservationLedger and hands off to NegotiationHandler.

### NegotiationHandler

Conducts peer-to-peer deal negotiation over NIP-17 DMs using the NP-0
protocol (3 message types: `np.propose_deal`, `np.accept_deal`,
`np.reject_deal`). Manages the negotiation portion of the deal state
machine (PROPOSED -> ACCEPTED) and enforces timeouts at each stage (30s
for proposal response, 60s for acceptance). When the deal is accepted,
it hands off to SwapExecutor for escrow verification and execution. The
NegotiationHandler does NOT manage swap execution -- no NP-0 messages
are exchanged during the EXECUTING state. If negotiation fails at any
point, it releases reserved volume via the VolumeReservationLedger.

### SwapExecutor

Wraps `SwapModule.proposeSwap()` / `SwapModule.acceptSwap()` and
subscribes to swap events. Before initiating a swap, calls
`swapModule.pingEscrow(escrowAddress, 10000)` to verify the escrow is
responsive; if the ping fails, the deal transitions to FAILED with reason
`ESCROW_UNREACHABLE`. On `swap:proposal_received`, matches against pending
deals and auto-accepts if terms match. On `swap:completed`, `swap:failed`,
or `swap:cancelled`, updates the deal and intent state accordingly.

No custom crash recovery is needed. On startup, the trader agent calls
`SwapModule.load()` which restores all in-flight swaps from persistent
storage, re-announces to escrow for pending swaps, and resumes event
monitoring. The SwapModule manages its own persistence via
`StorageProvider`.

### VolumeReservationLedger

A thin bookkeeping layer (`Map<string, bigint>`) that tracks how much of
each asset is committed to active deals and swaps that have not yet
deposited to escrow. This prevents the agent from over-committing volume
across concurrent negotiations -- for example, promising 100 ALPHA to
two different counterparties when only 100 ALPHA is available.

All balance queries, token inventory, send/receive, split/join, and
double-spend prevention are delegated entirely to the Sphere SDK
`PaymentsModule`. The SDK's `TokenReservationLedger` prevents
double-spend at the token level during `send()`; the
`TokenSplitCalculator` handles optimal denomination selection. The
VolumeReservationLedger operates one layer above: it tracks *volume
commitments* (not individual tokens) so the agent knows how much
capacity remains for new deals.

```typescript
interface VolumeReservationLedger {
  /** Reserve volume for a deal. Returns false if insufficient available volume. */
  reserve(coinId: string, amount: bigint, dealId: string): boolean;
  /** Release reservation when deal completes, fails, or is cancelled. */
  release(dealId: string): void;
  /** Get available volume = SDK balance - sum of reservations. */
  getAvailable(coinId: string): bigint;
  /** List all active reservations. */
  getReservations(): Array<{ dealId: string; coinId: string; amount: bigint }>;
}
```

The ledger is consulted at two points: (1) before negotiation, to confirm
that the agent can deliver the proposed volume, and (2) on deal
completion/failure/cancellation, to release the reservation. The ledger
state is persisted as part of the TraderStateStore (it is small enough to
serialize inline in the trader state file).

### TraderStateStore

File-backed persistence layer under `/data/wallet/trader/`. Stores intents, deals,
strategy configuration, and cached search results as JSON files. Writes are
atomic (write to temp file, then rename) to prevent corruption on crash.
On startup, the store loads all state and reconciles against the MarketModule
by calling `getMyIntents()` to verify which intents are still active.

---

## 3. Intent Format

The `TradingIntent` is the core data structure. It is immutable once posted;
updates produce a new version with an incremented sequence number.

```typescript
interface TradingIntent {
  readonly intent_id: string;           // SHA-256 of canonical JSON (see protocol spec 2.5)
  readonly market_intent_id: string;    // ID returned by MarketModule.postIntent()
  readonly agent_pubkey: string;        // secp256k1 compressed (66 hex chars)
  readonly agent_address: string;       // Nostr address for NP-0 negotiation
  readonly salt: string;                // 32 hex chars (16 random bytes) — ensures unique intent_id
  readonly direction: 'buy' | 'sell';
  readonly base_asset: string;          // e.g., "ALPHA"
  readonly quote_asset: string;         // e.g., "USDC"
  readonly rate_min: number;            // minimum acceptable rate (quote per base)
  readonly rate_max: number;            // maximum acceptable rate
  readonly volume_min: number;          // minimum fill volume (base units)
  readonly volume_max: number;          // maximum offered volume
  readonly volume_filled: number;       // cumulative filled volume
  readonly escrow_address: string;      // preferred escrow pubkey, or "any"
  readonly deposit_timeout_sec: number; // max seconds for escrow deposit
  readonly expiry_ms: number;           // absolute expiry (epoch ms)
  readonly signature: string;           // ECDSA over intent_id bytes
}
```

See the [protocol spec Section 2.4](protocols/trader-agent-protocol-spec.md#24-intent-data-structure) for field constraints and validation rules.

---

## 4. Intent Lifecycle State Machine

```
DRAFT --[post]--> ACTIVE --[match]--> MATCHING --[propose]--> NEGOTIATING
                    ^         |                                   |
                    |    [cancel/expire]                    [deal completes]
                    |         v                                   |
                    |    CANCELLED / EXPIRED              PARTIALLY_FILLED
                    |                                       |         |
                    +-------[re-match]----------------------+    [all filled]
                                                                     |
                                                                  FILLED
```

| From | To | Trigger | Side Effect |
|---|---|---|---|
| DRAFT | ACTIVE | Intent validated and signed | Call `MarketModule.postIntent()` |
| ACTIVE | MATCHING | Match found via `search()` or feed | Reserve volume via VolumeReservationLedger |
| ACTIVE | CANCELLED | Owner CANCEL_INTENT command | Call `MarketModule.closeIntent()` |
| ACTIVE | EXPIRED | `now >= expiry_ms` | Call `MarketModule.closeIntent()` |
| MATCHING | NEGOTIATING | `np.propose_deal` sent | Start deal state machine |
| MATCHING | ACTIVE | Match rejected or 30s timeout | Release reservation, retry |
| NEGOTIATING | PARTIALLY_FILLED | Deal completes, volume remains | Update local state |
| NEGOTIATING | FILLED | Deal fills remaining volume | Call `MarketModule.closeIntent()` |
| NEGOTIATING | ACTIVE | Deal fails or is cancelled | Release reservation, resume matching |
| PARTIALLY_FILLED | MATCHING | New match found | Reserve remaining volume via VolumeReservationLedger |
| PARTIALLY_FILLED | CANCELLED | Owner CANCEL_INTENT | Call `MarketModule.closeIntent()` |
| PARTIALLY_FILLED | EXPIRED | `now >= expiry_ms` | Call `MarketModule.closeIntent()` |
| PARTIALLY_FILLED | FILLED | Deal fills remainder | Call `MarketModule.closeIntent()` |

Terminal states: **FILLED**, **CANCELLED**, **EXPIRED**.

---

## 5. ACP Command Extensions

Commands sent by the owner via `acp.command` with `payload.name` and `payload.params`:

| Command | Description | Key Params |
|---|---|---|
| `CREATE_INTENT` | Create and publish a trading intent via MarketModule | direction, base/quote asset, rate range, volume range, expiry_sec |
| `CANCEL_INTENT` | Cancel an active intent | intent_id, reason |
| `LIST_INTENTS` | List agent's intents with optional filter | filter (active/filled/cancelled/expired/all), limit, offset |
| `LIST_SWAPS` | List swap deals | filter (active/completed/failed/all), limit, offset |
| `SET_STRATEGY` | Configure autonomous trading behavior | auto_match, auto_negotiate, max_concurrent_swaps, min_search_score, market_api_url, trusted_escrows, blocked_counterparties |
| `GET_PORTFOLIO` | Return token holdings and reserved balances | (none) |
| `WITHDRAW_TOKEN` | Transfer a token back to the owner | asset, amount, to_address |

**Note:** There is no `DEPOSIT_TOKEN` command. The owner deposits tokens
by sending them directly to the agent's Sphere address via
`PaymentsModule.send()`. The agent's SDK receives them automatically
via Nostr transport subscription. See protocol spec Section 4.8.

See the [protocol spec Section 4](protocols/trader-agent-protocol-spec.md#4-extended-acp-commands-for-trader) for full request/response schemas and error codes.

---

## 6. Data Flow: Intent Creation to Swap Completion

```
1. Owner sends CREATE_INTENT via ACP-0
   Owner -> HM -> Container (ACP listener -> TraderCommandHandler)

2. TraderCommandHandler validates params, calls IntentEngine.createIntent()
   IntentEngine: validate -> sign -> persist to TraderStateStore
                 -> check available volume via PaymentsModule.getBalance()
                    minus VolumeReservationLedger reservations
                 -> reserve volume via VolumeReservationLedger
                 -> call MarketModule.postIntent() to publish

3. IntentEngine scan loop queries MarketModule.search() for matching intents
   (also receives real-time matches via MarketModule.subscribeFeed())
   IntentEngine: parse search results -> evaluate match criteria
                 -> reserve volume via VolumeReservationLedger
                 -> hand off to NegotiationHandler

4. NegotiationHandler sends np.propose_deal via NIP-17 DM
   NegotiationHandler -> counterparty agent
   Counterparty responds with np.accept_deal

5. SwapExecutor calls swapModule.pingEscrow() to verify escrow liveness
   SwapExecutor calls SwapModule.proposeSwap(deal) -> deal enters EXECUTING
   Counterparty receives swap:proposal_received event, calls acceptSwap()
   (No NP-0 DMs exchanged during EXECUTING -- SwapModule handles everything)

6. SwapModule coordinates deposits to escrow -> escrow confirms -> tokens released
   SwapModule emits swap:completed event -> deal enters COMPLETED

7. IntentEngine updates volume_filled
   VolumeReservationLedger releases the deal reservation
   TraderStateStore persists final state

   IF volume_filled == volume_max (fully filled):
     -> Intent transitions to FILLED
     -> IntentEngine calls MarketModule.closeIntent() to remove from market
     -> No further matching for this intent

   IF volume_filled < volume_max (partially filled):
     -> Intent transitions to PARTIALLY_FILLED
     -> IntentEngine computes remaining_volume = volume_max - volume_filled
     -> If remaining_volume >= volume_min (still tradeable):
          -> IntentEngine updates the description on the market by closing
             the old intent and posting a new one with adjusted volume_max
             reflecting the remaining volume
          -> Intent returns to ACTIVE state, scan loop resumes matching
          -> Next match will negotiate against the remaining volume only
     -> If remaining_volume < volume_min (below minimum fill threshold):
          -> Intent transitions to FILLED (treated as complete)
          -> MarketModule.closeIntent() removes from market
          -> The shortfall (volume_min - remaining_volume) is accepted as
             a rounding residual — not worth a separate trade

8. Swap failure or cancellation:
   SwapModule emits swap:failed or swap:cancelled event
   -> Deal enters FAILED or CANCELLED
   -> VolumeReservationLedger releases the reservation
   -> volume_filled is NOT updated (no fill occurred)
   -> Intent returns to ACTIVE, scan loop resumes matching
```

---

## 7. Security Model

### Intent Authentication

Intent posting is authenticated at two levels. Server-side, the MarketModule
API verifies secp256k1 ECDSA signed requests (`x-signature`, `x-public-key`,
`x-timestamp` headers), preventing spoofing and replay. Client-side, every
intent carries an ECDSA signature over its content-addressed `intent_id`
(SHA-256 of canonical JSON). Agents discovering intents via search parse the
description, recompute the `intent_id`, and verify the signature against the
`agentPublicKey` from the search result.

### Anti-Griefing Defenses

Anti-griefing defenses (reputation tracking, progressive trust, deposit-first strategies) are deferred to a future protocol version.

### Rate and Volume Bounds

The matching engine and negotiation handler enforce strict bounds: agreed
rate must fall within the overlapping range of both intents, agreed volume
must satisfy both minimum volumes, and volume can never exceed what is
available. Fills are irreversible (volume_filled only increases).

### Escrow Trust Model

All swaps use the Sphere SDK SwapModule's escrow mechanism. Tokens are
deposited to a neutral escrow address, not directly to the counterparty.
The escrow releases tokens only when both deposits are confirmed. Agents
can restrict acceptable escrows via the `trusted_escrows` strategy
parameter. Deposit timeouts trigger automatic refund.

### DoS Mitigations

- `max_active_intents` (default 20) caps intent creation
- `max_concurrent_swaps` (default 3) caps parallel swaps
- MarketModule API rate limiting and secp256k1 auth required for posting
- 64 KiB message size limit on all NP-0 protocol messages
- `msg_id` deduplication and `ts_ms` clock-skew checks (300s tolerance)

---

## 8. Storage Layout

```
/data/
  wallet/                    # Sphere wallet identity (managed by base tenant)
    identity.json
    mnemonic.enc
    trader/                  # Trader-specific state (managed by TraderStateStore)
      strategy.json          # Current SET_STRATEGY configuration
      intents/
        <intent_id>.json     # One file per intent (full TradingIntent + state)
      deals/
        <deal_id>.json       # One file per deal (DealTerms + state)
      search_cache/
        <asset_pair>.json    # Cached MarketModule search results per asset pair
  tokens/                    # TXF token files (managed by Sphere SDK PaymentsModule)
    <asset>_<txf_hash>.txf
    ...
```

Note: Trader state lives under `/data/wallet/trader/` because the Host
Manager only mounts two volumes (`/data/wallet` and `/data/tokens`). All
persistent trader state must reside under one of these mount points. The
SwapModule manages its own swap persistence via `StorageProvider` -- no
custom swap state directory is needed.

All writes use atomic rename (write to `.tmp`, then `rename()`) to prevent
corruption on crash. On startup, the TraderStateStore scans these directories
and reconciles against the MarketModule via `getMyIntents()` to verify which
published intents are still active in the search index. The SwapModule
restores in-flight swaps automatically via `SwapModule.load()`.
