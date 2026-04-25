# Trader Agent Integration Guide

**Version:** 0.1 (Draft)
**Date:** 2026-04-03
**Status:** Proposed
**Related:** [Architecture](trader-agent-architecture.md) | [Protocol Spec](protocols/trader-agent-protocol-spec.md)

---

## 1. Position in the Unicity 5-Layer Architecture

The trader agent operates primarily at **L5 (Wallet/Agent)** but reaches
down through every layer of the stack:

```
L5  Trader Agent         -- intent management, negotiation, volume reservation
L4  state-transition-sdk -- token transfers, TXF creation, predicate evaluation
    sphere-sdk           -- SwapModule (escrow), MarketModule (intents), CommunicationsModule (DMs)
L3  aggregator           -- inclusion proofs for token ownership verification
L2  BFT consensus        -- confirms state transitions within 1-second rounds
L1  PoW chain            -- anchors token creation events
```

The trader agent never calls L1-L3 directly. All lower-layer interactions
are mediated through sphere-sdk and state-transition-sdk, which abstract
proof fetching, state transition submission, and consensus confirmation.

---

## 2. Sphere SDK Module Dependencies

The trader agent depends on three Sphere SDK modules directly (plus
AccountingModule used indirectly via SwapModule). The SDK handles ALL
balance queries, token inventory, send/receive, split/join, and
double-spend prevention -- the trader agent is a thin layer on top of
these primitives, not a reimplementation of wallet functionality.

### SwapModule

Executes atomic token swaps via escrow. The `SwapExecutor` constructs a
`SwapDeal` from the agreed `DealTerms` and passes it to
`SwapModule.proposeSwap(deal)`. The SwapModule internally builds the
`SwapManifest`, computes the `swap_id` via SHA-256 of canonical fields,
generates a random salt, and signs the consent. No manual manifest
construction is needed.

```typescript
import { SwapModule, SwapDeal } from '@unicitylabs/sphere-sdk';

const deal: SwapDeal = {
  partyA: myAddress,
  partyB: counterpartyAddress,
  partyACurrency: dealTerms.base_asset,
  partyAAmount: String(dealTerms.volume),
  partyBCurrency: dealTerms.quote_asset,
  partyBAmount: String(dealTerms.volume * dealTerms.rate),
  timeout: dealTerms.deposit_timeout_sec,
  escrowAddress: dealTerms.escrow_address,
};
const { swapId } = await swapModule.proposeSwap(deal);

// The counterparty receives a swap:proposal_received event and calls:
// await swapModule.acceptSwap(swapId);

// Listen for completion/failure:
swapModule.on('swap:completed', (ev) => { /* update deal state */ });
swapModule.on('swap:failed', (ev) => { /* handle failure */ });
swapModule.on('swap:cancelled', (ev) => { /* handle cancellation */ });
```

### PaymentsModule

The primary module for ALL token operations. Handles balance queries,
token inventory, send/receive, and transparent split/join. The trader
agent delegates all wallet-level operations to PaymentsModule rather
than reimplementing them.

```typescript
import { PaymentsModule } from '@unicitylabs/sphere-sdk';

// Balance queries — returns Asset[] with totalAmount, confirmedAmount, unconfirmedAmount per coinId
const assets = await paymentsModule.getBalance('ALPHA');

// Full token inventory
const tokens = await paymentsModule.getTokens();

// Aggregated assets with price data
const allAssets = await paymentsModule.getAssets();

// Send tokens — transparent split/join via TokenSplitCalculator,
// atomic reservation via TokenReservationLedger (prevents double-spend)
const receipt = await paymentsModule.send({
  coinId: 'ALPHA',
  amount: withdrawAmount,
  to: recipientPubkey,
});

// Receive incoming transfers
await paymentsModule.receive();
```

**Key internals the trader agent does NOT need to reimplement:**

- **Double-spend prevention:** The SDK's `TokenReservationLedger` tracks
  token status (confirmed -> transferring -> spent) and prevents any token
  from being used in two concurrent `send()` calls.
- **Split/join:** The SDK's `TokenSplitCalculator` selects optimal token
  denominations (exact match -> combination -> greedy+split) transparently
  during `send()`.
- **Token storage:** The SDK manages TXF files in `/data/tokens/` directly.

### Indirect Dependencies (used via SwapModule)

**AccountingModule** -- Used indirectly by the SwapModule for deposit
invoices and payout verification. The trader agent does NOT call
AccountingModule directly.

### CommunicationsModule

Provides NIP-17 encrypted DMs for NP-0 negotiation. The trader agent
uses this for all peer-to-peer deal negotiation communication.

```typescript
import { CommunicationsModule } from '@unicitylabs/sphere-sdk';

// Send deal proposal via DM (NP-0)
await commsModule.sendDirectMessage(counterpartyAddress, JSON.stringify(npMessage));

// Listen for incoming messages
commsModule.on('direct_message', (msg) => { /* handle NP-0 */ });
```

### MarketModule

Provides intent publication, semantic search, and real-time feed
subscription via the centralized market API. This is the primary
transport for TIP-0 intent discovery, replacing the previous NIP-29
group broadcast approach.

```typescript
import { MarketModule } from '@unicitylabs/sphere-sdk';

// Post a trading intent
const result = await marketModule.postIntent({
  description: 'Selling 500-1000 ALPHA for USDC. Rate: 450-500 USDC per ALPHA. Escrow: any.',
  intentType: 'sell',
  category: 'ALPHA/USDC',
  price: 475,          // midpoint rate for filtering
  currency: 'USDC',
  contactHandle: agentAddress,
  expiresInDays: 7,
});
const marketIntentId = result.id;

// Semantic search for matching intents
const matches = await marketModule.search(
  'Buying ALPHA for USDC near rate 475',
  {
    filters: { intentType: 'buy', category: 'ALPHA/USDC', minPrice: 450, maxPrice: 500 },
    limit: 50,
    minScore: 0.6,
  }
);

// Real-time feed subscription (receives FeedMessage with FeedListing objects)
// FeedListing has: id, title, descriptionPreview, agentName, agentId, type, createdAt
// After receiving a feed event, call search() to get full intent details for matching
marketModule.subscribeFeed({
  onIntent: (feedMsg) => { /* call search() for full details, then evaluate */ },
  onError: (err) => { /* handle reconnection */ },
});

// REST fallback when WebSocket feed is unavailable
const recent = await marketModule.getRecentListings();

// List own intents
const myIntents = await marketModule.getMyIntents();

// Close an intent
await marketModule.closeIntent(marketIntentId);
```

---

## 3. MarketModule as Intent Database

### Overview

The Sphere SDK MarketModule provides a centralized intent database backed
by a Qdrant vector database, PostgreSQL metadata store, and OpenAI
`text-embedding-3-small` embeddings (1536 dimensions). This replaces the
previous NIP-29 group broadcast approach with a more scalable and
semantically-aware system.

### Intent Publication

Intents are posted via `MarketModule.postIntent()` with a structured
`PostIntentRequest`. The `description` field carries a human-readable
encoding of trading parameters (see protocol spec Section 2.8) that
produces effective vector embeddings. Structured fields (`intentType`,
`price`, `currency`, `category`) enable exact server-side filtering on
top of semantic search.

Authentication uses secp256k1 ECDSA signed requests. The market API
verifies `x-signature`, `x-public-key`, and `x-timestamp` headers on
every posting and close operation.

### Intent Discovery

Agents discover matching intents through two channels:

1. **Periodic search:** The IntentEngine calls `MarketModule.search()`
   with semantic queries derived from each active intent. The search
   combines natural language similarity (vector cosine distance) with
   exact field filters. Results are ranked by similarity score (0-1).

2. **Live feed:** `MarketModule.subscribeFeed()` provides a WebSocket
   connection that pushes new intents as they are posted. This provides
   near-real-time discovery without polling.

### No Local Intent Book Required

Unlike the NIP-29 approach, the MarketModule IS the intent database.
Agents do not need to maintain a local order book of remote intents.
Each matching scan queries the market API directly. Local state only
tracks the agent's own intents and their lifecycle.

Search results are ephemeral -- they represent the current state of the
market at query time. The `expiresAt` field on search results provides
the server-side expiry. The agent performs client-side validation
(rate overlap, volume sufficiency, escrow compatibility) on top of
search results before initiating negotiation.

### Ordering

Search results are ranked by semantic similarity score. For deterministic
tie-breaking during matching (when multiple results pass client-side
validation), the matching engine applies price-time priority: best rate
first, then earliest `createdAt`, then largest available volume.

---

## 4. SwapModule Integration

### Mapping Deals to Swaps

Each NP-0 deal maps to exactly one SwapModule swap. The `SwapExecutor`
constructs a `SwapDeal` from the agreed `DealTerms` and passes it to
`SwapModule.proposeSwap(deal)`. The SwapModule internally builds the
`SwapManifest`, computes the `swap_id` via SHA-256 of canonical fields,
generates a random salt, and signs the consent. No manual manifest
construction is needed.

The SwapModule provides privacy via the random salt in the manifest,
preventing the escrow from correlating swap activity with public intent
data from the market API. No custom `swap_id` derivation is needed.

```typescript
const deal: SwapDeal = {
  partyA: myAddress,
  partyB: counterpartyAddress,
  partyACurrency: dealTerms.base_asset,
  partyAAmount: String(dealTerms.volume),
  partyBCurrency: dealTerms.quote_asset,
  partyBAmount: String(dealTerms.volume * dealTerms.rate),
  timeout: dealTerms.deposit_timeout_sec,
  escrowAddress: dealTerms.escrow_address,
};
const { swapId } = await swapModule.proposeSwap(deal);
```

### Escrow Liveness Check

Before transitioning from ACCEPTED to EXECUTING, the proposer calls
`swapModule.pingEscrow(escrowAddress, 10000)` to verify the escrow is
responsive. If the ping fails, the deal transitions to FAILED with reason
`ESCROW_UNREACHABLE`. This avoids committing to a swap against a
non-responsive escrow.

### Lifecycle Management

The SwapModule handles all swap coordination via its own DM protocol. No
NP-0 messages are exchanged during the EXECUTING state. The `SwapExecutor`
subscribes to SwapModule events to determine the deal outcome:

- `swap:proposed` -- swap initiated (proposer side)
- `swap:proposal_received` -- match against pending deals, call `acceptSwap()` if terms match
- `swap:announced`, `swap:deposit_sent` -- progress updates (logged)
- `swap:completed` -- transition deal to COMPLETED, release reservation, update intent fill
- `swap:failed` or `swap:cancelled` -- transition deal to FAILED, release reservation

### Crash Recovery

On startup, the trader agent calls `SwapModule.load()` which restores all
in-flight swaps from persistent storage, re-announces to escrow for
pending swaps, and resumes event monitoring. No custom crash recovery is
needed. The SwapModule manages its own persistence via `StorageProvider`.

### Concurrent Swaps

The `max_concurrent_swaps` strategy parameter (default 3, max 10) limits
how many swaps can run simultaneously. The `SwapExecutor` maintains a
semaphore and rejects new swaps when the limit is reached, causing the
NegotiationHandler to send `np.reject_deal` with reason `AGENT_BUSY`.

---

## 5. Token Operations and Volume Reservation

### SDK-Managed Token Operations

All token operations are delegated to the Sphere SDK `PaymentsModule`.
The trader agent does NOT maintain its own token index, balance cache,
or split/join logic.

| Operation | SDK Method | Notes |
|---|---|---|
| Balance query | `PaymentsModule.getBalance(coinId?)` | Returns `Asset[]` with totalAmount, confirmedAmount, unconfirmedAmount |
| Token inventory | `PaymentsModule.getTokens()` | Full token list with status |
| Aggregated assets | `PaymentsModule.getAssets()` | Assets with price data |
| Deposit (owner → agent) | Automatic via Nostr transport | Owner calls `send()` to agent's address; SDK receives automatically |
| Deposit catch-up | `PaymentsModule.receive()` | Polls relay for transfers received while offline |
| Withdrawal (agent → owner) | `PaymentsModule.send()` | Transparent split/join, atomic reservation |
| Double-spend prevention | `TokenReservationLedger` (internal) | Token-level status: confirmed -> transferring -> spent |
| Denomination selection | `TokenSplitCalculator` (internal) | Exact match -> combination -> greedy+split |

### Volume Reservation (VolumeReservationLedger)

The one thing the SDK does NOT handle is cross-deal volume bookkeeping.
When the agent is negotiating multiple deals concurrently, it needs to
know how much volume is already committed so it does not promise more
than it can deliver.

The `VolumeReservationLedger` is a simple `Map<string, bigint>` that
tracks volume commitments by deal ID:

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

`getAvailable()` calls `PaymentsModule.getBalance(coinId)` for the total
confirmed balance, then subtracts the sum of all active reservations for
that coin. This is the amount available for new deals.

**Important distinction:** Double-spend prevention (ensuring a specific
token is not used twice in `send()`) is handled by the SDK's
`TokenReservationLedger`. Volume reservation (ensuring the agent does not
commit 100 ALPHA to two different deals when it only holds 100 ALPHA) is
handled by the `VolumeReservationLedger`. These operate at different
levels and are complementary.

The ledger state is persisted as part of the TraderStateStore (serialized
inline in `/data/wallet/trader/strategy.json` alongside other small
runtime state).

---

## 6. Cross-Layer Data Flow with Latency Estimates

```
Action                          Layer   Typical Latency
-----------------------------------------------------------
Owner sends CREATE_INTENT       L5      < 100ms (DM relay)
Intent posted to MarketModule   L5      100-300ms (API + embedding)
Match scan via search()         L5      200-500ms (vector search)
 or feed subscription           L5      < 100ms (WebSocket push)
Deal negotiation (NP-0 DMs)    L5      1-10s (depends on counterparty)
Swap initiation                 L4      200-500ms (SwapModule)
Escrow deposit confirmation     L2/L3   1-3s (BFT round + aggregation)
Swap completion                 L4      1-3s (both deposits confirmed)
Intent closed via closeIntent() L5      50-100ms (API call)
-----------------------------------------------------------
Total: intent creation to fill          ~10-30s typical
```

The dominant latency contributors are the scan interval (configurable),
counterparty response time, and L2 BFT consensus rounds (1 second each).

---

## 7. Market API and Escrow Discovery

### Market API

The trader agent connects to the MarketModule API for intent publication
and discovery. The API URL defaults to `https://market-api.unicity.network`
and can be overridden via `SET_STRATEGY.market_api_url` or the
`MARKET_API_URL` environment variable at container creation.

The MarketModule provides a global intent database accessible to all
agents. Authentication uses secp256k1 ECDSA signed requests -- the same
keypair used for the agent's Sphere wallet identity. Search is public
and requires no authentication; posting and closing intents require auth.

The `min_search_score` strategy parameter (default 0.6, range 0-1)
controls the semantic similarity threshold for search results. Lower
values return more results but with less relevance; higher values return
fewer, more targeted results.

### Escrow Discovery

Escrow services are identified by their secp256k1 public keys. The
`trusted_escrows` strategy parameter lists escrow pubkeys the agent will
accept. If empty, the agent accepts any escrow (the `"any"` default).

For production deployments, operators should configure `trusted_escrows`
to a known set of audited escrow services. The escrow service itself is
a Sphere SDK SwapModule endpoint -- any party running a SwapModule
instance can act as escrow.

---

## 8. Template Configuration

### templates.json Entry

Add the trader agent template to `config/templates.json`:

```json
{
  "template_id": "trader-agent",
  "image": "unicity/trader-agent:0.1",
  "entrypoint": ["node", "/app/dist/trader/main.js"],
  "env_defaults": {
    "MARKET_API_URL": "https://market-api.unicity.network",
    "MIN_SEARCH_SCORE": "0.6",
    "DEFAULT_ESCROW_NAMETAG": "any",
    "SWAP_TIMEOUT_SECONDS": "300",
    "MAX_CONCURRENT_SWAPS": "3",
    "INTENT_EXPIRY_SECONDS": "604800"
  }
}
```

Note: Do NOT include `UNICITY_NETWORK` in `env_defaults` -- it is
automatically injected by the Host Manager for all tenant containers.
Only trader-specific configuration belongs here. All trader env vars use
non-`UNICITY_` prefixed names to avoid collision with manager-injected
variables.

### Environment Variables

Standard tenant env vars (injected by Host Manager):

| Variable | Description |
|---|---|
| `UNICITY_MANAGER_PUBKEY` | Host Manager's secp256k1 pubkey |
| `UNICITY_BOOT_TOKEN` | One-time boot handshake token |
| `UNICITY_INSTANCE_ID` | Unique instance identifier |
| `UNICITY_INSTANCE_NAME` | Human-readable instance name |
| `UNICITY_TEMPLATE_ID` | `"trader-agent"` |
| `UNICITY_NETWORK` | `"testnet"` or `"mainnet"` |
| `UNICITY_DATA_DIR` | `/data/wallet` |
| `UNICITY_TOKENS_DIR` | `/data/tokens` |

Trader-specific env vars (non-`UNICITY_` prefixed to avoid collision with
manager-injected variables):

| Variable | Description | Default |
|---|---|---|
| `MARKET_API_URL` | MarketModule API base URL | `"https://market-api.unicity.network"` |
| `MIN_SEARCH_SCORE` | Minimum semantic similarity score for matching (0-1) | `"0.6"` |
| `DEFAULT_ESCROW_NAMETAG` | Default escrow nametag or pubkey | `"any"` |
| `SWAP_TIMEOUT_SECONDS` | Max seconds for escrow deposit | `300` |
| `MAX_CONCURRENT_SWAPS` | Max simultaneous swaps | `3` |
| `INTENT_EXPIRY_SECONDS` | Maximum intent lifetime in seconds | `604800` (7 days) |

### Volume Mounts

```yaml
volumes:
  - /data/wallet    # Sphere wallet identity + trader state (persistent)
  - /data/tokens    # TXF token files (persistent)
```

The Host Manager only mounts two volumes: `/data/wallet` and `/data/tokens`.
Trader-specific state is stored under `/data/wallet/trader/` (a subdirectory
of the wallet mount). Both volumes must be persistent across container
restarts to preserve wallet identity, token holdings, and trading state.

### Resource Limits

Recommended Docker resource constraints:

```json
{
  "memory": "256m",
  "cpu_shares": 512,
  "pids_limit": 64,
  "read_only": false,
  "network_mode": "bridge"
}
```

The trader agent needs outbound network access for the MarketModule API,
Nostr relay connections (NP-0 negotiation), and aggregator queries.
Inbound connections are not required -- all communication is
API-mediated or relay-mediated.
