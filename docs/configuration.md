# Trader Service — Configuration

The trader is configured almost entirely through environment variables
injected by the agentic-hosting Host Manager when it spawns the container.
A small set of additional variables let an operator tune behavior at spawn
time without rebuilding the image.

## Required (host-manager-injected)

These follow the [agentic-hosting Tenant Container Contract](../../agentic-hosting/ref_materials/03-Tenant-CLI-Template.md):

| Variable | Purpose |
|---|---|
| `UNICITY_MANAGER_PUBKEY` | secp256k1 hex pubkey of the spawning Host Manager. |
| `UNICITY_BOOT_TOKEN` | Random nonce included in `acp.hello` to prove the manager spawned us. Cleared from `process.env` after handshake. |
| `UNICITY_INSTANCE_ID` | UUID assigned by the manager. |
| `UNICITY_INSTANCE_NAME` | Human-readable name. |
| `UNICITY_TEMPLATE_ID` | Template id (e.g. `trader-service`). |
| `UNICITY_NETWORK` | `testnet` \| `mainnet` \| `dev`. |
| `UNICITY_DATA_DIR` | Wallet data directory (default `/data/wallet`). |
| `UNICITY_TOKENS_DIR` | Tokens directory (default `/data/tokens`). |

## Optional

| Variable | Purpose |
|---|---|
| `UNICITY_CONTROLLER_PUBKEY` | secp256k1 hex pubkey of an additional principal allowed to send `acp.command` (typically the developer running `trader-ctl`). |
| `UNICITY_HEARTBEAT_INTERVAL_MS` | Heartbeat cadence (clamped to `[1000, 300_000]`). |
| `UNICITY_LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error`. |
| `SPHERE_NAMETAG` | Nametag the trader registers for itself; defaults to `t-<instanceId-fragment>`. |
| `UNICITY_API_KEY` | Sphere oracle API key (passed through to providers). |

## Trader-specific

| Variable | Purpose |
|---|---|
| `UNICITY_TRUSTED_ESCROWS` | Comma-separated list of escrow nametags or DIRECT addresses the trader will accept as counterparties. The trader only proposes / accepts swaps that involve an escrow on this allowlist. |

If `UNICITY_TRUSTED_ESCROWS` is unset, the trader falls back to the
`strategy.trusted_escrows` field persisted under `${UNICITY_DATA_DIR}/trader/strategy.json`.
The CLI's `set-strategy --trusted-escrows <list>` overwrites that file.

### File-based override

If a JSON file exists at `${UNICITY_DATA_DIR}/config/trader-strategy.json`,
the trader loads it at boot and merges it into the strategy state. The file
follows the `TraderStrategy` shape from `src/trader/types.ts`:

```json
{
  "trusted_escrows": ["@escrow-prod", "DIRECT://04a1b2..."],
  "rate_strategy": "moderate",
  "max_concurrent_negotiations": 4,
  "deposit_timeout_sec": 300
}
```

Order of precedence (later entries override earlier):
1. `DEFAULT_STRATEGY` baked into the binary
2. `${UNICITY_DATA_DIR}/trader/strategy.json` (persisted via `SET_STRATEGY`)
3. `${UNICITY_DATA_DIR}/config/trader-strategy.json` (operator-supplied)
4. `UNICITY_TRUSTED_ESCROWS` env var (only the `trusted_escrows` field)
