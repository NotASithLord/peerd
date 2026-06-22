// @ts-check
// VM tab-close interrupt + per-VM command serialization — SW-side.
//
// Exercises createVmTabTracker and createVmClient with injected IO
// (stub tabs API / stub sendTabMessage), in the browser so the real
// webextension-polyfill module and promise semantics are in play. The
// pure lane logic itself (createKeyedQueue) is covered in Bun at
// tests/peerd-engine/command-queue.test.ts.

import { describe, it, expect } from '../../framework.js';
import { createVmTabTracker } from '/background/vm-tab-tracker.js';
import { createVmClient } from '/background/vm-client.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * A bare deferred whose settle value is whatever the test hands it (a tab
 * reply, `{ ok: true }`, a run result) — genuinely dynamic, so `any`.
 * @returns {{ promise: Promise<any>, resolve: (value?: any) => void, reject: (reason?: any) => void }}
 */
const deferred = () => {
  /** @type {(value?: any) => void} */
  let resolve = () => {};
  /** @type {(reason?: any) => void} */
  let reject = () => {};
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

/**
 * Stub tabs API: create() mints live ids; get() throws for dead ids. Only the
 * handful of methods the tracker touches are implemented; cast to the full
 * Tabs.Static the tracker's `tabs` dep expects.
 * @returns {{ live: Set<number>, api: import('webextension-polyfill').Tabs.Static }}
 */
const stubTabs = () => {
  /** @type {Set<number>} */
  const live = new Set();
  let nextId = 100;
  return {
    live,
    api: /** @type {import('webextension-polyfill').Tabs.Static} */ (/** @type {unknown} */ ({
      query: async () => [],
      /** @param {number} id */
      get: async (id) => {
        if (!live.has(id)) throw new Error(`No tab with id: ${id}.`);
        return { id };
      },
      create: async () => { const id = nextId++; live.add(id); return { id }; },
      update: async () => ({}),
      /** @param {number} id */
      remove: async (id) => { live.delete(id); },
    })),
  };
};

describe('vm-tab-tracker — tab close', () => {
  it('onTabReady pins the mapping; onTabRemoved returns the dropped vmId', () => {
    const tracker = createVmTabTracker({ tabs: stubTabs().api });
    tracker.onTabReady('vm-x', 50);
    expect(tracker.getTabId('vm-x')).toBe(50);
    expect(tracker.isReady('vm-x')).toBe(true);
    expect(tracker.onTabRemoved(50)).toBe('vm-x');
    expect(tracker.getTabId('vm-x')).toBe(null);
  });

  it('onTabRemoved for an unknown tab returns null', () => {
    const tracker = createVmTabTracker({ tabs: stubTabs().api });
    expect(tracker.onTabRemoved(999)).toBe(null);
  });

  it('ensureTab resolves once the spawned tab announces ready', async () => {
    const tracker = createVmTabTracker({ tabs: stubTabs().api });
    const pending = tracker.ensureTab('vm-x');
    await tick();                      // let tabs.create settle
    tracker.onTabReady('vm-x', /** @type {number} */ (tracker.getTabId('vm-x')));
    expect(await pending).toBe(100);
  });

  it('closing the tab mid-spawn rejects pending ensureTab with VMTabClosedError', async () => {
    const tracker = createVmTabTracker({ tabs: stubTabs().api });
    const pending = tracker.ensureTab('vm-x');
    const settled = pending.then(() => null, (e) => e);   // attach early: no unhandled rejection
    await tick();                      // tab created (id 100), not ready yet
    expect(tracker.onTabRemoved(100)).toBe('vm-x');
    const err = await settled;
    expect(err?.name).toBe('VMTabClosedError');
    expect(err?.vmId).toBe('vm-x');
  });

  it('a tab close with NO ready-waiter leaves no unhandled rejection behind', async () => {
    // why: each entry eagerly creates a readyPromise that tab close
    // rejects; this guards that the rejection never surfaces as an
    // unhandled rejection in the SW console, listeners or not.
    /** @type {unknown} */
    let unhandled = null;
    /** @param {PromiseRejectionEvent} e */
    const onUnhandled = (e) => { unhandled = e.reason; e.preventDefault(); };
    self.addEventListener('unhandledrejection', onUnhandled);
    try {
      const tracker = createVmTabTracker({ tabs: stubTabs().api });
      const pending = tracker.ensureTab('vm-x');
      pending.catch(() => {});         // the CALLER's handler; entry's own promise stays bare
      await tick();
      tracker.onTabRemoved(100);
      await tick(); await tick();      // give the event loop a chance to flag it
      expect(unhandled).toBe(null);
    } finally {
      self.removeEventListener('unhandledrejection', onUnhandled);
    }
  });
});

// --- vm-client: serialization + interrupt ---------------------------------

/**
 * Client harness: sendTabMessage returns deferreds the test settles;
 * tracker is a trivial always-live stub (tracker behavior is covered
 * above); registry auto-creates vm-1, vm-2, ... lazily per session.
 */
const makeHarness = () => {
  /** @type {{ tabId: number, message: Record<string, any> }[]} */
  const calls = [];
  /** @type {ReturnType<typeof deferred>[]} */
  const pendings = [];
  /** @param {number} tabId @param {object} message */
  const sendTabMessage = (tabId, message) => {
    const d = deferred();
    calls.push({ tabId, message: /** @type {Record<string, any>} */ (message) });
    pendings.push(d);
    return d.promise;
  };
  /** @type {string | null} */
  let defaultId = null;
  let created = 0;
  // Minimal registry/tracker stubs — only the methods vm-client reaches are
  // implemented; cast each to the production type createVmClient's deps expect.
  const registry = /** @type {ReturnType<typeof import('/peerd-engine/index.js').createVmRegistry>} */ (/** @type {unknown} */ ({
    /** @param {string} id */
    get: async (id) => ({ id }),
    getDefaultForSession: async () => defaultId,
    /** @param {string} _sid @param {string} id */
    setDefaultForSession: async (_sid, id) => { defaultId = id; },
    create: async () => ({ id: `vm-${++created}` }),
  }));
  const tracker = /** @type {ReturnType<typeof import('/background/vm-tab-tracker.js').createVmTabTracker>} */ (/** @type {unknown} */ (
    { ensureTab: async () => 7, getTabId: () => 7 }));
  const client = createVmClient({ registry, tracker, sendTabMessage });
  /** @param {string} stdout */
  const okRun = (stdout) => ({
    ok: true,
    result: { stdout, stderr: '', exitCode: 0, durationMs: 1 },
  });
  return { client, calls, pendings, okRun, createdCount: () => created };
};

describe('vm-client — per-VM command queue', () => {
  it('serializes commands to the same VM: second starts after first settles', async () => {
    const h = makeHarness();
    const r1 = h.client.run('echo one', { vmId: 'vm-a' });
    const r2 = h.client.run('echo two', { vmId: 'vm-a' });
    await tick();
    expect(h.calls.length).toBe(1);    // second RPC has NOT been sent
    expect(h.calls[0].message.cmd).toBe('echo one');

    h.pendings[0].resolve(h.okRun('one\n'));
    expect((await r1).stdout).toBe('one\n');
    await tick();
    expect(h.calls.length).toBe(2);
    expect(h.calls[1].message.cmd).toBe('echo two');

    h.pendings[1].resolve(h.okRun('two\n'));
    expect((await r2).stdout).toBe('two\n');
  });

  it('commands to different VMs run concurrently', async () => {
    const h = makeHarness();
    h.client.run('echo a', { vmId: 'vm-a' }).catch(() => {});
    h.client.run('echo b', { vmId: 'vm-b' }).catch(() => {});
    await tick();
    expect(h.calls.length).toBe(2);    // neither waited for the other
    expect(h.calls.map((c) => c.message.vmId).sort()).toEqual(['vm-a', 'vm-b']);
  });

  it('writeFile shares the lane with run (both drive the same bash)', async () => {
    const h = makeHarness();
    const r1 = h.client.run('long job', { vmId: 'vm-a' });
    const w = h.client.writeFile('/tmp/x', new Uint8Array([1]), { vmId: 'vm-a' });
    await tick();
    expect(h.calls.length).toBe(1);
    h.pendings[0].resolve(h.okRun(''));
    await r1;
    await tick();
    expect(h.calls.length).toBe(2);
    expect(h.calls[1].message.type).toBe('vm/write-file');
    h.pendings[1].resolve({ ok: true });
    await w;
  });

  it('onTabClosed rejects in-flight AND queued commands with VMTabClosedError', async () => {
    const h = makeHarness();
    const r1 = h.client.run('inflight', { vmId: 'vm-a' });
    const r2 = h.client.run('queued', { vmId: 'vm-a' });
    const e1p = r1.then(() => null, (e) => e);
    const e2p = r2.then(() => null, (e) => e);
    await tick();
    expect(h.calls.length).toBe(1);

    h.client.onTabClosed('vm-a');
    const [e1, e2] = await Promise.all([e1p, e2p]);
    expect(e1?.name).toBe('VMTabClosedError');
    expect(e2?.name).toBe('VMTabClosedError');
    expect(e1?.message).toContain('vm-a');

    // the orphaned RPC settling later is dropped without effect
    h.pendings[0].resolve(h.okRun('zombie'));
    await tick();
  });

  it('after onTabClosed a fresh command starts immediately (no 90s orphan wait)', async () => {
    const h = makeHarness();
    const r1 = h.client.run('inflight', { vmId: 'vm-a' });
    r1.catch(() => {});
    await tick();
    h.client.onTabClosed('vm-a');

    const r3 = h.client.run('fresh', { vmId: 'vm-a' });
    await tick();
    // 2 sends total: the orphan + the fresh one — fresh did not queue
    // behind the orphan's still-unsettled deferred.
    expect(h.calls.length).toBe(2);
    expect(h.calls[1].message.cmd).toBe('fresh');
    h.pendings[1].resolve(h.okRun('fresh\n'));
    expect((await r3).stdout).toBe('fresh\n');
  });

  it('concurrent first commands in a session land on ONE auto-created VM', async () => {
    // why: without the resolve lane, both calls see "no default yet"
    // and race registry.create — two VMs for one chat, and the per-VM
    // serialization never engages for exactly the calls it exists for.
    const h = makeHarness();
    const r1 = h.client.run('first', { sessionId: 's1' });
    const r2 = h.client.run('second', { sessionId: 's1' });
    await tick(); await tick();
    expect(h.createdCount()).toBe(1);
    expect(h.calls.length).toBe(1);    // and they serialized on that VM
    expect(h.calls[0].message.vmId).toBe('vm-1');

    h.pendings[0].resolve(h.okRun('1'));
    await r1;
    await tick();
    expect(h.calls[1].message.vmId).toBe('vm-1');
    h.pendings[1].resolve(h.okRun('2'));
    await r2;
  });
});
