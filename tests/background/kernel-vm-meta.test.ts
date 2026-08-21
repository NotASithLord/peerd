import { describe, expect, test } from 'bun:test';
import { makeKernelVmMetaRoute } from '../../extension/background/kernel-local-routes.js';

const sender = { id: 'peerd', url: 'chrome-extension://peerd/engine-tabs/vm-tab/index.html' };

describe('native kernel VM metadata route', () => {
  test('waits for hydrated settings and returns the exact v1 record without feature startup', async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[] = [];
    const record = { id: 'vm-1', name: 'Dev VM', image: 'sha256:abc' };
    const route = makeKernelVmMetaRoute({
      ready,
      idb: { get: async (store: string, key: string) => {
        calls.push(`${store}:${key}`);
        return { key, value: { schemaVersion: 1, vms: { 'vm-1': record } } };
      } },
      settingsStore: { get: () => ({ devMode: true }) },
      isAllowed: (value) => value === sender,
    });
    const pending = route({ vmId: 'vm-1' }, sender);
    await Promise.resolve();
    expect(calls).toEqual([]);
    release();
    expect(await pending).toEqual({ ok: true, record, devMode: true });
    expect(calls).toEqual(['vms:webvms.v1']);
  });

  test('rejects forged senders and malformed ids before readiness or storage IO', async () => {
    let reads = 0;
    const route = makeKernelVmMetaRoute({
      ready: Promise.resolve(),
      idb: { get: async () => { reads += 1; return undefined; } },
      settingsStore: { get: () => ({}) },
      isAllowed: (value) => value === sender,
    });
    expect(await route({ vmId: 'vm-1' }, {})).toEqual({ ok: false, error: 'vm-meta-unauthorized' });
    expect(await route({ vmId: 1 }, sender)).toEqual({ ok: false, error: 'vmId-required' });
    expect(reads).toBe(0);
  });

  test('fails closed for absent, corrupt, future, inherited, and non-object records', async () => {
    const rows = [
      undefined,
      { key: 'other', value: { schemaVersion: 1, vms: { vm: {} } } },
      { key: 'webvms.v1', value: { schemaVersion: 2, vms: { vm: {} } } },
      { key: 'webvms.v1', value: { schemaVersion: 1, vms: [] } },
      { key: 'webvms.v1', value: { schemaVersion: 1, vms: { vm: 'bad' } } },
      { key: 'webvms.v1', value: { schemaVersion: 1, vms: Object.create({ vm: {} }) } },
    ];
    for (const row of rows) {
      const route = makeKernelVmMetaRoute({
        ready: Promise.resolve(), idb: { get: async () => row },
        settingsStore: { get: () => ({ devMode: true }) }, isAllowed: () => true,
      });
      expect(await route({ vmId: 'vm' }, sender)).toEqual({ ok: false, error: 'vm-not-found' });
    }
  });

  test('preserves bounded storage failures and never performs a write or feature operation', async () => {
    let reads = 0;
    const route = makeKernelVmMetaRoute({
      ready: Promise.resolve(),
      idb: { get: async () => { reads += 1; throw new Error('vm catalog unavailable'); } },
      settingsStore: { get: () => { throw new Error('settings must not run'); } },
      isAllowed: () => true,
    });
    expect(await route({ vmId: 'vm' }, sender)).toEqual({
      ok: false, error: 'vm catalog unavailable',
    });
    expect(reads).toBe(1);
  });
});
