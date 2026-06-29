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
  // now:()=>1 keeps the idle-reuse freeze probe dormant (idleMs stays tiny), so these
  // serialization/interrupt tests exercise only the command lane — the freeze gate has
  // its own harness + cases below.
  const client = createVmClient({ registry, tracker, sendTabMessage, now: () => 1 });
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

// --- vm-client: wedged / frozen-tab self-heal -----------------------------

/**
 * Reboot harness. `plan` is consumed one entry per send (probe + run included):
 * 'hang' never settles (→ the round-trip timeout fires), anything else resolves as
 * the reply. `fresh:true` makes getTabId report no tab until ensureTab runs (a fresh
 * create → the idle-reuse probe is skipped). `now` drives idle accounting; lastUsed
 * starts empty, so idleMs === now() — a small now() reads as "recently used".
 * @param {{ plan: (string | object)[], timeoutMs?: number, readyProbeMs?: number,
 *           idleProbeMs?: number, fresh?: boolean, now?: () => number }} cfg
 */
const makeRebootHarness = ({ plan, timeoutMs = 40, readyProbeMs = 40, idleProbeMs = 1000, fresh = false, now }) => {
  let sends = 0;
  let created = false;
  /** @type {{ tabId: number, message: any }[]} */ const calls = [];
  /** @type {string[]} */ const reloads = [];
  /** @type {string[]} */ const marked = [];
  /** @param {number} tabId @param {object} message */
  const sendTabMessage = (tabId, message) => {
    calls.push({ tabId, message: /** @type {any} */ (message) });
    const step = plan[sends];
    sends += 1;
    if (step === 'hang' || step === undefined) return new Promise(() => {});
    return Promise.resolve(step);
  };
  const tracker = /** @type {ReturnType<typeof import('/background/vm-tab-tracker.js').createVmTabTracker>} */ (/** @type {unknown} */ ({
    ensureTab: async () => { created = true; return 7; },
    getTabId: () => (fresh && !created ? null : 7),
    /** @param {string} id */ reloadTab: async (id) => { reloads.push(id); return true; },
    /** @param {string} id */ markReloading: (id) => { marked.push(id); },
  }));
  const registry = /** @type {ReturnType<typeof import('/peerd-engine/index.js').createVmRegistry>} */ (/** @type {unknown} */ ({
    /** @param {string} id */ get: async (id) => ({ id }),
    getDefaultForSession: async () => null,
    setDefaultForSession: async () => {},
    create: async () => ({ id: 'vm-1' }),
  }));
  const client = createVmClient({
    registry, tracker, sendTabMessage,
    messageTimeoutMs: timeoutMs, readyProbeMs, idleProbeMs,
    ...(now ? { now } : {}),
  });
  return { client, calls, reloads, marked, sendCount: () => sends };
};

const OK_RUN = { ok: true, result: { stdout: 'ok\n', stderr: '', exitCode: 0, durationMs: 1 } };

describe('vm-client — mid-call freeze (reactive reload)', () => {
  // now:()=>1 → idleMs tiny → the idle-reuse PROBE is skipped; these isolate the
  // reactive channel-timeout backstop.
  it('reloads a tab that goes dark mid-call, then retries the command', async () => {
    const h = makeRebootHarness({ plan: ['hang', OK_RUN], now: () => 1 });
    const out = await h.client.run('echo hi', { vmId: 'vm-a' });
    expect(out.stdout).toBe('ok\n');
    expect(h.reloads).toEqual(['vm-a']);
    expect(h.marked).toEqual(['vm-a']);     // reset readiness so ensureTab waits for re-boot
    expect(h.sendCount()).toBe(2);          // original + one retry
  });

  it('gives a terminal error (no loop) when still unresponsive after the reload', async () => {
    const h = makeRebootHarness({ plan: ['hang', 'hang'], now: () => 1 });
    const err = await h.client.run('echo hi', { vmId: 'vm-a' }).then(() => null, (e) => e);
    expect(err?.message).toContain('unresponsive');
    expect(h.reloads).toEqual(['vm-a']);
    expect(h.sendCount()).toBe(2);          // original + one retry, then stop — not a loop
  });

  it('the liveness probe never reboots — isReady returns false on a wedged tab', async () => {
    const h = makeRebootHarness({ plan: ['hang'], now: () => 1 });
    const ready = await h.client.isReady({ vmId: 'vm-a' });
    expect(ready).toBe(false);
    expect(h.reloads).toEqual([]);          // reboot:false — a probe must not recreate a tab
    expect(h.sendCount()).toBe(1);
  });
});

describe('vm-client — idle-reuse freeze gate', () => {
  const READY = { ok: true, ready: true };
  const NOT_READY = { ok: true, ready: false };

  it('probes a long-idle reused tab and recreates it BEFORE the command when frozen', async () => {
    // now()=50000 > idleProbeMs(1000) → idle; reused (getTabId→7); probe says frozen.
    const h = makeRebootHarness({ plan: [NOT_READY, OK_RUN], now: () => 50_000 });
    const out = await h.client.run('echo hi', { vmId: 'vm-a' });
    expect(out.stdout).toBe('ok\n');
    expect(h.calls[0].message.type).toBe('vm/is-ready');   // probed first
    expect(h.reloads).toEqual(['vm-a']);                   // recreated BEFORE the run
    expect(h.calls[1].message.type).toBe('vm/run');
    expect(h.sendCount()).toBe(2);
  });

  it('probes but does NOT recreate when the idle tab is still alive', async () => {
    const h = makeRebootHarness({ plan: [READY, OK_RUN], now: () => 50_000 });
    const out = await h.client.run('echo hi', { vmId: 'vm-a' });
    expect(out.stdout).toBe('ok\n');
    expect(h.calls[0].message.type).toBe('vm/is-ready');
    expect(h.reloads).toEqual([]);                         // alive → no reload
    expect(h.sendCount()).toBe(2);
  });

  it('skips the probe for a recently-used VM (no per-command overhead)', async () => {
    // now()=100 < idleProbeMs(1000) → not idle → no probe; the run is the only send.
    const h = makeRebootHarness({ plan: [OK_RUN], now: () => 100 });
    const out = await h.client.run('echo hi', { vmId: 'vm-a' });
    expect(out.stdout).toBe('ok\n');
    expect(h.calls[0].message.type).toBe('vm/run');        // no is-ready probe
    expect(h.reloads).toEqual([]);
    expect(h.sendCount()).toBe(1);
  });

  it('skips the probe for a freshly created VM (not a reuse)', async () => {
    const h = makeRebootHarness({ plan: [OK_RUN], now: () => 50_000, fresh: true });
    const out = await h.client.run('echo hi', { vmId: 'vm-a' });
    expect(out.stdout).toBe('ok\n');
    expect(h.calls[0].message.type).toBe('vm/run');        // fresh create → no probe
    expect(h.reloads).toEqual([]);
    expect(h.sendCount()).toBe(1);
  });
});
