/**
 * trader-ctl — controller-side CLI for a running trader tenant.
 *
 * Sends ACP-0 commands (CREATE_INTENT, CANCEL_INTENT, LIST_INTENTS, ...)
 * directly to a trader tenant via Sphere DM. The tenant's AcpListener auths
 * the sender against either UNICITY_MANAGER_PUBKEY or
 * UNICITY_CONTROLLER_PUBKEY, so the CLI runs under the same Sphere identity
 * the operator configured at spawn time.
 *
 * Source: modeled after sphere-cli's `sphere host` command tree (commander
 * 12, --json output, --timeout with a 100 ms floor).
 */

import { Command, Option } from 'commander';

import { Sphere } from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

import { createTraderDmTransport, TimeoutError, TransportError, MIN_TIMEOUT_MS } from './dm-transport.js';
import type { TraderDmTransport } from './dm-transport.js';
import type { AcpResultPayload, AcpErrorPayload } from '../protocols/acp.js';

// =============================================================================
// Global option types
// =============================================================================

interface GlobalOpts {
  tenant: string;
  json?: boolean;
  timeout?: string;
  network?: string;
  dataDir?: string;
  tokensDir?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

// =============================================================================
// Helpers
// =============================================================================

function fail(message: string, exitCode = 1): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(exitCode);
}

function parseTimeoutMs(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    fail(`--timeout must be a positive integer (got "${raw}")`, 2);
  }
  if (parsed < MIN_TIMEOUT_MS) {
    process.stderr.write(`Warning: --timeout=${parsed} ms below floor ${MIN_TIMEOUT_MS} ms; using floor.\n`);
    return MIN_TIMEOUT_MS;
  }
  return parsed;
}

function parseGlobalOpts(cmd: Command): GlobalOpts {
  // optsWithGlobals walks the parent chain and merges; preferred over manual
  // parent traversal in Commander 12.
  const opts = cmd.optsWithGlobals();
  if (typeof opts['tenant'] !== 'string' || opts['tenant'] === '') {
    fail('--tenant is required (a @nametag, DIRECT://<hex>, or 64-char hex pubkey)', 2);
  }
  return {
    tenant: opts['tenant'] as string,
    json: opts['json'] === true,
    timeout: typeof opts['timeout'] === 'string' ? opts['timeout'] : undefined,
    network: typeof opts['network'] === 'string' ? opts['network'] : undefined,
    dataDir: typeof opts['dataDir'] === 'string' ? opts['dataDir'] : undefined,
    tokensDir: typeof opts['tokensDir'] === 'string' ? opts['tokensDir'] : undefined,
  };
}

interface SphereContext {
  sphere: Sphere;
  transport: TraderDmTransport;
  dispose: () => Promise<void>;
}

async function withTransport(opts: GlobalOpts): Promise<SphereContext> {
  const network = (opts.network ?? process.env['UNICITY_NETWORK'] ?? 'testnet') as 'testnet' | 'mainnet' | 'dev';
  const dataDir = opts.dataDir ?? process.env['UNICITY_DATA_DIR'] ?? `${process.env['HOME']}/.trader-ctl/wallet`;
  const tokensDir = opts.tokensDir ?? process.env['UNICITY_TOKENS_DIR'] ?? `${process.env['HOME']}/.trader-ctl/tokens`;
  const apiKey = process.env['UNICITY_API_KEY'] ?? process.env['SPHERE_API_KEY'] ?? null;

  const providers = createNodeProviders({
    network,
    dataDir,
    tokensDir,
    oracle: apiKey ? { apiKey } : {},
  });

  const { sphere } = await Sphere.init({
    ...providers,
    autoGenerate: true,
  });

  const transport = createTraderDmTransport(sphere.communications, {
    tenantAddress: opts.tenant,
    instanceId: process.env['UNICITY_INSTANCE_ID'] ?? 'trader-ctl',
    instanceName: process.env['UNICITY_INSTANCE_NAME'] ?? 'trader-ctl',
    timeoutMs: parseTimeoutMs(opts.timeout),
  });

  return {
    sphere,
    transport,
    dispose: async (): Promise<void> => {
      await transport.dispose();
      await sphere.destroy();
    },
  };
}

function emitResult(opts: GlobalOpts, response: AcpResultPayload | AcpErrorPayload): never {
  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
  } else if (response.ok === false) {
    process.stderr.write(`Error [${response.error_code}]: ${response.message}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(response.result, null, 2)}\n`);
  }
  process.exit(response.ok === false ? 1 : 0);
}

async function runCommand(
  opts: GlobalOpts,
  commandName: string,
  params: Record<string, unknown>,
): Promise<never> {
  const ctx = await withTransport(opts);
  try {
    const response = await ctx.transport.sendCommand(commandName, params);
    await ctx.dispose();
    emitResult(opts, response);
  } catch (err) {
    await ctx.dispose().catch(() => {});
    if (err instanceof TimeoutError) {
      fail(`Timed out: ${err.message}`);
    }
    if (err instanceof TransportError) {
      fail(`Transport error: ${err.message}`);
    }
    fail(err instanceof Error ? err.message : String(err));
  }
}

// =============================================================================
// Subcommands
// =============================================================================

function addCreateIntent(parent: Command): Command {
  return parent
    .command('create-intent')
    .description('Submit a new trading intent to the trader')
    .requiredOption('--direction <buy|sell>', 'Trade direction')
    .requiredOption('--base <asset>', 'Base asset (e.g. UCT)')
    .requiredOption('--quote <asset>', 'Quote asset (e.g. USDC)')
    .requiredOption('--rate-min <bigint>', 'Minimum acceptable rate (string-encoded bigint)')
    .requiredOption('--rate-max <bigint>', 'Maximum acceptable rate (string-encoded bigint)')
    .requiredOption('--volume-min <bigint>', 'Minimum volume per match')
    .requiredOption('--volume-max <bigint>', 'Maximum volume the intent will accept')
    .option('--expiry-ms <ms>', 'Expiry duration in milliseconds (default: 24h)')
    .option('--escrow-address <address>', 'Escrow address for this intent (default: "any")')
    .option('--deposit-timeout-sec <sec>', 'Override deposit timeout in seconds (default: 300). Lower for tests; production should keep the default.')
    .action(async function (this: Command) {
      const opts = parseGlobalOpts(this);
      const local = this.opts() as Record<string, string | undefined>;
      const direction = local['direction'];
      if (direction !== 'buy' && direction !== 'sell') {
        fail('--direction must be "buy" or "sell"', 2);
      }
      const params: Record<string, unknown> = {
        direction,
        base_asset: local['base'],
        quote_asset: local['quote'],
        rate_min: local['rateMin'],
        rate_max: local['rateMax'],
        volume_min: local['volumeMin'],
        volume_max: local['volumeMax'],
      };
      const expiryMs =
        local['expiryMs'] !== undefined
          ? Number.parseInt(local['expiryMs'], 10)
          : 24 * 60 * 60 * 1000; // default 24h
      params['expiry_sec'] = Math.floor(expiryMs / 1000);
      if (local['escrowAddress'] !== undefined) {
        params['escrow_address'] = local['escrowAddress'];
      }
      if (local['depositTimeoutSec'] !== undefined) {
        params['deposit_timeout_sec'] = Number.parseInt(local['depositTimeoutSec'], 10);
      }
      await runCommand(opts, 'CREATE_INTENT', params);
    });
}

function addCancelIntent(parent: Command): Command {
  return parent
    .command('cancel-intent')
    .description('Cancel an active intent by ID')
    .requiredOption('--intent-id <id>', 'Intent ID to cancel')
    .action(async function (this: Command) {
      const opts = parseGlobalOpts(this);
      const local = this.opts() as Record<string, string | undefined>;
      await runCommand(opts, 'CANCEL_INTENT', { intent_id: local['intentId'] });
    });
}

function addListIntents(parent: Command): Command {
  return parent
    .command('list-intents')
    .description('List the trader\'s active and recent intents')
    .option('--state <state>', 'Filter by state: active|filled|cancelled|expired')
    .option('--limit <n>', 'Maximum number of intents to return')
    .action(async function (this: Command) {
      const opts = parseGlobalOpts(this);
      const local = this.opts() as Record<string, string | undefined>;
      const params: Record<string, unknown> = {};
      if (local['state'] !== undefined) params['state'] = local['state'];
      if (local['limit'] !== undefined) params['limit'] = Number.parseInt(local['limit'], 10);
      await runCommand(opts, 'LIST_INTENTS', params);
    });
}

function addListSwaps(parent: Command): Command {
  return parent
    .command('list-deals')
    .description('List active and completed deals (a.k.a. swaps)')
    .option('--state <state>', 'Filter by state: active|completed|failed')
    .option('--limit <n>', 'Maximum number of deals to return')
    .action(async function (this: Command) {
      const opts = parseGlobalOpts(this);
      const local = this.opts() as Record<string, string | undefined>;
      const params: Record<string, unknown> = {};
      if (local['state'] !== undefined) params['state'] = local['state'];
      if (local['limit'] !== undefined) params['limit'] = Number.parseInt(local['limit'], 10);
      await runCommand(opts, 'LIST_SWAPS', params);
    });
}

function addPortfolio(parent: Command): Command {
  return parent
    .command('portfolio')
    .description('Show the trader\'s current asset balances')
    .action(async function (this: Command) {
      const opts = parseGlobalOpts(this);
      await runCommand(opts, 'GET_PORTFOLIO', {});
    });
}

function addStatus(parent: Command): Command {
  return parent
    .command('status')
    .description('Show STATUS — uptime + adapter info')
    .action(async function (this: Command) {
      const opts = parseGlobalOpts(this);
      await runCommand(opts, 'STATUS', {});
    });
}

function addSetStrategy(parent: Command): Command {
  return parent
    .command('set-strategy')
    .description('Update the trader\'s strategy parameters')
    .option('--rate-strategy <strategy>', 'Rate strategy: aggressive|moderate|conservative')
    .option('--max-concurrent <n>', 'Max concurrent negotiations')
    .option('--trusted-escrows <list>', 'Comma-separated escrow addresses (overwrites)')
    .option(
      '--blocked-counterparties <list>',
      'Comma-separated counterparty addresses or pubkeys to block (overwrites). ' +
        'Pass empty string to clear. Engine filters matched intents whose ' +
        'agent_pubkey is on this list before fan-out.',
    )
    .action(async function (this: Command) {
      const opts = parseGlobalOpts(this);
      const local = this.opts() as Record<string, string | undefined>;
      const params: Record<string, unknown> = {};
      if (local['rateStrategy'] !== undefined) params['rate_strategy'] = local['rateStrategy'];
      if (local['maxConcurrent'] !== undefined) {
        params['max_concurrent_negotiations'] = Number.parseInt(local['maxConcurrent'], 10);
      }
      if (local['trustedEscrows'] !== undefined) {
        params['trusted_escrows'] = local['trustedEscrows'].split(',').map((s) => s.trim()).filter((s) => s !== '');
      }
      if (local['blockedCounterparties'] !== undefined) {
        // Empty string is a valid "clear the list" signal — split('') on ''
        // gives [''], which we filter out, leaving []. The handler accepts
        // [] and replaces the strategy field.
        params['blocked_counterparties'] = local['blockedCounterparties']
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s !== '');
      }
      await runCommand(opts, 'SET_STRATEGY', params);
    });
}

// =============================================================================
// Entry
// =============================================================================

export function buildProgram(): Command {
  const program = new Command('trader-ctl')
    .description('Send ACP-0 commands directly to a running trader tenant')
    .addOption(new Option('--tenant <address>', '@nametag, DIRECT://<hex>, or hex pubkey of the trader tenant')
      .makeOptionMandatory(true))
    .option('--timeout <ms>', `Per-request timeout in ms (floor ${MIN_TIMEOUT_MS}, default ${DEFAULT_TIMEOUT_MS})`)
    .option('--json', 'Emit raw JSON response instead of pretty output')
    .option('--network <name>', 'Sphere network: testnet|mainnet|dev (overrides UNICITY_NETWORK)')
    .option('--data-dir <path>', 'Wallet data directory (overrides UNICITY_DATA_DIR)')
    .option('--tokens-dir <path>', 'Tokens directory (overrides UNICITY_TOKENS_DIR)');

  addCreateIntent(program);
  addCancelIntent(program);
  addListIntents(program);
  addListSwaps(program);
  addPortfolio(program);
  addSetStrategy(program);
  addStatus(program);

  return program;
}

export async function main(argv: readonly string[] = process.argv): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(argv as string[]);
}

// Auto-start when invoked as the entrypoint (mirrors trader/main.ts).
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

function isMainModule(): boolean {
  try {
    const url = fileURLToPath(import.meta.url);
    const argv1 = process.argv[1];
    if (!argv1) return false;
    try {
      return url === realpathSync(argv1);
    } catch {
      return url === argv1 || url.endsWith(argv1);
    }
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((err) => {
    process.stderr.write(`trader-ctl: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
