import { describe, test, expect } from 'bun:test';
import { makeSettingsStore } from '../../extension/background/settings-store.js';

// Pins the Option A migration semantics that used to live inline as let
// settings/storedSettings: stored holds only user-set keys, merged overlays
// defaults, reset FORGETS (so the key tracks the channel default again).

const makeKv = (initial: any = undefined) => {
  let v: any = initial;
  return { get: async () => v, set: async (_k: string, val: any) => { v = val; }, _peek: () => v };
};

const defaults = { a: 1, b: 2, c: 3 };
const store = (kv: any = makeKv()) => makeSettingsStore({ kv, key: 'settings.v1', defaults });

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe('settings-store', () => {
  test('network defaults are not consent, while explicit choices survive restart and restore', async () => {
    const kv = makeKv();
    const previous = makeSettingsStore({ kv, key: 'settings.v1', defaults: { dwebEnabled: true } });
    await previous.load();
    await previous.update({ devMode: true });
    expect(previous.stored()).not.toHaveProperty('dwebEnabled');
    const open = () => makeSettingsStore({ kv, key: 'settings.v1', defaults: {
      dwebEnabled: false, dwebAgentEnabled: false,
    } });
    const migrated = open();
    await migrated.load();
    expect(migrated.get().dwebEnabled).toBe(false);
    expect(migrated.stored()).not.toHaveProperty('dwebEnabled');
    for (const choice of [true, false]) {
      await migrated.update({ dwebEnabled: choice });
      const restarted = open();
      await restarted.load();
      expect(restarted.stored().dwebEnabled).toBe(choice);
      expect(restarted.get().dwebAgentEnabled).toBe(false);
      const restored = makeSettingsStore({ kv: makeKv(restarted.stored()), key: 'settings.v1',
        defaults: { dwebEnabled: false, dwebAgentEnabled: false } });
      await restored.load();
      expect(restored.get().dwebEnabled).toBe(choice);
      expect(restored.stored().dwebEnabled).toBe(choice);
    }
    await migrated.reset(['dwebEnabled']);
    expect(migrated.get().dwebEnabled).toBe(false);
    expect(migrated.stored()).not.toHaveProperty('dwebEnabled');
  });
  test('get() is defaults before load', () => {
    expect(store().get()).toEqual(defaults);
  });
  test('load merges stored over defaults; stored() is user-set only', async () => {
    const s = store(makeKv({ b: 20 }));
    await s.load();
    expect(s.get()).toEqual({ a: 1, b: 20, c: 3 });
    expect(s.stored()).toEqual({ b: 20 });
  });
  test('load ignores a non-object stored blob', async () => {
    const s = store(makeKv('garbage'));
    await s.load();
    expect(s.get()).toEqual(defaults);
  });
  test('update merges, persists only user-set keys, returns merged', async () => {
    const kv = makeKv();
    const s = store(kv);
    await s.load();
    const merged = await s.update({ a: 10 });
    expect(merged).toEqual({ a: 10, b: 2, c: 3 });
    expect(s.stored()).toEqual({ a: 10 });
    expect(kv._peek()).toEqual({ a: 10 }); // defaults never persisted
  });
  test('update is cumulative across calls', async () => {
    const s = store();
    await s.update({ a: 10 });
    await s.update({ b: 20 });
    expect(s.stored()).toEqual({ a: 10, b: 20 });
  });
  test('reset FORGETS keys so they track the default again', async () => {
    const kv = makeKv({ a: 10, b: 20 });
    const s = store(kv);
    await s.load();
    await s.reset(['a']);
    expect(s.get()).toEqual({ a: 1, b: 20, c: 3 }); // a back to default
    expect(s.stored()).toEqual({ b: 20 });
    expect(kv._peek()).toEqual({ b: 20 });
  });
  test('a stored key equal to its default still persists verbatim (Option A)', async () => {
    const s = store(makeKv({ a: 1 })); // equals default
    await s.load();
    expect(s.stored()).toEqual({ a: 1 }); // honored verbatim, not dropped
  });
  test('a cold-worker write waits for hydration and preserves existing settings', async () => {
    const read = deferred<any>();
    const writes: any[] = [];
    const kv = {
      get: () => read.promise,
      set: async (_key: string, value: any) => { writes.push({ ...value }); },
    };
    const s = store(kv);
    const loading = s.load();
    const updating = s.update({ a: 10 });
    await Promise.resolve();
    expect(writes).toEqual([]);

    read.resolve({ b: 20 });
    await Promise.all([loading, updating]);
    expect(s.stored()).toEqual({ a: 10, b: 20 });
    expect(writes).toEqual([{ a: 10, b: 20 }]);
  });
  test('concurrent mutations persist in call order even when storage is slow', async () => {
    const firstWrite = deferred<void>();
    const writes: any[] = [];
    const kv = {
      get: async () => ({ c: 30 }),
      set: async (_key: string, value: any) => {
        writes.push({ ...value });
        if (writes.length === 1) await firstWrite.promise;
      },
    };
    const s = store(kv);
    await s.load();
    const first = s.update({ a: 10 });
    const second = s.update({ b: 20 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writes).toEqual([{ a: 10, c: 30 }]);

    firstWrite.resolve();
    await Promise.all([first, second]);
    expect(writes).toEqual([
      { a: 10, c: 30 },
      { a: 10, b: 20, c: 30 },
    ]);
    expect(s.stored()).toEqual({ a: 10, b: 20, c: 30 });
  });
  test('a failed hydration is retried before the next mutation', async () => {
    let reads = 0;
    const writes: any[] = [];
    const kv = {
      get: async () => {
        reads += 1;
        if (reads === 1) throw new Error('temporary storage failure');
        return { b: 20 };
      },
      set: async (_key: string, value: any) => { writes.push({ ...value }); },
    };
    const s = store(kv);
    await expect(s.load()).rejects.toThrow('temporary storage failure');
    await s.update({ a: 10 });
    expect(reads).toBe(2);
    expect(writes).toEqual([{ a: 10, b: 20 }]);
  });
  test('a rejected persistence write does not leak into memory or a later write', async () => {
    let writes = 0;
    const saved: any[] = [];
    const kv = {
      get: async () => ({ b: 20 }),
      set: async (_key: string, value: any) => {
        writes += 1;
        if (writes === 1) throw new Error('disk full');
        saved.push({ ...value });
      },
    };
    const s = store(kv);
    await s.load();
    await expect(s.update({ a: 10 })).rejects.toThrow('disk full');
    expect(s.get()).toEqual({ a: 1, b: 20, c: 3 });
    expect(s.stored()).toEqual({ b: 20 });

    await s.update({ c: 30 });
    expect(saved).toEqual([{ b: 20, c: 30 }]);
    expect(s.stored()).toEqual({ b: 20, c: 30 });
  });
});

test('explicit discovery choice persists across restart without changing transport consent', async () => {
  const kv = makeKv(); const defaults = { dwebEnabled: false, dwebDiscoveryEnabled: true };
  const open = () => makeSettingsStore({ kv, key: 'settings.v1', defaults });
  const settings = open(); await settings.load();
  for (const enabled of [true, false]) {
    await settings.update({ dwebDiscoveryEnabled: enabled });
    expect(kv._peek().dwebDiscoveryEnabled).toBe(enabled);
    const restarted = open(); await restarted.load();
    expect(restarted.get()).toEqual({ dwebEnabled: false, dwebDiscoveryEnabled: enabled });
  }
});

test('settings mutation checks its authority after queueing and hydration before persistence', async () => {
  for (const phase of ['queue', 'hydrate']) {
    const gate = deferred<void>(); let writes = 0; let current = true;
    const kv = { get: async () => { if (phase === 'hydrate') await gate.promise; return undefined; },
      set: async () => { writes++; if (phase === 'queue' && writes === 1) await gate.promise; } };
    const settings = makeSettingsStore({ kv, key: 'settings.v1', defaults: {} });
    const held = phase === 'queue' ? settings.update({ unrelated: true }) : Promise.resolve();
    const pending = settings.update({ dwebDiscoveryEnabled: false }, () => current);
    await Promise.resolve(); await Promise.resolve(); current = false; gate.resolve(); await held;
    await expect(pending).rejects.toThrow('settings-authority-retired');
    expect(writes).toBe(phase === 'queue' ? 1 : 0);
    expect(settings.stored()).not.toHaveProperty('dwebDiscoveryEnabled');
  }
});

test('discovery refresh never creates a host and distinguishes inactive from failed live enforcement', async () => {
  const { refreshDiscoverySetting } = await import('../../extension/background/dweb-peer-policy.js');
  let settings: Record<string, any> = { dwebEnabled: false, dwebDiscoveryEnabled: true };
  let contexts: any[] = [], sends = 0, probes = 0;
  let reply: any = { ok: true, enabled: true };
  const browser = { runtime: { getContexts: async () => { probes++; return contexts; },
    sendMessage: async (message: any) => { sends++; expect(message).toEqual({ type: 'dweb/base-host/set-discovery' }); return reply; } } };
  const deps = { browser, settingsStore: { get: () => settings } };
  expect(await refreshDiscoverySetting(deps)).toEqual({ ok: true, inactive: true, enabled: true });
  expect(probes).toBe(1); expect(sends).toBe(0);
  settings.dwebEnabled = true;
  expect(await refreshDiscoverySetting(deps)).toMatchObject({ ok: true, inactive: true });
  expect(sends).toBe(0);
  contexts = [{}];
  expect(await refreshDiscoverySetting(deps)).toEqual(reply);
  for (reply of [{ ok: false }, { ok: true, enabled: false }, undefined]) {
    await expect(refreshDiscoverySetting(deps)).rejects.toThrow('discovery-enforcement-unconfirmed');
  }
  settings = { dwebEnabled: false, dwebDiscoveryEnabled: 'true' };
  await expect(refreshDiscoverySetting(deps)).rejects.toThrow('discovery-enforcement-unconfirmed');
  contexts = [];
  expect(await refreshDiscoverySetting(deps)).toMatchObject({ enabled: false, inactive: true });
});

test('late discovery acknowledgment cannot confirm a superseded preference or retired authority', async () => {
  const { refreshDiscoverySetting } = await import('../../extension/background/dweb-peer-policy.js');
  for (const change of ['preference', 'authority']) {
    const gate = deferred<any>(); const entered = deferred<void>(); let current = true;
    const settings = { dwebEnabled: true, dwebDiscoveryEnabled: false };
    const pending = refreshDiscoverySetting({ settingsStore: { get: () => settings }, browser: { runtime: {
      getContexts: async () => [{}], sendMessage: async () => { entered.resolve(); return gate.promise; },
    } } }, () => current);
    await entered.promise;
    if (change === 'preference') settings.dwebDiscoveryEnabled = true; else current = false;
    gate.resolve({ ok: true, enabled: false });
    await expect(pending).rejects.toThrow('discovery-enforcement-unconfirmed');
  }
});

test('timed-out context discovery cannot dispatch a late refresh command', async () => {
  const { refreshDiscoverySetting } = await import('../../extension/background/dweb-peer-policy.js');
  const contexts = deferred<any[]>(); let sends = 0;
  const pending = refreshDiscoverySetting({ settingsStore: { get: () => ({ dwebEnabled: true, dwebDiscoveryEnabled: false }) },
    browser: { runtime: { getContexts: () => contexts.promise, sendMessage: async () => { sends++; } } } });
  await expect(pending).rejects.toThrow('discovery-enforcement-timeout');
  contexts.resolve([{}]); await Promise.resolve(); await Promise.resolve();
  expect(sends).toBe(0);
}, 8_000);

test('combined master-off settings await teardown before discovery refresh', async () => {
  const source = await Bun.file(new URL('../../extension/background/vault-kernel.js', import.meta.url)).text();
  const start = source.indexOf('const onKernelSettingsChanged =');
  const end = source.indexOf('const lockLifecycle =', start);
  const gate = deferred<void>(); const events: string[] = [];
  const lifecycle = new Function('featureHost',
    source.slice(start, end) + '\nreturn onKernelSettingsChanged;')(
    { runtime: { disable: async () => { events.push('stopping'); await gate.promise; events.push('stopped'); } } });
  const demand = await Bun.file(new URL('../../extension/background/kernel-demand-plane.js', import.meta.url)).text();
  const wrapperStart = demand.indexOf('  const onSettingsChanged =');
  const wrapperEnd = demand.indexOf('  const authorityScheduler =', wrapperStart);
  const changed = new Function('deps', 'refreshDiscoverySetting',
    demand.slice(wrapperStart, wrapperEnd) + '\nreturn onSettingsChanged;')(
    { dwebEnabled: true, onSettingsChanged: lifecycle }, async () => { events.push('refresh'); });
  const pending = changed({ dwebEnabled: false, dwebDiscoveryEnabled: false });
  await Promise.resolve(); expect(events).toEqual(['stopping']);
  gate.resolve(); await pending;
  expect(events).toEqual(['stopping', 'stopped', 'refresh']);
});
