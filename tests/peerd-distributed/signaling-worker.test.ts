import { expect, test } from 'bun:test';
import { SignalingRoom } from '../../signaling-node/worker.js';
import { ROOM_CAP, WEBSITE_CAP } from '../../extension/peerd-distributed/transport/signaling.js';

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

// Only the Durable Object/WebSocket runtime shell is faked. The production
// worker and shared signaling reducer execute, with durable attachments copied
// on every read/write as in a hibernating runtime.
const withRuntime = async (run: (ctx: any, join: (room: SignalingRoom, kind?: string) => Promise<Socket>) => Promise<void>) => {
  const sockets: Socket[] = [];
  const ctx = {
    acceptWebSocket(socket: Socket, tags: string[]) { socket.tags = tags; sockets.push(socket); },
    getWebSockets(tag?: string) { return tag ? sockets.filter(socket => socket.tags.includes(tag)) : sockets; },
    setWebSocketAutoResponse() {},
  };
  const globals = globalThis as any;
  const names = ['WebSocketPair', 'WebSocketRequestResponsePair', 'Response'];
  const original = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  const NativeResponse = Response;
  try {
    globals.WebSocketPair = class { 0 = new Socket(); 1 = new Socket(); };
    globals.WebSocketRequestResponsePair = class {};
    globals.Response = new Proxy(NativeResponse, {
      construct(target, args) {
        return args[1]?.status === 101 ? { status: 101, webSocket: args[1].webSocket } : Reflect.construct(target, args);
      },
    });
    await run(ctx, async (room, kind = 'extension') => {
      await room.fetch(new Request(`https://node.test/rendezvous?key=test&kind=${kind}`, { headers: { Upgrade: 'websocket' } }));
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
  const websites: Socket[] = [];
  for (let index = 0; index < WEBSITE_CAP; index++) {
    const visitor = await join(room, 'website');
    websites.push(visitor);
    await room.webSocketMessage(visitor, JSON.stringify({ t: 'signal', to: 'absent', payload: {} }));
    expect(visitor.deserializeAttachment().kind).toBe('website');
    // New heap, same runtime-owned sockets. No previous instance state survives.
    room = new SignalingRoom(ctx, {});
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
