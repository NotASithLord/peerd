import { describe, expect, test } from 'bun:test';
import {
  makeDeferredStorageAreaKV,
  makeStorageAreaKV,
} from '../../extension/peerd-egress/storage/kv.js';
import { makeSessionCache } from '../../extension/peerd-egress/storage/session-cache.js';

const storageArea = () => {
  const values = new Map<string, any>();
  return {
    values,
    area: {
      get: async (key: string|null) => key === null
        ? Object.fromEntries(values)
        : { [key]: values.get(key) },
      set: async (items: Record<string, any>) => {
        for (const [key, value] of Object.entries(items)) values.set(key, value);
      },
      remove: async (key: string) => { values.delete(key); },
      clear: async () => { values.clear(); },
    },
  };
};

describe.each(['Chrome service worker', 'Firefox event page'])(
  'browser-neutral vault storage: %s',
  () => {
    test('local storage preserves wrapper shape, prefix listing, and mutations', async () => {
      const fixture = storageArea();
      const kv = makeStorageAreaKV(fixture.area);
      await kv.set('settings.v1', { vaultAutoLockMs: 60_000 });
      await kv.set('vault.legacy', { wrapped: true });
      expect(await kv.get('settings.v1')).toEqual({ vaultAutoLockMs: 60_000 });
      expect(await kv.list('vault.')).toEqual({ 'vault.legacy': { wrapped: true } });
      await kv.delete('vault.legacy');
      expect(await kv.get('vault.legacy')).toBeUndefined();
      await kv.clear();
      expect(await kv.list()).toEqual({});
    });

    test('session mirror uses promise StorageArea object envelopes', async () => {
      const fixture = storageArea();
      const session = makeSessionCache(fixture.area);
      const record = { dk: 'bytes', unlockedAt: 123, autoLockMs: 60_000 };
      await session.sessionSet('vault.unlocked.v1', record);
      expect(await session.sessionGet('vault.unlocked.v1')).toEqual(record);
      await session.sessionDelete('vault.unlocked.v1');
      expect(await session.sessionGet('vault.unlocked.v1')).toBeUndefined();
    });

    test('real storage resolution is deferred until the first operation', async () => {
      let area: ReturnType<typeof storageArea>['area'] | undefined;
      const kv = makeDeferredStorageAreaKV(() => area);
      expect(() => kv).not.toThrow();
      await expect(kv.get('late')).rejects.toThrow('browser.storage.local is unavailable');

      const fixture = storageArea();
      area = fixture.area;
      await kv.set('late', { ready: true });
      expect(await kv.get('late')).toEqual({ ready: true });
    });
  },
);
