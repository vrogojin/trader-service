/**
 * Shared type re-exports for the trader-service package.
 *
 * Source: trimmed from agentic-hosting/src/shared/types.ts during the trader
 * decoupling. Manager-side types (InstanceRecord, TemplateConfig, ManagerConfig,
 * etc.) are intentionally omitted — the trader only runs as a tenant. The
 * tenant-side `TenantConfig` interface is owned by `./config.ts` and re-exported
 * here so existing call sites that imported it from `./types.js` keep working.
 */

export type { TenantConfig } from './config.js';
export { LOG_LEVELS } from './config.js';
export type { LogLevel } from './config.js';

import { LOG_LEVELS } from './config.js';
import type { LogLevel } from './config.js';

/**
 * Numeric priority lookup used by the logger to filter messages below the
 * configured threshold. Matches agentic-hosting's shared/types.ts.
 */
export const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Spread enforces that LOG_LEVEL_PRIORITY covers every level exactly — adding
// a new level to LOG_LEVELS without updating LOG_LEVEL_PRIORITY would surface
// here as a TS error.
const _LEVEL_KEYS_COVER_LOG_LEVELS: readonly LogLevel[] = LOG_LEVELS;
void _LEVEL_KEYS_COVER_LOG_LEVELS;
