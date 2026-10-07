import { expect, test } from 'bun:test';
import { PUBLIC_ROOM, SPARSE_PUBLIC_PROFILE, INTRODUCTION_LIMIT, ROOM_CAP, WEBSITE_CAP } from '../../extension/peerd-distributed/transport/signaling.js';

// Exercise the shipped server over real local WebSockets. This proves shell
// routing/negotiation, not WebRTC degree, network connectivity or browser scale.
test('Bun server negotiates sparse membership without activating it for legacy/private clients', async () => {
  const child = Bun.spawn([process.execPath, 'signaling-node/bun-server.mjs'], {
    cwd: new URL('../../', import.meta.url).pathname,
    env: { ...process.env, PORT: '0' }, stdout: 'pipe', stderr: 'ignore',
  });
  const sockets: WebSocket[] = [];
  const { promise: listening, resolve, reject } = Promise.withResolvers<string>();
  let watchdog: ReturnType<typeof setTimeout>;
  const stopped = new Promise<never>((_, fail) => {
    watchdog = setTimeout(() => { child.kill(); fail(new Error('Bun signaling fixture deadline')); }, 8_000);
  });
  const read = (async () => {
    let tail = '';
    for await (const bytes of child.stdout) {
      tail = (tail + new TextDecoder().decode(bytes)).slice(-2_048);
      const port = /listening: ws:\/\/localhost:(\d+)/.exec(tail)?.[1];
      if (port) resolve(`ws://localhost:${port}/rendezvous`);
    }
    reject(new Error('Bun signaling server exited before listening'));
  })();
  try {
    await Promise.race([stopped, (async () => {
      const url = await listening;
      const join = async (key: string, profile = '', kind = 'extension') => {
        const ws = new WebSocket(`${url}?key=${encodeURIComponent(key)}&profile=${profile}&kind=${kind}`);
        sockets.push(ws);
        const messages: any[] = [];
        const first = Promise.withResolvers<any>();
        ws.addEventListener('message', event => { const message = JSON.parse(String(event.data)); messages.push(message); first.resolve(message); });
        ws.addEventListener('error', () => first.reject(new Error('fixture socket error')));
        ws.addEventListener('close', () => first.reject(new Error('fixture closed before room response')));
        return { ws, messages, reply: await first.promise };
      };
      const peers = [];
      for (let index = 0; index < 40; index++) {
        const peer = await join(PUBLIC_ROOM, SPARSE_PUBLIC_PROFILE);
        peers.push(peer);
        expect(peer.reply).toMatchObject({ t: 'room', profile: SPARSE_PUBLIC_PROFILE });
        expect(peer.reply.members.length).toBeLessThanOrEqual(INTRODUCTION_LIMIT);
      }
      const legacy = await join(PUBLIC_ROOM);
      expect(legacy.reply.t).toBe('room');
      expect(legacy.reply.profile).toBeUndefined();
      expect(legacy.reply.members).toHaveLength(INTRODUCTION_LIMIT);
      const sender = peers[0]!;
      const delivered = Promise.withResolvers<any>();
      legacy.ws.addEventListener('message', event => { const m = JSON.parse(String(event.data)); if (m.t === 'signal') delivered.resolve(m); });
      // The following signal is an ordered processing barrier: neither malformed
      // requests nor an immediate valid sample may bypass the initial lease.
      sender.ws.send(JSON.stringify({ t: 'sample', requestId: {} }));
      sender.ws.send(JSON.stringify({ t: 'sample', requestId: 'early', limit: 1000000 }));
      sender.ws.send(JSON.stringify({ t: 'signal', to: legacy.reply.self, payload: { opaque: true } }));
      expect(await delivered.promise).toEqual({ t: 'signal', from: sender.reply.self, payload: { opaque: true } });
      const echoed = Promise.withResolvers<void>();
      sender.ws.addEventListener('message', event => { const m = JSON.parse(String(event.data)); if (m.t === 'signal' && m.payload === 'barrier') echoed.resolve(); });
      legacy.ws.send(JSON.stringify({ t: 'signal', to: sender.reply.self, payload: 'barrier' }));
      await echoed.promise; // same receiving socket FIFO, including any erroneous sample reply
      expect(sender.messages.some(m => m.t === 'sample')).toBe(false);
      for (let index = 0; index < WEBSITE_CAP; index++) {
        const visitor = await join(PUBLIC_ROOM, SPARSE_PUBLIC_PROFILE, 'website');
        expect(visitor.reply.t).toBe('room');
        expect(visitor.reply.profile).toBeUndefined();
      }
      expect((await join(PUBLIC_ROOM, SPARSE_PUBLIC_PROFILE, 'website')).reply).toEqual({ t: 'full' });
      for (let index = 0; index < ROOM_CAP; index++) {
        const privatePeer = await join('private', SPARSE_PUBLIC_PROFILE);
        expect(privatePeer.reply.profile).toBeUndefined();
        expect(privatePeer.reply.members).toHaveLength(index);
      }
      expect((await join('private', SPARSE_PUBLIC_PROFILE)).reply).toEqual({ t: 'full' });
      const closed = Promise.withResolvers<number>();
      sender.ws.addEventListener('close', event => closed.resolve(event.code));
      for (let index = 0; index < 121; index++) sender.ws.send(JSON.stringify({ t: 'sample', requestId: [] }));
      expect(await closed.promise).toBe(1008);
      const oversized = peers[1]!;
      const tooLarge = Promise.withResolvers<number>();
      oversized.ws.addEventListener('close', event => tooLarge.resolve(event.code));
      const frame = JSON.stringify({ t: 'signal', to: legacy.reply.self, payload: '😀'.repeat(17_000) });
      expect(frame.length).toBeLessThan(64 * 1024);
      expect(new TextEncoder().encode(frame).byteLength).toBeGreaterThan(64 * 1024);
      oversized.ws.send(frame);
      // Bun's native maxPayloadLength rejects before the handler can send its
      // explicit 1009 close. The client observes an abnormal native termination.
      expect(await tooLarge.promise).toBe(1006);
      const finalBarrier = Promise.withResolvers<void>();
      legacy.ws.addEventListener('message', event => { const m = JSON.parse(String(event.data)); if (m.t === 'signal' && m.payload === 'finished') finalBarrier.resolve(); });
      peers[2]!.ws.send(JSON.stringify({ t: 'signal', to: legacy.reply.self, payload: 'finished' }));
      await finalBarrier.promise;
      expect(legacy.messages.some(m => m.t === 'signal' && m.from === oversized.reply.self)).toBe(false);
    })()]);
  } finally {
    clearTimeout(watchdog!);
    for (const ws of sockets) ws.close();
    child.kill();
    await child.exited;
    await read;
  }
}, 10_000);
