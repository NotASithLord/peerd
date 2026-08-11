// @ts-check
// Pod tracker/client integration with injected browser IO. These tests pin the
// lifecycle distinction that matters: a stopped durable Pod is catalog state,
// while execution reopens a tab and each RPC remains instance-addressed.

import { describe, it, expect } from '../../framework.js';
import { createPodClient } from '/background/pod-client.js';
import { createPodTabTracker } from '/background/pod-tab-tracker.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const stubTabs = () => {
  /** @type {Set<number>} */ const live = new Set();
  let nextId = 40;
  return {
    live,
    api: /** @type {import('webextension-polyfill').Tabs.Static} */ (/** @type {unknown} */ ({
      query: async () => [],
      get: async (/** @type {number} */ id) => {
        if (!live.has(id)) throw new Error('tab missing');
        return { id };
      },
      create: async () => { const id = nextId++; live.add(id); return { id }; },
      remove: async (/** @type {number} */ id) => { live.delete(id); },
      update: async () => ({}),
    })),
  };
};

describe('Pod tab tracker', () => {
  it('spawns, becomes ready, and cleanly forgets a closed worker host', async () => {
    const tabs = stubTabs();
    /** @type {string[]} */ const events = [];
    const tracker = createPodTabTracker({
      tabs: tabs.api,
      onAdopt: (id, tabId) => events.push(`adopt:${id}:${tabId}`),
      onDrop: (id) => events.push(`drop:${id}`),
    });
    tracker.onTabPending('pod-reopened', 39);
    expect(tracker.getTabId('pod-reopened')).toBe(39);
    expect(tracker.onTabRemoved(39)).toBe('pod-reopened');
    const opening = tracker.ensureTab('pod-test');
    await tick();
    expect(tracker.getTabId('pod-test')).toBe(40);
    tracker.onTabReady('pod-test', 40);
    expect(await opening).toBe(40);
    expect(tracker.onTabRemoved(40)).toBe('pod-test');
    expect(tracker.getTabId('pod-test')).toBe(null);
    expect(events).toEqual([
      'adopt:pod-reopened:39', 'drop:pod-reopened',
      'adopt:pod-test:40', 'adopt:pod-test:40', 'drop:pod-test',
    ]);
  });
});

describe('Pod client', () => {
  it('reports a stopped durable Pod without opening it, then reopens for exec', async () => {
    /** @type {string|null} */ let defaultId = 'pod-1';
    let created = 0;
    /** @type {number|null} */ let liveTab = null;
    let opened = 0;
    /** @type {Array<{tabId:number,message:any}>} */ const messages = [];
    const registry = {
      get: async (/** @type {string} */ id) => ({ id, persistent: true }),
      getDefaultForSession: async () => defaultId,
      setDefaultForSession: async (/** @type {string} */ _sessionId, /** @type {string} */ id) => { defaultId = id; },
      create: async () => ({ id: `pod-${++created}` }),
    };
    const tracker = {
      getTabId: () => liveTab,
      ensureTab: async () => { opened += 1; liveTab = 71; return liveTab; },
    };
    const client = createPodClient({
      registry,
      tracker,
      sendTabMessage: async (tabId, message) => {
        messages.push({ tabId, message });
        return { ok: true, job: { id: 'job-1', state: 'completed', stdout: 'ok\n', stderr: '', exitCode: 0 } };
      },
    });

    expect(await client.status({ sessionId: 'session-a' })).toEqual({ podId: 'pod-1', persistent: true, state: 'stopped', cwd: '/', jobs: [] });
    expect(opened).toBe(0);
    const result = await client.exec('echo ok', { sessionId: 'session-a', background: true });
    expect(result).toEqual({ podId: 'pod-1', id: 'job-1', state: 'completed', stdout: 'ok\n', stderr: '', exitCode: 0 });
    expect(opened).toBe(1);
    expect(messages[0].tabId).toBe(71);
    expect({ ...messages[0].message, jobId: '<job>' }).toEqual({
      type: 'pod/exec', command: 'echo ok', timeoutMs: undefined,
      background: true, remoteGitGrant: null, podId: 'pod-1',
      jobId: '<job>',
    });
    expect(messages[0].message.jobId.startsWith('job-')).toBe(true);
  });

  it('a read-only status does not create a current Pod', async () => {
    let created = false;
    const client = createPodClient({
      registry: {
        getDefaultForSession: async () => null,
        create: async () => { created = true; return { id: 'pod-new' }; },
      },
      tracker: { getTabId: () => null },
      sendTabMessage: async () => ({}),
    });
    let message = '';
    try { await client.status({ sessionId: 'session-a' }); }
    catch (error) { message = /** @type {{message?:string}} */ (error)?.message ?? ''; }
    expect(message).toContain('No current Pod');
    expect(created).toBe(false);
  });

  it('rejects an explicit id missing from the Pod registry', async () => {
    const client = createPodClient({
      registry: { get: async () => null },
      tracker: {},
      sendTabMessage: async () => ({}),
    });
    let message = '';
    try { await client.exec('pwd', { podId: 'pod-missing' }); }
    catch (error) { message = /** @type {{message?:string}} */ (error)?.message ?? ''; }
    expect(message).toContain('Pod not found');
  });

  it('binds foreground execution to the caller abort signal', async () => {
    /** @type {any[]} */ const messages = [];
    /** @type {(value:any)=>void} */ let finishExec = () => {};
    const client = createPodClient({
      registry: { get: async () => ({ id: 'pod-1' }) },
      tracker: { getTabId: () => 7, ensureTab: async () => 7 },
      sendTabMessage: async (_tabId, message) => {
        messages.push(message);
        if (message.type === 'pod/cancel') {
          finishExec({ ok: true, job: { id: message.jobId, state: 'failed', exitCode: 130 } });
          return { ok: true, cancelled: true };
        }
        return new Promise((resolve) => { finishExec = resolve; });
      },
    });
    const controller = new AbortController();
    const running = client.exec('sleep 30', { podId: 'pod-1', signal: controller.signal });
    await tick();
    controller.abort();
    expect((await running).exitCode).toBe(130);
    expect(messages.map((message) => message.type)).toEqual(['pod/exec', 'pod/cancel']);
    expect(messages[1].jobId).toBe(messages[0].jobId);
  });

  it('does not dispatch a foreground command stopped while its Pod tab is opening', async () => {
    /** @type {()=>void} */ let finishOpening = () => {};
    const opening = new Promise((resolve) => { finishOpening = () => resolve(7); });
    /** @type {any[]} */ const messages = [];
    const client = createPodClient({
      registry: { get: async () => ({ id: 'pod-1' }) },
      tracker: { getTabId: () => 7, ensureTab: async () => opening },
      sendTabMessage: async (_tabId, message) => {
        messages.push(message);
        return { ok: true, job: { id: message.jobId, state: 'completed', exitCode: 0 } };
      },
    });
    const controller = new AbortController();
    const running = client.exec('echo too-late', { podId: 'pod-1', signal: controller.signal });
    await tick();
    controller.abort();
    finishOpening();
    let message = '';
    try { await running; }
    catch (error) { message = /** @type {{message?:string}} */ (error)?.message ?? ''; }
    expect(message).toContain('cancelled before dispatch');
    expect(messages.some((entry) => entry.type === 'pod/exec')).toBe(false);
  });

  it('renews a live external workspace lease and releases it after the operation', async () => {
    /** @type {any[]} */ const messages = [];
    /** @type {()=>void} */ let heartbeat = () => {};
    let cleared = false;
    const client = createPodClient({
      registry: { get: async () => ({ id: 'pod-1' }) },
      tracker: { getTabId: () => 7 },
      sendTabMessage: async (_tabId, message) => {
        messages.push(message);
        return { ok: true, ...(message.action === 'acquire' ? { leaseMs: 30_000 } : {}) };
      },
      setIntervalFn: (/** @type {()=>void} */ callback) => { heartbeat = callback; return 123; },
      clearIntervalFn: (id) => { expect(id).toBe(123); cleared = true; },
    });
    /** @type {()=>void} */ let finish = () => {};
    const gate = new Promise((resolve) => { finish = () => resolve(undefined); });
    const running = client.withWorkspaceLock('pod-1', async () => {
      heartbeat();
      await gate;
      return 'done';
    });
    await tick();
    expect(messages.map((message) => message.action)).toEqual(['acquire', 'renew']);
    finish();
    expect(await running).toBe('done');
    expect(cleared).toBe(true);
    expect(messages.map((message) => message.action)).toEqual(['acquire', 'renew', 'release']);
    expect(new Set(messages.map((message) => message.token)).size).toBe(1);
  });
});
