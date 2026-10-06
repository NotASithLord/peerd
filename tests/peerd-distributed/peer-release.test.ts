import { expect, test } from 'bun:test';
import { createPeer } from '../../extension/peerd-distributed/transport/peer.js';
import { createBufferedChannel } from '../../extension/peerd-distributed/transport/channel.js';

class DataChannel {
  readyState = 'connecting';
  closes = 0;
  onmessage: any;
  onopen: any;
  onclose: any;
  send() {}
  close() { this.closes++; this.readyState = 'closed'; this.onclose?.(); }
}
class PeerConnection extends EventTarget {
  dc = new DataChannel();
  ondatachannel: any;
  connectionState = 'new';
  iceConnectionState = 'new';
  remoteDescription: any = null;
  closes = 0;
  addIceCalls = 0;
  createDataChannel() { return this.dc; }
  async setRemoteDescription(description: any) { this.remoteDescription = description; }
  async addIceCandidate() { this.addIceCalls++; }
  close() {
    this.closes++;
    this.connectionState = 'closed'; this.iceConnectionState = 'closed';
    // Native terminal events can race or re-enter an explicit close.
    this.dispatchEvent(new Event('connectionstatechange'));
    this.dispatchEvent(new Event('iceconnectionstatechange'));
  }
}
const peer = (initiator = true) => createPeer({ initiator, RTCPeerConnection: PeerConnection as any });

test('a close notification cannot suppress later one-shot transport release', () => {
  let releases = 0;
  const channel = createBufferedChannel({ send() {}, close() { releases++; channel.close(); } });
  let notifications = 0;
  channel.onClose(() => { notifications++; channel.close(); });
  channel.signalClose(); channel.close(); channel.close();
  expect(releases).toBe(1);
  expect(notifications).toBe(1);
});

test('remote data-channel close releases the native peer and settles an unopened channel', async () => {
  const p = peer(); const pc = p.pc as unknown as PeerConnection;
  const outcome = p.channelReady.catch((error) => error);
  pc.dc.readyState = 'closed'; pc.dc.onclose();
  expect(await outcome).toMatchObject({ message: 'peer transport closed before channel opened' });
  expect(pc.closes).toBe(1); expect(pc.dc.closes).toBe(0);
  pc.dc.onclose();
  expect(pc.closes).toBe(1);
});

test('closing an open peer releases its transport once despite reentrant terminal events', async () => {
  const p = peer(); const pc = p.pc as unknown as PeerConnection;
  pc.dc.readyState = 'open'; pc.dc.onopen();
  const channel = await p.channelReady;
  let notices = 0; channel.onClose(() => { notices++; channel.close(); });
  pc.dc.onclose();
  expect(channel.isClosed()).toBe(true);
  channel.close();
  expect(pc.closes).toBe(1); expect(pc.dc.closes).toBe(1); expect(notices).toBe(1);
});

test('a responder failing before receiving a data channel releases its peer and refuses late work', async () => {
  const p = peer(false); const pc = p.pc as unknown as PeerConnection;
  const outcome = p.channelReady.catch((error) => error);
  await p.addRemoteCandidate({ candidate: 'buffered' });
  pc.iceConnectionState = 'failed';
  pc.dispatchEvent(new Event('iceconnectionstatechange'));
  expect(await outcome).toBeInstanceOf(Error);
  expect(pc.closes).toBe(1);
  await p.addRemoteCandidate({ candidate: 'late' });
  await expect(p.setRemote({ type: 'offer', sdp: 'late' })).rejects.toThrow('transport closed');
  expect(pc.addIceCalls).toBe(0);
  const late = new DataChannel(); pc.ondatachannel({ channel: late });
  expect(late.closes).toBe(1);
  expect(pc.closes).toBe(1);
});

test('closing during the ICE disconnect grace clears its timer', async () => {
  const p = peer(); const pc = p.pc as unknown as PeerConnection;
  pc.dc.readyState = 'open'; pc.dc.onopen();
  const channel = await p.channelReady;
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  const timer = {};
  let scheduled = false;
  let cleared = false;
  try {
    globalThis.setTimeout = ((..._args: any[]) => { scheduled = true; return timer; }) as any;
    globalThis.clearTimeout = ((value: any) => { if (value === timer) cleared = true; }) as any;
    pc.iceConnectionState = 'disconnected'; pc.dispatchEvent(new Event('iceconnectionstatechange'));
    expect(scheduled).toBe(true);
    channel.close();
    expect(cleared).toBe(true);
    expect(pc.closes).toBe(1);
  } finally { globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; }
});


test('an extra incoming data channel cannot replace the owned channel or suppress its close notification', async () => {
  const p = peer(false); const pc = p.pc as unknown as PeerConnection;
  const first = new DataChannel(); first.readyState = 'open';
  pc.ondatachannel({ channel: first });
  const channel = await p.channelReady;
  let notices = 0; channel.onClose(() => { notices++; });
  const extra = new DataChannel(); extra.readyState = 'open';
  pc.ondatachannel({ channel: extra });
  expect(extra.closes).toBe(1);
  expect(first.closes).toBe(0);
  expect(channel.isClosed()).toBe(false);
  first.readyState = 'closed'; first.onclose();
  expect(channel.isClosed()).toBe(true);
  expect(notices).toBe(1);
  expect(pc.closes).toBe(1);
});

test('external native peer close does not recursively close it again', async () => {
  const p = peer(); const pc = p.pc as unknown as PeerConnection;
  const outcome = p.channelReady.catch((error) => error);
  pc.close();
  expect(await outcome).toBeInstanceOf(Error);
  expect(pc.closes).toBe(1);
  expect(pc.dc.closes).toBe(1);
});


test('a queued disconnect timer preserves recovery visible before its state-change event', async () => {
  const p = peer(); const pc = p.pc as unknown as PeerConnection;
  pc.dc.readyState = 'open'; pc.dc.onopen();
  const channel = await p.channelReady;
  const originalSet = globalThis.setTimeout;
  let fire: (() => void) | undefined;
  try {
    globalThis.setTimeout = ((callback: () => void) => { fire = callback; return 0; }) as any;
    pc.iceConnectionState = 'disconnected'; pc.dispatchEvent(new Event('iceconnectionstatechange'));
    pc.iceConnectionState = 'connected';
    fire?.();
    expect(pc.closes).toBe(0);
    expect(channel.isClosed()).toBe(false);
  } finally { globalThis.setTimeout = originalSet; channel.close(); }
});
