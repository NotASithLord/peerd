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
