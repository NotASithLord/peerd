import { expect, test } from 'bun:test';
import { webRtcSessionBinding } from '../../extension/peerd-distributed/transport/channel-binding.js';
import { createBufferedChannel, memoryPair } from '../../extension/peerd-distributed/transport/channel.js';
import { createPeer } from '../../extension/peerd-distributed/transport/peer.js';
import { createBroadcastTransport } from '../../extension/peerd-distributed/transport/transports/broadcast.js';
import { createConnector } from '../../extension/peerd-distributed/transport/connect.js';

const fp = (byte: string) => Array(32).fill(byte).join(':');
const sdp = (byte: string) => `v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 ${fp(byte)}\r\n`;
const descriptions = { localDescription: { sdp: sdp('AA') }, remoteDescription: { sdp: sdp('BB') } };

test('WebRTC bindings preserve endpoint order and negotiated stream identity', () => {
  const binding = webRtcSessionBinding(descriptions, { readyState: 'open', id: 4 });
  expect(binding).toEqual({ kind: 'webrtc-dtls-sha256', localFingerprint: 'aa'.repeat(32), remoteFingerprint: 'bb'.repeat(32), streamId: 4 });
  expect(Object.isFrozen(binding)).toBe(true);
  const reversed = webRtcSessionBinding({ localDescription: descriptions.remoteDescription, remoteDescription: descriptions.localDescription }, { readyState: 'open', id: 4 });
  expect(reversed.localFingerprint).toBe(binding.remoteFingerprint);
  expect(reversed.remoteFingerprint).toBe(binding.localFingerprint);
});

test('WebRTC binding refuses missing or ambiguous fingerprints and unopened streams', () => {
  for (const remote of ['', 'a=fingerprint:sha-1 AA', `a=fingerprint:sha-256 ${fp('AA')}:BB`, `${sdp('AA')}${sdp('BB')}`, `${sdp('AA')}a=fingerprint:sha-384 ${fp('BB')}`]) {
    expect(() => webRtcSessionBinding({ ...descriptions, remoteDescription: { sdp: remote } }, { readyState: 'open', id: 0 })).toThrow();
  }
  for (const id of [null, -1, 65535, 0.5, NaN]) expect(() => webRtcSessionBinding(descriptions, { readyState: 'open', id })).toThrow();
  expect(() => webRtcSessionBinding(descriptions, { readyState: 'connecting', id: 0 })).toThrow();
  const repeated = `${sdp('BB')}a=fingerprint:sha-256 ${fp('bb')}\r\n`;
  expect(webRtcSessionBinding({ ...descriptions, remoteDescription: { sdp: repeated } }, { readyState: 'open', id: 0 }).remoteFingerprint).toBe('bb'.repeat(32));
});

test('WebRTC adapter reads binding from its own PC and channel, never incoming frames', async () => {
  class Peer {
    localDescription = descriptions.localDescription;
    remoteDescription = descriptions.remoteDescription;
    dc = { id: 7, readyState: 'open', send() {}, close() {}, onmessage: null as any };
    addEventListener() {}
    createDataChannel() { return this.dc; }
    close() {}
  }
  const peer = createPeer({ initiator: true, RTCPeerConnection: Peer as any });
  const channel = await peer.channelReady;
  expect(channel.getSessionBinding().streamId).toBe(7);
  (peer.pc as any).dc.onmessage({ data: JSON.stringify({ binding: { localFingerprint: 'cc'.repeat(32) } }) });
  expect(channel.getSessionBinding().localFingerprint).toBe('aa'.repeat(32));
  channel.close();
  expect(channel.getSessionBinding()).toBe(null);
});

test('memory links have fresh, inverse local bindings; generic channels do not invent one', () => {
  const [a, b] = memoryPair();
  const [c, d] = memoryPair();
  const binding = a.getSessionBinding()!;
  expect(binding.kind).toBe('trusted-local');
  expect(b.getSessionBinding()).toEqual({ ...binding, localFingerprint: binding.remoteFingerprint, remoteFingerprint: binding.localFingerprint });
  expect(c.getSessionBinding()?.localFingerprint).not.toBe(binding.localFingerprint);
  expect(createBufferedChannel({ send() {} }).getSessionBinding()).toBe(null);
  [a, b, c, d].forEach((channel) => channel.close());
});

test('unbound broadcast opens no bus and cannot win authenticated transport selection', async () => {
  let opened = 0;
  const broadcast = createBroadcastTransport({ BroadcastChannel: class { constructor() { opened++; } } as any });
  broadcast.listen('self', () => { throw new Error('must not accept an unauthenticated inbound link'); });
  expect(opened).toBe(0);
  expect(broadcast.canReach({ did: 'remote' })).toBe(0);
  await expect(broadcast.connect({ did: 'remote' })).rejects.toThrow('authenticated session binding unavailable');
  const [channel, remote] = memoryPair();
  const fallback = { name: 'secure-fixture', connect: async () => channel };
  const result = await createConnector({ transports: [broadcast, fallback] }).connect({ did: 'remote' });
  expect(result.transport).toBe('secure-fixture');
  expect(result.channel.getSessionBinding()).toBeTruthy();
  channel.close(); remote.close();
});
