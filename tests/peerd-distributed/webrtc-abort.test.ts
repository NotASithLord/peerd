import { describe, test, expect } from 'bun:test';
import { abortClosesPc, createWebrtcTransport } from '../../extension/peerd-distributed/transport/transports/webrtc.js';
import { createInprocTransport } from '../../extension/peerd-distributed/transport/transports/inproc.js';

// A capturing mock RTCPeerConnection (injectable) lets us drive the REAL webrtc
// transport's connect() to prove the WIRED late-completion guard: once the
// channel opens, `opened` flips true before the caller's finally-abort runs, so
// abort must leave the live pc alone. (We only assert the open-then-abort path:
// a never-opening dial leaves channelReady pending forever, which the bun runner
// waits on; that direction is covered by the abortClosesPc unit tests above.)
const instances: any[] = [];
class MockDataChannel {
  readyState = 'connecting';
  onmessage: any = null; onopen: any = null; onclose: any = null;
  send() {} close() { this.readyState = 'closed'; }
}
class MockPC {
  closed = false; remoteDescription: any = null; localDescription: any = { sdp: 'mock' };
  connectionState = 'new'; iceConnectionState = 'new'; dc = new MockDataChannel(); ondatachannel: any = null;
  constructor(public config: any) { instances.push(this); }
  addEventListener() {} createDataChannel() { return this.dc; }
  async createOffer() { return { type: 'offer', sdp: 'mock' }; }
  async createAnswer() { return { type: 'answer', sdp: 'mock' }; }
  async setLocalDescription(d: any) { this.localDescription = { sdp: d?.sdp ?? 'mock' }; }
  async setRemoteDescription(d: any) { this.remoteDescription = d; }
  async addIceCandidate() {}
  close() { this.closed = true; this.dc.close(); }
}
const sigStub = () => ({ send() {}, onRemote: () => () => {} });

// D2: a dial/accept that never pairs (ghost roster member, symmetric NAT, or a
// hostile peer that answers then stalls ICE) is abandoned by rooms.js's give-up
// timeout, but nothing closed the RTCPeerConnection → its ICE agent / STUN gather
// / listeners leaked. abortClosesPc closes the pc on abort, BUT only while the
// channel has not yet opened (a late completion past the timeout must leave the
// live, admitted link alone), one-shot and idempotent.

const fakePeer = () => {
  const state = { closes: 0 };
  return { p: { pc: { close: () => { state.closes += 1; } } as any }, state };
};

describe('abortClosesPc — the D2 leak-fix invariant', () => {
  test('closes the pc on abort while the channel has not opened', () => {
    const { p, state } = fakePeer();
    const ac = new AbortController();
    abortClosesPc(ac.signal, p, () => false);
    expect(state.closes).toBe(0);
    ac.abort();
    expect(state.closes).toBe(1);
  });

  test('does NOT close once the channel has opened (late-completion guard)', () => {
    const { p, state } = fakePeer();
    const ac = new AbortController();
    abortClosesPc(ac.signal, p, () => true); // already opened
    ac.abort();
    expect(state.closes).toBe(0);
  });

  test('one-shot: a doubled abort closes at most once', () => {
    const { p, state } = fakePeer();
    const ac = new AbortController();
    abortClosesPc(ac.signal, p, () => false);
    ac.abort();
    ac.abort();
    expect(state.closes).toBe(1);
  });

  test('no signal → no listener, no crash (back-compat for callers that pass none)', () => {
    const { p, state } = fakePeer();
    expect(() => abortClosesPc(undefined, p, () => false)).not.toThrow();
    expect(state.closes).toBe(0);
  });

  test('a pc.close() that throws (already closed) is swallowed', () => {
    const ac = new AbortController();
    abortClosesPc(ac.signal, { pc: { close: () => { throw new Error('already closed'); } } as any }, () => false);
    expect(() => ac.abort()).not.toThrow();
  });
});

describe('webrtc transport — the wired late-completion guard (D2)', () => {
  test('a channel that opens before abort keeps its live pc', async () => {
    instances.length = 0;
    const t = createWebrtcTransport({ RTCPeerConnection: MockPC as any });
    const ac = new AbortController();
    const ready = t.connect({ did: 'x' }, { signaling: sigStub() as any, signal: ac.signal });
    const pc = instances[0];
    // the channel opens (the real success path) → `opened` flips true
    pc.dc.readyState = 'open';
    pc.dc.onopen();
    await ready;
    // the caller's finally-abort now no-ops (opened): the live pc survives
    ac.abort();
    expect(pc.closed).toBe(false);
  });
});

describe('non-webrtc transports ignore the new signal opt (D2 abstraction safety)', () => {
  test('inproc still links when a signal is passed through', async () => {
    const t = createInprocTransport();
    t.listen('did:key:zHere', (ch: any) => { ch.setHandler((m: any) => ch.send({ pong: m.ping })); });
    const ac = new AbortController();
    // the connector passes opts through generically; a non-webrtc transport
    // simply ignores `signal` (its connect destructures nothing named it)
    const client = await (t.connect as (p: any, o?: any) => Promise<any>)({ did: 'did:key:zHere' }, { signal: ac.signal });
    const reply = await new Promise((res) => { client.setHandler(res); client.send({ ping: 1 }); });
    expect(reply).toEqual({ pong: 1 });
  });
});

describe('rooms.js + webrtc wire the AbortController at every abandonment site (D2)', () => {
  test('all four dial/accept sites construct, pass, and abort a controller', async () => {
    const src = await Bun.file('extension/peerd-distributed/transport/rooms.js').text();
    expect((src.match(/new AbortController\(\)/g) ?? []).length).toBe(4);
    expect((src.match(/signal: ac\.signal/g) ?? []).length).toBe(4);
    expect((src.match(/ac\.abort\(\)/g) ?? []).length).toBe(4);
  });

  test('the webrtc transport threads signal into connect + accept and guards the helper', async () => {
    const src = await Bun.file('extension/peerd-distributed/transport/transports/webrtc.js').text();
    expect(src).toContain('{ once: true }');
    expect(src).toContain('if (isOpen()) return;');
    // both connect() and accept() wire the helper, guarded on `opened`
    expect((src.match(/abortClosesPc\(signal, p, \(\) => opened\)/g) ?? []).length).toBe(2);
  });

  test('connectViaSignaling (the 1:1 convenience) also closes its abandoned pc', async () => {
    const src = await Bun.file('extension/peerd-distributed/transport/signaling-client.js').text();
    expect(src).toContain('new AbortController()');
    // threaded into both the joiner dial and the responder accept, aborted in finally
    expect((src.match(/signal: ac\.signal/g) ?? []).length).toBe(2);
    expect(src).toContain('ac.abort()');
  });
});
