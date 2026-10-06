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
