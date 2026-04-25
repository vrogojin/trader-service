import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createNullTenantStateStore,
  createFsTenantStateStore,
} from './state-store.js';
import type { TenantState } from './state-store.js';
import {
  createMockFilesystem,
  createMockTenantStateStore,
} from '../../test/mocks/mock-filesystem.js';

const sampleState: TenantState = {
  instance_id: 'test-123',
  message_count: 42,
  last_activity_ms: 1700000000000,
  custom: { foo: 'bar', nested: { a: 1 } },
};

describe('createNullTenantStateStore', () => {
  it('load returns null', async () => {
    const store = createNullTenantStateStore();
    expect(await store.load()).toBeNull();
  });

  it('save is a no-op', async () => {
    const store = createNullTenantStateStore();
    await expect(store.save(sampleState)).resolves.toBeUndefined();
    expect(await store.load()).toBeNull();
  });
});

describe('createMockTenantStateStore', () => {
  it('save then load round-trips', async () => {
    const fs = createMockFilesystem();
    const store = createMockTenantStateStore(fs, '/data', 'inst-1');
    await store.save(sampleState);
    const loaded = await store.load();
    expect(loaded).toEqual(sampleState);
  });

  it('load returns null when no prior state', async () => {
    const fs = createMockFilesystem();
    const store = createMockTenantStateStore(fs, '/data', 'inst-1');
    expect(await store.load()).toBeNull();
  });

  it('data persists across separate store instances', async () => {
    const fs = createMockFilesystem();
    const store1 = createMockTenantStateStore(fs, '/data', 'inst-1');
    await store1.save(sampleState);

    // Simulate container restart: new store instance, same filesystem
    const store2 = createMockTenantStateStore(fs, '/data', 'inst-1');
    const loaded = await store2.load();
    expect(loaded).toEqual(sampleState);
  });
});

describe('createFsTenantStateStore', () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('save then load round-trips', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'tenant-state-'));
    const store = createFsTenantStateStore(tmpDir, 'inst-fs-1');
    await store.save(sampleState);
    const loaded = await store.load();
    expect(loaded).toEqual(sampleState);
  });

  it('load returns null when file does not exist', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'tenant-state-'));
    const store = createFsTenantStateStore(tmpDir, 'inst-fs-2');
    expect(await store.load()).toBeNull();
  });

  it('load returns null for corrupted JSON', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'tenant-state-'));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(tmpDir, 'tenant-state.json'), '{not valid json!!!');
    const store = createFsTenantStateStore(tmpDir, 'inst-fs-3');
    expect(await store.load()).toBeNull();
  });

  it('load returns null for valid JSON with wrong shape', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'tenant-state-'));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(tmpDir, 'tenant-state.json'), JSON.stringify({ instance_id: 123, message_count: 'not a number' }));
    const store = createFsTenantStateStore(tmpDir, 'inst-fs-4');
    expect(await store.load()).toBeNull();
  });

  it('load returns null for negative message_count', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'tenant-state-'));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(tmpDir, 'tenant-state.json'), JSON.stringify({
      instance_id: 'test', message_count: -1, last_activity_ms: 0, custom: {},
    }));
    const store = createFsTenantStateStore(tmpDir, 'inst-fs-5');
    expect(await store.load()).toBeNull();
  });
});
