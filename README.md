# trader-service

Autonomous P2P token-swap trader agent for the [agentic-hosting](https://github.com/vrogojin/agentic_hosting) platform.

The trader is a long-running tenant that:
- discovers counterparties on the Sphere market feed,
- negotiates rates and volumes via DM,
- executes swaps through a trusted escrow service (e.g. [escrow-service](https://github.com/vrogojin/escrow-service)), and
- reports its lifecycle (intents, deals, balances) back to its controller via ACP-0 commands.

It is deployed as a Docker image and spawned by the agentic-hosting Host Manager Agent
through the standard Tenant Container Contract.

## Repo layout

```
src/
  trader/         Trader domain logic (intent engine, negotiation handler, swap executor)
  acp-adapter/    Thin shim — the trader's standalone main already implements ACP-0
  cli/            trader-ctl — controller-side CLI sending ACP commands over DM
  protocols/      ACP-0 envelope + types (vendored from agentic-hosting)
  shared/         Logger / config / replay-guard / crypto utilities (vendored)
  tenant/         AcpListener / CommandHandler / heartbeat (vendored)
bin/trader-ctl    Shell wrapper that exec's dist/cli/main.js
docs/             Architecture, integration, protocol spec, test spec
```

## Quick start

```bash
# In a parent directory containing trader-service/ and sphere-sdk/ siblings
cd sphere-sdk && npm ci && npm run build
cd ../trader-service && npm ci && npm run build && npm test
```

### CLI usage

```bash
# Submit a buy intent for 100 UCT @ 0.95–1.00 USDC
./bin/trader-ctl --tenant @my-trader create-intent \
  --direction buy --base UCT --quote USDC \
  --rate-min 95000000 --rate-max 100000000 \
  --volume-min 10000000 --volume-total 100000000

# List active intents
./bin/trader-ctl --tenant @my-trader list-intents --state active

# Show portfolio
./bin/trader-ctl --tenant @my-trader portfolio

# JSON output for scripting
./bin/trader-ctl --tenant @my-trader --json status
```

The CLI talks **directly** to a running trader tenant via Sphere DM (it does
not go through the host manager). The tenant's AcpListener authenticates the
sender against `UNICITY_MANAGER_PUBKEY` or `UNICITY_CONTROLLER_PUBKEY` —
configure the controller pubkey at spawn time so the CLI's wallet can issue
commands.

## Documentation

- [docs/architecture.md](docs/architecture.md) — high-level component diagram
- [docs/integration-guide.md](docs/integration-guide.md) — step-by-step integration with sphere-sdk
- [docs/protocol-spec.md](docs/protocol-spec.md) — full ACP command set + state machines
- [docs/configuration.md](docs/configuration.md) — env vars + strategy file layout
- [docs/test-specification.md](docs/test-specification.md) — test plan (236 tests)

## Status

Restored from `pre-trader-cut-v1` tag of agentic-hosting (Phase b decoupling).
The package depends on a sibling `sphere-sdk` checkout (`file:../sphere-sdk`)
pinned to SHA `44b4705352c1582575eeeafbc46dddc8d95e8995` until sphere-sdk
publishes a unified release with the swap, market, and accounting exports.
