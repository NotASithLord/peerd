import { describe, expect, test } from 'bun:test';

const withWebExtensionRuntime = async <T>(run: () => Promise<T>): Promise<T> => {
  const globals = globalThis as typeof globalThis & {
    browser?: unknown;
    chrome?: unknown;
  };
  const priorBrowser = globals.browser;
  const priorChrome = globals.chrome;
  try {
    globals.browser = undefined;
    globals.chrome = { runtime: {} } as unknown as typeof chrome;
    return await run();
  } finally {
    globals.browser = priorBrowser;
    globals.chrome = priorChrome;
  }
};

describe('native storage surface', () => {
  test('exports only the ten IDB operations used by the authority kernel', async () => {
    await withWebExtensionRuntime(async () => {
      const { idb, kv } = await import('../../extension/peerd-egress/kernel-storage.js');

      expect(Object.keys(idb).sort()).toEqual([
        'count',
        'del',
        'delUpTo',
        'get',
        'getAll',
        'getAllKeys',
        'getMany',
        'patch',
        'put',
        'transact',
      ]);
      expect(Object.keys(kv).sort()).toEqual(['delete', 'get', 'list', 'set']);
    });
  });

  test('keeps whole-store conveniences on the legacy background surface', async () => {
    await withWebExtensionRuntime(async () => {
      const legacy = await import('../../extension/peerd-egress/background.js');

      expect(legacy.idbKV).toBe(legacy.idb.idbKV);
      expect(typeof legacy.idb.clear).toBe('function');
      expect(typeof legacy.kv.clear).toBe('function');
      expect(Object.keys(legacy.idbKV('apps')).sort()).toEqual(['get', 'set']);
    });
  });

  test('retains the guarded delete primitive used by vault rollback', async () => {
    await withWebExtensionRuntime(async () => {
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
});
