# Bug Report — Testnet Nostr Relay Silently Dropping All Writes

**Date filed:** 2026-05-01
**Affected service:** `wss://nostr-relay.testnet.unicity.network`
**Software:** `nostr-rs-relay v0.9.0`
**Severity:** P0 — blocks all testnet e2e flows that depend on Nostr (trader/escrow provisioning, faucet nametag resolution, peer DMs requiring nametag binding)
**First observed:** 2026-04-30 ~21:31 UTC (last accepted kind:30078 event timestamp)

## Status timeline

- **2026-04-30 ~21:31 UTC** — relay stopped accepting writes. Silent: no `OK`/`NOTICE` returned to publishers. Reads still served.
- **2026-05-01 ~10:45 UTC** — writes start succeeding again. `OK ... true` returned. Reads remain healthy. Partial-fill e2e passes in 45s as expected.
- **2026-05-01 ~13:00 UTC** — second degradation begins. Reads work but slowly: queries that returned in 177ms earlier now take 5–7 seconds for a single event. The SDK's 5s `queryWithFirstSeenWins` default timeout fires before the response arrives → `resolveNametag()` returns null → `sendDM()` throws `INVALID_RECIPIENT` → every `np.propose_deal` fails. Tests that retry indefinitely (25-min budgets) eventually succeed; tighter-budget tests hit the wall.
- **2026-05-01 ~15:50 UTC** — third degradation. Relay no longer responds to queries within 8s at all. End-to-end blocked again.

---

## Summary

The testnet Nostr relay accepts WebSocket connections and serves historical queries normally, but **silently drops every event publish** without sending an `OK` or `NOTICE` response. Clients see no error and assume the publish succeeded; the events never appear in subsequent queries. This breaks all flows that depend on freshly-published events propagating to the relay (most notably nametag binding events, kind:30078).

## NOT a capacity issue

The relay degrades severely under **trivial load** — empirically, ~25 trader containers + 5 escrows (i.e. ~30 long-lived WebSocket connections) is enough to cause:
- Silent publish failures (events never indexed)
- Query response time blowing up from ~150ms baseline to 5-7+ seconds, or no response at all
- Subscriptions that go silent without a `CLOSED`/`NOTICE` notification

Public Nostr relays (e.g. `nostr.wine`, `relay.damus.io`, `relay.nostr.band`) routinely handle **hundreds to thousands** of concurrent connections without these symptoms. nostr-rs-relay is generally capable of the same. **30 connections is not "load"** — it's three orders of magnitude below normal Nostr relay capacity.

This points to one of:
- Internal database write/index bug (events accepted at the protocol layer but not persisted/indexed)
- Subscription handler that doesn't clean up dead subs and runs out of slots
- Resource limit set to an unreasonably low value in the relay's config (e.g. `max_subscriptions = 1`)
- DB lock contention in v0.9.0 (this is an old version — current nostr-rs-relay is significantly later)
- Underlying VM I/O / memory / file-descriptor exhaustion that's not surfaced in any client-visible error

The version exposed in NIP-11 is `nostr-rs-relay v0.9.0`. Current upstream is several minor versions ahead with bug fixes and config improvements.

## Impact

- **Trader/escrow provisioning fails** in `trader-service` e2e-live tests — published `nametag_binding` events are dropped, faucet returns `400 "Nametag not found"` when looking up the trader.
- **Faucet's nametag → pubkey resolution times out** because the relay has no recent kind:30078 events to serve.
- Any service that relies on registering a new nametag via Nostr is non-functional.
- Existing nametags published before 2026-04-30 21:31 UTC continue to resolve (read path is healthy).

## Reproduction

### Step 1 — Confirm the relay's last-accepted event

```bash
node -e "
const WS = require('ws');
const ws = new WS('wss://nostr-relay.testnet.unicity.network');
ws.on('open', () => ws.send(JSON.stringify(['REQ', 'q', { kinds: [30078], limit: 3 }])));
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg[0] === 'EVENT') {
    const ageHours = (Date.now()/1000 - msg[2].created_at) / 3600;
    console.log('event ts:', new Date(msg[2].created_at*1000).toISOString(), '(age:', ageHours.toFixed(1), 'h)');
  } else if (msg[0] === 'EOSE') process.exit(0);
});
setTimeout(() => process.exit(0), 5000);
"
```

Expected output (proves the relay is alive for reads but stale for kind:30078 writes):

```
event ts: 2026-04-30T21:31:50.000Z (age: 9.8 h)
event ts: 2026-04-30T21:31:38.000Z (age: 9.8 h)
event ts: 2026-04-30T21:31:35.000Z (age: 9.8 h)
```

### Step 2 — Try to publish a fresh event from any new key

```js
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import WebSocket from 'ws';

const sk = randomBytes(32);
const pk = bytesToHex(schnorr.getPublicKey(sk));
const ws = new WebSocket('wss://nostr-relay.testnet.unicity.network');
ws.on('open', () => {
  const ev = {
    pubkey: pk,
    created_at: Math.floor(Date.now() / 1000),
    kind: 1,
    tags: [],
    content: 'relay-publish-probe',
  };
  const ser = JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]);
  const id = sha256(new TextEncoder().encode(ser));
  ev.id = bytesToHex(id);
  ev.sig = bytesToHex(schnorr.sign(id, sk));
  ws.send(JSON.stringify(['EVENT', ev]));
});
ws.on('message', (d) => console.log('RECV:', d.toString()));
setTimeout(() => process.exit(0), 10000);
```

**Observed:** zero messages from the relay during the 10-second window. No `OK`, no `NOTICE`, no `AUTH` challenge, no `CLOSED`.

### Step 3 — Confirm the publish was dropped (fresh connection, query by event-id)

After step 2, open a new WebSocket and `REQ` the event id you just published. The relay returns `EOSE` with no `EVENT` — the event was never stored.

### Step 4 — Try every kind we care about

Repeat step 2 with `kind:1059` (NIP-17 gift wrap) and `kind:30078` (NIP-78 app data). All three kinds (1, 1059, 30078) are silently dropped. Tested with both real-time and the future-skewed timestamps that the most-recent stored events use — same outcome.

## Evidence the relay is in a partial / silent-broken state

### NIP-11 metadata advertises that writes should work

```bash
$ curl -s -H "Accept: application/nostr+json" https://nostr-relay.testnet.unicity.network
{
  "name": "Unnamed nostr-rs-relay",
  "supported_nips": [1, 2, 9, 11, 12, 15, 16, 20, 22, 33, 40],
  "software": "https://git.sr.ht/~gheartsfield/nostr-rs-relay",
  "version": "0.9.0",
  "limitation": {
    "payment_required": false,
    "restricted_writes": false
  }
}
```

`restricted_writes: false` means writes should be accepted from anyone, but they aren't. NIP-20 (Command Results) is in `supported_nips`, so the relay should send `OK` on every `EVENT` message — but it doesn't.

### All event kinds — not just kind:30078 — stopped flowing

```text
Latest stored event of any kind:    2026-05-02T20:45:34Z (kind:1059, future-skewed timestamp)
Latest stored kind:30078 event:     2026-04-30T21:31:50Z (real timestamp)
```

Both happened in the same wall-clock window (~10 h ago in real time — the kind:1059 events appear "future" because their publishers used artificial timestamps, NIP-17 randomization, or had skewed clocks). After that window, **nothing** has been accepted.

### Our system clock is correct

```bash
$ curl -sI https://www.google.com | grep -i '^date'
date: Fri, 01 May 2026 07:39:09 GMT
$ date -u
Fri May  1 07:39:09 AM UTC 2026
```

So this isn't us publishing too-old events; it's the relay refusing to accept any publish.

### Other publishers also can't publish

Confirmed by direct WebSocket probes from this host (IP `213.199.61.236`) and indirectly via `trader-service`'s e2e-live test suite — every fresh secp256k1 keypair we throw at the relay gets the same silent drop.

## Why this is hard to detect from the client

`@unicitylabs/nostr-js-sdk@0.4.1`'s `broadcastEvent` resolves the publish promise on a 5-second `OK`-not-received timeout, with the comment _"some relays don't send OK"_:

```js
async broadcastEvent(event) {
    // ... send EVENT message ...
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            this.pendingOks.delete(event.id);
            // Consider it successful if we sent it (some relays don't send OK)
            resolve(event.id);
        }, 5000);
        this.pendingOks.set(event.id, { resolve, reject, timer });
    });
}
```

So `Sphere.init` returns success even though the relay never indexed the event. Downstream consumers (the faucet, peer agents) hit the broken read path and surface the failure as `Nametag not found`, far from the actual root cause.

## Suggested actions

### Immediate (Unicity infra ops)

1. **Restart the relay process**. Likely DB write-mount is full or corrupt, or an in-process write lock is stuck.
2. Inspect `nostr-rs-relay` logs at the moment of `2026-04-30 ~21:31 UTC` for write errors.
3. Confirm relay's disk has free space and DB file is not read-only on the underlying volume.

### Short-term (mitigation)

4. **Run a second testnet relay** in active-active so a single relay's DB stall doesn't take the whole testnet offline. Configure all SDK clients with the relay list (`sphere-sdk/constants.ts:328` currently hardcodes a single URL).
5. Add a relay-write health probe to monitoring: publish a kind:1 event from a known throwaway key every minute; alert if no `OK` returns.

### Medium-term (SDK)

6. In `@unicitylabs/nostr-js-sdk`, `broadcastEvent` should distinguish "no OK in 5s" from "OK received". The current code masks real publish failures as success. At minimum it could log a diagnostic warning on the no-OK path; ideally fail when ALL relays time out without `OK`.
7. In `Sphere.registerNametag`, after `publishIdentityBinding` succeeds, optionally do a single bounded `resolve(@nametag)` to confirm the relay actually serves the event before returning. (`trader-service` does this client-side as a workaround in `src/trader/main.ts`.)

## Defensive code already shipped (trader-service)

`trader-service` PR #9 contains workarounds documented inline:

- Bounded nametag-verify loop in `src/trader/main.ts` — surfaces this issue with a clear `nametag_verification_timeout` log line instead of wedging startup.
- Sequential trader provisioning in `test/e2e-live/helpers/tenant-fixture.ts` — avoids piling concurrent nametag publishes on the relay even when it IS healthy.
- Anchored regex in `fundWithRetry` to correctly classify faucet 4xx vs 5xx, plus retry on the specific propagation-race error strings (`Nametag not found`, `Nametag resolution timed out`).

These don't fix the underlying outage — they make the failure mode explicit and bounded. None of them will help the e2e-live tests pass while the relay is read-only.

## Contact

Triage / discussion: this report.
Branch with diagnostics + workarounds: `fix/e2e-live-real-issues` ([trader-service PR #9](https://github.com/vrogojin/trader-service/pull/9)).
