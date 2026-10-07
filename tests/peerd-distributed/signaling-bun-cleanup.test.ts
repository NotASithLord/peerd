import { expect, test } from 'bun:test';
import { createSignalingServer } from '../../signaling-node/bun-server.mjs';
import { PUBLIC_ROOM, SPARSE_PUBLIC_PROFILE } from '../../extension/peerd-distributed/transport/rendezvous-profile.js';

// Run the actual shell callbacks against native-send outcomes that real loopback
// cannot deterministically force. Real socket routing is covered separately.
const fixture = (now = () => 0) => {
  let callbacks: any;
  const sockets: any[] = [];
  let depth = 0, peakDepth = 0;
  const server = { port: 1, stop() {}, upgrade(_req: Request, { data }: any) {
    const ws = { data, readyState: 1, mode: 'sent', messages: [] as any[], code: 0,
      send(text: string) {
        depth++; peakDepth = Math.max(peakDepth, depth);
        try {
          if (this.mode === 'throw') throw new Error('native write failed');
          if (this.mode === 'drop') return 0;
          this.messages.push(JSON.parse(text));
          return this.mode === 'buffer' ? -1 : text.length;
        } finally { depth--; }
      },
      close(code: number) { this.code = code; this.readyState = 3; callbacks.websocket.close(this); },
    };
    sockets.push(ws); callbacks.websocket.open(ws); return true;
  } };
  const host = createSignalingServer({ now, log() {}, limits: { roomJoins: 128 },
    serve: ((options: any) => { callbacks = options; return server; }) as typeof Bun.serve });
  const join = (key = PUBLIC_ROOM, profile = SPARSE_PUBLIC_PROFILE) => {
    callbacks.fetch(new Request(`http://localhost/rendezvous?key=${key}&profile=${profile}`,
      { headers: { Upgrade: 'websocket' } }), server);
    return sockets.at(-1)!;
  };
  return { host, join, callbacks: () => callbacks, peakDepth: () => peakDepth };
};

test('dropped and throwing recipients retire iteratively without refund or stale membership', () => {
  const f = fixture();
  try {
    const peers = Array.from({ length: 120 }, () => f.join());
    expect(f.host.stats().memberships).toBe(120);
    const before = f.host.stats().egressFrames;
    peers.forEach((peer, index) => { peer.mode = index % 2 ? 'throw' : 'drop'; });
    // Sparse departure broadcasts are suppressed by the reducer. Exercise a
    // whole admission batch with sixteen distinct failing recipients instead.
    const newcomer = f.join();
    expect(f.host.stats().memberships).toBe(105);
    expect(peers.filter(peer => peer.code === 1013)).toHaveLength(16);
    expect(f.host.stats().egressFrames).toBe(before + 17);
    expect(newcomer.code).toBe(0);
    expect(f.peakDepth()).toBe(1);
  } finally { f.host.stop(); }
  expect(f.host.stats()).toMatchObject({ live: 0, connections: 0, memberships: 0, cleanupErrors: 0 });
});

test('buffered writes remain owned; synchronous close callbacks and failed cleanup accounting release once', () => {
  let invalidClock = false;
  const f = fixture(() => invalidClock ? NaN : 0);
  const a = f.join(), b = f.join();
  a.mode = 'buffer';
  f.callbacks().websocket.message(b, JSON.stringify({ t: 'signal', to: a.data.connId, payload: 'buffered' }));
  expect(a.messages.at(-1).payload).toBe('buffered');
  expect(f.host.stats().live).toBe(2);
  invalidClock = true;
  f.host.stop();
  expect(f.host.stats()).toMatchObject({ live: 0, connections: 0, memberships: 0, cleanupErrors: 2 });
  f.callbacks().websocket.close(a); f.callbacks().websocket.close(b);
  expect(f.host.stats().live).toBe(0);
});

test('legacy departure fanout retires every failed recipient without stranded cleanup work', () => {
  const f = fixture();
  try {
    const peers = Array.from({ length: 16 }, () => f.join('legacy', ''));
    peers.forEach((peer, index) => { peer.mode = index % 2 ? 'throw' : 'drop'; });
    peers[0]!.close(1000);
    expect(peers.slice(1).every(peer => peer.code === 1013)).toBe(true);
    expect(f.host.stats()).toMatchObject({ live: 0, connections: 0, memberships: 0, cleanupErrors: 0 });
  } finally { f.host.stop(); }
});
