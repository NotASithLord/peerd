import { expect, test } from 'bun:test';
import { SignalingRoom } from '../../signaling-node/worker.js';
import { ROOM_BUDGET_KEY } from '../../signaling-node/durable-room-budget.js';
import { ROOM_CAP, WEBSITE_CAP, PUBLIC_ROOM, SPARSE_PUBLIC_PROFILE, INTRODUCTION_LIMIT, SAMPLE_INTERVAL_MS } from '../../extension/peerd-distributed/transport/signaling.js';

class Socket {
  readyState = 1;
  attachment: any;
  sent: any[] = [];
  closed: any[] = [];
  tags: string[] = [];
  serializeAttachment(value: any) { this.attachment = structuredClone(value); }
  deserializeAttachment() { return structuredClone(this.attachment); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close(code?: number, reason?: string) { this.readyState = 3; this.closed.push({ code, reason }); }
}

// Match the Cloudflare runtime contract so tests exercise the configured
// keepalive pair instead of disguising its constructor as a zero-argument API.
class AutoResponsePair {
  constructor(private request: string, private response: string) {}
  getRequest() { return this.request; }
  getResponse() { return this.response; }
}

// Only the Durable Object/WebSocket runtime shell is faked. The production
// worker and shared signaling reducer execute, with durable attachments copied
// on every read/write as in a hibernating runtime.
const withRuntime = async (run: (ctx: any, join: (room: SignalingRoom, kind?: string, key?: string, profile?: string) => Promise<Socket>) => Promise<void>) => {
  const sockets: Socket[] = [];
  let autoResponse: AutoResponsePair | null = null;
  const persisted = new Map<string, any>();
  let transaction = Promise.resolve();
  const controls = { beforePut: null as null | ((value: any) => Promise<void>), fail: false, writes: 0 };
  const ctx = {
    persisted, controls,
    storage: { transaction(run: (tx: any) => Promise<any>) {
      const next = transaction.then(async () => {
        if (controls.fail) throw new Error('storage unavailable');
        const staged = new Map(persisted);
        const result = await run({
          get: async (key: string) => structuredClone(staged.get(key)),
          put: async (key: string, value: any) => {
            await controls.beforePut?.(value);
            if (controls.fail) throw new Error('storage unavailable');
            staged.set(key, structuredClone(value));
          },
        });
        persisted.clear(); for (const [key, value] of staged) persisted.set(key, value);
        controls.writes++; return result;
      });
      transaction = next.then(() => {}, () => {}); return next;
    } },
    acceptWebSocket(socket: Socket, tags: string[]) { socket.tags = tags; sockets.push(socket); },
    getWebSockets(tag?: string) { return tag ? sockets.filter(socket => socket.tags.includes(tag)) : sockets; },
    setWebSocketAutoResponse(pair: AutoResponsePair) { autoResponse = pair; },
    getWebSocketAutoResponse() { return autoResponse; },
  };
  const globals = globalThis as any;
  const names = ['WebSocketPair', 'WebSocketRequestResponsePair', 'Response'];
  const original = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  const NativeResponse = Response;
  try {
    globals.WebSocketPair = class { 0 = new Socket(); 1 = new Socket(); };
    globals.WebSocketRequestResponsePair = AutoResponsePair;
    globals.Response = new Proxy(NativeResponse, {
      construct(target, args) {
        return args[1]?.status === 101 ? { status: 101, webSocket: args[1].webSocket } : Reflect.construct(target, args);
      },
    });
    await run(ctx, async (room, kind = 'extension', key = 'test', profile = '') => {
      await room.fetch(new Request(`https://node.test/rendezvous?key=${encodeURIComponent(key)}&kind=${kind}&profile=${encodeURIComponent(profile)}`, { headers: { Upgrade: 'websocket' } }));
      return sockets[sockets.length - 1]!;
    });
  } finally {
    names.forEach((name, index) => {
      const descriptor = original[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globals[name];
    });
  }
};

test('website admission pool survives messages and fresh Durable Object instances', async () => withRuntime(async (ctx, join) => {
  let room = new SignalingRoom(ctx, {});
  expect(ctx.getWebSocketAutoResponse().getRequest()).toBe('{"t":"ping"}');
  expect(ctx.getWebSocketAutoResponse().getResponse()).toBe('{"t":"pong"}');
  const websites: Socket[] = [];
  for (let index = 0; index < WEBSITE_CAP; index++) {
    const visitor = await join(room, 'website');
    websites.push(visitor);
    await room.webSocketMessage(visitor, JSON.stringify({ t: 'signal', to: 'absent', payload: {} }));
    expect(visitor.deserializeAttachment().kind).toBe('website');
    // New heap, same runtime-owned sockets. No previous instance state survives.
    room = new SignalingRoom(ctx, {});
    expect(ctx.getWebSocketAutoResponse().getResponse()).toBe('{"t":"pong"}');
  }
  const overflow = await join(room, 'website');
  expect(overflow.sent).toContainEqual({ t: 'full' });
  expect(overflow.readyState).toBe(3);
  for (let index = 0; index < ROOM_CAP; index++) {
    const extension = await join(room);
    expect(extension.sent.some(message => message.t === 'room')).toBe(true);
  }
  const extensionOverflow = await join(new SignalingRoom(ctx, {}));
  expect(extensionOverflow.sent).toContainEqual({ t: 'full' });
  expect(websites.every(socket => socket.readyState === 1)).toBe(true);
}));

test('rate count and website kind both survive repeated hibernation wakes', async () => withRuntime(async (ctx, join) => {
  const visitor = await join(new SignalingRoom(ctx, {}), 'website');
  for (let index = 0; index < 121; index++) {
    await new SignalingRoom(ctx, {}).webSocketMessage(visitor, '{}');
  }
  expect(visitor.deserializeAttachment()).toMatchObject({ kind: 'website', msgCount: 121 });
  expect(visitor.closed).toEqual([{ code: 1008, reason: 'rate limit exceeded' }]);
}));

test('UTF-8 wire limit rejects oversized multibyte JSON before bookkeeping or relay', async () => withRuntime(async (ctx, join) => {
  const room = new SignalingRoom(ctx, {});
  const sender = await join(room, 'website');
  const target = await join(room);
  const data = JSON.stringify({ t: 'signal', to: target.attachment.connId, payload: '😀'.repeat(17_000) });
  expect(data.length).toBeLessThan(64 * 1024);
  expect(new TextEncoder().encode(data).byteLength).toBeGreaterThan(64 * 1024);
  await room.webSocketMessage(sender, data);
  expect(sender.closed).toEqual([{ code: 1009, reason: 'message too large' }]);
  expect(sender.attachment).toMatchObject({ kind: 'website', msgCount: 0 });
  expect(target.sent.some(message => message.t === 'signal')).toBe(false);
}));

test('exact UTF-8 boundary relays, while one more byte is rejected', async () => withRuntime(async (ctx, join) => {
  const room = new SignalingRoom(ctx, {});
  const sender = await join(room);
  const target = await join(room);
  const message = { t: 'signal', to: target.attachment.connId, payload: '' };
  const available = 64 * 1024 - new TextEncoder().encode(JSON.stringify(message)).byteLength;
  message.payload = 'é'.repeat(Math.floor(available / 2)) + 'a'.repeat(available % 2);
  const exact = JSON.stringify(message);
  expect(new TextEncoder().encode(exact).byteLength).toBe(64 * 1024);
  await room.webSocketMessage(sender, exact);
  expect(target.sent.at(-1)?.payload).toBe(message.payload);
  expect(sender.readyState).toBe(1);
  message.payload += 'a';
  await room.webSocketMessage(sender, JSON.stringify(message));
  expect(sender.closed).toEqual([{ code: 1009, reason: 'message too large' }]);
}));


test('sparse public negotiation, sampling lease, kind and generic flood limit survive hibernation', async () => withRuntime(async (ctx, join) => {
  let room = new SignalingRoom(ctx, {});
  const sockets: Socket[] = [];
  for (let index = 0; index < 40; index++) {
    const before = ctx.getWebSockets().reduce((sum: number, s: Socket) => sum + s.sent.length, 0);
    const socket = await join(room, 'extension', PUBLIC_ROOM, SPARSE_PUBLIC_PROFILE);
    sockets.push(socket);
    expect(socket.sent[0]).toMatchObject({ t: 'room', profile: SPARSE_PUBLIC_PROFILE });
    expect(socket.sent[0].members.length).toBeLessThanOrEqual(INTRODUCTION_LIMIT);
    expect(ctx.getWebSockets().reduce((sum: number, s: Socket) => sum + s.sent.length, 0) - before).toBeLessThanOrEqual(INTRODUCTION_LIMIT + 1);
    room = new SignalingRoom(ctx, {});
  }
  const sender = sockets[0]!;
  const request = JSON.stringify({ t: 'sample', requestId: 'sample1', limit: 1_000_000 });
  const count = sender.sent.length;
  await room.webSocketMessage(sender, request);
  expect(sender.sent).toHaveLength(count); // initial introduction consumes lease
  sender.serializeAttachment({ ...sender.attachment, lastSampleAt: Date.now() - SAMPLE_INTERVAL_MS - 100 });
  await new SignalingRoom(ctx, {}).webSocketMessage(sender, request);
  expect(sender.sent.at(-1)).toMatchObject({ t: 'sample', requestId: 'sample1' });
  expect(sender.sent.at(-1).members).toHaveLength(INTRODUCTION_LIMIT);
  expect(sender.sent.at(-1).members).not.toContain(sender.attachment.connId);
  const sampledAt = sender.attachment.lastSampleAt;
  await new SignalingRoom(ctx, {}).webSocketMessage(sender, request);
  expect(sender.attachment).toMatchObject({ key: PUBLIC_ROOM, profile: SPARSE_PUBLIC_PROFILE, kind: 'extension', lastSampleAt: sampledAt });
  expect(sender.sent).toHaveLength(count + 1);
  for (let index = sender.attachment.msgCount; index < 121; index++) {
    await new SignalingRoom(ctx, {}).webSocketMessage(sender, JSON.stringify({ t: 'sample', requestId: {} }));
  }
  expect(sender.closed).toEqual([{ code: 1008, reason: 'rate limit exceeded' }]);
  const remainingMessages = sockets.slice(1).map(s => s.sent.length);
  await new SignalingRoom(ctx, {}).webSocketClose(sender);
  expect(sockets.slice(1).map(s => s.sent.length)).toEqual(remainingMessages);
}));

test('private attachments cannot enable sparse membership and old public attachments remain legacy', async () => withRuntime(async (ctx, join) => {
  let room = new SignalingRoom(ctx, {});
  const privatePeer = await join(room, 'extension', 'private', SPARSE_PUBLIC_PROFILE);
  expect(privatePeer.sent[0].profile).toBeUndefined();
  // Even a persisted profile field without verified public-key enrollment is
  // insufficient when rebuilding the reducer after eviction.
  privatePeer.serializeAttachment({ ...privatePeer.attachment, profile: SPARSE_PUBLIC_PROFILE, lastSampleAt: 0 });
  await new SignalingRoom(ctx, {}).webSocketMessage(privatePeer, JSON.stringify({ t: 'sample', requestId: 'no' }));
  expect(privatePeer.sent).toHaveLength(1);
  for (let index = 1; index <= ROOM_CAP; index++) await join(room, 'extension', 'private', SPARSE_PUBLIC_PROFILE);
  expect(ctx.getWebSockets().at(-1).sent).toContainEqual({ t: 'full' });
}));

test('old attachments join the mixed public room without losing relay scope or expanding legacy slots', async () => withRuntime(async (ctx, join) => {
  const room = new SignalingRoom(ctx, {});
  const legacy = await join(room, 'extension', PUBLIC_ROOM);
  legacy.serializeAttachment({ connId: legacy.attachment.connId, kind: 'extension', windowStart: Date.now(), msgCount: 0 });
  const sparse = await join(new SignalingRoom(ctx, {}), 'extension', PUBLIC_ROOM, SPARSE_PUBLIC_PROFILE);
  expect(sparse.sent[0].members).toContain(legacy.attachment.connId);
  await new SignalingRoom(ctx, {}).webSocketMessage(legacy, JSON.stringify({ t: 'signal', to: sparse.attachment.connId, payload: { opaque: true } }));
  expect(sparse.sent.at(-1)).toEqual({ t: 'signal', from: legacy.attachment.connId, payload: { opaque: true } });
  for (let index = 1; index <= ROOM_CAP; index++) await join(new SignalingRoom(ctx, {}), 'extension', PUBLIC_ROOM);
  expect(ctx.getWebSockets().at(-1).sent).toContainEqual({ t: 'full' });
  expect(legacy.attachment.profile).toBeUndefined();
}));


test('rejected socket remains outside membership if runtime close fails', async () => withRuntime(async (ctx, join) => {
  const room = new SignalingRoom(ctx, {});
  for (let index = 0; index < ROOM_CAP; index++) await join(room);
  const close = Socket.prototype.close;
  try {
    Socket.prototype.close = () => { throw new Error('runtime close unavailable'); };
    const rejected = await join(new SignalingRoom(ctx, {}));
    expect(rejected.readyState).toBe(1);
    expect(rejected.attachment.admitted).toBe(false);
    const target: Socket = ctx.getWebSockets()[0];
    const before = target.sent.length;
    await new SignalingRoom(ctx, {}).webSocketMessage(rejected, JSON.stringify({ t: 'signal', to: target.attachment.connId, payload: 'forbidden' }));
    expect(target.sent).toHaveLength(before);
    target.readyState = 3;
    const replacement = await join(new SignalingRoom(ctx, {}));
    expect(replacement.sent[0].t).toBe('room');
    expect(replacement.sent[0].members).toHaveLength(ROOM_CAP - 1);
    expect(replacement.sent[0].members).not.toContain(rejected.attachment.connId);
  } finally { Socket.prototype.close = close; }
}));


test('aggregate ingress survives socket churn and a fresh Worker instance after every event', async () => withRuntime(async (ctx, join) => {
  let parsed = 0, time = 0;
  const options = { now: () => time, limits: { roomMessages: 2 }, parse: (raw: string) => { parsed++; return JSON.parse(raw); } };
  const make = () => new SignalingRoom(ctx, {}, options);
  const a = await join(make()), b = await join(make());
  await make().webSocketMessage(a, '{bad');
  await make().webSocketMessage(b, '{bad');
  await make().webSocketClose(a);
  const c = await join(make());
  await make().webSocketMessage(c, '{}');
  expect(parsed).toBe(2); expect(c.closed.at(-1).code).toBe(1013);
  expect(ctx.persisted.get(ROOM_BUDGET_KEY).used.messages).toBe(2);
  time = 10_000;
  await make().webSocketMessage(b, '{}');
  time = 0;
  await make().webSocketMessage(b, '{}');
  await make().webSocketMessage(b, '{}');
  expect(parsed).toBe(4); expect(b.closed.at(-1).code).toBe(1013);
}));

test('durable join failure precedes WebSocketPair acceptance and corrupt records never reset', async () => withRuntime(async (ctx, join) => {
  ctx.controls.fail = true;
  const req = new Request('https://node.test/rendezvous?key=test', { headers: { Upgrade: 'websocket' } });
  expect((await new SignalingRoom(ctx, {}).fetch(req)).status).toBe(503);
  expect(ctx.getWebSockets()).toHaveLength(0);
  ctx.controls.fail = false;
  ctx.persisted.set(ROOM_BUDGET_KEY, { version: 99 });
  expect((await new SignalingRoom(ctx, {}).fetch(req)).status).toBe(503);
  expect(ctx.getWebSockets()).toHaveLength(0);
  expect(ctx.persisted.get(ROOM_BUDGET_KEY)).toEqual({ version: 99 });
}));

test('retirement during pending ingress debit prevents later parsing and survives a wake', async () => withRuntime(async (ctx, join) => {
  let parsed = 0;
  const room = new SignalingRoom(ctx, {}, { parse: raw => { parsed++; return JSON.parse(raw); } });
  const a = await join(room), b = await join(room), before = b.sent.length;
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  ctx.controls.beforePut = async () => { entered.resolve(); await release.promise; };
  const message = room.webSocketMessage(a, JSON.stringify({ t: 'signal', to: b.attachment.connId, payload: 'late' }));
  await entered.promise;
  expect(parsed).toBe(0); expect(b.sent).toHaveLength(before);
  const close = room.webSocketClose(a);
  expect(a.attachment).toMatchObject({ retired: true, admitted: false });
  ctx.controls.beforePut = null; release.resolve();
  await message; await close;
  expect(parsed).toBe(0);
  await new SignalingRoom(ctx, {}).webSocketMessage(a, '{}');
  expect(parsed).toBe(0);
  expect(b.sent.filter(m => m.t === 'signal')).toHaveLength(0);
}));

test('whole-operation custody serializes admissions across a pending egress debit', async () => withRuntime(async (ctx, join) => {
  const room = new SignalingRoom(ctx, {});
  await join(room);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  ctx.controls.beforePut = async (value: any) => {
    if (value.used.egressFrames > 1) { entered.resolve(); await release.promise; }
  };
  const first = join(room); await entered.promise;
  const second = join(room);
  expect(ctx.getWebSockets()).toHaveLength(2);
  expect(ctx.getWebSockets()[1].attachment.admitted).toBe(false);
  expect(ctx.getWebSockets()[1].sent).toHaveLength(0);
  ctx.controls.beforePut = null; release.resolve();
  const a = await first, b = await second;
  expect(a.attachment.admitted).toBe(true); expect(b.attachment.admitted).toBe(true);
  expect(b.sent[0].members).toContain(a.attachment.connId);
}));

test('pending work is bounded and excess senders retire without parsing or a late useful effect', async () => withRuntime(async (ctx, join) => {
  let parsed = 0;
  const room = new SignalingRoom(ctx, {}, { parse: raw => { parsed++; return JSON.parse(raw); } });
  const a = await join(room);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  ctx.controls.beforePut = async () => { entered.resolve(); await release.promise; };
  const first = room.webSocketMessage(a, '{}'); await entered.promise;
  const rest = Array.from({ length: 20 }, () => room.webSocketMessage(a, '{}'));
  expect(a.closed.at(-1).code).toBe(1013); expect(parsed).toBe(0);
  expect(a.attachment.retired).toBe(true);
  ctx.controls.beforePut = null; release.resolve();
  await Promise.all([first, ...rest]);
  expect(parsed).toBe(0);
}));

test('failed outgoing reservation leaves sampling lease unchanged and closes before any partial reply', async () => withRuntime(async (ctx, join) => {
  let time = 0;
  const room = new SignalingRoom(ctx, {}, { now: () => time });
  const a = await join(room, 'extension', PUBLIC_ROOM, SPARSE_PUBLIC_PROFILE);
  const before = a.sent.length;
  time = SAMPLE_INTERVAL_MS;
  ctx.controls.beforePut = async (value: any) => { if (value.used.egressFrames > 0) throw new Error('egress persist rejected'); };
  await room.webSocketMessage(a, JSON.stringify({ t: 'sample', requestId: 'test' }));
  expect(a.attachment.lastSampleAt).toBe(0);
  expect(a.attachment.admitted).toBe(false);
  expect(a.sent).toHaveLength(before);
  expect(a.closed.at(-1).code).toBe(1013);
  await room.webSocketClose(a); await room.webSocketError(a);
  expect(a.closed).toHaveLength(1);
}));

test('durable aggregate byte and join refusals survive fresh instances without extra parsing or socket allocation', async () => withRuntime(async (ctx, join) => {
  let parsed = 0;
  const options = { now: () => 0, limits: { roomJoins: 2, roomIngressBytes: 6 },
    parse: (raw: string) => { parsed++; return JSON.parse(raw); } };
  const make = () => new SignalingRoom(ctx, {}, options);
  const a = await join(make()), b = await join(make());
  await make().webSocketMessage(a, '"😀"');
  await make().webSocketMessage(b, '{}');
  expect(parsed).toBe(1); expect(b.closed.at(-1).code).toBe(1013);
  const response = await make().fetch(new Request('https://node.test/rendezvous?key=test', { headers: { Upgrade: 'websocket' } }));
  expect(response.status).toBe(503); expect(ctx.getWebSockets()).toHaveLength(2);
  expect(ctx.persisted.get(ROOM_BUDGET_KEY).used).toMatchObject({ joins: 2, ingressBytes: 6, messages: 1 });
}));

test('failed send keeps its debit and retires a recipient durably even when native close throws', async () => withRuntime(async (ctx, join) => {
  const room = new SignalingRoom(ctx, {}), sender = await join(room), target = await join(room);
  const before = ctx.persisted.get(ROOM_BUDGET_KEY).used.egressFrames;
  target.send = () => { throw new Error('write failed'); };
  target.close = () => { throw new Error('close failed'); };
  await room.webSocketMessage(sender, JSON.stringify({ t: 'signal', to: target.attachment.connId, payload: 'opaque' }));
  expect(ctx.persisted.get(ROOM_BUDGET_KEY).used.egressFrames).toBe(before + 1);
  expect(target.attachment).toMatchObject({ retired: true, admitted: false });
  const replacement = await join(new SignalingRoom(ctx, {}));
  expect(replacement.sent[0].members).not.toContain(target.attachment.connId);
  const count = sender.sent.length;
  await new SignalingRoom(ctx, {}).webSocketMessage(target, JSON.stringify({ t: 'signal', to: sender.attachment.connId, payload: 'forbidden' }));
  expect(sender.sent).toHaveLength(count);
}));

test('local protocol retirement and dead-socket reaping each notify honest legacy peers once', async () => withRuntime(async (ctx, join) => {
  const room = new SignalingRoom(ctx, {});
  const a = await join(room), honest = await join(room);
  await room.webSocketMessage(a, 'x'.repeat(64 * 1024 + 1));
  // An admitted operation is a queue barrier behind the best-effort notice.
  await room.webSocketMessage(honest, '{}');
  await room.webSocketClose(a); await room.webSocketError(a);
  expect(honest.sent.filter(message => message.t === 'left' && message.member === a.attachment.connId)).toHaveLength(1);
  const dead = await join(room);
  dead.readyState = 2;
  await join(room);
  await room.webSocketMessage(honest, '{}');
  await room.webSocketClose(dead);
  expect(honest.sent.filter(message => message.t === 'left' && message.member === dead.attachment.connId)).toHaveLength(1);
}));

test('attached socket ceiling survives clock windows and failed native closes independently of membership', async () => withRuntime(async (ctx, join) => {
  let time = 0;
  const make = () => new SignalingRoom(ctx, {}, { now: () => time, attachedLimit: 2 });
  const room = make(), a = await join(room), b = await join(room);
  for (const socket of [a, b]) socket.close = () => { socket.readyState = 2; throw new Error('native close stalled'); };
  await room.webSocketClose(a); await room.webSocketClose(b);
  for (let index = 0; index < 3; index++) {
    time += 10_000;
    const response = await make().fetch(new Request('https://node.test/rendezvous?key=test', { headers: { Upgrade: 'websocket' } }));
    expect(response.status).toBe(503);
    expect(ctx.getWebSockets()).toHaveLength(2);
  }
  expect(ctx.getWebSockets().every((socket: Socket) => socket.attachment.admitted === false)).toBe(true);
}));

test('double platform custody failure fences current-instance work without claiming durable retirement', async () => withRuntime(async (ctx, join) => {
  let parsed = 0;
  const room = new SignalingRoom(ctx, {}, { parse: raw => { parsed++; return JSON.parse(raw); } });
  const a = await join(room), b = await join(room);
  a.serializeAttachment = () => { throw new Error('attachment unavailable'); };
  a.close = () => { throw new Error('close unavailable'); };
  await room.webSocketClose(a);
  await room.webSocketMessage(b, '{}');
  expect(parsed).toBe(0);
  const result = await room.fetch(new Request('https://node.test/rendezvous?key=test', { headers: { Upgrade: 'websocket' } }));
  expect(result.status).toBe(503);
  expect(ctx.getWebSockets()).toHaveLength(2);
  // Both platform operations failed: never assert the old attachment vanished.
  expect(a.attachment.admitted).toBe(true);
}));
