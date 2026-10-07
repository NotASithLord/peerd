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
        return { breakpointId: 'first-script' };
      }
      if (method === 'Runtime.runIfWaitingForDebugger') {
        expect(commands).toContain('Debugger.setInstrumentationBreakpoint');
        emit('Debugger.paused', { reason: 'instrumentation', callFrames: [{ callFrameId: 'first' }] });
      }
      if (method === 'Debugger.evaluateOnCallFrame') {
        expect(params.callFrameId).toBe('first');
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
  const { instrumentPausedWorker, createConsentDiagnostics } = await import('../../scripts/cdp/network-consent-cold.mjs');
  const worker = pausedWorker();
  await instrumentPausedWorker(worker.connection, 'worker', createConsentDiagnostics({ phase: 'before-choice' }, () => {}));
  expect(worker.commands).not.toContain('Runtime.evaluate');
  expect(worker.commands.indexOf('Debugger.evaluateOnCallFrame')).toBeLessThan(worker.commands.indexOf('Debugger.resume'));
  expect(worker.commands).toContain('Debugger.removeBreakpoint');
  expect(worker.listeners.size).toBe(0);
  expect(worker.applicationRuns()).toBe(1);
});

test('failed first-script injection does not release unobserved application code', async () => {
  const { instrumentPausedWorker, createConsentDiagnostics } = await import('../../scripts/cdp/network-consent-cold.mjs');
  const worker = pausedWorker(true);
  await expect(instrumentPausedWorker(worker.connection, 'worker', createConsentDiagnostics({ phase: 'before-choice' }, () => {})))
    .rejects.toThrow('Worker observer injection failed');
  expect(worker.listeners.size).toBe(0);
  expect(worker.applicationRuns()).toBe(0);
});

test('root and descendant attachments share one owner and paused pages arm preload before release', async () => {
  const { observeHosts, createConsentDiagnostics } = await import('../../scripts/cdp/network-consent-cold.mjs');
  const origin = 'chrome-extension://fixture/';
  const listeners = new Set<any>();
  const targets = new Map<string, any>();
  const calls: any[] = [];
  const preloads = new Set<string>();
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
      if (method === 'Page.addScriptToEvaluateOnNewDocument') preloads.add(sessionId!);
      if (method === 'Runtime.evaluate' && params.expression !== '0') {
        expect(targets.get(sessionId!).type).not.toBe('worker');
        expect(sessionId).not.toBe('offscreen');
        ready(sessionId!);
      }
      if (method === 'Debugger.setInstrumentationBreakpoint') return { breakpointId: 'first' };
      if (method === 'Runtime.runIfWaitingForDebugger') {
        if (sessionId === 'offscreen') { expect(preloads.has(sessionId)).toBe(true); ready(sessionId); }
        else emit('Debugger.paused', { reason: 'instrumentation', callFrames: [{ callFrameId: 'first' }] }, sessionId);
      }
      if (method === 'Debugger.evaluateOnCallFrame') { ready(sessionId!); return { result: { value: true } }; }
      return {};
    },
  };
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ webSocketDebuggerUrl: 'fake' }) });
  try {
    const observer = await observeHosts({ port: server.port, sw: { id: 'fixture' } }, evidence,
      createConsentDiagnostics(evidence, () => {}), () => {}, async () => connection);
    await observer.barrier();
    expect(evidence.observerErrors).toEqual([]);
    expect(calls.filter(call => call.method === 'Debugger.evaluateOnCallFrame')).toHaveLength(4);
    expect(calls.filter(call => call.method === 'Target.detachFromTarget')).toHaveLength(3);
    for (const parent of ['home', 'sw', 'offscreen']) {
      expect(evidence.events.some((event: any) => event.sessionId === `${parent}-worker`)).toBe(true);
    }
    await observer.close();
    expect(listeners.size).toBe(0);
  } finally { server.stop(true); }
});
