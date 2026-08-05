// The §11.5 write guard — read-only verdicts enforced at the adapter
// chokepoint: blocked surfaces refuse writes with a named error, reads
// always pass, unblocked surfaces are untouched.

import { describe, test, expect } from 'bun:test';
import {
  makeWriteGuard, StoreReadOnlyError,
} from '../../../extension/peerd-runtime/lifecycle/write-guard.js';
import { STORE_REGISTRY } from '../../../extension/peerd-runtime/lifecycle/store-registry.js';

const makeKv = () => {
  const map = new Map<string, unknown>();
  return {
    map,
    get: async (k: string) => map.get(k),
    set: async (k: string, v: unknown) => { map.set(k, v); },
    delete: async (k: string) => { map.delete(k); },
    list: async () => Object.fromEntries(map),
  };
};

const makeIdb = () => {
  const ops: string[] = [];
  return {
    ops,
    get: async (store: string, key: string) => { ops.push(`get:${store}:${key}`); return undefined; },
    put: async (store: string) => { ops.push(`put:${store}`); },
    del: async (store: string) => { ops.push(`del:${store}`); },
    getAll: async (store: string) => { ops.push(`getAll:${store}`); return []; },
    clear: async (store: string) => { ops.push(`clear:${store}`); },
  };
};

describe('registry physical mapping', () => {
  test('every registry entry declares where its bytes live', () => {
    for (const entry of STORE_REGISTRY) {
      const physical = (entry as { physical?: Record<string, string[]> }).physical;
      expect(physical).toBeDefined();
      const locations = [
        ...(physical!.kvKeys ?? []), ...(physical!.kvPrefixes ?? []),
        ...(physical!.idbStores ?? []), ...(physical!.selfHosted ?? []),
      ];
      expect(locations.length).toBeGreaterThan(0);
    }
  });
});

describe('kv enforcement', () => {
  test('blocking a store refuses writes to its keys and prefixes, reads pass', async () => {
    const guard = makeWriteGuard();
    const kv = guard.wrapKv(makeKv());
    await kv.set('hooks.user.v1', { a: 1 });          // pre-block: fine
    guard.block(['hooks', 'vault']);
    expect(() => kv.set('hooks.user.v1', { a: 2 })).toThrow(StoreReadOnlyError);
    expect(() => kv.set('secret:openai-key', 'x')).toThrow(StoreReadOnlyError); // vault prefix
    expect(() => kv.delete('hooks.user.v1')).toThrow(StoreReadOnlyError);
    await expect(kv.get('hooks.user.v1')).resolves.toEqual({ a: 1 }); // reads pass
    await kv.set('settings.v1', {});                   // unrelated key untouched
    await kv.set('peerd.lifecycle.operations', {});    // lifecycle keys never blocked
  });

  test('the thrown error names the store and promises no data changed', () => {
    const guard = makeWriteGuard();
    const kv = guard.wrapKv(makeKv());
    guard.block(['hooks']);
    try {
      kv.set('hooks.user.v1', {});
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as StoreReadOnlyError).name).toBe('StoreReadOnlyError');
      expect((e as Error).message).toContain("'hooks'");
      expect((e as Error).message).toContain('no data was changed');
    }
  });
});

describe('idb enforcement', () => {
  test('write verbs refuse for blocked object stores; reads and other stores pass', async () => {
    const guard = makeWriteGuard();
    const raw = makeIdb();
    const idb = guard.wrapIdb(raw);
    guard.block(['sessions', 'audit']);
    expect(() => idb.put('sessions')).toThrow(StoreReadOnlyError);
    expect(() => idb.del('session_messages')).toThrow(StoreReadOnlyError);
    expect(() => idb.clear('audit_log')).toThrow(StoreReadOnlyError);
    await idb.get('sessions', 'x');                    // read passes
    await idb.put('contacts');                         // unblocked store passes
    expect(raw.ops).toEqual(['get:sessions:x', 'put:contacts']);
  });

  test('idbKV adapters wrap per object store', async () => {
    const guard = makeWriteGuard();
    const sets: string[] = [];
    const adapter = { get: async () => undefined, set: async (k: string) => { sets.push(k); } };
    const vms = guard.wrapIdbKvAdapter('vms', adapter);
    await vms.set('webvms.v1', {});
    guard.block(['engine-registries']);
    expect(() => vms.set('webvms.v1', {})).toThrow(StoreReadOnlyError);
    expect(sets).toEqual(['webvms.v1']);
  });
});

describe('bookkeeping', () => {
  test('block is additive and idempotent; unknown names are ignored', () => {
    const guard = makeWriteGuard();
    guard.block(['hooks']);
    guard.block(['hooks', 'no-such-store']);
    guard.block(['memory']);
    expect(guard.blockedStores().sort()).toEqual(['hooks', 'memory']);
  });
});
