import { expect, test } from 'bun:test';
import { createGossip } from '../../extension/peerd-distributed/gossip/topic.js';
import { createMemoryTopicStore, createTopicSync } from '../../extension/peerd-distributed/gossip/sync.js';
import { createSyncWork } from '../../extension/peerd-distributed/gossip/sync-work.js';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import { buildEnvelope, signEnvelope } from '../../extension/peerd-distributed/transport/envelope.js';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

const fixture = (verify?: (env: unknown) => Promise<boolean>) => {
  const listeners = new Set<(event: any) => unknown>();
  const gone = new Set<() => void>();
  let channel = {};
  const sent: any[] = [];
  const audits: string[] = [];
  const mesh = {
    peers: () => [{ did: 'neighbor', channel }],
    onEnvelope(cb: (event: any) => unknown) { listeners.add(cb); return () => listeners.delete(cb); },
    onPeer: () => () => {},
    onPeerGone(cb: () => void) { gone.add(cb); return () => gone.delete(cb); },
    sign: async (ch: number, typ: number, body: any) => ({ ch, typ, body }),
    send: async (_did: string, env: any) => { sent.push(env); },
    broadcast: async () => {},
  };
  const gossip = createGossip({ mesh });
  const store = createMemoryTopicStore();
  const sync = createTopicSync({ mesh, gossip, store, verify, audit: (type) => audits.push(type) });
  sync.retain('feed');
  return {
    gossip, store, sync, sent, audits,
    async emit(typ: number, body: any) {
      await Promise.all([...listeners].map((cb) => cb({ via: 'neighbor', env: { v: 1, ch: 4, typ, from: 'neighbor', body } })));
    },
    replace() { channel = {}; for (const cb of gone) cb(); },
    close() { sync.close(); gossip.close(); },
  };
};

test('sync validates bounded arrays and exact inner publication scope before verification', async () => {
  let checks = 0;
  const f = fixture(async () => { checks++; return true; });
  const inner = { v: 1, ch: 4, typ: 0, body: { topic: 'feed' } };
  for (const haves of [null, {}, new Array(513).fill('a'.repeat(86) + '=='), [17], ['short']]) {
    await f.emit(2, { topic: 'feed', haves });
  }
  for (const envs of [null, {}, new Array(257).fill(inner), [{ ...inner, ch: 0 }],
    [{ ...inner, typ: 3 }], [{ ...inner, v: 2 }], [{ ...inner, body: { topic: 'other' } }]]) {
    await f.emit(3, { topic: 'feed', envs });
  }
  expect(checks).toBe(0);
  expect(f.audits.filter((type) => type === 'sync_request_invalid')).toHaveLength(5);
  expect(f.audits.filter((type) => type === 'sync_response_invalid')).toHaveLength(7);
  expect(f.store.list('feed')).toEqual([]);
  f.close();
});

test('valid signatures on unrelated topics and control frames never become retained history', async () => {
  const f = fixture();
  const identity = await generateIdentity();
  const signed = async (ch: number, typ: number, topic: string) => signEnvelope(buildEnvelope({
    ch, typ, from: identity.did, id: `${ch}:${typ}:${topic}`, ts: 1, body: { topic, data: 'entry' },
  }), identity);
  const delivered: any[] = [];
  f.gossip.subscribe('other', (msg) => delivered.push(msg));
  await f.emit(3, { topic: 'feed', envs: [await signed(4, 0, 'other')] });
  await f.emit(3, { topic: 'feed', envs: [await signed(0, 2, 'feed')] });
  expect(delivered).toEqual([]);
  expect(f.store.list('feed')).toEqual([]);
  await f.emit(3, { topic: 'feed', envs: [await signed(4, 0, 'feed')] });
  expect(f.store.list('feed')).toHaveLength(1);
  f.close();
});

for (const retirement of ['close', 'replace'] as const) {
  test(`sync ${retirement} fences results of already-running inner verification`, async () => {
    const entered = deferred<void>();
    const gate = deferred<boolean>();
    const f = fixture(async () => { entered.resolve(); return gate.promise; });
    const pending = f.emit(3, { topic: 'feed', envs: [{
      v: 1, ch: 4, typ: 0, from: 'author', id: 'one', ts: 1, sig: 'signature', body: { topic: 'feed', data: 1 },
    }] });
    await entered.promise;
    if (retirement === 'close') f.sync.close(); else f.replace();
    gate.resolve(true);
    await pending;
    expect(f.store.list('feed')).toEqual([]);
    f.close();
  });
}

for (const mutation of ['close', 'replace', 'mute'] as const) {
  test(`subscriber ${mutation} during backfill delivery prevents tap retention`, async () => {
    const f = fixture();
    const identity = await generateIdentity();
    const inner = await signEnvelope(buildEnvelope({
      ch: 4, typ: 0, from: identity.did, id: mutation, ts: 1, body: { topic: 'feed', data: 'entry' },
    }), identity);
    let delivered = 0;
    f.gossip.subscribe('feed', () => {
      delivered++;
      if (mutation === 'close') f.sync.close();
      else if (mutation === 'replace') f.replace();
      else f.gossip.mute(identity.did);
    });
    await f.emit(3, { topic: 'feed', envs: [inner] });
    expect(delivered).toBe(1);
    expect(f.store.list('feed')).toEqual([]);
    f.close();
  });
}

test('sync work bounds active and pending owners, preserves slots through close, and releases queued work', async () => {
  const work = createSyncWork();
  const gate = deferred<void>();
  let started = 0;
  const owner = {};
  const jobs: Promise<void>[] = [];
  for (let i = 0; i < 16; i++) jobs.push(work.run(owner, () => true, async () => { started++; await gate.promise; })!);
  expect(work.run(owner, () => true, async () => {})).toBeNull();
  for (let i = 0; i < 48; i++) jobs.push(work.run({}, () => true, async () => { started++; await gate.promise; })!);
  expect(work.run({}, () => true, async () => {})).toBeNull();
  await Promise.resolve();
  expect(started).toBe(8);
  work.close();
  expect(work.run({}, () => true, async () => {})).toBeNull();
  gate.resolve();
  await Promise.all(jobs);
  expect(started).toBe(8);
});

test('retiring an owner cancels its queue without freeing active work prematurely', async () => {
  const work = createSyncWork();
  const gate = deferred<void>();
  let live = true;
  let started = 0;
  const owner = {};
  const jobs = Array.from({ length: 16 }, () => work.run(owner, () => live, async () => { started++; await gate.promise; })!);
  await Promise.resolve();
  expect(started).toBe(2);
  live = false;
  work.retire();
  await Promise.all(jobs.slice(2));
  expect(started).toBe(2);
  gate.resolve();
  await Promise.all(jobs);
  const next = work.run(owner, () => true, async () => { started++; });
  await next;
  expect(started).toBe(3);
  work.close();
});
