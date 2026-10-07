import { describe, test, expect } from 'bun:test';
import { createPeer } from '../../extension/peerd-distributed/transport/peer.js';

// createPeer runs over WebRTC, but the RTCPeerConnection is injectable, so its
// inbound-robustness logic is unit-testable with a minimal mock: the
// pre-description ICE buffer must be bounded (a hostile peer cannot trickle
// unbounded candidates before sending a description), and a malformed
// data-channel frame must close the carrier without throwing out of the handler.

class MockDataChannel {
  readyState = 'connecting';
  onmessage: any = null;
  onopen: any = null;
  onclose: any = null;
  send() {}
  close() { this.readyState = 'closed'; }
}

class MockRTCPeerConnection {
  remoteDescription: any = null;
  connectionState = 'new';
  iceConnectionState = 'new';
  addIceCalls: any[] = [];
  dc = new MockDataChannel();
  constructor(public config: any) {}
  addEventListener() {}
  createDataChannel() { return this.dc; }
  ondatachannel: any = null;
  async setRemoteDescription(d: any) { this.remoteDescription = d; }
  async addIceCandidate(c: any) { this.addIceCalls.push(c); }
  close() {}
}

const makePeer = () => createPeer({ initiator: true, RTCPeerConnection: MockRTCPeerConnection as any });

describe('createPeer — inbound robustness', () => {
  test('the pre-description ICE buffer is bounded (candidates past the cap are dropped)', async () => {
    const peer = makePeer();
    const pc = peer.pc as any;
    // 65 candidates arrive before any remote description → buffered, none applied
    for (let i = 0; i < 65; i += 1) await peer.addRemoteCandidate({ candidate: `c${i}`, sdpMid: '0' } as any);
    expect(pc.addIceCalls.length).toBe(0);
    // setting the remote description flushes the buffer — exactly the cap (64),
    // the 65th was dropped
    await peer.setRemote({ type: 'answer', sdp: 'x' } as any);
    expect(pc.addIceCalls.length).toBe(64);
  });

  test('a malformed frame closes an unopened carrier and ignores later valid frames', async () => {
    const peer = makePeer();
    const dc = (peer.pc as any).dc;
    const rejected = peer.channelReady.then(() => null, error => error);
    expect(typeof dc.onmessage).toBe('function');
    expect(() => dc.onmessage({ data: '{ not valid json' })).not.toThrow();
    expect(await rejected).toMatchObject({ message: 'peer transport closed before channel opened' });
    expect(dc.readyState).toBe('closed');
    let reads = 0;
    expect(() => dc.onmessage({ get data() { reads++; return JSON.stringify({ ok: 1 }); } })).not.toThrow();
    expect(reads).toBe(0);
  });
});
