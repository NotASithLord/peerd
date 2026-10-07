import { expect, test } from 'bun:test';
import { createSignalingServer } from '../../signaling-node/bun-server.mjs';
import { PUBLIC_ROOM, SPARSE_PUBLIC_PROFILE } from '../../extension/peerd-distributed/transport/rendezvous-profile.js';

const fixture = (limits: Record<string, number> = {}) => {
  let time = 0, parsed = 0;
  const parseWaiters = new Map<number, () => void>();
  const host = createSignalingServer({ port: 0, hostname: '127.0.0.1', limits, now: () => time,
    log: () => {}, parse: raw => { parsed++; parseWaiters.get(parsed)?.(); return JSON.parse(raw); } });
  const sockets: WebSocket[] = [];
  const deadline = <T>(promise: Promise<T>) => {
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('real signaling budget deadline')), 2000); })])
      .finally(() => clearTimeout(timer!));
  };
  const connect = (key: string, profile = '') => {
    const ws = new WebSocket(`ws://127.0.0.1:${host.server.port}/rendezvous?key=${encodeURIComponent(key)}&profile=${profile}`);
    sockets.push(ws);
    const first = Promise.withResolvers<any>(), closed = Promise.withResolvers<number>();
    const messages: any[] = [];
    ws.onmessage = event => { const m = JSON.parse(String(event.data)); messages.push(m); first.resolve(m); };
    ws.onclose = event => { closed.resolve(event.code); first.resolve(null); };
    ws.onerror = () => {}; // failed HTTP upgrade is asserted through close + membership
    return { ws, messages, first: deadline(first.promise), closed: closed.promise };
  };
  return { host, connect, deadline, parsedThrough: (count: number) => parsed >= count ? Promise.resolve() : deadline(new Promise<void>(resolve => parseWaiters.set(count, resolve))), parsed: () => parsed, advance: () => { time += 10_000; },
    stop: () => { for (const ws of sockets) ws.close(); host.stop(); } };
};

test('individually legal sockets exhaust aggregate room ingress before parse and recover only after the window', async () => {
  const f = fixture({ roomMessages: 2 });
  try {
    const a = f.connect('room'), b = f.connect('room'); await a.first; await b.first;
    a.ws.send('{bad'); await f.parsedThrough(1); b.ws.send('{bad'); await f.parsedThrough(2); a.ws.send('{bad');
    expect(await f.deadline(a.closed)).toBe(1013); expect(f.parsed()).toBe(2);
    const c = f.connect('room'); await c.first; c.ws.send('{bad');
    expect(await f.deadline(c.closed)).toBe(1013); expect(f.parsed()).toBe(2);
    f.advance();
    const d = f.connect('room'); const reply = await d.first;
    const received = Promise.withResolvers<any>(); b.ws.addEventListener('message', e => { const m = JSON.parse(String(e.data)); if (m.t === 'signal') received.resolve(m); });
    d.ws.send(JSON.stringify({ t: 'signal', to: b.messages[0].self, payload: 'recovered' }));
    expect(await f.deadline(received.promise)).toMatchObject({ t: 'signal', from: reply.self, payload: 'recovered' });
  } finally { f.stop(); }
  expect(f.host.stats()).toMatchObject({ live: 0, connections: 0, memberships: 0 });
});

test('private key fanout cannot evade process ingress or retain more room/socket ownership', async () => {
  const f = fixture({ processMessages: 2, rooms: 3, sockets: 3 });
  try {
    const peers = ['a', 'b', 'c'].map(key => f.connect(key)); await Promise.all(peers.map(p => p.first));
    peers[0]!.ws.send('null'); await f.parsedThrough(1); peers[1]!.ws.send('null'); await f.parsedThrough(2); peers[2]!.ws.send('null');
    expect(await f.deadline(peers[2]!.closed)).toBe(1013); expect(f.parsed()).toBe(2);
    const excess = f.connect('d'); expect(await excess.first).toBeNull();
    expect(f.host.stats().rooms).toBe(3);
    f.advance(); const next = f.connect('d'); expect((await next.first).t).toBe('room');
  } finally { f.stop(); }
});

test('egress refusal sends no partial admission and leave still frees a saturated room', async () => {
  const f = fixture({ roomEgressFrames: 3, roomControlFrames: 1 });
  try {
    const a = f.connect('r'); await a.first; // one reply
    const b = f.connect('r'); await b.first; // reply + joined consumes the rest
    const c = f.connect('r'); expect(await c.first).toBeNull(); expect(await f.deadline(c.closed)).toBe(1013);
    expect(f.host.stats()).toMatchObject({ live: 2, memberships: 2 });
    expect(a.messages.filter(m => m.t === 'joined')).toHaveLength(1);
    b.ws.close(); await f.deadline(b.closed);
    // The next rejected join is an ordered shell barrier after departure.
    const barrier = f.connect('r'); await barrier.first;
    expect(f.host.stats().memberships).toBe(1);
    f.advance(); const recovered = f.connect('r'); expect((await recovered.first).members).toHaveLength(1);
  } finally { f.stop(); }
});

test('sample response cannot spend reserved control credit and refusal retires membership', async () => {
  const f = fixture({ roomEgressFrames: 4, roomControlFrames: 2 });
  try {
    const peer = f.connect(PUBLIC_ROOM, SPARSE_PUBLIC_PROFILE); expect((await peer.first).profile).toBe(SPARSE_PUBLIC_PROFILE);
    const other = f.connect(PUBLIC_ROOM, SPARSE_PUBLIC_PROFILE); const destination = (await other.first).self;
    f.advance();
    for (let index = 1; index <= 2; index++) {
      peer.ws.send(JSON.stringify({ t: 'signal', to: destination, payload: index }));
      await f.parsedThrough(index);
    }
    peer.ws.send(JSON.stringify({ t: 'sample', requestId: 'one' }));
    expect(await f.deadline(peer.closed)).toBe(1013);
    expect(peer.messages.some(message => message.t === 'sample')).toBe(false);
    expect(f.host.stats()).toMatchObject({ live: 1, memberships: 1 });
  } finally { f.stop(); }
});

test('default budget carries forty peers and a bounded honest opaque ICE burst', async () => {
  const f = fixture();
  try {
    const peers = [];
    for (let index = 0; index < 40; index++) {
      const peer = f.connect(PUBLIC_ROOM, SPARSE_PUBLIC_PROFILE);
      const reply = await peer.first;
      peers.push({ ...peer, id: reply.self });
    }
    const delivered = Promise.withResolvers<void>();
    let received = 0;
    for (const peer of peers) peer.ws.addEventListener('message', event => {
      if (JSON.parse(String(event.data)).t === 'signal' && ++received === 960) delivered.resolve();
    });
    // Four selected neighbors, six negotiation messages each (offer/answer and
    // opaque ICE candidates). This is shell traffic, not a native RTC benchmark.
    for (let index = 0; index < peers.length; index++) {
      for (let neighbor = 1; neighbor <= 4; neighbor++) for (let frame = 0; frame < 6; frame++) {
        peers[index]!.ws.send(JSON.stringify({ t: 'signal', to: peers[(index + neighbor) % peers.length]!.id,
          payload: { type: frame === 0 ? 'offer' : frame === 1 ? 'answer' : 'candidate', data: 'x'.repeat(1024) } }));
      }
    }
    await f.deadline(delivered.promise);
    expect(f.host.stats()).toMatchObject({ memberships: 40, live: 40, messages: 960 });
    expect(f.parsed()).toBe(960);
  } finally { f.stop(); }
});

test('aggregate UTF8 bytes reject individually legal frames before JSON parsing', async () => {
  const f = fixture({ roomIngressBytes: 8 });
  try {
    const a = f.connect('bytes'); await a.first;
    a.ws.send('"😀"'); await f.parsedThrough(1); // six UTF8 bytes
    a.ws.send('null');
    expect(await f.deadline(a.closed)).toBe(1013);
    expect(f.parsed()).toBe(1);
    expect(f.host.stats().ingressBytes).toBe(6);
  } finally { f.stop(); }
});

test('HTTP join refusal has retry guidance and spends no socket custody', async () => {
  const f = fixture({ roomJoins: 1 });
  try {
    const first = f.connect('bounded'); await first.first;
    const response = await fetch(`http://127.0.0.1:${f.host.server.port}/rendezvous?key=bounded`,
      { headers: { Upgrade: 'websocket' } });
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('10');
    expect(f.host.stats()).toMatchObject({ live: 1, memberships: 1 });
    const invalid = await fetch(`http://127.0.0.1:${f.host.server.port}/rendezvous?key=${'a'.repeat(257)}`,
      { headers: { Upgrade: 'websocket' } });
    expect(invalid.status).toBe(400);
    expect(f.host.stats().rooms).toBe(1);
  } finally { f.stop(); }
});
