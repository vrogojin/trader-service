# Trader Agent Protocol Specification

**Version:** 0.1 (Draft)
**Date:** 2026-04-03
**Status:** Proposed
**Authors:** Agentic Hosting Team
**Depends on:** ACP-0 v0.1, HMCP-0 v0.1, Sphere SDK SwapModule, Sphere SDK MarketModule

---

## Table of Contents

1. [Overview](#1-overview)
2. [Trading Intent Protocol (TIP-0)](#2-trading-intent-protocol-tip-0)
3. [Negotiation Protocol (NP-0)](#3-negotiation-protocol-np-0)
4. [Extended ACP Commands for Trader](#4-extended-acp-commands-for-trader)
5. [Intent Matching Rules](#5-intent-matching-rules)
6. [State Machines](#6-state-machines)
7. [Security and Validation](#7-security-and-validation)
8. [Appendix A: Canonical JSON Serialization](#appendix-a-canonical-json-serialization)
9. [Appendix B: Error Codes](#appendix-b-error-codes)
10. [Appendix C: Sequence Diagrams](#appendix-c-sequence-diagrams)

---

## 1. Overview

### 1.1 Purpose

This specification defines three protocol layers that enable autonomous trading
between Trader Agent instances running within the Unicity agentic hosting system:

1. **TIP-0 (Trading Intent Protocol)** -- Intent publication and discovery
   via the Sphere SDK MarketModule (centralized market API with vector
   embeddings for semantic search).
2. **NP-0 (Negotiation Protocol)** -- Peer-to-peer deal negotiation over
   Nostr NIP-17 encrypted DMs.
3. **Extended ACP commands** -- Owner-to-agent control commands carried over
   the existing ACP-0 protocol.

### 1.2 Transport Summary

```
Owner (human / controller)
    |  ACP-0 commands via Host Manager (CREATE_INTENT, SET_STRATEGY, ...)
    v
Trader Agent (tenant container)
    |  TIP-0: MarketModule API (postIntent, search, subscribeFeed)
    |  NP-0 messages via NIP-17 DMs (peer-to-peer)
    |  SwapModule escrow via NIP-17 DMs (swap execution)
    v
Market API (Qdrant + embeddings)  /  Other Trader Agents
```

### 1.3 Design Principles

- **Consistency with ACP-0/HMCP-0**: Envelope structure, field naming, and
  validation patterns follow the existing protocols exactly.
- **secp256k1 only**: All keys and signatures use the secp256k1 curve.
  No ed25519.
- **Content-addressed identifiers**: Intent IDs and deal IDs are derived from
  SHA-256 of canonical JSON, ensuring deterministic deduplication.
- **Offline-safe**: All messages carry absolute timestamps. Agents must
  validate expiry locally. No real-time clock synchronization is assumed
  beyond NTP-level accuracy.
- **Atomic intent updates**: Intents are immutable once posted. "Updates" are
  new messages that reference the original intent_id with a monotonic
  sequence number.

### 1.4 Notation Conventions

- All timestamps are Unix epoch milliseconds (`ts_ms`), type `number`.
- All byte strings are lowercase hex-encoded unless stated otherwise.
- `generateId()` produces a UUID v4 string (consistent with existing codebase).
- `sha256hex(data)` produces a lowercase hex SHA-256 digest.
- Field names use `snake_case` throughout.
- All interfaces use `readonly` modifiers (consistent with existing codebase).

---

## 2. Trading Intent Protocol (TIP-0)

### 2.1 Transport

TIP-0 uses the Sphere SDK **MarketModule** as its primary transport and
storage layer. The MarketModule provides a centralized market API backed
by a Qdrant vector database, PostgreSQL metadata store, and OpenAI
`text-embedding-3-small` embeddings (1536 dimensions). All intents are
posted via `MarketModule.postIntent()`, discovered via
`MarketModule.search()` (semantic search) or `MarketModule.subscribeFeed()`
(real-time WebSocket feed), and cancelled via `MarketModule.closeIntent()`.

Authentication uses secp256k1 ECDSA signed requests (headers:
`x-signature`, `x-public-key`, `x-timestamp`). Search is public and
requires no authentication. Posting and closing intents require auth.

> **Note:** A NIP-29 group MAY be used as an optional supplementary
> broadcast channel for intent announcements, but the MarketModule is
> the authoritative intent database. Agents MUST NOT rely on NIP-29 group
> messages for intent discovery.

### 2.2 Protocol Version

```
TIP_VERSION = "0.2"
```

### 2.3 Operations

TIP-0 operations map directly to MarketModule API calls:

| Operation | MarketModule Method | Description |
|---|---|---|
| Post intent | `postIntent(request)` | Publish a new trading intent with vector embedding |
| Search intents | `search(query, opts?)` | Semantic search for matching intents |
| Subscribe feed | `subscribeFeed(listener)` | WebSocket live feed of new listings |
| List own intents | `getMyIntents()` | Retrieve all intents posted by this agent |
| Close intent | `closeIntent(intentId)` | Cancel/close an active intent |

There are no explicit wire-format message types. The MarketModule API
handles serialization, authentication, and delivery.

### 2.4 Intent Data Structure

The `TradingIntent` is the core local data object. It maps to the
MarketModule's `PostIntentRequest` for publication and is enriched with
a `market_intent_id` (returned by `postIntent()`) for lifecycle tracking.

```typescript
interface TradingIntent {
  readonly intent_id: string;            // sha256hex of canonical JSON of initial intent fields
  readonly market_intent_id: string;     // ID returned by MarketModule.postIntent()
  readonly agent_pubkey: string;         // secp256k1 compressed (66 hex chars)
  readonly agent_address: string;        // Nostr direct address for NP-0 negotiation
  readonly salt: string;                 // 32 hex chars (16 random bytes) — ensures unique intent_id
  readonly direction: 'buy' | 'sell';
  readonly base_asset: string;           // e.g., "ALPHA"
  readonly quote_asset: string;          // e.g., "USDC"
  readonly rate_min: number;             // minimum acceptable rate (quote per base unit)
  readonly rate_max: number;             // maximum acceptable rate (quote per base unit)
  readonly volume_min: number;           // minimum acceptable fill volume (base units)
  readonly volume_max: number;           // maximum offered volume (base units)
  readonly volume_filled: number;        // cumulative filled volume (base units)
  readonly escrow_address: string;       // preferred escrow pubkey, or "any"
  readonly deposit_timeout_sec: number;  // max seconds to wait for escrow deposit
  readonly expiry_ms: number;            // absolute expiry timestamp (epoch ms)
  readonly signature: string;            // ECDSA signature over intent_hash (see 2.5)
}
```

#### Mapping to PostIntentRequest

When posting to the MarketModule, the structured trading fields are encoded
into a `PostIntentRequest`:

```typescript
// Build a structured natural-language description for semantic embedding
const description = [
  `${direction === 'sell' ? 'Selling' : 'Buying'} ${base_asset} for ${quote_asset}`,
  `Rate: ${rate_min}-${rate_max} ${quote_asset} per ${base_asset}`,
  `Volume: ${volume_min}-${volume_max} ${base_asset}`,
  `Escrow: ${escrow_address}`,
].join('. ');

const request: PostIntentRequest = {
  description,
  intentType: direction === 'sell' ? 'sell' : 'buy',
  category: `${base_asset}/${quote_asset}`,
  price: (rate_min + rate_max) / 2,      // midpoint rate for filtering
  currency: quote_asset,
  contactHandle: agent_address,           // Nostr address for NP-0 negotiation
  expiresInDays: Math.ceil((expiry_ms - Date.now()) / 86_400_000),
};
```

The `market_intent_id` returned by `postIntent()` is stored locally and
used for `closeIntent()` calls.

**Field constraints:**

| Field | Constraint |
|---|---|
| `intent_id` | 64 lowercase hex chars (SHA-256 output) |
| `market_intent_id` | Non-empty string (assigned by market API) |
| `agent_pubkey` | Must match `/^0[23][0-9a-fA-F]{64}$/` |
| `agent_address` | Non-empty string, max 256 chars |
| `direction` | Exactly `"buy"` or `"sell"` |
| `base_asset` | 1-32 uppercase alphanumeric chars: `/^[A-Z0-9_]{1,32}$/` |
| `quote_asset` | 1-32 uppercase alphanumeric chars: `/^[A-Z0-9_]{1,32}$/` |
| `base_asset` vs `quote_asset` | Must not be equal |
| `rate_min` | Positive finite number, `rate_min <= rate_max` |
| `rate_max` | Positive finite number |
| `volume_min` | Positive finite number, `volume_min <= volume_max` |
| `volume_max` | Positive finite number |
| `volume_filled` | Non-negative finite number, `<= volume_max` |
| `escrow_address` | `"any"` or valid secp256k1 compressed pubkey |
| `deposit_timeout_sec` | Integer, 30 <= value <= 300 |
| `expiry_ms` | Integer, must be in the future when posted |
| `signature` | Valid ECDSA DER-encoded hex string |

### 2.5 Intent ID Derivation

The `intent_id` is derived deterministically from the initial intent fields
at creation time. This prevents spoofing and allows any party to verify
the ID independently.

```
intent_hash_input = canonical_json({
    agent_pubkey,
    agent_address,
    salt,               // 32 hex chars (16 random bytes) — ensures uniqueness
    direction,
    base_asset,
    quote_asset,
    rate_min,
    rate_max,
    volume_min,
    volume_max,
    escrow_address,
    deposit_timeout_sec,
    expiry_ms,
    created_ms          // timestamp of initial post
})

intent_id = sha256hex(intent_hash_input)
```

The `signature` field is an ECDSA signature over the raw bytes of
`intent_id` (32 bytes, decoded from hex) using the private key
corresponding to `agent_pubkey`.

Verification: `ecdsaVerify(signature, bytes(intent_id), agent_pubkey)`.

Note: The `market_intent_id` is a server-assigned identifier returned by
`MarketModule.postIntent()`. It is NOT derived from intent content. The
`intent_id` (content-addressed) is used for NP-0 deal references; the
`market_intent_id` is used for MarketModule API calls (`closeIntent()`,
`getMyIntents()`).

### 2.6 MarketModule Search Integration

Intent discovery uses `MarketModule.search()` with semantic queries
constructed from the agent's own intent parameters. The search combines
natural language similarity (via vector embeddings) with exact field
filters.

#### Building a Search Query

```typescript
// For a buy intent looking for sellers:
const query = `Selling ${base_asset} for ${quote_asset} near rate ${rate_max}`;
const opts: SearchOptions = {
  filters: {
    intentType: 'sell',
    category: `${base_asset}/${quote_asset}`,
    minPrice: rate_min,
    maxPrice: rate_max,
  },
  limit: 50,
  minScore: 0.6,  // similarity threshold (tunable via strategy)
};

const results: SearchIntentResult[] = await marketModule.search(query, opts);
```

#### SearchIntentResult Fields

Each result from `search()` includes:

| Field | Description |
|---|---|
| `id` | Market API intent ID |
| `score` | 0-1 cosine similarity score |
| `agentNametag` | Publisher's nametag |
| `agentPublicKey` | Publisher's secp256k1 public key |
| `description` | Free-form text (contains structured trading details) |
| `intentType` | `'buy'` or `'sell'` |
| `category` | Asset pair, e.g., `"ALPHA/USDC"` |
| `price` | Midpoint rate |
| `currency` | Quote asset |
| `contactHandle` | Nostr address for NP-0 negotiation |
| `createdAt` | ISO timestamp |
| `expiresAt` | ISO timestamp |

#### Parsing Search Results

The agent parses the structured `description` field to extract exact
trading parameters (rate range, volume range, escrow address) for
client-side matching validation. The `contactHandle` provides the Nostr
address for initiating NP-0 negotiation.

#### Live Feed Subscription

For real-time intent discovery, agents subscribe to the MarketModule
WebSocket feed:

```typescript
marketModule.subscribeFeed({
  onIntent: (feedMsg: FeedMessage) => {
    // FeedMessage contains FeedListing objects with:
    //   id, title, descriptionPreview, agentName, agentId, type, createdAt
    // After receiving a feed event, call search() to get full intent details
    // for matching (rate range, volume, escrow, contactHandle, etc.)
    intentEngine.evaluateFeedListing(feedMsg);
  },
  onError: (err: Error) => {
    logger.warn({ err }, 'Market feed error, will reconnect');
  },
});
```

As a REST fallback when the WebSocket feed is unavailable, agents can
call `MarketModule.getRecentListings()` periodically to discover newly
posted intents.

### 2.7 Intent Lifecycle via MarketModule

#### 2.7.1 Posting an Intent

When the agent creates a new intent, it calls `MarketModule.postIntent()`
with a `PostIntentRequest` constructed from the `TradingIntent` fields
(see Section 2.4, "Mapping to PostIntentRequest"). The returned
`market_intent_id` is stored in the local `TradingIntent`.

**Validation rules (local, before posting):**
- `volume_filled` MUST be `0`.
- `expiry_ms` MUST be in the future.
- `signature` MUST be valid for `intent_id` against `agent_pubkey`.

#### 2.7.2 Cancelling an Intent

Cancellation calls `MarketModule.closeIntent(market_intent_id)`. The
MarketModule authenticates via the agent's secp256k1 key and removes the
intent from the search index.

#### 2.7.3 Intent Updates

The MarketModule does not support in-place updates. To update an intent
(rate or volume change), the agent closes the existing intent and posts
a new one with updated parameters. The new intent retains the same
local `intent_id` but receives a new `market_intent_id`. The local
`TradingIntent` tracks the latest `market_intent_id`.

**Monotonicity constraints (narrowing only):** Updates MUST NOT widen the
rate range: `rate_min` can only increase or stay the same; `rate_max` can
only decrease or stay the same compared to the previous version. Updates
MUST NOT decrease `volume_min`. This ensures that existing matches remain
valid and that agents cannot bait counterparties with narrow ranges then
widen after attracting proposals.

#### 2.7.4 Fill Notifications

When a fill completes, the agent updates its local state. If the intent
is fully filled, it calls `MarketModule.closeIntent()` to remove it from
the search index. Partial fills are tracked locally; the agent may
close-and-repost with updated volume if desired.

### 2.8 Description Field Encoding

The `description` field in `PostIntentRequest` carries structured trading
information in a human-readable format that produces good vector embeddings.
The canonical format is:

```
{Selling|Buying} {volume_min}-{volume_max} {base_asset} for {quote_asset}.
Rate: {rate_min}-{rate_max} {quote_asset} per {base_asset}.
Escrow: {escrow_address}.
Deposit timeout: {deposit_timeout_sec}s.
```

Example: `"Selling 500-1000 ALPHA for USDC. Rate: 450-500 USDC per ALPHA. Escrow: any. Deposit timeout: 300s."`

Agents parsing search results MUST extract these fields from the
description using a tolerant parser. Unrecognized description formats
SHOULD be skipped.

### 2.9 TIP TypeScript Interfaces (Complete)

```typescript
// ---- tip.ts ----

export const TIP_VERSION = '0.2';

export const INTENT_DIRECTIONS = ['buy', 'sell'] as const;
export type IntentDirection = (typeof INTENT_DIRECTIONS)[number];

export const ASSET_NAME_RE = /^[A-Z0-9_]{1,32}$/;

export interface TradingIntent {
  readonly intent_id: string;
  readonly market_intent_id: string;
  readonly agent_pubkey: string;
  readonly agent_address: string;
  readonly direction: IntentDirection;
  readonly base_asset: string;
  readonly quote_asset: string;
  readonly rate_min: number;
  readonly rate_max: number;
  readonly volume_min: number;
  readonly volume_max: number;
  readonly volume_filled: number;
  readonly escrow_address: string;
  readonly deposit_timeout_sec: number;
  readonly expiry_ms: number;
  readonly signature: string;
}

// PostIntentRequest mapping (see Section 2.4)
export interface TradingIntentPostRequest {
  readonly description: string;
  readonly intentType: 'buy' | 'sell';
  readonly category: string;          // "{base_asset}/{quote_asset}"
  readonly price: number;             // midpoint rate
  readonly currency: string;          // quote asset
  readonly contactHandle: string;     // agent Nostr address
  readonly expiresInDays: number;
}

// IntentState defined in Section 6.1
export const INTENT_STATES = [
  'DRAFT', 'ACTIVE', 'MATCHING', 'NEGOTIATING',
  'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'EXPIRED',
] as const;
export type IntentState = (typeof INTENT_STATES)[number];
```

---

## 3. Negotiation Protocol (NP-0)

### 3.1 Transport

NP-0 messages are sent as Nostr NIP-17 encrypted DMs between two trader
agents. The `agent_address` field from the intent provides the destination.

### 3.2 Protocol Version

```
NP_VERSION = "0.1"
```

### 3.3 Message Types

NP-0 defines 3 message types for deal negotiation. Swap execution is
handled entirely by the Sphere SDK SwapModule, which has its own DM-based
protocol -- no NP-0 messages are needed during swap execution.

```typescript
const NP_MESSAGE_TYPES = [
  'np.propose_deal',      // proposer sends exact terms
  'np.accept_deal',       // acceptor agrees
  'np.reject_deal',       // acceptor rejects
] as const;

type NpMessageType = (typeof NP_MESSAGE_TYPES)[number];
```

### 3.4 NP Envelope

```typescript
interface NpMessage {
  readonly np_version: string;      // "0.1"
  readonly msg_id: string;          // UUID v4
  readonly deal_id: string;         // content-addressed (see 3.5)
  readonly ts_ms: number;
  readonly sender_pubkey: string;   // secp256k1 compressed
  readonly type: NpMessageType;
  readonly payload: Record<string, unknown>;
  readonly signature: string;       // ECDSA over sha256hex(deal_id + ":" + msg_id + ":" + type)
}
```

**Envelope validation:**
- `np_version` MUST equal `NP_VERSION`.
- `msg_id` MUST be a valid UUID v4 string.
- `deal_id` MUST be 64 lowercase hex chars.
- `sender_pubkey` MUST be a valid secp256k1 compressed pubkey.
- `signature` MUST verify against `sender_pubkey`.
- Message size MUST NOT exceed 64 KiB.
- No dangerous keys (`__proto__`, `constructor`, `prototype`).

### 3.5 Deal ID Derivation

The deal_id is derived from the proposal terms, ensuring both parties
reference the same deal deterministically:

```
deal_id = sha256hex(canonical_json({
    proposer_pubkey,
    acceptor_pubkey,
    proposer_intent_id,
    acceptor_intent_id,
    base_asset,
    quote_asset,
    rate,
    volume,
    escrow_address,
    created_ms
}))
```

### 3.6 Deal Terms Structure

```typescript
interface DealTerms {
  readonly proposer_pubkey: string;
  readonly acceptor_pubkey: string;
  readonly proposer_intent_id: string;
  readonly acceptor_intent_id: string;
  readonly base_asset: string;
  readonly quote_asset: string;
  readonly rate: number;                // agreed rate (quote per base unit)
  readonly volume: number;              // agreed volume (base units)
  readonly escrow_address: string;      // agreed escrow
  readonly deposit_timeout_sec: number;
  readonly created_ms: number;
}
```

### 3.7 Message Payloads

#### 3.7.1 np.propose_deal

Sent by the agent that initiates negotiation after matching intents.

```typescript
interface NpProposeDealPayload {
  readonly terms: DealTerms;
  readonly proposer_swap_address: string;   // address for SwapModule communication
  readonly message: string;                 // optional human-readable note, max 512 chars
}
```

**Validation rules:**
- `sender_pubkey` MUST equal `terms.proposer_pubkey`.
- `terms.rate` MUST fall within the overlapping range of both intents.
- `terms.volume` MUST satisfy both intents' `volume_min`.
- `terms.volume` MUST NOT exceed available volume of either intent.
- `deal_id` in envelope MUST match `sha256hex(canonical_json(terms))`.

#### 3.7.2 np.accept_deal

Sent by the counterparty to accept the proposed terms.

```typescript
interface NpAcceptDealPayload {
  readonly acceptor_swap_address: string;   // address for SwapModule communication
  readonly message: string;                 // optional note, max 512 chars
}
```

**Validation rules:**
- `sender_pubkey` MUST equal `terms.acceptor_pubkey` from the proposal.
- The deal MUST be in state `PROPOSED`.

#### 3.7.3 np.reject_deal

Sent by the counterparty to reject the proposal.

```typescript
interface NpRejectDealPayload {
  readonly reason_code: DealRejectReason;
  readonly message: string;                 // human-readable, max 512 chars
}
```

```typescript
const DEAL_REJECT_REASONS = [
  'RATE_UNACCEPTABLE',
  'VOLUME_UNACCEPTABLE',
  'ESCROW_UNACCEPTABLE',
  'TIMEOUT_UNACCEPTABLE',
  'INSUFFICIENT_BALANCE',
  'STRATEGY_MISMATCH',
  'AGENT_BUSY',
  'OTHER',
] as const;
type DealRejectReason = (typeof DEAL_REJECT_REASONS)[number];
```

**Validation rules:**
- `sender_pubkey` MUST equal `terms.acceptor_pubkey` from the proposal.
- The deal MUST be in state `PROPOSED`.

#### 3.7.4 Swap Execution (Handled by SwapModule)

After the deal is accepted, the proposer verifies escrow liveness via
`pingEscrow()` and then transitions to `EXECUTING`. No further NP-0
messages are exchanged. The proposer calls `SwapModule.proposeSwap(deal)`
and the counterparty listens for a `swap:proposal_received` event and
calls `SwapModule.acceptSwap()`. The SwapModule handles all swap
communication via its own DM protocol, including consent signing (via
`signSwapManifest()`), deposit coordination, and completion/failure
notification.

The agent subscribes to SwapModule events to determine the deal outcome:
- `swap:completed` -- transition deal to COMPLETED
- `swap:failed` or `swap:cancelled` -- transition deal to FAILED

### 3.8 NP TypeScript Interfaces (Complete)

```typescript
// ---- np.ts ----

export const NP_VERSION = '0.1';

export const NP_MESSAGE_TYPES = [
  'np.propose_deal',
  'np.accept_deal',
  'np.reject_deal',
] as const;
export type NpMessageType = (typeof NP_MESSAGE_TYPES)[number];

export const DEAL_REJECT_REASONS = [
  'RATE_UNACCEPTABLE',
  'VOLUME_UNACCEPTABLE',
  'ESCROW_UNACCEPTABLE',
  'TIMEOUT_UNACCEPTABLE',
  'INSUFFICIENT_BALANCE',
  'STRATEGY_MISMATCH',
  'AGENT_BUSY',
  'OTHER',
] as const;
export type DealRejectReason = (typeof DEAL_REJECT_REASONS)[number];

export interface DealTerms {
  readonly proposer_pubkey: string;
  readonly acceptor_pubkey: string;
  readonly proposer_intent_id: string;
  readonly acceptor_intent_id: string;
  readonly base_asset: string;
  readonly quote_asset: string;
  readonly rate: number;
  readonly volume: number;
  readonly escrow_address: string;
  readonly deposit_timeout_sec: number;
  readonly created_ms: number;
}

export interface NpMessage {
  readonly np_version: string;
  readonly msg_id: string;
  readonly deal_id: string;
  readonly ts_ms: number;
  readonly sender_pubkey: string;
  readonly type: NpMessageType;
  readonly payload: Record<string, unknown>;
  readonly signature: string;
}

export interface NpProposeDealPayload {
  readonly terms: DealTerms;
  readonly proposer_swap_address: string;
  readonly message: string;
}

export interface NpAcceptDealPayload {
  readonly acceptor_swap_address: string;
  readonly message: string;
}

export interface NpRejectDealPayload {
  readonly reason_code: DealRejectReason;
  readonly message: string;
}

// DealState defined in Section 6.2
export const DEAL_STATES = [
  'PROPOSED', 'ACCEPTED', 'EXECUTING',
  'COMPLETED', 'FAILED', 'CANCELLED',
] as const;
export type DealState = (typeof DEAL_STATES)[number];
```

---

## 4. Extended ACP Commands for Trader

### 4.1 Overview

These commands are sent by the owner (controller) to the trader agent via
the existing ACP-0 `acp.command` mechanism. The host manager relays them
through HMCP-0 `hm.command`. The command name is in `payload.name` and
parameters are in `payload.params`, consistent with the existing
`AcpCommandPayload` interface.

### 4.2 Command: CREATE_INTENT

Creates a new trading intent and publishes it to the MarketModule.

**Request params:**

```typescript
interface CreateIntentParams {
  readonly direction: 'buy' | 'sell';
  readonly base_asset: string;
  readonly quote_asset: string;
  readonly rate_min: number;
  readonly rate_max: number;
  readonly volume_min: number;
  readonly volume_max: number;
  readonly escrow_address?: string;       // default: "any"
  readonly deposit_timeout_sec?: number;  // default: 300
  readonly expiry_sec: number;            // seconds from now until expiry
}
```

The handler maps these params to a `PostIntentRequest` (see Section 2.4)
and calls `MarketModule.postIntent()`. The returned `market_intent_id`
is stored in the local `TradingIntent`.

**Result:**

```typescript
interface CreateIntentResult {
  readonly intent_id: string;
  readonly market_intent_id: string;
  readonly state: 'ACTIVE';
  readonly expiry_ms: number;
  readonly created_ms: number;
}
```

**Error codes:**
- `INVALID_PARAM` -- validation failure (details in `message`)
- `ASSET_UNKNOWN` -- unrecognized asset identifier
- `INSUFFICIENT_BALANCE` -- agent does not hold enough of the offered asset
- `MAX_INTENTS_REACHED` -- agent has too many active intents

### 4.3 Command: CANCEL_INTENT

Cancels an active intent and removes it from the MarketModule via
`closeIntent(market_intent_id)`.

**Request params:**

```typescript
interface CancelIntentParams {
  readonly intent_id: string;
  readonly reason?: string;   // default: "cancelled by owner"
}
```

**Result:**

```typescript
interface CancelIntentResult {
  readonly intent_id: string;
  readonly state: 'CANCELLED';
  readonly volume_filled: number;  // how much was filled before cancellation
}
```

**Error codes:**
- `INTENT_NOT_FOUND` -- no intent with this ID
- `INTENT_NOT_ACTIVE` -- intent is already filled, cancelled, or expired
- `DEAL_IN_PROGRESS` -- intent has an active deal; cancel the deal first

### 4.4 Command: LIST_INTENTS

Lists intents owned by this agent.

**Request params:**

```typescript
interface ListIntentsParams {
  readonly filter?: 'active' | 'filled' | 'cancelled' | 'expired' | 'all';  // default: "all"
  readonly limit?: number;   // default: 50, max: 200
  readonly offset?: number;  // default: 0
}
```

**Result:**

```typescript
interface ListIntentsResult {
  readonly intents: readonly IntentSummary[];
  readonly total: number;
}

interface IntentSummary {
  readonly intent_id: string;
  readonly direction: 'buy' | 'sell';
  readonly base_asset: string;
  readonly quote_asset: string;
  readonly rate_min: number;
  readonly rate_max: number;
  readonly volume_max: number;
  readonly volume_filled: number;
  readonly state: IntentState;
  readonly expiry_ms: number;
  readonly created_ms: number;
  readonly active_deals: number;
}
```

### 4.5 Command: LIST_SWAPS

Lists swap deals this agent is participating in.

**Request params:**

```typescript
interface ListSwapsParams {
  readonly filter?: 'active' | 'completed' | 'failed' | 'all';  // default: "all"
  readonly limit?: number;   // default: 50, max: 200
  readonly offset?: number;  // default: 0
}
```

**Result:**

```typescript
interface ListSwapsResult {
  readonly deals: readonly DealSummary[];
  readonly total: number;
}

interface DealSummary {
  readonly deal_id: string;
  readonly counterparty_pubkey: string;
  readonly base_asset: string;
  readonly quote_asset: string;
  readonly rate: number;
  readonly volume: number;
  readonly state: DealState;
  readonly role: 'proposer' | 'acceptor';
  readonly swap_id: string | null;
  readonly created_ms: number;
  readonly updated_ms: number;
}
```

### 4.6 Command: SET_STRATEGY

Configures the agent's autonomous trading behavior.

**Request params:**

```typescript
interface SetStrategyParams {
  readonly auto_match?: boolean;           // enable automatic intent matching (default: true)
  readonly auto_negotiate?: boolean;       // auto-accept deals within strategy bounds (default: false)
  readonly max_concurrent_swaps?: number;  // max simultaneous swaps (default: 3, max: 10)
  readonly max_active_intents?: number;    // max simultaneous intents (default: 20, max: 100)
  readonly min_profit_margin?: number;     // minimum rate improvement over own intent (default: 0)
  readonly min_search_score?: number;      // minimum semantic similarity score for matching (default: 0.6, range: 0-1)
  readonly market_api_url?: string;        // market API URL (default: "https://market-api.unicity.network")
  readonly trusted_escrows?: readonly string[];  // list of trusted escrow pubkeys
  readonly blocked_counterparties?: readonly string[];  // manually blocklisted pubkeys
}
```

**Result:**

```typescript
interface SetStrategyResult {
  readonly strategy: SetStrategyParams;  // echoes back the full merged strategy
}
```

**Error codes:**
- `INVALID_PARAM` -- value out of range or wrong type

### 4.7 Command: GET_PORTFOLIO

Returns the agent's current token holdings and balances. Balance data
comes from `PaymentsModule.getBalance()` (the SDK's authoritative view);
the reservation breakdown comes from the `VolumeReservationLedger`.

**Request params:**

```typescript
type GetPortfolioParams = Record<string, never>;  // no params
```

**Result:**

```typescript
interface GetPortfolioResult {
  readonly agent_pubkey: string;
  readonly agent_address: string;
  readonly balances: readonly AssetBalance[];
  readonly reserved: readonly VolumeReservation[];
  readonly updated_ms: number;
}

interface AssetBalance {
  readonly asset: string;
  readonly available: number;   // PaymentsModule.getBalance() total minus VolumeReservationLedger sum
  readonly total: number;       // PaymentsModule.getBalance() totalAmount
  readonly confirmed: number;   // PaymentsModule.getBalance() confirmedAmount
  readonly unconfirmed: number; // PaymentsModule.getBalance() unconfirmedAmount
}

interface VolumeReservation {
  readonly asset: string;
  readonly amount: number;
  readonly deal_id: string;     // deal that reserved this volume
}
```

### 4.8 Deposits (Owner → Agent)

Deposits do **NOT** use an ACP command. The owner sends tokens directly
to the agent's Sphere address using `PaymentsModule.send()`:

```typescript
// Owner's side (external to the agent):
await ownerSphere.payments.send({
  recipient: agentDirectAddress,   // agent's DIRECT:// address
  coinId: 'ALPHA',
  amount: '1000000',
});
```

The agent's `PaymentsModule` automatically receives the transfer via its
Nostr transport subscription (Kind 31113 token transfer events). No
explicit `receive()` call is needed during normal operation — the SDK's
`handleIncomingTransfer()` processes arrivals in real-time.

The agent's balance updates immediately. The owner can verify receipt by
sending a `STATUS` or `GET_PORTFOLIO` ACP command.

**Fallback:** If the agent was offline when the owner sent, calling
`PaymentsModule.receive()` on startup polls the relay for pending events.
The standard `AcpListener.start()` flow already initializes the Sphere
SDK, which sets up the transport subscription.

### 4.9 Command: WITHDRAW_TOKEN

Owner requests the agent to transfer tokens back to a specified address.
The agent calls `PaymentsModule.send()` which handles split/join
transparently via `TokenSplitCalculator`.

**Request params:**

```typescript
interface WithdrawTokenParams {
  readonly asset: string;
  readonly amount: string;         // amount in smallest units
  readonly to_address: string;     // @nametag, DIRECT://, or secp256k1 pubkey
}
```

**Result:**

```typescript
interface WithdrawTokenResult {
  readonly asset: string;
  readonly amount: string;
  readonly to_address: string;
  readonly transfer_id: string;    // SDK transfer ID for tracking
  readonly remaining_balance: string;
}
```

**Error codes:**
- `INSUFFICIENT_BALANCE` -- not enough available (unreserved) balance
- `INVALID_ADDRESS` -- `to_address` cannot be resolved
- `WITHDRAWAL_BLOCKED` -- active swap reservations prevent full withdrawal
- `TRANSFER_FAILED` -- PaymentsModule.send() returned an error

---

## 5. Intent Matching Rules

### 5.0 Hybrid Matching Strategy

Intent matching uses a two-phase approach combining the MarketModule's
semantic search with client-side exact filtering:

1. **Phase 1 -- Semantic search (server-side):** The agent constructs a
   natural language query from its own intent parameters and calls
   `MarketModule.search()` with appropriate filters (`intentType`,
   `category`, `minPrice`, `maxPrice`). The MarketModule returns results
   ranked by cosine similarity score (0-1).

2. **Phase 2 -- Exact filtering (client-side):** The agent parses the
   `description` field of each search result to extract structured trading
   parameters (rate range, volume range, escrow address). It then applies
   the deterministic matching criteria below to confirm compatibility.

The `minScore` parameter in `SearchOptions` controls the semantic match
quality threshold. Recommended default: `0.6`. Agents MAY adjust this
via the `SET_STRATEGY` command to trade off match quantity vs. quality.

In addition to periodic search-based scans, the agent subscribes to
`MarketModule.subscribeFeed()` for real-time notifications of new intents.
Each incoming feed item is evaluated against all own active intents.

### 5.1 Matching Criteria

Two intents A and B match if and only if ALL of the following hold:

1. **Opposite directions:** `A.direction != B.direction`
2. **Same asset pair:** `A.base_asset == B.base_asset AND A.quote_asset == B.quote_asset`
3. **Overlapping rate ranges:** `A.rate_min <= B.rate_max AND B.rate_min <= A.rate_max`
4. **Sufficient volume:** `min(A.available, B.available) >= max(A.volume_min, B.volume_min)`
   where `available = volume_max - volume_filled`
5. **Both active:** Both intents are in state `ACTIVE` or `PARTIALLY_FILLED`
6. **Not expired:** `A.expiry_ms > now AND B.expiry_ms > now`
7. **Compatible escrow:** `A.escrow_address == "any" OR B.escrow_address == "any" OR A.escrow_address == B.escrow_address`
8. **Different agents:** `A.agent_pubkey != B.agent_pubkey` (no self-matching)

### 5.2 Rate Agreement

When two intents match, the agreed rate is determined as follows:

```
overlap_min = max(A.rate_min, B.rate_min)
overlap_max = min(A.rate_max, B.rate_max)

agreed_rate = floor((overlap_min + overlap_max) / 2)
```

Rationale: The midpoint of the overlapping range splits the surplus evenly
between both parties, avoiding asymmetric advantage. This is deterministic
and reproducible by both sides independently.

The acceptor MAY reject the proposal with `RATE_UNACCEPTABLE` if the
computed midpoint rate is unfavorable given the acceptor's current strategy
(e.g., `min_profit_margin` not met). This allows agents to opt out of
marginal trades without requiring protocol changes.

### 5.3 Volume Agreement

```
available_a = A.volume_max - A.volume_filled
available_b = B.volume_max - B.volume_filled
agreed_volume = min(available_a, available_b)
```

The volume is the maximum that both parties can fill. If `agreed_volume < max(A.volume_min, B.volume_min)`, the match fails criterion 4.

### 5.4 Escrow Agreement

```
if A.escrow_address != "any" AND B.escrow_address != "any":
    agreed_escrow = A.escrow_address    // must be equal per criterion 7
elif A.escrow_address != "any":
    agreed_escrow = A.escrow_address
elif B.escrow_address != "any":
    agreed_escrow = B.escrow_address
else:
    agreed_escrow = default_escrow      // from agent strategy config
```

### 5.5 Match Priority

When multiple intents match a given intent, they are ranked by:

1. **Best rate** -- For a buy intent, match with the lowest sell rate.
   For a sell intent, match with the highest buy rate.
2. **Time priority** -- Among equal rates, the earlier `created_ms` wins.
3. **Volume preference** -- Among equal rate and time, prefer the match
   that fills more volume.

Formally, for a buy intent B matching against sell intents S1, S2, ...:

```
sort(matches, by: [
    S.rate_min ASC,         // lowest ask first
    S.created_ms ASC,       // earlier first
    S.available DESC,       // larger volume first
])
```

For a sell intent S matching against buy intents B1, B2, ...:

```
sort(matches, by: [
    B.rate_max DESC,        // highest bid first
    B.created_ms ASC,       // earlier first
    B.available DESC,       // larger volume first
])
```

### 5.6 Matching Algorithm (Pseudocode)

```
async function findMatches(intent: Intent, marketModule: MarketModule): Match[] {
    // Phase 1: Semantic search via MarketModule
    const oppositeType = intent.direction == 'buy' ? 'sell' : 'buy'
    const query = `${oppositeType == 'sell' ? 'Selling' : 'Buying'} ${intent.base_asset} for ${intent.quote_asset}`
    const results = await marketModule.search(query, {
        filters: {
            intentType: oppositeType,
            category: `${intent.base_asset}/${intent.quote_asset}`,
            minPrice: intent.rate_min,
            maxPrice: intent.rate_max,
        },
        limit: 50,
        minScore: strategy.min_search_score ?? 0.6,
    })

    // Phase 2: Client-side exact filtering
    let candidates = results
        .map(r => parseSearchResult(r))  // extract rate/volume/escrow from description
        .filter(other =>
            other != null &&
            other.agent_pubkey != intent.agent_pubkey &&
            other.expiry_ms > now() &&
            intent.rate_min <= other.rate_max &&
            other.rate_min <= intent.rate_max &&
            isEscrowCompatible(intent, other)
        )

    let matches = candidates
        .map(other => ({
            intent: other,
            available: other.volume_max - other.volume_filled,
            overlap_min: max(intent.rate_min, other.rate_min),
            overlap_max: min(intent.rate_max, other.rate_max),
            score: other.search_score,  // semantic similarity from Phase 1
        }))
        .filter(m =>
            min(m.available, intent.volume_max - intent.volume_filled)
                >= max(intent.volume_min, m.intent.volume_min)
        )

    // Sort by priority (best rate first, then time, then volume)
    if intent.direction == 'buy':
        matches.sort(by: [m.intent.rate_min ASC, m.intent.created_ms ASC, m.available DESC])
    else:
        matches.sort(by: [m.intent.rate_max DESC, m.intent.created_ms ASC, m.available DESC])

    return matches
}
```

### 5.7 Simultaneous Match Race Resolution

When two agents independently match each other's intents and both attempt
to propose a deal, a race condition occurs. To resolve this deterministically:

**Proposer selection rule:** The agent with the lexicographically LOWER
`agent_pubkey` (compared as lowercase hex strings) is always the proposer.
The other agent MUST wait for an incoming `np.propose_deal` rather than
sending its own.

If an agent determines it should be the acceptor (its pubkey is
lexicographically higher), it MUST NOT send `np.propose_deal` for that
intent pair and instead wait up to 30 seconds for the proposer's message.

**Duplicate deal guard:** An acceptor MUST reject an incoming
`np.propose_deal` if it already has a non-terminal deal (PROPOSED, ACCEPTED,
or EXECUTING) for the referenced `acceptor_intent_id`. The rejection
reason code is `AGENT_BUSY`.

---

## 6. State Machines

### 6.1 Intent Lifecycle

```
                              +-----------+
                              |   DRAFT   |
                              +-----+-----+
                                    |
                          [postIntent() call]
                                    |
                                    v
                              +-----------+
                  +---------->|  ACTIVE   |<----------+
                  |           +-----+-----+           |
                  |                 |                  |
                  |     [match found]  [cancel cmd]   |
                  |          |              |          |
                  |          v              v          |
                  |   +----------+   +-----------+    |
                  |   | MATCHING |   | CANCELLED |    |
                  |   +----+-----+   +-----------+    |
                  |        |                          |
                  |  [deal proposed]                   |
                  |        v                          |
                  |  +-------------+                  |
                  |  | NEGOTIATING |---[deal fails]---+
                  |  +------+------+
                  |         |
                  |   [deal completes, partial fill]
                  |         v
                  |  +------------------+
                  +--| PARTIALLY_FILLED |--[all volume filled]--+
                     +------------------+                       |
                                                                v
                                                          +--------+
                              [expiry_ms reached]         | FILLED |
                              from ACTIVE,                +--------+
                              PARTIALLY_FILLED
                                    |
                                    v
                              +---------+
                              | EXPIRED |
                              +---------+
```

#### Intent State Transition Table

| From | To | Guard | Side Effect |
|---|---|---|---|
| DRAFT | ACTIVE | Intent validated, signature valid | Call `MarketModule.postIntent()` |
| ACTIVE | MATCHING | Match found by matching engine | Reserve volume via `VolumeReservationLedger` |
| ACTIVE | CANCELLED | Owner sends CANCEL_INTENT | Call `MarketModule.closeIntent()`, release reservations |
| ACTIVE | EXPIRED | `now >= expiry_ms` | Call `MarketModule.closeIntent()` with reason "expired" |
| MATCHING | NEGOTIATING | `np.propose_deal` sent | -- |
| MATCHING | ACTIVE | Match rejected or timed out (30s) | Release reservation via `VolumeReservationLedger`, retry matching |
| NEGOTIATING | PARTIALLY_FILLED | Deal completes, `volume_filled < volume_max` | Update local state, close intent if fully filled, update volume |
| NEGOTIATING | FILLED | Deal completes, `volume_filled >= volume_max` | Update local state, close intent if fully filled |
| NEGOTIATING | ACTIVE | Deal rejected or failed | Release reservation via `VolumeReservationLedger`, resume matching |
| PARTIALLY_FILLED | MATCHING | New match found | Reserve remaining volume via `VolumeReservationLedger` |
| PARTIALLY_FILLED | CANCELLED | Owner sends CANCEL_INTENT | Call `MarketModule.closeIntent()` |
| PARTIALLY_FILLED | FILLED | Deal completes remaining volume | Update local state, close intent if fully filled |
| PARTIALLY_FILLED | EXPIRED | `now >= expiry_ms` | Call `MarketModule.closeIntent()` with reason "expired" |

**Terminal states:** FILLED, CANCELLED, EXPIRED.

### 6.2 Deal Lifecycle

```
    np.propose_deal
          |
          v
    +----------+
    | PROPOSED |---[np.reject_deal / timeout 30s]---> CANCELLED
    +----+-----+
         |
    [np.accept_deal]
         v
    +----------+
    | ACCEPTED |---[pingEscrow() fails]---> FAILED (ESCROW_UNREACHABLE)
    +----+-----+---[timeout 60s]----------> CANCELLED
         |
    [pingEscrow() succeeds, SwapModule.proposeSwap()]
         v
    +-----------+
    | EXECUTING |---[swap:failed/cancelled]---> FAILED
    +-----+-----+--[timeout: deposit_timeout_sec + 60s]---> FAILED
          |
    [swap:completed]
          v
    +-----------+
    | COMPLETED |
    +-----------+
```

In the `EXECUTING` state, no NP-0 DMs are exchanged. The proposer calls
`SwapModule.proposeSwap(deal)` and the counterparty listens for a
`swap:proposal_received` event and calls `SwapModule.acceptSwap()`. The
SwapModule's own DM protocol handles all swap coordination. The agent
listens to SwapModule events (`swap:completed`, `swap:failed`,
`swap:cancelled`) to transition the deal to its terminal state.

Before transitioning from ACCEPTED to EXECUTING, the proposer calls
`swapModule.pingEscrow(escrowAddress, 10000)` to verify the escrow is
responsive. If the ping fails, the deal transitions to FAILED with
reason `ESCROW_UNREACHABLE`.

#### Deal State Transition Table

| From | To | Trigger | Guard | Side Effect |
|---|---|---|---|---|
| PROPOSED | ACCEPTED | `np.accept_deal` | Sender is acceptor | Start escrow check |
| PROPOSED | CANCELLED | `np.reject_deal` | Sender is acceptor | Notify proposer, release reservation |
| PROPOSED | CANCELLED | Timeout (30s) | No response received | Release reservation, return to matching |
| ACCEPTED | EXECUTING | `pingEscrow()` succeeds | -- | Call `SwapModule.proposeSwap(deal)`, counterparty calls `acceptSwap()` |
| ACCEPTED | FAILED | `pingEscrow()` fails | Escrow unreachable | Release reservation, reason `ESCROW_UNREACHABLE` |
| ACCEPTED | CANCELLED | Timeout (60s) | No escrow response | Release reservation |
| ACCEPTED | CANCELLED | `np.reject_deal` | Either party cancels | Release reservation |
| EXECUTING | COMPLETED | SwapModule emits `swap:completed` | -- | Release reservation, update intent fill, close intent via MarketModule if fully filled |
| EXECUTING | FAILED | SwapModule emits `swap:failed` or `swap:cancelled` | -- | Release reservation, log failure |
| EXECUTING | FAILED | Timeout (`deposit_timeout_sec + 60s`) | No swap completion within deadline | Release reservation |

**Terminal states:** COMPLETED, FAILED, CANCELLED.

### 6.3 Cross-Machine Interaction: Intent + Deal

A single intent may spawn multiple sequential deals (partial fills). The
constraint is:

- An intent may have at most ONE deal in a non-terminal state at any time.
- When a deal reaches a terminal state, the intent transitions back to
  `ACTIVE` or `PARTIALLY_FILLED` (if volume remains) to allow re-matching.
- Volume reserved for a deal is released via `VolumeReservationLedger` if the deal fails or is cancelled.

```
Intent: ACTIVE ---> MATCHING ---> NEGOTIATING ---> PARTIALLY_FILLED
                                       |                  |
                        Deal: PROPOSED -> ... -> COMPLETED |
                                                          |
                                    MATCHING <------------+
                                       |
                        Deal: PROPOSED -> ... -> COMPLETED
                                                          |
                                                     FILLED
```

---

## 7. Security and Validation

### 7.1 Intent Authentication

Intent posting and cancellation are authenticated at two levels:

**Server-side (MarketModule API):** The market API verifies secp256k1
ECDSA signed requests via `x-signature`, `x-public-key`, and
`x-timestamp` headers. This prevents:

- **Spoofing**: An attacker cannot post or close intents on behalf of
  another agent. The market API rejects requests with invalid signatures.
- **Replay**: The `x-timestamp` header is checked for freshness.

**Client-side (local signature):** Every intent also carries an ECDSA
signature over its content-addressed `intent_id`. This provides:

- **Tamper detection**: Any agent receiving a search result can recompute
  the `intent_id` from the `description` fields and verify the signature
  against the `agentPublicKey`.
- **Non-repudiation**: The signature binds the agent to the intent terms,
  which is used during NP-0 negotiation.

**Verification procedure (by matching agents):**

```
1. Parse structured fields from the description (Section 2.8)
2. Recompute intent_id from canonical JSON of parsed fields (Section 2.5)
3. Verify ECDSA signature over bytes(intent_id) against agentPublicKey
4. Verify agentPublicKey is a valid secp256k1 compressed key (02/03 prefix)
```

### 7.2 Anti-Griefing Defenses

Anti-griefing defenses (reputation tracking, progressive trust, deposit-first strategies) are deferred to a future protocol version.

### 7.3 Rate and Volume Bound Enforcement

```
// On intent creation:
assert(rate_min > 0)
assert(rate_max >= rate_min)
assert(volume_min > 0)
assert(volume_max >= volume_min)
assert(volume_filled == 0)

// On intent update:
assert(new_volume_filled >= old_volume_filled)  // fills are irreversible
assert(new_volume_max >= new_volume_filled)
assert(new_rate_min > 0)
assert(new_rate_max >= new_rate_min)
assert(new_seq > old_seq)

// On deal proposal:
assert(rate >= overlap_min AND rate <= overlap_max)
assert(volume >= max(A.volume_min, B.volume_min))
assert(volume <= min(A.available, B.available))
```

### 7.4 Expiry Enforcement

- Agents MUST NOT match intents where `expiry_ms <= now`.
- Agents MUST NOT accept deals referencing expired intents.
- The matching engine runs an expiry sweep every 10 seconds, transitioning
  expired intents to the `EXPIRED` state.
- Agents MUST independently verify `expiry_ms > now` on search results
  before considering them for matching.

### 7.5 Escrow Security

All token exchanges use the Sphere SDK SwapModule's escrow mechanism:

1. The SwapModule internally handles consent signing via `signSwapManifest()`.
2. Tokens are deposited to the escrow address, not directly to the counterparty.
3. The escrow releases tokens only when both deposits are confirmed.
4. Deposit timeouts trigger automatic refund.
5. The `trusted_escrows` strategy parameter restricts which escrows an agent
   will use, preventing routing through untrusted intermediaries.

### 7.6 Message Authentication

All NP-0 messages carry an ECDSA signature in the envelope. Every receiver
MUST verify:

```
1. signature verifies against sender_pubkey
2. sender_pubkey is a participant in the referenced deal_id
3. msg_id is unique (deduplication via sliding window of recent msg_ids)
4. ts_ms is within 300,000 ms of local time (clock skew tolerance)
```

### 7.7 Denial of Service Mitigations

| Attack Vector | Mitigation |
|---|---|
| Intent flood | `max_active_intents` strategy cap; market API rate limiting + secp256k1 auth |
| Proposal flood | Max 3 pending proposals per counterparty per 60s |
| Stale intent book pollution | Automatic expiry sweep; max intent lifetime 7 days |
| Fake intent griefing | Deferred to a future protocol version (Section 7.2) |
| Large message payloads | 64 KiB message size limit (consistent with existing protocols) |
| Replay attacks | `msg_id` deduplication window (see below); `ts_ms` clock skew check |

**Replay deduplication window:** Agents MUST maintain a deduplication window
of at least 600 seconds (10 minutes) and at least 10,000 entries. Messages
with `ts_ms` older than the deduplication window MUST be rejected. The
deduplication store maps `msg_id` to `ts_ms` and evicts entries older than
the window on each insert.

### 7.8 Dangerous Key Rejection

Consistent with the existing `hasDangerousKeys()` function in `envelope.ts`,
all TIP-0 and NP-0 message parsers MUST reject messages containing
`__proto__`, `constructor`, or `prototype` keys at any nesting depth. Maximum
nesting depth is 20 levels.

### 7.9 Known Risks and Recommended Mitigations

This section documents known asset-loss risks identified during security
audit. Implementors MUST understand these risks before deploying with real
assets.

#### 7.9.1 Escrow Trust (CRITICAL)

The swap protocol depends on a trusted escrow service to hold deposits and
release payouts. This introduces three critical failure modes:

| Risk | Impact | Recommended Mitigation |
|------|--------|----------------------|
| **Escrow disappears** after receiving deposits | Irrecoverable fund loss — no on-chain reclaim mechanism | Implement time-locked on-chain escrow using L4 state-transition predicates with automatic refund after timeout |
| **Partial execution** — escrow pays one party but crashes before paying the other | One party loses deposited tokens | Escrow must implement atomic payout execution (both payouts in a single L2 BFT round) or two-phase commit |
| **Escrow key compromise** — attacker forges payout invoices | All escrowed funds stolen | Support multi-sig escrow (M-of-N operators); implement escrow transparency logs |

**Current state:** The `trusted_escrows` strategy parameter restricts which
escrows the agent will use, and the SwapModule verifies escrow sender
identity. However, these are trust-based mitigations, not cryptographic
guarantees. A production deployment SHOULD use an on-chain escrow
mechanism when available.

#### 7.9.2 Payout Verification (CRITICAL)

The SwapModule emits `swap:completed` with a `payoutVerified` boolean.
If payout verification fails (transient L3 error, wallet corruption),
the event fires with `payoutVerified: false`.

**Risk:** The SwapExecutor may update `volume_filled` and release the
`VolumeReservationLedger` reservation without confirmed receipt of tokens.

**Required implementation:** The SwapExecutor MUST:
1. Check `payoutVerified === true` before updating `volume_filled`.
2. If `payoutVerified === false`, keep the deal in EXECUTING state.
3. Retry `verifyPayout()` periodically (e.g., every 30 seconds, max 10 retries).
4. If verification fails after all retries, escalate to the owner via
   ACP status and transition to FAILED.

#### 7.9.3 Deposit Idempotency (CRITICAL)

If the agent crashes between `payInvoice()` (deposit sent) and persisting
the deposit state, crash recovery may re-attempt the deposit, resulting
in double payment to the escrow.

**Required implementation:**
1. Persist a `deposit_attempted: true` flag BEFORE calling `payInvoice()`.
2. On crash recovery, if `deposit_attempted` is true but
   `localDepositTransferId` is missing, query the escrow via
   `getSwapStatus({ queryEscrow: true })` before re-depositing.
3. Only re-deposit if the escrow confirms the deposit was NOT received.

#### 7.9.4 NP-0 to SwapModule Term Binding (HIGH)

The NP-0 `deal_id` and the SwapModule `swap_id` are computed from
different field sets with no explicit binding. A malicious proposer
could negotiate favorable terms via NP-0 then submit different terms
to the SwapModule.

**Required implementation:** On `swap:proposal_received`, the
SwapExecutor MUST compare the received `SwapDeal` fields
(`partyACurrency`, `partyAAmount`, `partyBCurrency`, `partyBAmount`,
`timeout`) against the stored NP-0 `DealTerms`. Reject the swap if
any field diverges.

#### 7.9.5 Protocol Version (HIGH)

The SwapModule accepts both v1 and v2 proposals. Protocol v1 lacks
mutual consent signatures and does not bind `escrow_address` in the
`swap_id` computation, enabling MITM address substitution.

**Required implementation:** The SwapModule does not expose a
`minimum_protocol_version` configuration option — it accepts both v1
and v2 proposals unconditionally. The trader agent's `SwapExecutor`
MUST check `protocolVersion` on every `swap:proposal_received` event
and call `rejectSwap()` for any proposal where `protocolVersion !== 2`.
Outgoing proposals always use v2 (the SwapModule defaults to v2 for
`proposeSwap()`).

#### 7.9.6 Volume Reservation Atomicity (HIGH)

Concurrent match evaluations can race on `VolumeReservationLedger`:
two evaluations may both read the same available balance and both
reserve, resulting in over-commitment beyond actual holdings.

**Required implementation:** All `reserve()` calls MUST be serialized
(e.g., via async mutex). The `reserve()` method must re-check
`getAvailable()` after acquiring the lock, not before. Invariant:
`sum(reservations[coinId]) <= PaymentsModule.getBalance(coinId)`.

#### 7.9.7 Nostr DM Delivery (HIGH)

Nostr relay delivery is best-effort. If the escrow's payout
`invoice_delivery` DM is lost, the agent never receives its payout
tokens despite the escrow having executed the release.

**Recommended mitigation:**
1. Use multiple redundant Nostr relays for escrow communication.
2. On startup and periodically, query escrow status for all
   non-terminal swaps to catch missed DMs.
3. The escrow should retain records for at least 30 days.

#### 7.9.8 Container Lifecycle (HIGH)

If the host manager kills the container with SIGKILL during a deposit,
graceful shutdown does not run and in-memory state is lost.

**Required implementation:**
1. The host manager MUST send SIGTERM and wait (default 30s) before
   SIGKILL when stopping a trader container.
2. The `hm.stop` handler SHOULD check for active swaps and send
   `SHUTDOWN_GRACEFUL` via ACP before stopping the container.
3. This is already the default behavior in the host manager's
   `stop()` implementation.

#### 7.9.9 Front-Running (HIGH)

All intents are publicly searchable via the MarketModule API. An
attacker can observe large intents and front-run by trading ahead
of the intended counterparty.

**Accepted risk for MVP.** Future mitigations: blinded intents with
commit-reveal schemes, or private intents shared only with known
counterparties via NIP-17 DMs.

#### 7.9.10 Griefing via Non-Deposit (HIGH)

An attacker posts fake intents, engages in NP-0 negotiation, accepts
the swap, then never deposits. The victim's tokens are locked in
escrow for up to `deposit_timeout_sec` (max 300 seconds).

**Accepted risk for MVP.** The 300-second max timeout and
`max_concurrent_swaps` (default 3) limit exposure. Anti-griefing
defenses (reputation, progressive trust, deposit-first strategies)
are deferred to a future protocol version (see Section 7.2).

---

## Appendix A: Canonical JSON Serialization

Content-addressed identifiers (intent_id, deal_id) require deterministic
JSON serialization. The canonical form is:

1. Keys sorted lexicographically (Unicode code point order).
2. No whitespace between tokens.
3. Numbers serialized as `JSON.stringify()` with no trailing zeros.
4. Strings use minimal escaping (only characters that MUST be escaped per RFC 8259).
5. No `undefined` values; omit optional fields rather than setting to `null`.

Implementation: `JSON.stringify(obj, Object.keys(obj).sort())` is sufficient
for flat objects. For nested objects, apply recursively.

```typescript
function canonicalJson(obj: Record<string, unknown>): string {
  return JSON.stringify(obj, (_, value) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[key] = (value as Record<string, unknown>)[key];
      }
      return sorted;
    }
    return value;
  });
}
```

---

## Appendix B: Error Codes

### B.1 ACP Command Error Codes (Trader Extensions)

| Code | HTTP Analog | Description |
|---|---|---|
| `INVALID_PARAM` | 400 | Missing, malformed, or out-of-range parameter |
| `INTENT_NOT_FOUND` | 404 | No intent with the given intent_id |
| `INTENT_NOT_ACTIVE` | 409 | Intent is in a terminal or non-modifiable state |
| `DEAL_IN_PROGRESS` | 409 | Cannot cancel intent while a deal is active |
| `ASSET_UNKNOWN` | 400 | Unrecognized asset identifier |
| `INSUFFICIENT_BALANCE` | 409 | Not enough available (unlocked) tokens |
| `MAX_INTENTS_REACHED` | 429 | Agent has reached max_active_intents |
| `INVALID_TXF` | 400 | TXF data cannot be parsed |
| `PROOF_INVALID` | 400 | Inclusion proof does not verify |
| `ASSET_MISMATCH` | 400 | Declared asset does not match TXF content |
| `TRANSFER_NOT_TO_AGENT` | 403 | TXF recipient is not the agent's pubkey |
| `INVALID_ADDRESS` | 400 | Destination address is not a valid pubkey |
| `WITHDRAWAL_LOCKED` | 409 | Active swaps prevent withdrawal |
| `TRANSFER_FAILED` | 500 | State transition SDK error during transfer |

### B.2 NP-0 Deal Rejection Reason Codes

| Code | Description |
|---|---|
| `RATE_UNACCEPTABLE` | Proposed rate is outside strategy bounds |
| `VOLUME_UNACCEPTABLE` | Proposed volume is too small or too large |
| `ESCROW_UNACCEPTABLE` | Proposed escrow is not in trusted list |
| `TIMEOUT_UNACCEPTABLE` | Deposit timeout is too short or too long |
| `INSUFFICIENT_BALANCE` | Acceptor does not have enough tokens |
| `STRATEGY_MISMATCH` | Deal violates agent's strategy configuration |
| `AGENT_BUSY` | Agent has reached max_concurrent_swaps |
| `OTHER` | Catch-all; details in message field |

### B.3 Deal Failure Reason Codes

| Code | Description |
|---|---|
| `DEPOSIT_TIMEOUT` | One or both parties failed to deposit within timeout |
| `ESCROW_REJECTED` | Escrow rejected the deposit or consent |
| `ESCROW_UNREACHABLE` | Escrow failed to respond to `pingEscrow()` before swap execution |
| `COUNTERPARTY_UNRESPONSIVE` | Counterparty stopped responding during negotiation |
| `NETWORK_ERROR` | Nostr relay or aggregator connectivity failure |
| `INTERNAL_ERROR` | Unexpected internal error in the agent |

---

## Appendix C: Sequence Diagrams

### C.1 Full Trading Flow: Intent to Completed Swap

```
  Owner           Trader-A         Market API         Trader-B          Escrow
    |                |                  |                 |                |
    |--CREATE_INTENT>|                  |                 |                |
    |<--intent_id----|                  |                 |                |
    |                |--postIntent()-->|                 |                |
    |                |                  |  (B searches or subscribes)     |
    |                |                  |<--search()---- (B finds A)     |
    |                |                  |                 |                |
    |                |  [matching engine detects overlap via search]      |
    |                |                  |                 |                |
    |                |---np.propose_deal (NIP-17 DM)----->|                |
    |                |<--np.accept_deal (NIP-17 DM)-------|                |
    |                |                  |                 |                |
    |                |  [pingEscrow() succeeds]            |                |
    |                |                  |                 |                |
    |                |  [deal -> EXECUTING]                |                |
    |                |  [SwapModule.proposeSwap(deal)]     |                |
    |                |                  |     [swap:proposal_received]    |
    |                |                  |     [SwapModule.acceptSwap()]   |
    |                |                  |                 |                |
    |                |----deposit (SwapModule DM)------------------------->|
    |                |                  |                 |---deposit----->|
    |                |                  |                 |                |
    |                |                  |        [escrow confirms both]   |
    |                |                  |                 |                |
    |                |<----------settlement tokens------------------------|
    |                |                  |                 |<---settlement--|
    |                |                  |                 |                |
    |                |  [swap:completed event]             |                |
    |                |  [deal -> COMPLETED]                |                |
    |                |--closeIntent()-->|                 |                |
    |                |                  |                 |                |
    |<--acp.result---|                  |                 |                |
    |  (fill update) |                  |                 |                |
```

### C.2 Intent Cancellation

```
  Owner           Trader-A         Market API
    |                |                  |
    |--CANCEL_INTENT>|                  |
    |                |--closeIntent()-->|
    |<--cancelled----|                  |
```

### C.3 Deal Rejection

```
  Trader-A                    Trader-B
    |                            |
    |---np.propose_deal--------->|
    |                            |  [strategy check: rate too low]
    |<--np.reject_deal-----------|
    |                            |
    |  [return to ACTIVE,        |
    |   try next match]          |
```

### C.4 Partial Fill Sequence

```
  Trader-A (sell 100 ALPHA)       Trader-B (buy 60 ALPHA)       Trader-C (buy 50 ALPHA)
    |                                |                              |
    |  [match with B: 60 ALPHA]      |                              |
    |---np.propose_deal (60)-------->|                              |
    |       ...swap completes...     |                              |
    |  [intent: PARTIALLY_FILLED]    |                              |
    |  [volume_filled = 60]          |                              |
    |  [available = 40]              |                              |
    |                                |                              |
    |  [match with C: 40 ALPHA (capped by available)]               |
    |---np.propose_deal (40)--------------------------------------->|
    |       ...swap completes...                                    |
    |  [intent: PARTIALLY_FILLED]                                   |
    |  [volume_filled = 100 -> FILLED]                              |
```

---

## Appendix D: Version History

| Version | Date | Changes |
|---|---|---|
| 0.1 | 2026-04-03 | Initial draft |
| 0.2 | 2026-04-03 | Replace NIP-29 group broadcast with MarketModule (semantic search, vector embeddings) |
