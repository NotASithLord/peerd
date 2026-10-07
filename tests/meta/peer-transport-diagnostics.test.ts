import { expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { installPeerTransportDiagnostics } from '../../scripts/cdp/peer-transport-diagnostics.mjs';

class Channel extends EventTarget {
  readyState = 'open';
  bufferedAmount = 0;
  failure: Error | null = null;
  receivedThis: unknown;
  send(_payload: unknown) {
    this.receivedThis = this;
    if (this.failure) throw this.failure;
    this.bufferedAmount += 1;
    return 'native-result';
  }
}
class Peer extends EventTarget {
  static marker = Symbol('native-static');
  connectionState = 'connected';
  iceConnectionState = 'connected';
  signalingState = 'stable';
  constructor(public options: unknown) { super(); }
  createDataChannel(_name: string) { return new Channel(); }
}
const setup = () => {
  const world: any = { RTCPeerConnection: Peer, Date };
  runInNewContext(`(${installPeerTransportDiagnostics.toString()})();`, world);
  return world;
};

test('carrier observers preserve native construction/send and record only bounded stage metadata', () => {
  const world = setup();
  const options = { iceServers: [] };
  const peer = new world.RTCPeerConnection(options);
  expect(peer).toBeInstanceOf(Peer);
  expect(peer.options).toBe(options);
  expect(world.RTCPeerConnection.marker).toBe(Peer.marker);
  expect(Object.getPrototypeOf(peer)).toBe(Peer.prototype);
  class Derived extends world.RTCPeerConnection {}
  const derived = new Derived();
  expect(derived).toBeInstanceOf(Derived);
  expect(derived).toBeInstanceOf(Peer);
  const channel = peer.createDataChannel('secret-label');
  expect(channel.send(JSON.stringify({ __t: 'HELLO', env: { secret: 'DO-NOT-RETAIN' } }))).toBe('native-result');
  expect(channel.receivedThis).toBe(channel);
  channel.dispatchEvent(Object.assign(new Event('message'), { data: '{"__t":"HELLO_PROOF","secret":"DO-NOT-RETAIN"}' }));
  channel.failure = new Error('DO-NOT-RETAIN');
  let thrown;
  try { channel.send('private application data'); } catch (error) { thrown = error; }
  expect(thrown).toBe(channel.failure);
  channel.readyState = 'closing';
  channel.dispatchEvent(new Event('closing'));
  const records = world.__DWEB_TRANSPORT__;
  expect(records.map((entry: any) => entry.stage)).toEqual(['observed', 'send-call', 'send-return', 'receive', 'send-call', 'send-throw', 'closing']);
  expect(records[2]).toMatchObject({ frame: 'HELLO', state: 'open', bufferedAmount: 1 });
  expect(records[3].frame).toBe('HELLO_PROOF');
  expect(records.every((entry: any) => Number.isFinite(entry.at))).toBe(true);
  expect(JSON.stringify(records)).not.toContain('DO-NOT-RETAIN');
  expect(JSON.stringify(records)).not.toContain('secret-label');
  for (let i = 0; i < 500; i++) channel.dispatchEvent(new Event('bufferedamountlow'));
  expect(records.length).toBe(128);
});

test('incoming carriers are observed once without replacing application listeners', () => {
  const world = setup();
  const peer = new world.RTCPeerConnection({});
  const channel = new Channel();
  let received = 0;
  channel.addEventListener('message', () => { received++; });
  peer.dispatchEvent(Object.assign(new Event('datachannel'), { channel }));
  peer.dispatchEvent(Object.assign(new Event('datachannel'), { channel }));
  channel.dispatchEvent(Object.assign(new Event('message'), { data: 'private' }));
  expect(received).toBe(1);
  expect(world.__DWEB_TRANSPORT__.map((entry: any) => entry.stage)).toEqual(['observed', 'receive']);
});
