/**
 * Tenant state persistence — atomic file-backed store and null (no-op) store.
 */

import { readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface TenantState {
  instance_id: string;
  message_count: number;
  last_activity_ms: number;
  custom: Record<string, unknown>;
}

export interface TenantStateStore {
  load(): Promise<TenantState | null>;
  save(state: TenantState): Promise<void>;
}

/** Validate parsed JSON is a well-formed TenantState. Returns null if invalid. */
function validateTenantState(parsed: unknown): TenantState | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj['instance_id'] !== 'string') return null;
  if (typeof obj['message_count'] !== 'number' || !Number.isFinite(obj['message_count']) || obj['message_count'] < 0) return null;
  if (typeof obj['last_activity_ms'] !== 'number' || !Number.isFinite(obj['last_activity_ms']) || obj['last_activity_ms'] < 0) return null;
  if (typeof obj['custom'] !== 'object' || obj['custom'] === null) return null;
  return {
    instance_id: obj['instance_id'],
    message_count: obj['message_count'],
    last_activity_ms: obj['last_activity_ms'],
    custom: obj['custom'] as Record<string, unknown>,
  };
}

export function createFsTenantStateStore(
  dataDir: string,
  _instanceId: string,
): TenantStateStore {
  const filePath = join(dataDir, 'tenant-state.json');

  return {
    async load(): Promise<TenantState | null> {
      try {
        const content = await readFile(filePath, 'utf-8');
        const parsed: unknown = JSON.parse(content);
        return validateTenantState(parsed);
      } catch {
        return null;
      }
    },

    async save(state: TenantState): Promise<void> {
      await mkdir(dirname(filePath), { recursive: true });
      const temp = `${filePath}.tmp.${randomBytes(4).toString('hex')}`;
      const fd = await open(temp, 'w');
      try {
        await fd.writeFile(JSON.stringify(state, null, 2), 'utf-8');
        await fd.sync();
      } finally {
        await fd.close();
      }
      try {
        await rename(temp, filePath);
      } catch (err) {
        try { await unlink(temp); } catch { /* best effort */ }
        throw err;
      }
    },
  };
}

export function createNullTenantStateStore(): TenantStateStore {
  return {
    async load(): Promise<TenantState | null> {
      return null;
    },
    async save(_state: TenantState): Promise<void> {
      // no-op
    },
  };
}
