import { describe, expect, test } from 'bun:test';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import { createBufferedChannel, memoryPair } from '../../extension/peerd-distributed/transport/channel.js';
import { createRoomMesh, CTRL } from '../../extension/peerd-distributed/transport/mesh.js';
import { buildEnvelope, signEnvelope } from '../../extension/peerd-distributed/transport/envelope.js';

import { iterateSyncChunks, SYNC_CHUNK_BYTES } from '../../extension/peerd-distributed/self/sync.js';

const channel = () => {
  let handler: (msg: any) => void = () => {};
  let closed = false;
  return {
    send: (_msg: any) => {},
    setHandler: (h: (msg: any) => void) => { handler = h; },
    onClose: (_cb: () => void) => () => {},
    close: () => { closed = true; },
    receive: (msg: any) => handler(msg),
    closed: () => closed,
  };
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

describe('mesh local abuse cooldowns', () => {
  test('malformed frames evict their carrier; readmission resumes after cooldown', async () => {
    const identity = await generateIdentity();
    let time = 0;
    const mesh = createRoomMesh({ roomId: 'r', identity, now: () => time });
    const c = channel();
    mesh.addLink(c, 'carrier');
    c.receive({ garbage: true });
    c.receive(null);
    expect(mesh.hasLink('carrier')).toBe(true);
    c.receive({ v: 9 });
    expect(c.closed()).toBe(true);
    expect(mesh.hasLink('carrier')).toBe(false);
    const retry = channel();
    expect(mesh.addLink(retry, 'carrier')).toBe(false);
    expect(retry.closed()).toBe(true);
    // A different peer remains admissible: the penalty is local to the carrier.
    expect(mesh.addLink(channel(), 'other')).toBe(true);
    time = 300_000;
    expect(mesh.addLink(channel(), 'carrier')).toBe(true);
    mesh.close();
  });

  test('control floods are charged before signature verification', async () => {
    const identity = await generateIdentity();
    const events: string[] = [];
    const mesh = createRoomMesh({ roomId: 'r', identity, ctrlRateLimit: 2,
      audit: (name) => events.push(name) });
    const c = channel();
    mesh.addLink(c, 'carrier');
    const invalid = { v: 1, ch: 0, typ: CTRL.PING, sig: 'invalid', from: 'forged' };
    c.receive(invalid); c.receive(invalid); c.receive(invalid);
    expect(mesh.hasLink('carrier')).toBe(false);
    expect(events).toContain('peer_ctrl_rate_limited');
    expect(mesh.addLink(channel(), 'forged')).toBe(true);
    await settle();
    mesh.close();
  });

  test('isolated bad frames expire; repeated invalid signatures cool down the carrier', async () => {
    const identity = await generateIdentity();
    let time = 0;
    const mesh = createRoomMesh({ roomId: 'r', identity, now: () => time });
    const c = channel();
    mesh.addLink(c, 'carrier');
    c.receive({ garbage: true }); c.receive({ garbage: true });
    time = 60_000;
    c.receive({ garbage: true });
    expect(mesh.hasLink('carrier')).toBe(true);
    c.receive({ v: 1, ch: 4, from: identity.did, sig: 'bad' });
    await settle();
    expect(mesh.hasLink('carrier')).toBe(true);
    c.receive({ v: 1, ch: 4, from: identity.did, sig: 'bad' });
    await settle();
    expect(mesh.hasLink('carrier')).toBe(false);
    mesh.close();
  });

  test('a replaced link cannot dispatch or penalize the current connection', async () => {
    const [identity, remote] = await Promise.all([generateIdentity(), generateIdentity()]);
    const mesh = createRoomMesh({ roomId: 'r', identity });
    const received: any[] = [];
    mesh.onEnvelope((env) => received.push(env));
    const old = channel();
    mesh.addLink(old, remote.did);
    const env = await signEnvelope(buildEnvelope({ ch: 5, typ: 0, from: remote.did,
      body: {}, id: 'one', ts: 0 }), remote);
    old.receive(env); // verification is now pending on the old generation
    const current = channel();
    mesh.addLink(current, remote.did);
    old.receive(null); old.receive(null); old.receive(null);
    await settle();
    expect(received).toHaveLength(0);
    expect(mesh.hasLink(remote.did)).toBe(true);
    current.receive(env);
    await settle();
    expect(received).toHaveLength(1);
    mesh.close();
  });
});


describe('aggregate ingress bounds', () => {
  test('honest direct bursts queue verification without losing reliable frames', async () => {
    const [identity, remote] = await Promise.all([generateIdentity(), generateIdentity()]);
    const mesh = createRoomMesh({ roomId: 'r', identity });
    const c = channel();
    mesh.addLink(c, remote.did);
    const env = await signEnvelope(buildEnvelope({ ch: 3, typ: 1, from: remote.did,
      body: {}, id: 'burst', ts: 0 }), remote);
    let received = 0;
    const complete = new Promise<void>((resolve) => mesh.onEnvelope(() => {
      if (++received === 40) resolve();
    }));
    for (let i = 0; i < 40; i++) c.receive(env);
    await complete;
    expect(received).toBe(40);
    expect(mesh.hasLink(remote.did)).toBe(true);
    mesh.close();
  });

  test('aggregate saturation queues another peer and drains all accepted work', async () => {
    const [identity, remote] = await Promise.all([generateIdentity(), generateIdentity()]);
    const mesh = createRoomMesh({ roomId: 'r', identity });
    const env = await signEnvelope(buildEnvelope({ ch: 4, typ: 0, from: remote.did,
      body: {}, id: 'bounded', ts: 0 }), remote);
    const carriers = Array.from({ length: 5 }, (_, i) => {
      const c = channel(); mesh.addLink(c, `carrier-${i}`); return c;
    });
    let received = 0;
    const complete = new Promise<void>((resolve) => mesh.onEnvelope(() => {
      if (++received === 129) resolve();
    }));
    for (const c of carriers.slice(0, 4)) for (let i = 0; i < 32; i++) c.receive(env);
    carriers[4].receive(env);
    await complete;
    expect(received).toBe(129);
    expect(mesh.hasLink('carrier-4')).toBe(true);
    mesh.close();
  });

  test('verification overflow closes the transport without banning a DID or dispatching canceled work', async () => {
    const [identity, remote] = await Promise.all([generateIdentity(), generateIdentity()]);
    const mesh = createRoomMesh({ roomId: 'r', identity });
    const c = channel(); mesh.addLink(c, remote.did);
    const env = await signEnvelope(buildEnvelope({ ch: 3, typ: 1, from: remote.did,
      body: {}, id: 'overflow', ts: 0 }), remote);
    let received = 0;
    mesh.onEnvelope(() => { received++; });
    for (let i = 0; i < 65; i++) c.receive(env);
    expect(c.closed()).toBe(true);
    expect(mesh.hasLink(remote.did)).toBe(false);
    const replacement = channel();
    expect(mesh.addLink(replacement, remote.did)).toBe(true);
    await settle();
    expect(received).toBe(0);
    const complete = new Promise<void>((resolve) => mesh.onEnvelope(() => resolve()));
    replacement.receive(env);
    await complete;
    expect(received).toBe(1);
    mesh.close();
  });

  test('a permitted self-device surface can stream more than 256 signed chunks without cooldown', async () => {
    const [identity, remote] = await Promise.all([generateIdentity(), generateIdentity()]);
    const sender = createRoomMesh({ roomId: 'self', identity });
    const receiver = createRoomMesh({ roomId: 'self', identity: remote });
    const [a, b] = memoryPair();
    sender.addLink(a, remote.did); receiver.addLink(b, identity.did);
    let received = 0;
    const complete = new Promise<void>((resolve) => receiver.onEnvelope(() => {
      if (++received === 257) resolve();
    }));
    for (const data of iterateSyncChunks({ snapshotId: 'test', surface: 'memory',
      bytes: new Uint8Array(257 * SYNC_CHUNK_BYTES) })) {
      expect(sender.send(remote.did, await sender.sign(3, 1, { data }))).toBe(true);
    }
    await complete;
    expect(received).toBe(257);
    expect(receiver.hasLink(identity.did)).toBe(true);
    sender.close(); receiver.close();
  });

  test('a stalled channel consumer has a bounded backlog and releases it on close', () => {
    let closes = 0;
    const c = createBufferedChannel({ send: () => {}, close: () => { closes++; } });
    for (let i = 0; i < 17; i++) c.deliver({ i });
    expect(c.isClosed()).toBe(true);
    expect(closes).toBe(1);
    let delivered = 0;
    c.setHandler(() => { delivered++; });
    expect(delivered).toBe(0);
  });
});
