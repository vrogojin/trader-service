# Live E2E Tests — Trader Agent over Real Infrastructure

> **Status in trader-service: NOT RUNNABLE STANDALONE.**
>
> These tests were forward-ported from `agentic-hosting@pre-trader-cut-v1`
> as part of the Phase b decoupling. They preserve the exact spec of the
> integration scenarios that exercise the trader agent end-to-end through
> a real Host Manager Agent + Docker + testnet stack.
>
> They cannot run from this repo as-is because the controller-side
> dependencies — `createHostManager`, the HMCP-0 protocol module, the
> Dockerode adapter, the tenant template registry — live in
> `agentic-hosting`, not here. Running `npm run test:e2e-live` in this
> repo today will fail at module resolution; that failure is the signal,
> not a bug.
>
> They are excluded from the default `npm test` run and from
> `tsconfig.test.json` so the standalone trader-service build stays
> green. The intended path is one of:
>
> 1. Move these files into the `agentic-hosting` nightly integration CI
>    once the trader-service Docker image is wired up there (preferred).
> 2. Run them out of a thin "integration" repo that depends on both
>    `trader-service` and `agentic-hosting` and stitches the host-manager
>    + trader spawn loop together.
>
> Either path is appropriate; both should preserve the test bodies as
> the canonical scenario spec. Until then, the test bodies and helpers
> below describe the manual runbook for verifying live trader behaviour.

---

Tests the full trading stack through real infrastructure:
real Docker, real Nostr relays, real aggregator, real escrow, real MarketModule API.

## Architecture

```
Controller (Vitest test runner)
    |  HMCP-0 via Sphere DMs
    v
Host Manager (in-process, real Docker socket)
    |  hm.spawn / hm.command / hm.stop
    v
+------------------+  +------------------+  +------------------+  +------------------+
| Escrow Service   |  | Trader Alice     |  | Trader Bob       |  | Trader Carol     |
| (Docker)         |  | (Docker)         |  | (Docker)         |  | (Docker)         |
+------------------+  +--------+---------+  +--------+---------+  +--------+---------+
                               |  NP-0 DMs (NIP-17)  |                     |
                               +---------------------+---------------------+
                               |
                       MarketModule API (Qdrant + embeddings)
```

## Speed Optimization: Shared Setup, Fast Tests

The expensive operations (wallet creation, faucet, Docker spawn) happen
**once** in `beforeAll`. Individual tests only do trading operations.

```
beforeAll (~2-3 min, ONCE):
  1. Create controller + manager Sphere wallets
  2. Start Host Manager (in-process, real Docker)
  3. hm.spawn escrow-service → wait RUNNING
  4. hm.spawn trader-alice → wait RUNNING
  5. hm.spawn trader-bob → wait RUNNING
  6. hm.spawn trader-carol → wait RUNNING
  7. Fund all traders via faucet (parallel)
  8. Wait for balances via GET_PORTFOLIO

Per test (~1-2 min each):
  1. Reset trader state (cancel active intents, reset strategy)
  2. Send trading commands
  3. Wait for swap completion
  4. Verify results + portfolios

afterAll (~30s, ONCE):
  1. hm.stop all instances
  2. Verify STOPPED
  3. manager.dispose()
  4. Destroy Sphere wallets
```

### Between-Test Reset (not restart)

Instead of tearing down and rebuilding Docker containers, each test
resets the trader state via ACP commands:

```typescript
async function resetTrader(env, instanceName) {
  // Cancel all active intents
  const intents = await sendCommand(env, instanceName, 'LIST_INTENTS', { filter: 'active' });
  for (const intent of intents.intents) {
    await sendCommand(env, instanceName, 'CANCEL_INTENT', { intent_id: intent.intent_id });
  }
  // Reset strategy to defaults
  await sendCommand(env, instanceName, 'SET_STRATEGY', DEFAULT_STRATEGY);
  // Verify clean state
  const status = await sendCommand(env, instanceName, 'STATUS');
  expect(status.active_intents).toBe(0);
  expect(status.pending_swaps).toBe(0);
}
```

## Test Scenarios

| # | Scenario | Uses | Expected Time |
|---|----------|------|---------------|
| 1 | Happy path: Alice sells, Bob buys | Alice, Bob, Escrow | ~90s |
| 2 | Multiple traders competing for same intent | Alice, Bob, Carol, Escrow | ~90s |
| 3 | Partial fill (Bob 400 then Carol 600) | Alice, Bob, Carol, Escrow | ~120s |
| 4 | Escrow timeout (stop counterparty mid-swap) | Alice, Bob, Escrow | ~90s |
| 5 | Agent restart mid-trade (stop + start) | Alice, Bob, Escrow | ~120s |

**Total: ~3 min setup + ~8 min tests + ~30s teardown ≈ 12 min**

## Infrastructure (shared, testnet)

- Nostr relays: testnet
- Aggregator: testnet
- Faucet: https://faucet.unicity.network/api/v1/faucet/request
- MarketModule API: https://market-api.unicity.network

## Running

```bash
# Requires: Docker socket access, testnet connectivity
npm run test:e2e-live
```

## Configuration

```typescript
// vitest.e2e-live.config.ts
{
  testTimeout: 180_000,     // 3 min per test (was 10 min)
  hookTimeout: 300_000,     // 5 min for beforeAll (wallet+faucet+spawn)
  pool: 'forks',
  poolOptions: { forks: { singleFork: true } },
  sequence: { concurrent: false },
  retry: 0,
  bail: 1,
}
```

## Verify-After-Every-Command Discipline

Every state-changing command is followed by verification:
- hm.spawn → hm.inspect (assert RUNNING)
- CREATE_INTENT → LIST_INTENTS (assert active)
- Swap completed → LIST_SWAPS (assert COMPLETED)
- GET_PORTFOLIO → assert balance changed
- hm.stop → hm.inspect (assert STOPPED)
- Between tests → resetTrader (assert 0 active intents, 0 pending swaps)

## Per-Test Isolation Strategy

Tests share containers but NOT trading state:
- **Shared:** Docker containers, Sphere wallets, escrow service, balances
- **Per-test:** Intents (cancelled between tests), deals, strategy (reset)
- **Isolation guarantee:** `resetTrader()` before each test ensures clean slate
- **Funding strategy:** Fund generously once (10x expected volume) so all
  tests have enough without re-funding

## Scenario 5 Exception

The "agent restart" test (Scenario 5) DOES stop/start a container — this
is the feature being tested. This test runs last and takes longer (~120s)
because it includes a Docker restart cycle. After restart, the agent
recovers via SwapModule.load() and the test verifies the swap completes.
