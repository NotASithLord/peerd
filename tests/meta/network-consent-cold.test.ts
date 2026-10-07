import { expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { OBSERVER_SOURCE, assertNoTransport } from '../../scripts/cdp/network-consent-cold.mjs';

test('consent oracle rejects actual transport events, independent of lease status', () => {
  assertNoTransport([{ kind: 'observer-ready' }], 'fresh');
  for (const kind of ['WebSocket', 'RTCPeerConnection', 'native-websocket']) {
    expect(() => assertNoTransport([{ kind, lease: 'idle' }], 'fresh')).toThrow('transport before consent');
  }
});

test('constructor observer preserves native construction, subclassing, failures and arguments', () => {
  const records: any[] = [];
  const calls: any[] = [];
  class Native {
    static OPEN = 1;
    value: any;
    constructor(value: any) {
      if (value === 'invalid') throw new TypeError('native rejected');
      this.value = value;
      calls.push({ value, target: new.target });
    }
  }
  const context = { WebSocket: Native, RTCPeerConnection: Native,
    location: { href: 'chrome-extension://fixture/offscreen/offscreen.html' },
    __peerdConsentTransportObserved: (payload: string) => records.push(JSON.parse(payload)) };
  runInNewContext(OBSERVER_SOURCE, context);
  const options = { iceServers: [] };
  const rtc = new context.RTCPeerConnection(options);
  expect(rtc).toBeInstanceOf(Native);
  expect(rtc.value).toBe(options);
  expect(context.WebSocket.OPEN).toBe(1);
  class Derived extends context.WebSocket {}
  const socket = new Derived('wss://example.test');
  expect(socket).toBeInstanceOf(Derived);
  expect(calls[1].target).toBe(Derived);
  expect(() => new context.WebSocket('invalid')).toThrow('native rejected');
  expect(records.map(record => record.kind)).toEqual(['observer-ready', 'RTCPeerConnection', 'WebSocket']);
  runInNewContext(OBSERVER_SOURCE, context); // No wrapping twice after attachment/navigation probes.
  new context.WebSocket('wss://again.test');
  expect(records.filter(record => record.kind === 'WebSocket')).toHaveLength(2);
});

test('a silent CDP command fails with persisted pending-method evidence', async () => {
  const { createConsentDiagnostics } = await import('../../scripts/cdp/network-consent-cold.mjs');
  const evidence: any = { phase: 'before-choice' };
  const snapshots: any[] = [];
  const diagnostic = createConsentDiagnostics(evidence,
    () => snapshots.push(JSON.parse(JSON.stringify(evidence))), 5);
  await expect(diagnostic('Runtime.evaluate session=paused-worker', () => new Promise(() => {})))
    .rejects.toThrow('Consent deadline: Runtime.evaluate session=paused-worker');
  expect(snapshots[0].commands[0].status).toBe('pending');
  expect(snapshots.at(-1).commands[0]).toMatchObject({
    label: 'Runtime.evaluate session=paused-worker', phase: 'before-choice', status: 'failed',
  });
});

test('run watchdog saves failure even when launch never returns; late launch cannot succeed', async () => {
  const { runColdConsent } = await import('../../scripts/cdp/network-consent-cold.mjs');
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const directory = await mkdtemp(`${tmpdir()}/consent-watchdog-`);
  const reportPath = `${directory}/report.json`;
  let finishLaunch!: (ctx: any) => void;
  let closed!: () => void;
  const closing = new Promise<void>(resolve => { closed = resolve; });
  try {
    await expect(runColdConsent({ reportPath, runBudgetMs: 5,
      launch: () => new Promise(resolve => { finishLaunch = resolve; }),
    })).rejects.toThrow('Consent deadline: consent scenario');
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    expect(report.ok).toBe(false);
    expect(report.commands[0].status).toBe('failed');
    finishLaunch({ close: async () => { closed(); } });
    await closing;
    expect(JSON.parse(await readFile(reportPath, 'utf8')).ok).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('observer attachment that finishes after its deadline closes the late connection', async () => {
  const { attachConsentObserver, createConsentDiagnostics } = await import('../../scripts/cdp/network-consent-cold.mjs');
  let finish!: (connection: any) => void;
  let closed!: () => void;
  const closing = new Promise<void>(resolve => { closed = resolve; });
  const diagnostic = createConsentDiagnostics({ phase: 'fresh-locked' }, () => {}, 5);
  await expect(attachConsentObserver('unused', diagnostic,
    () => new Promise(resolve => { finish = resolve; }))).rejects.toThrow('Consent deadline: observer attach');
  finish({ close: closed });
  await closing;
});

const pausedWorker = (injectFails = false) => {
  const listeners = new Set<any>();
  const commands: string[] = [];
  let installed = false;
  let armed = false;
  let applicationRuns = 0;
  const emit = (method: string, params: any) => {
    for (const listener of listeners) listener(method, params, { sessionId: 'worker' });
  };
  const connection = {
    on: (listener: any) => listeners.add(listener),
    off: (listener: any) => listeners.delete(listener),
    async send(method: string, params: any) {
      commands.push(method);
      if (method === 'Runtime.evaluate') return new Promise(() => {}); // Startup wait has no runnable context.
      if (method === 'Debugger.setInstrumentationBreakpoint') {
        expect(params.instrumentation).toBe('beforeScriptExecution');
        armed = true;
        return { breakpointId: 'first-script' };
      }
      if (method === 'Runtime.runIfWaitingForDebugger') {
        expect(commands).toContain('Debugger.setInstrumentationBreakpoint');
        emit('Debugger.paused', { reason: 'instrumentation', callFrames: [{ callFrameId: 'first' }] });
      }
      if (method === 'Debugger.removeBreakpoint') armed = false;
      if (method === 'Debugger.evaluateOnCallFrame') {
        if (armed) {
          emit('Debugger.paused', { reason: 'instrumentation', callFrames: [{ callFrameId: 'injected' }] });
          return new Promise(() => {});
        }
        expect(params.callFrameId).toBe('first');
        if (params.expression === '1') return { result: { value: 1 } };
        if (injectFails) return { exceptionDetails: { text: 'injection refused' } };
        installed = true;
        emit('Runtime.bindingCalled', { name: '__peerdConsentTransportObserved', payload: '{"kind":"observer-ready"}' });
        return { result: { value: true } };
      }
      if (method === 'Debugger.resume') { if (!injectFails) expect(installed).toBe(true); applicationRuns++; }
      return {};
    },
  };
  return { connection, commands, listeners, applicationRuns: () => applicationRuns };
};

test('worker observer installs at its first-script pause before application code runs', async () => {
  const { instrumentPausedTarget, createConsentDiagnostics } = await import('../../scripts/cdp/network-consent-cold.mjs');
  const worker = pausedWorker();
  const diagnostic = createConsentDiagnostics({ phase: 'before-choice' }, () => {}, 20);
  const send = worker.connection.send.bind(worker.connection);
  worker.connection.send = (method, params) => diagnostic(method, () => send(method, params));
  const pauses: any[] = [];
  await instrumentPausedTarget(worker.connection, 'worker', diagnostic, pause => { pauses.push(pause); });
  expect(pauses).toHaveLength(1);
  expect(Object.keys(pauses[0])).toEqual(['reason', 'url', 'scriptId', 'lineNumber', 'columnNumber']);
  expect(worker.commands.indexOf('Debugger.removeBreakpoint')).toBeLessThan(worker.commands.indexOf('Debugger.evaluateOnCallFrame'));
  expect(worker.commands).not.toContain('Runtime.evaluate');
  expect(worker.commands.indexOf('Debugger.evaluateOnCallFrame')).toBeLessThan(worker.commands.indexOf('Debugger.resume'));
  expect(worker.commands).toContain('Debugger.removeBreakpoint');
  expect(worker.listeners.size).toBe(0);
  expect(worker.applicationRuns()).toBe(1);
});

test('failed first-script injection does not release unobserved application code', async () => {
  const { instrumentPausedTarget, createConsentDiagnostics } = await import('../../scripts/cdp/network-consent-cold.mjs');
  const worker = pausedWorker(true);
  await expect(instrumentPausedTarget(worker.connection, 'worker', createConsentDiagnostics({ phase: 'before-choice' }, () => {})))
    .rejects.toThrow('Target observer injection failed');
  expect(worker.listeners.size).toBe(0);
  expect(worker.applicationRuns()).toBe(0);
});

test('enabled Page preload covers the runtime-created current document before offscreen release', async () => {
  const { observeHosts, createConsentDiagnostics } = await import('../../scripts/cdp/network-consent-cold.mjs');
  const origin = 'chrome-extension://fixture/';
  const listeners = new Set<any>();
  const targets = new Map<string, any>();
  const calls: any[] = [];
  const preloads = new Set<string>();
  const pageEnabled = new Set<string>();
  const currentContexts = new Set<string>();
  const instrumented = new Set<string>();
  const evidence: any = { phase: 'fresh-locked', events: [], observerErrors: [] };
  const emit = (method: string, params: any, sessionId?: string) => {
    for (const listener of [...listeners]) listener(method, params, { sessionId });
  };
  const target = (sessionId: string, targetId: string, type: string, url: string, waitingForDebugger: boolean) => {
    const targetInfo = { targetId, type, url };
    targets.set(sessionId, targetInfo);
    emit('Target.attachedToTarget', { sessionId, targetInfo, waitingForDebugger });
  };
  const ready = (sessionId: string) => emit('Runtime.bindingCalled', {
    name: '__peerdConsentTransportObserved', payload: JSON.stringify({ kind: 'observer-ready',
      href: targets.get(sessionId).url || `${origin}offscreen/offscreen.html` }),
  }, sessionId);
  const connection = {
    events: [],
    on: (listener: any) => listeners.add(listener), off: (listener: any) => listeners.delete(listener), close() {},
    async send(method: string, params: any = {}, sessionId?: string): Promise<any> {
      calls.push({ method, params, sessionId });
      if (method === 'Target.getTargets') return { targetInfos: [...targets.values()] };
      if (method === 'Target.setAutoAttach' && params.autoAttach) {
        if (!sessionId) {
          target('home', 'home', 'page', `${origin}home/home.html`, false);
          target('sw', 'sw', 'service_worker', `${origin}background.js`, false);
          target('offscreen', 'offscreen', 'other', '', true);
          target('shared-root', 'shared', 'shared_worker', `${origin}shared.js`, true);
        } else if (['home', 'sw', 'offscreen'].includes(sessionId)) {
          expect(params.filter.some((entry: any) => entry.type === 'service_worker')).toBe(false);
          target(`${sessionId}-worker`, `${sessionId}-worker`, 'worker', `${origin}worker.js`, true);
          target(`${sessionId}-shared`, 'shared', 'shared_worker', `${origin}shared.js`, true);
        }
      }
      if (method === 'Runtime.enable') currentContexts.add(sessionId!);
      if (method === 'Page.enable') pageEnabled.add(sessionId!);
      if (method === 'Page.addScriptToEvaluateOnNewDocument') {
        expect(pageEnabled.has(sessionId!)).toBe(true);
        expect(currentContexts.has(sessionId!)).toBe(true);
        expect(params.runImmediately).toBe(true);
        preloads.add(sessionId!);
        if (params.runImmediately) { instrumented.add(sessionId!); ready(sessionId!); }
      }
      if (method === 'Runtime.evaluate' && params.expression !== '0') {
        expect(targets.get(sessionId!).type).not.toBe('worker');
        expect(sessionId).not.toBe('offscreen');
        ready(sessionId!);
      }
      if (method === 'Debugger.setInstrumentationBreakpoint') return { breakpointId: 'first' };
      if (method === 'Runtime.runIfWaitingForDebugger') {
        if (sessionId === 'offscreen') {
          expect(preloads.has(sessionId)).toBe(true);
          expect(instrumented.has(sessionId)).toBe(true);
          expect(calls.some(call => call.sessionId === sessionId
            && call.method === 'Debugger.setInstrumentationBreakpoint')).toBe(false);
        } else emit('Debugger.paused', { reason: 'instrumentation', callFrames: [{ callFrameId: 'first' }] }, sessionId);
      }
      if (method === 'Debugger.evaluateOnCallFrame') {
        if (params.expression === '1') return { result: { value: 1 } };
        instrumented.add(sessionId!); ready(sessionId!); return { result: { value: true } };
      }
      if (method === 'Debugger.resume') expect(instrumented.has(sessionId!)).toBe(true);
      return {};
    },
  };
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ webSocketDebuggerUrl: 'fake' }) });
  try {
    const observer = await observeHosts({ port: server.port, sw: { id: 'fixture' } }, evidence,
      createConsentDiagnostics(evidence, () => {}), () => {}, async () => connection);
    await observer.barrier();
    expect(evidence.observerErrors).toEqual([]);
    expect(calls.filter(call => call.method === 'Debugger.evaluateOnCallFrame' && call.params.expression !== '1')).toHaveLength(4);
    expect(calls.filter(call => call.method === 'Target.detachFromTarget')).toHaveLength(3);
    for (const parent of ['home', 'sw', 'offscreen']) {
      expect(evidence.events.some((event: any) => event.sessionId === `${parent}-worker`)).toBe(true);
    }
    await observer.close();
    expect(listeners.size).toBe(0);
  } finally { server.stop(true); }
});

test('RTC canary requires native construction and close, while retaining failure stages', async () => {
  const { RTC_CANARY_SOURCE, rtcCanaryComplete } = await import('../../scripts/cdp/network-consent-cold.mjs');
  for (const failure of ['none', 'construct', 'close']) {
    const records: any[] = [];
    const error = new Error(`native ${failure} failed`);
    class Native {
      constructor() { if (failure === 'construct') throw error; }
      close() { if (failure === 'close') throw error; }
    }
    const context = { RTCPeerConnection: Native,
      location: { href: 'chrome-extension://fixture/offscreen/offscreen.html' },
      __peerdConsentTransportObserved: (payload: string) => records.push({ ...JSON.parse(payload), sessionId: 'host' }) };
    runInNewContext(OBSERVER_SOURCE, context);
    if (failure === 'none') expect(runInNewContext(RTC_CANARY_SOURCE, context)).toBe(true);
    else {
      let caught;
      try { runInNewContext(RTC_CANARY_SOURCE, context); } catch (value) { caught = value; }
      expect(caught).toBe(error);
    }
    expect(rtcCanaryComplete(records, 'host')).toBe(failure === 'none');
    expect(rtcCanaryComplete([{ kind: 'RTCPeerConnection', sessionId: 'host' }, ...records,
      { kind: 'RTCPeerConnection', sessionId: 'host' }], 'host')).toBe(failure === 'none');
    expect(rtcCanaryComplete(records, 'retired-host')).toBe(false);
    expect(rtcCanaryComplete(records.filter(event => event.kind !== 'RTCPeerConnection'), 'host')).toBe(false);
    expect(records.filter(event => event.kind === 'rtc-canary').map(event => event.stage)).toEqual(
      failure === 'construct' ? ['entry', 'before-construct'] : failure === 'close'
        ? ['entry', 'before-construct', 'constructed'] : ['entry', 'before-construct', 'constructed', 'closed']);
  }
});

test('passive lifecycle diagnostics omit arbitrary messages and lease secrets', async () => {
  const { lifecycleErrorLabels, leaseDiagnostic } = await import('../../scripts/cdp/network-consent-cold.mjs');
  expect(lifecycleErrorLabels(['private payload feature-lease-host-start-timeout', 'secret',
    'feature-lease-host-start-timeout'])).toEqual(['feature-lease-host-start-timeout']);
  expect(leaseDiagnostic({ locked: false, secret: 'private', leases: { 'dweb/base': {
    status: 'starting', generation: 2, hostEpoch: 'epoch', durable: true, leaseId: 'secret', context: 'private',
  } } })).toEqual({ locked: false, leases: { 'dweb/base': {
    status: 'starting', generation: 2, hostEpoch: 'epoch', durable: true,
  } } });
});

// A paused worker never answers the chosen command; close must cancel its local
// wait instead of requiring a response from a target that Chrome can retire.
const teardownObserver = async (blockedMethod: string) => {
  const { observeHosts, createConsentDiagnostics } = await import('../../scripts/cdp/network-consent-cold.mjs');
  const listeners = new Set<any>();
  const calls: { method: string; sessionId?: string; params: any }[] = [];
  const evidence: any = { phase: 'explicit-enable', events: [], observerErrors: [] };
  let finish!: (value: any) => void;
  let fail!: (error: Error) => void;
  let entered!: () => void;
  const blocked = new Promise<void>(resolve => { entered = resolve; });
  let closes = 0;
  const emit = (method: string, params: any, sessionId?: string) => {
    for (const listener of [...listeners]) listener(method, params, { sessionId });
  };
  const target = (sessionId: string, type = 'worker') => emit('Target.attachedToTarget', {
    sessionId, targetInfo: { targetId: sessionId, type,
      url: `chrome-extension://fixture/${type === 'page' ? 'home/home.html' : 'offscreen/controller-worker.js'}` },
    waitingForDebugger: type !== 'page',
  });
  const connection = {
    events: [], on: (listener: any) => listeners.add(listener), off: (listener: any) => listeners.delete(listener),
    close() { closes++; },
    async send(method: string, params: any = {}, sessionId?: string): Promise<any> {
      calls.push({ method, params, sessionId });
      if (method === 'Target.getTargets') return { targetInfos: [] };
      if (method === 'Debugger.setInstrumentationBreakpoint') return { breakpointId: 'first' };
      if (sessionId === 'held' && blockedMethod === 'first-script' && method === 'Runtime.runIfWaitingForDebugger') {
        entered(); return {}; // The target never reaches the promised first-script pause.
      }
      if (sessionId === 'held' && method === blockedMethod) {
        entered();
        return new Promise((resolve, reject) => { finish = resolve; fail = reject; });
      }
      if (method === 'Target.setAutoAttach' && !sessionId) {
        if (params.autoAttach) target('home', 'page');
        else target('late'); // An event already queued when teardown starts.
      }
      if (method === 'Page.addScriptToEvaluateOnNewDocument') emit('Runtime.bindingCalled', {
        name: '__peerdConsentTransportObserved',
        payload: JSON.stringify({ kind: 'observer-ready', href: 'chrome-extension://fixture/home/home.html' }),
      }, sessionId);
      return {};
    },
  };
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ webSocketDebuggerUrl: 'fake' }) });
  try {
    const observer = await observeHosts({ port: server.port, sw: { id: 'fixture' } }, evidence,
      createConsentDiagnostics(evidence, () => {}, 100), () => {}, async () => connection);
    return { observer, evidence, calls, listeners, target, blocked, finish: (value: any) => finish(value),
      fail: (error: Error) => fail(error), closes: () => closes };
  } finally { server.stop(true); }
};

for (const method of ['Debugger.enable', 'Target.setAutoAttach']) test(`observer close fences late continuations after held ${method}`, async () => {
  const fixture = await teardownObserver(method);
  fixture.target('held');
  await fixture.blocked;
  const closing = fixture.observer.close();
  expect(fixture.observer.close()).toBe(closing);
  await closing;
  expect(fixture.closes()).toBe(1);
  expect(fixture.listeners.size).toBe(0);
  expect(fixture.evidence.observerErrors).toEqual([]);
  expect(fixture.evidence.commands.filter((entry: any) => entry.status === 'cancelled'))
    .toEqual([expect.objectContaining({ label: `${method} session=held` })]);
  expect(fixture.evidence.commands.some((entry: any) => ['pending', 'failed'].includes(entry.status))).toBe(false);
  expect(fixture.evidence.lifecycle).toEqual([expect.objectContaining({
    method: 'Target.attachedToTarget', sessionId: 'late', targetId: 'late', duringTeardown: true,
  })]);
  const finishedCalls = [...fixture.calls];
  const finishedEvidence = JSON.stringify(fixture.evidence);
  fixture.finish({});
  await Promise.resolve(); await Promise.resolve();
  expect(JSON.stringify(fixture.evidence)).toBe(finishedEvidence);
  // Cross the original diagnostic deadline: its cancelled timer must not rewrite the report.
  await new Promise(resolve => setTimeout(resolve, 120));
  expect(JSON.stringify(fixture.evidence)).toBe(finishedEvidence);
  expect(fixture.calls).toEqual(finishedCalls);
  expect(fixture.calls.some(call => call.sessionId === 'late')).toBe(false);
  expect(fixture.calls.some(call => call.method === 'Runtime.runIfWaitingForDebugger')).toBe(false);
  if (method === 'Target.setAutoAttach') expect(fixture.calls.some(call => call.method === 'Debugger.enable')).toBe(false);
  await expect(fixture.observer.barrier()).rejects.toThrow('Consent observer closed');
  expect(fixture.calls).toEqual(finishedCalls);
});

test('observer close preserves a real command failure that occurred before cancellation', async () => {
  const fixture = await teardownObserver('Debugger.enable');
  fixture.target('held');
  await fixture.blocked;
  fixture.fail(new Error('fixture protocol failure'));
  await expect(fixture.observer.barrier()).rejects.toThrow('fixture protocol failure');
  await expect(fixture.observer.close()).rejects.toThrow('fixture protocol failure');
  expect(fixture.evidence.observerErrors).toHaveLength(1);
  expect(fixture.evidence.commands.some((entry: any) => entry.label === 'Debugger.enable session=held'
    && entry.status === 'failed' && entry.error.includes('fixture protocol failure'))).toBe(true);
  expect(fixture.closes()).toBe(1);
  expect(fixture.listeners.size).toBe(0);
});


test('observer close cancels a first-script event wait and removes its listener without resuming', async () => {
  const fixture = await teardownObserver('first-script');
  fixture.target('held');
  await fixture.blocked;
  // A barrier queues behind the installation rather than creating another lease.
  const barrier = fixture.observer.barrier();
  const rejected = barrier.catch(error => error);
  await fixture.observer.close();
  expect((await rejected).message).toBe('Consent observer closed');
  expect(fixture.listeners.size).toBe(0);
  expect(fixture.closes()).toBe(1);
  expect(fixture.evidence.observerErrors).toEqual([]);
  expect(fixture.calls.some(call => ['Debugger.resume', 'Debugger.disable'].includes(call.method))).toBe(false);
  expect(fixture.evidence.commands.some((entry: any) => entry.status === 'pending' || entry.status === 'failed')).toBe(false);
});


test('same-turn protocol rejection remains a failure when close follows immediately', async () => {
  const fixture = await teardownObserver('Debugger.enable');
  fixture.target('held');
  await fixture.blocked;
  fixture.fail(new Error('same-turn protocol failure'));
  await expect(fixture.observer.close()).rejects.toThrow('same-turn protocol failure');
  expect(fixture.evidence.observerErrors).toHaveLength(1);
  expect(fixture.closes()).toBe(1);
  expect(fixture.listeners.size).toBe(0);
});


test('close fences an installation whose first native dispatch is still queued', async () => {
  const fixture = await teardownObserver('Debugger.enable');
  fixture.target('held');
  await fixture.observer.close();
  expect(fixture.calls.some(call => call.sessionId === 'held')).toBe(false);
  expect(fixture.evidence.commands.some((entry: any) => entry.status === 'failed' || entry.status === 'pending')).toBe(false);
  expect(fixture.evidence.observerErrors).toEqual([]);
  expect(fixture.listeners.size).toBe(0);
});


const retirementObserver = async (barrierBudgetMs = 30_000) => {
  const { observeHosts, createConsentDiagnostics } = await import('../../scripts/cdp/network-consent-cold.mjs');
  const listeners = new Set<any>();
  const targets = new Map<string, any>();
  const calls: { method: string; sessionId?: string; params: any }[] = [];
  const evidence: any = { phase: 'before-choice', events: [], observerErrors: [] };
  let onDrain: (sessionId: string) => any = () => ({});
  let inventoryFails = false;
  const emit = (method: string, params: any, sessionId?: string) => {
    for (const listener of [...listeners]) listener(method, params, { sessionId });
  };
  const ready = (sessionId: string) => emit('Runtime.bindingCalled', { name: '__peerdConsentTransportObserved',
    payload: JSON.stringify({ kind: 'observer-ready', href: targets.get(sessionId).url }) }, sessionId);
  const target = (sessionId: string) => {
    const targetInfo = { targetId: sessionId, type: sessionId === 'home' ? 'page' : 'worker',
      url: `chrome-extension://fixture/${sessionId === 'home' ? 'home/home.html' : 'offscreen/controller-worker.js'}` };
    targets.set(sessionId, targetInfo);
    emit('Target.attachedToTarget', { sessionId, targetInfo, waitingForDebugger: false });
  };
  const connection = {
    events: [], on: (listener: any) => listeners.add(listener), off: (listener: any) => listeners.delete(listener), close() {},
    async send(method: string, params: any = {}, sessionId?: string): Promise<any> {
      calls.push({ method, sessionId, params });
      if (method === 'Target.setAutoAttach' && params.autoAttach && !sessionId) target('home');
      if (method === 'Page.addScriptToEvaluateOnNewDocument') ready(sessionId!);
      if (method === 'Runtime.evaluate') {
        if (params.expression === '0') return onDrain(sessionId!);
        ready(sessionId!);
      }
      if (method === 'Target.getTargets') {
        expect(params.filter).toEqual([{}]);
        if (inventoryFails) throw new Error('fixture inventory failure');
        return { targetInfos: [...targets.values()] };
      }
      return {};
    },
  };
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ webSocketDebuggerUrl: 'fake' }) });
  try {
    const diagnostic = createConsentDiagnostics(evidence, () => {}, 50);
    const observer = await observeHosts({ port: server.port, sw: { id: 'fixture' } }, evidence,
      (...[label, operation, budget, signal]: Parameters<typeof diagnostic>) =>
        diagnostic(label, operation, label === 'observer stable barrier' ? barrierBudgetMs : budget, signal),
      () => {}, async () => connection);
    return { observer, evidence, calls, emit, target, targets,
      onDrain: (callback: typeof onDrain) => { onDrain = callback; },
      failInventory: () => { inventoryFails = true; },
      retire(sessionId: string, destroyed = true) {
        emit('Target.detachedFromTarget', { sessionId, targetId: sessionId });
        if (destroyed) { targets.delete(sessionId); emit('Target.targetDestroyed', { targetId: sessionId }); }
      } };
  } finally { server.stop(true); }
};

test('a destroyed observed target cancels its drain and replacement must pass the reconciled barrier', async () => {
  const fixture = await retirementObserver();
  fixture.target('old');
  await fixture.observer.barrier();
  let finish!: (value: any) => void;
  fixture.onDrain(sessionId => {
    if (sessionId !== 'old') return {};
    fixture.retire('old'); fixture.target('replacement');
    return new Promise(resolve => { finish = resolve; });
  });
  await fixture.observer.barrier();
  expect(fixture.calls.some(call => call.method === 'Runtime.evaluate' && call.sessionId === 'replacement' && call.params.expression === '0')).toBe(true);
  expect(fixture.evidence.lifecycle.some((entry: any) => entry.method === 'observer.retirementConfirmed' && entry.targetId === 'old')).toBe(true);
  expect(fixture.evidence.commands.some((entry: any) => entry.label === 'Runtime.evaluate session=old' && entry.status === 'cancelled')).toBe(true);
  const snapshot = JSON.stringify(fixture.evidence);
  finish({}); await Promise.resolve(); await Promise.resolve();
  expect(JSON.stringify(fixture.evidence)).toBe(snapshot);
  await new Promise(resolve => setTimeout(resolve, 60));
  expect(JSON.stringify(fixture.evidence)).toBe(snapshot);
  fixture.emit('Runtime.bindingCalled', { name: '__peerdConsentTransportObserved',
    payload: JSON.stringify({ kind: 'WebSocket', href: 'chrome-extension://fixture/offscreen/controller-worker.js' }) }, 'old');
  expect(() => assertNoTransport(fixture.evidence.events, 'retired realm')).toThrow('transport before consent');
  await fixture.observer.close();
});

test('detached but live target cannot discharge a barrier and failed inventory is not absence', async () => {
  const live = await retirementObserver();
  live.target('old'); await live.observer.barrier();
  live.onDrain(sessionId => {
    if (sessionId !== 'old') return {};
    live.retire('old', false); return new Promise(() => {});
  });
  await expect(live.observer.barrier()).rejects.toThrow('target destruction target=old');
  expect(live.targets.has('old')).toBe(true);
  await live.observer.close();
  const missing = await retirementObserver();
  missing.failInventory();
  await expect(missing.observer.barrier()).rejects.toThrow('fixture inventory failure');
  await missing.observer.close();
}, 5_000);

test('a newly live unobserved target and repeated target churn fail closed', async () => {
  const unseen = await retirementObserver();
  unseen.targets.set('unseen', { targetId: 'unseen', type: 'worker', url: 'chrome-extension://fixture/worker.js' });
  await expect(unseen.observer.barrier()).rejects.toThrow('Live target lacks observer: unseen');
  await unseen.observer.close();
  const churn = await retirementObserver();
  let generation = 0;
  churn.target('worker0'); await churn.observer.barrier();
  churn.onDrain(sessionId => {
    if (sessionId === 'home') return {};
    churn.retire(sessionId); churn.target(`worker${++generation}`); return new Promise(() => {});
  });
  await expect(churn.observer.barrier()).rejects.toThrow('target churn exceeded barrier budget');
  expect(generation).toBe(8);
  await churn.observer.close();
});


test('duplicate session detach preserves its observed owner, but pre-ready detach is fatal', async () => {
  const duplicate = await retirementObserver();
  duplicate.target('old'); await duplicate.observer.barrier();
  duplicate.emit('Target.attachedToTarget', { sessionId: 'duplicate', targetInfo: duplicate.targets.get('old'), waitingForDebugger: false });
  duplicate.emit('Target.detachedFromTarget', { sessionId: 'duplicate', targetId: 'old' });
  await duplicate.observer.barrier();
  expect(duplicate.evidence.observerErrors).toEqual([]);
  expect(duplicate.evidence.lifecycle.some((entry: any) => entry.method === 'observer.retirementConfirmed')).toBe(false);
  await duplicate.observer.close();
  const unobserved = await retirementObserver();
  unobserved.target('too-soon'); unobserved.retire('too-soon');
  await expect(unobserved.observer.barrier()).rejects.toThrow('Unobserved target detached: too-soon');
  await expect(unobserved.observer.close()).rejects.toThrow('Unobserved target detached: too-soon');
});

test('same-turn real protocol failure is not erased by target destruction', async () => {
  const fixture = await retirementObserver();
  fixture.target('old'); await fixture.observer.barrier();
  fixture.onDrain(sessionId => {
    if (sessionId !== 'old') return {};
    const failure = Promise.reject(new Error('real drain failure'));
    fixture.retire('old'); return failure;
  });
  await expect(fixture.observer.barrier()).rejects.toThrow('real drain failure');
  expect(fixture.evidence.commands.some((entry: any) => entry.label === 'Runtime.evaluate session=old'
    && entry.status === 'failed' && entry.error.includes('real drain failure'))).toBe(true);
  await fixture.observer.close();
});


test('destruction before detach discharges only its exact observed target', async () => {
  const fixture = await retirementObserver();
  fixture.target('old'); await fixture.observer.barrier();
  fixture.onDrain(sessionId => {
    if (sessionId !== 'old') return {};
    fixture.targets.delete('old');
    fixture.emit('Target.targetDestroyed', { targetId: 'old' });
    fixture.emit('Target.detachedFromTarget', { sessionId: 'old', targetId: 'old' });
    return new Promise(() => {});
  });
  await fixture.observer.barrier();
  expect(fixture.evidence.lifecycle.filter((entry: any) => entry.method === 'observer.retirementConfirmed')).toHaveLength(1);
  await fixture.observer.close();
});

test('explicit worker handoff retains destruction proof even when detach notification follows its reply', async () => {
  const fixture = await retirementObserver();
  fixture.target('old'); await fixture.observer.barrier();
  await fixture.observer.releaseWorker('old');
  fixture.targets.delete('old'); // Inventory absence alone is not proof.
  fixture.emit('Target.detachedFromTarget', { sessionId: 'old', targetId: 'old' });
  await expect(fixture.observer.barrier()).rejects.toThrow('target destruction target=old');
  fixture.emit('Target.targetDestroyed', { targetId: 'old' });
  await fixture.observer.close();
}, 5_000);

test('barrier deadline cancels its pending command and forbids late continuation or report mutation', async () => {
  const fixture = await retirementObserver(10);
  fixture.target('held'); await fixture.observer.barrier();
  let finish!: (value: any) => void;
  fixture.onDrain(sessionId => sessionId === 'held' ? new Promise(resolve => { finish = resolve; }) : {});
  await expect(fixture.observer.barrier()).rejects.toThrow('Consent deadline: observer stable barrier');
  // Permit rejection propagation, not target completion, to finish cancellation bookkeeping.
  await new Promise(resolve => setTimeout(resolve, 0));
  const snapshot = JSON.stringify(fixture.evidence);
  const calls = [...fixture.calls];
  finish({}); await new Promise(resolve => setTimeout(resolve, 60));
  expect(fixture.calls).toEqual(calls);
  expect(JSON.stringify(fixture.evidence)).toBe(snapshot);
  expect(fixture.evidence.commands.some((entry: any) => entry.status === 'pending')).toBe(false);
  await fixture.observer.close();
});
