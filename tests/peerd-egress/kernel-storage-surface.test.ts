import { describe, expect, test } from 'bun:test';

// Use the shared preload's native browser identity. Replacing the global
// during an import can permanently bind browser-api.js to a partial fake and
// contaminate later tests even after the global itself is restored.
describe('native storage surface', () => {
  test('exports only the IDB operations used by the authority kernel', async () => {
    const { idb, kv } = await import('../../extension/peerd-egress/kernel-storage.js');

    expect(Object.keys(idb).sort()).toEqual([
      'count',
      'del',
      'delUpTo',
      'get',
      'getAll',
      'getAllKeys',
      'getMany',
      'mutate',
      'patch',
      'put',
      'transact',
    ]);
    expect(Object.keys(kv).sort()).toEqual(['delete', 'get', 'list', 'set']);
  });

  test('keeps whole-store conveniences on the legacy background surface', async () => {
    const legacy = await import('../../extension/peerd-egress/background.js');

    expect(legacy.idbKV).toBe(legacy.idb.idbKV);
    expect(typeof legacy.idb.clear).toBe('function');
    expect(typeof legacy.kv.clear).toBe('function');
    expect(Object.keys(legacy.idbKV('apps')).sort()).toEqual(['get', 'set']);
  });

  test('retains the guarded delete primitive used by vault rollback', async () => {
    const { purgeVaultBlob } = await import('../../extension/peerd-egress/kernel-storage.js');
    const calls: string[] = [];

    await purgeVaultBlob({
      kv: { delete: async (key: string) => { calls.push(`kv:${key}`); } },
      idb: { del: async (store: string, key: IDBValidKey) => {
        calls.push(`idb:${store}:${String(key)}`);
      } },
    });

    expect(calls).toEqual(['kv:vault.v1', 'idb:vault:vault.v1']);
  });
});
