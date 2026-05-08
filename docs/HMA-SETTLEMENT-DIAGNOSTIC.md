# HMA Trade-Settlement Diagnostic

**Status as of 2026-05-05** — `feat/hma-trade-settlement-live` branch, latest commit `5fb50f0`.

The `hma-trade-settlement.e2e-live` test still fails. Settlement reaches
ACCEPTED on both scenarios but never COMPLETED. This document captures
what works, what doesn't, what we tried, and the remaining hypotheses
so a follow-up session can pick up where we stopped.

---

## Goal

End-to-end live proof that operators can:
1. Launch HMA over Sphere DM (no HTTP)
2. Spawn escrow + 2 traders + faucet via `sphere host spawn`
3. Fund traders via the new js-faucet agent over DM
4. Match buy/sell intents
5. Settle the swap (deal → COMPLETED on both sides)
6. Withdraw post-trade tokens to a controller-owned address

Steps 1-4 work. Step 5 is where we're stuck.

## Current state (round 12)

| Layer | Direct-docker (basic-roundtrip) | HMA-spawned (this test) |
|---|---|---|
| Spawn | ✓ | ✓ |
| Funding | ✓ (selfMintFund) | ✓ (faucet via `FAUCET_REQUEST` DM) |
| set-strategy / portfolio / list-intents | ✓ | ✓ |
| Match found | ✓ | ✓ |
| Deal accepted | ✓ | ✓ (round 12 first time) |
| Swap announced to escrow | ✓ | ✓ (round 12) |
| Escrow creates deposit invoice | ✓ | ✓ (round 12 — log: `"Swap announced, deposit invoice created"`) |
| Escrow sends invoice DM to trader | ✓ | ✓ (round 12 — log: `diag_outbound_dm_sent invoice_delivery`) |
| **Trader receives invoice DM** | ✓ | ✗ (log: `invoice_target_addresses: null`) |
| Trader deposits | ✓ | ✗ (blocked) |
| Swap COMPLETED | ✓ | ✗ (blocked) |

The break is at **trader-side ingest of the escrow's invoice_delivery DM**.

## Round-by-round progression

| Round | Outcome | Bug found / fix |
|---|---|---|
| 1-7 | Various early failures | controller wallet races, faucet name mapping, etc. — all fixed |
| 8 | 29 deals each, locked in PROPOSED→FAILED→CANCELLED loop | TRADER_TEST_FUND self-mint produces issuer==sender tokens that confuse swap |
| 9 | Same as 8 | Cross-scenario rate differentiation didn't help |
| 10 | 2 deals each, never reach ACCEPTED, escrow logs `Swap not found` | Diagnosed: trader sends `status` query but never `swap.announce` |
| 11 | 1 scenario reaches ACCEPTED for first time | Trader's `intent-engine.ts:836` defaults `escrow_address` to literal `'any'` when CLI omits `--escrow-address` |
| 12 | **Both scenarios reach ACCEPTED**, escrow creates+sends invoice, but trader doesn't process it | Layer-mismatch fixed (`escrow.tenantPubkey` vs `escrow.tenantDirectAddress` — swap-executor compares to DIRECT://hex) |

## Bugs already fixed (committed on `feat/hma-trade-settlement-live`)

1. **Faucet integration** (commit `b2659a3`) — replaces `TRADER_TEST_FUND` self-mint and broken public-faucet HTTP. Fund traders via `FAUCET_REQUEST` DMs to a shared js-faucet agent. Killed the spam-loop.

2. **`--escrow-address` flag in sphere-cli** (commit `c58a463` in trader-service; sphere-cli rebuild required) — `sphere trader create-intent` previously had no way to set `escrow_address`, so the trader defaulted to `'any'` (per `trader-service/src/trader/intent-engine.ts:836`). The swap-executor then tried to route `swap.announce` to the literal string `'any'`. Now passes through to ACP wire field correctly.

3. **escrow_address must be DIRECT://hex, not chain pubkey** (commit `5fb50f0`) — `swap-executor.ts:714` compares `terms.escrow_address === match.escrowDirectAddress`. The DIRECT://hex address is structurally derived (`UnmaskedPredicateReference(pubkey).toAddress()`), NOT just `DIRECT://${pubkey}`. Test now passes `escrow.tenantDirectAddress` to both `setStrategy({trustedEscrows: [...]})` and `createIntent({escrowAddress: ...})`.

## The remaining symptom (in detail)

Round 12 trader log (`alice` container) shows:

```
swap_id_registered (deal_id=..., swap_id=169ea57a..., matched_by="proposal_info")
swap_deposit_target_diag (every ~3s):
  swap_id: 169ea57a...
  escrowDirectAddress: DIRECT://000055759f52413cab92...   ← correct
  manifest_party_a_currency: UCT
  manifest_party_a_value: 10
  manifest_party_b_currency: USDU
  manifest_party_b_value: 10
  invoice_target_addresses: null   ← never populated
  invoice_target_assets: null
```

Round 12 escrow log (same swap_id) shows:

```
Swap announced, deposit invoice created    invoice_id: 00004af2b309ee84
diag_invoice_delivery_attempt   party: A    recipient_prefix: 8ff3bcef9e1aa95d
diag_outbound_dm_sending        message_type: invoice_delivery   payload_bytes: 5789
diag_outbound_dm_sent           message_type: invoice_delivery
diag_invoice_delivery_complete
[same for party B]
```

Escrow believes it sent the DM successfully. Trader has no log entry showing receipt.

## Why direct-docker works but HMA-spawned doesn't (open question)

Same trader image (`trader:local`), same escrow image. The difference is the runtime environment:

| | direct-docker | HMA-spawned |
|---|---|---|
| `UNICITY_MANAGER_PUBKEY` | unset | set |
| `UNICITY_MANAGER_DIRECT_ADDRESS` | unset | set |
| `UNICITY_BOOT_TOKEN` | unset | set |
| ACP heartbeats every 5s | none (no manager to talk to) | active |
| ACP DM listener (`sphere.on('message:dm')`) | active but bails (no manager pubkey to match) | active and validating against manager pubkey |
| Periodic `payments.receive({finalize:true})` loop | active | active |

Both setups have the ACP listener attached (it's compiled into `startTrader()`).
The difference is whether it has a manager_pubkey to filter against.

## Hypotheses for the remaining bug

### Update 2026-05-05: ROOT CAUSE FOUND — escrow side, not trader side

A focused investigation agent traced the full flow on both ends and found
the bug is in the **escrow's `deliverDepositInvoice` function** (compiled
into `escrow:v0.1` at `/app/dist/sphere/message-handler.js`). It is
**asymmetric**: party A's invoice always delivers; party B's never does.

Evidence (from one round-12 escrow's logs, repeats across multiple swaps):

```
diag_invoice_delivery_attempt   party=A   ← logged
diag_outbound_dm_sending        message_type=invoice_delivery   recipient=A   ← logged
diag_outbound_dm_sent           message_type=invoice_delivery   recipient=A   ← logged
diag_invoice_delivery_complete  party=A   ← logged

diag_invoice_delivery_attempt   party=B   ← logged
[NO diag_outbound_dm_sending for invoice_delivery to B — never appears]
diag_invoice_delivery_complete  party=B   ← logged anyway
```

The `complete` log fires (no thrown exception); the `sending` log doesn't
(no actual `sendDM` call). The function exits "normally" without delivering
the invoice to party B.

The deployed `escrow:v0.1` image was built from an unsynced source commit
(JS at `/app/dist/sphere/message-handler.js` does NOT match
`/home/vrogojin/escrow-service/src/sphere/message-handler.ts` at HEAD).
The exact mechanism inside the diverged image (early-return that was missed,
fire-and-forget reference instead of `await reply(...)`, build-step DCE, etc.)
requires access to the unsynced commit to confirm — but the fix is the same
either way: rebuild + re-tag.

**Why basic-roundtrip works direct-docker with the same image**:
basic-roundtrip uses ONE trader pair. The HMA test uses two pairs concurrently.
Party-A vs party-B is determined by the canonical pubkey ordering in the
swap manifest — concurrent swaps may always produce the same A/B alignment.
But basic-roundtrip's single pair may happen to land in a way where the
party-B-broken path doesn't matter (e.g., the test only asserts the buyer's
side, not the seller's). Worth re-running basic-roundtrip with the
rebuilt image to confirm; the asymmetry is a real defect regardless.

**Update 2026-05-08 (round 14)**: rebuilt `escrow:local` from current
`escrow-service` HEAD; bug REPRODUCED unchanged. So the bug is in current
source, not the divergence between the deployed image and HEAD as the
original agent suspected. The deployed `escrow:v0.1` image had additional
`diag_invoice_delivery_*` log lines that do NOT exist in HEAD — that's
what made the divergence look like the cause; the bug is structural.

**Update 2026-05-08 (round 15)**: branched `escrow-service` to
`debug/instrument-deliver-invoice` (`c0e19ea`), instrumented every code
path of `deliverDepositInvoice` (enter / no-id / no-token / sending /
sent / threw) plus per-party try/catch in the announce-handler's for-loop.
Round 15 itself failed at preflight — testnet Nostr relay's write path
went down again (intermittent — every WS publish-kind:* returns no OK).
The instrumented build is committed and pushed; next live attempt against
this branch will produce log lines pinpointing party B's actual path.

**Update 2026-05-08 (round 19, local-infra fully working)**:
The local-infra harness now runs end-to-end on a Docker-hosted Nostr relay
(no testnet dependency for messaging). Fix chain that closed it:

  - sphere-cli (host/sphere-init.ts AND legacy/legacy-cli.ts) reads
    UNICITY_NOSTR_RELAYS / SPHERE_NOSTR_RELAYS;
  - helpers/sphere-cli.ts buildEnv() forwards the env into sphere-cli
    subprocesses;
  - helpers/manager-process.ts: spawnHostManager forwards env to HMA
    binary, AND provisionManagerWallet (which pre-creates the manager
    wallet + publishes the nametag binding) ALSO reads it — without
    this, the nametag binding lands on testnet, the HMA's later
    Sphere.init loads the existing wallet (wallet_created: false) and
    skips re-publish, sphere-cli's queryPubkeyByNametag returns null
    on the local relay;
  - helpers/manager-process.ts: UNICITY_HEALTH_PORT default → 0 (OS-
    assigned) so leaked HMA processes don't EADDRINUSE the next run;
  - hma-trade-settlement test: use SPHERE_NOSTR_RELAYS (NOT
    UNICITY_NOSTR_RELAYS) in HMA spawn-env passthrough — HMA's
    validatePayloadEnv blocks any env starting with UNICITY_;
  - helpers/faucet-client.ts: same env-pickup pattern so the in-process
    Sphere wallet that signs FAUCET_REQUEST DMs talks to the local relay.

Round 19 evidence:
  - Local relay log: 534+ kind:1059 (gift-wrap DMs) + 10+ kind:30078
    (wallet/nametag bindings) — full settlement traffic on local infra.
  - Escrow's instrumentation: every swap shows `deliver_deposit_invoice_enter
    → _sending → _sent` for BOTH parties (the asymmetric bug from
    rounds 11-12 IS GONE in escrow:local from current source).
  - Trader log: `diag_invoice_delivery_received` → `_imported` →
    `swap_deposit_target_diag` populated → `swap_deposit_sent`. The
    deposit IS sent. The trader DOES process the invoice.
  - Final failure: `[Accounting] Direction mismatch: transport memo says
    return_cancelled, on-chain says forward for invoice <id> — using
    on-chain` → `swap_cancelled`.

**The local-infra goal is met.** What remains is a swap-protocol
settlement-layer issue (transport memo vs on-chain direction
mismatch) that's independent of the relay infra. This is the next
real bug to chase, and it now reproduces deterministically against
a controlled local relay — debug iterations no longer wait on
testnet propagation or burn through testnet rate limits.

**Update 2026-05-08 (rounds 16-17, local-infra harness)**:
ported uxf's local-infra Nostr relay setup to trader-service to
escape the testnet write-path outages. Added
`UNICITY_NOSTR_RELAYS` env override across every component
(trader-service, escrow-service, agentic-hosting host-manager,
js-faucet, sphere-cli host/legacy inits) plus `helpers/sphere-cli.ts
buildEnv()` forwards the env into sphere-cli subprocesses.
Global-setup boots the relay when `TRADER_E2E_LOCAL_RELAY=1`.

What works:
  - Local relay container boots, tests skip preflight, env propagates
    to host-manager + spawned tenants
  - Wallet events (kind:30078) and DM gift-wraps (kind:1059) ARE
    published to the local relay (verified by tailing relay logs)
  - HMA dist needed a rebuild (was 4 days stale on disk)

What does NOT yet work — SDK-level gap:
  - Nametag binding events (kind:31113/31115/31116) bypass the
    `transport.relays` override. They route through
    `MultiAddressTransportMux` (sphere-sdk/transport/MultiAddressTransportMux.ts:9)
    which has its OWN relay list independent of the per-provider
    transport config. Because of this, the manager registers a
    nametag against the (default/testnet) mux-relay but sphere-cli's
    `queryPubkeyByNametag` (also via the mux) doesn't find it on
    the local relay → "Unicity ID not found: @m-…".
  - `nostr-js-sdk`'s `publishNametagBinding` calls
    `queryPubkeyByNametag` first to detect conflicts; both
    operations target the mux's hard-coded relay list, not the
    SDK consumer's override.

Fix path:
  1. **SDK change** — extend `MultiAddressTransportMux` to accept a
     relay override so it picks up `transport.relays` (or a sibling
     `transport.muxRelays`) from the createNodeProviders config.
     Default behavior unchanged.
  2. **Tactical workaround** — for tests that use the local relay,
     identify peers by raw `DIRECT://hex` (which the SDK resolves
     transport-side, not via the nametag mux) and avoid `@nametag`.
     The hma-trade-settlement test already passes
     `escrow.tenantDirectAddress` for the swap routing; the only
     remaining `@nametag` usage is sphere-cli's manager-address
     resolution. The test could read `manager.directAddress` and
     pass that instead of `@${manager.nametag}` — quick fix.

Local-infra commits already pushed; the workaround in (2) is the
fastest path to a green run.

**Remediation (in priority order)**:

1. Rebuild `escrow:local` from `/home/vrogojin/escrow-service` source and
   re-tag as the test's image. Re-run hma-trade-settlement and expect
   COMPLETED.
2. After settlement works: file an upstream issue + PR against escrow-service
   to harden `deliverDepositInvoice` — use `Promise.allSettled([reply(B,...),
   reply(A,...)])` and log the rejection reasons explicitly so silent failures
   are impossible.
3. Sphere-sdk secondary defect (independent): `SwapModule.handleIncomingDM`
   walks `accepted → announced` via `status_result.state` (SwapModule.ts:3119–3171)
   even when `swap.depositInvoiceId` is unset. This is what made the trader's
   diag log say "registered, polling for invoice" while accounting actually
   has no invoice record. Constrain the walk to require both
   `swap.depositInvoiceId !== undefined` AND `accounting.getInvoice(id) !== null`
   before transitioning. Medium priority — only relevant once the escrow
   regression is fixed.

The hypotheses below (H2/H3) are now **superseded** by the escrow-side root
cause. Kept for historical context.

### ~~H1 — ACP listener consumes the invoice DM before the swap module sees it~~ — RULED OUT

**Update**: investigated sphere-sdk's event architecture. Incoming DMs are
dispatched via TWO INDEPENDENT paths in `dist/index.js`:

  - line 13910: `deps.emitEvent("message:dm", message)` — generic event bus
    (this is what `sphere.on('message:dm', ...)` subscribes to).
  - line 13911-13918: iterates `dmHandlers` set
    (this is what `sphere.communications.onDirectMessage(handler)` registers
    into; used internally by PaymentsModule (line 18816) and SwapModule
    (line 24212)).

Both fire unconditionally for every DM. No propagation control, no ordering
between the two paths. The ACP listener (on the event bus) and the SDK's
SwapModule (on `dmHandlers`) are on independent channels — they each get
their own copy. The ACP listener CANNOT preempt the SwapModule.

So this hypothesis is incorrect. The remaining candidates are below.

**Note on architecture**: the dual-path dispatch with no propagation control
is itself a design smell — there's no way for a handler to say "I consumed
this, don't deliver it to other consumers." A koa-compose-style middleware
chain (`use(handler, priority)` with `next()` semantics) would be cleaner
and would let the trader's ACP filter declaratively consume non-ACP DMs.
Tracked separately; not on the critical path for THIS bug.

### H2 — Periodic `payments.receive({finalize:true})` races with swap module's DM consumption

The trader's main loop (`src/trader/main.ts:545`) calls
`sphere.payments.receive({ finalize: true })` every 5s. We've seen
`ENOENT: wallet.json.tmp` errors in trader logs from this and the heartbeat
loop racing on atomic temp+rename writes.

If the `wallet.json` write race corrupts the swap module's DM-state cache,
incoming swap DMs may be silently dropped.

**Bisect**: lengthen `SYNC_INTERVAL_MS` (currently 5s) to 60s and see if
settlement starts working. If yes, race is the cause.

### H3 — HMA-spawned container's relay subscription latency

HMA's docker create injects more env vars and starts the container with
`tini` as PID 1. The relay subscription inside the trader may not be fully
established by the time the escrow sends the invoice. NIP-17 events that
arrive before the subscription is active are NOT replayable for that
subscriber session.

`sphere.fetchPendingEvents()` is supposed to catch missed events, but its
periodic call (also 5s in the sync loop) may be racing or filtering.

**Bisect**: add an explicit `await sphere.fetchPendingEvents()` after the
trader's first STATUS query and before the swap-executor begins polling for
invoice_target. If the invoice arrives after this explicit fetch, latency
is the cause.

## Proposed debugging plan for the follow-up session

H1 is ruled out (see updated hypothesis above), so start with the SDK's
internal DM dispatch.

1. **Instrument sphere-sdk's `CommunicationsModule.handleIncoming` (or
   equivalent) to log EVERY incoming DM at the raw level**, BEFORE any
   filtering / dedup. The log line should include sender prefix, payload
   size, and the message id. With this in place, re-run the test:

   - If the escrow's invoice_delivery DM appears in the trader's raw log:
     → the SDK is receiving it. Bug is downstream (handleIncomingDM rejecting,
     SwapModule not registering it as the active swap, etc.). Continue to
     step 2.
   - If it does NOT appear: bug is at the transport layer (relay subscription
     latency, DM-decryption failure, recipient mismatch). Skip to step 3.

2. **For the "received but not processed" case (most likely)**: instrument
   `SwapModule.handleIncomingDM` in `sphere-sdk/dist/index.js:24212` (or
   wherever its body is) to log every entry and the path it takes. Possible
   silent rejections:
   - signature verification fails (wrong chain pubkey)
   - swap-id-not-found (the trader doesn't have the swap registered when
     the invoice arrives — race between announce-ack and invoice_delivery)
   - protocol version mismatch (trader v1 vs escrow v2 or vice versa)
   - dedup hit (`dm.isRead === true` because the SDK persisted it from a
     prior backfill — relevant if the escrow re-sends after a wallet reload)

3. **For the transport-layer case**: capture network-level evidence —
   instrument the trader's NostrTransportProvider to log every Nostr event
   it receives at the wire level. If the kind:1059 wraps for the escrow's
   pubkey arrive but never decrypt to the trader, decryption is failing.
   If they don't arrive at all, the relay subscription has a hole.

4. **Architectural follow-up (separate effort)**: introduce a propagation-
   aware middleware chain in sphere-sdk's CommunicationsModule (koa-compose
   style — `use(mw, priority)` with `next()`), so that future consumers
   (ACP listener, app code) can declaratively filter / consume / pass DMs
   in an ordered pipeline. The current dual-path dispatch
   (`emitEvent` + `dmHandlers` running in parallel with no coordination)
   isn't the cause of THIS bug but is an obvious source of future bugs as
   more consumers attach.

## Key files

- Test: `test/e2e-live/hma-trade-settlement.e2e-live.test.ts`
- Test helpers:
  - `test/e2e-live/helpers/faucet-client.ts` (in-process Sphere wallet for `FAUCET_REQUEST`)
  - `test/e2e-live/helpers/manager-process.ts`
  - `test/e2e-live/helpers/hma-spawn.ts`
  - `test/e2e-live/helpers/sphere-trader.ts`
- Trader code likely involved:
  - `src/trader/main.ts:545` — `payments.receive({ finalize: true })` periodic
  - `src/trader/swap-executor.ts:714` — `negotiatedEscrow === escrowDirectAddress` check
  - `src/trader/intent-engine.ts:836` — `escrow_address ?? DEFAULT_ESCROW`
  - `src/acp-adapter/main.ts` (Phase 4h decoupling) — ACP DM listener
- Sphere SDK: `@unicitylabs/sphere-sdk` payments + swap modules

## Reproducing the failure

```bash
# Build all required images
cd /home/vrogojin && docker build -f trader-service/Dockerfile \
  -t ghcr.io/vrogojin/agentic-hosting/trader:local .
cd /home/vrogojin && docker build -f js-faucet/Dockerfile \
  -t ghcr.io/unicitynetwork/agentic-hosting/faucet:local .
cd /home/vrogojin/agentic_hosting && npm run build
cd /home/vrogojin/sphere-cli-work/sphere-cli && npm run build

# Run the test
cd /home/vrogojin/trader-service
git checkout feat/hma-trade-settlement-live
npm run test:e2e-live -- test/e2e-live/hma-trade-settlement.e2e-live.test.ts
# Expect: FAIL ~590s, both pairs reach ACCEPTED, neither reaches COMPLETED.

# Inspect trader log:
docker ps -a --filter "name=alice-p" --filter "status=exited" --format "{{.Names}}" | head -1 \
  | xargs -I {} docker logs {} 2>&1 | grep -E "swap_deposit_target_diag|swap_id_register|swap_announced"

# Inspect escrow log:
docker ps -a --filter "name=escrow-p" --filter "status=exited" --format "{{.Names}}" | head -1 \
  | xargs -I {} docker logs {} 2>&1 | grep -iE "announce|invoice_delivery|outbound_dm"
```

## Out of scope for this debugging session

- Production hardening of js-faucet (rate limiting, batched mints, etc.)
- Pushing js-faucet image to ghcr.io/unicitynetwork (needs PAT)
- Adding `faucet-agent` template entry to agentic-hosting/config/templates.json
- `sphere faucet request` subcommand in sphere-cli
- Withdraw-via-HMA live test
