/**
 * In-memory filesystem mock and mock TenantStateStore for unit tests.
 */

import type {
  TenantState,
  TenantStateStore,
} from '../../src/tenant/state-store.js';

export interface MockFilesystem {
  files: Map<string, string>;
}

export function createMockFilesystem(): MockFilesystem {
  return { files: new Map() };
}

export function createMockTenantStateStore(
  fs: MockFilesystem,
  dataDir: string,
  instanceId: string,
): TenantStateStore {
  // Key must be namespaced by instanceId. In production the state file lives
  // on a per-instance bind mount (`${instanceDir}/wallet:/data/wallet`) so the
  // container-relative path is globally unique. The mock fs is a single
  // Map<string,string>, so if we keyed by dataDir alone every tenant would
  // clobber every other tenant's state — the last-writer-wins. Namespacing by
  // instanceId restores the per-instance isolation the real bind mount
  // provides.
  const key = `${dataDir}/${instanceId}/tenant-state.json`;

  return {
    async load(): Promise<TenantState | null> {
      const raw = fs.files.get(key);
      if (raw === undefined) return null;
      try {
        return JSON.parse(raw) as TenantState;
      } catch {
        return null;
      }
    },

    async save(state: TenantState): Promise<void> {
      fs.files.set(key, JSON.stringify(state, null, 2));
    },
  };
}
