import { describe, test, expect } from 'bun:test';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import { createDhtNode } from '../../extension/peerd-distributed/dht/node.js';
import { createDhtStore } from '../../extension/peerd-distributed/dht/store.js';
import { nodeIdOf } from '../../extension/peerd-distributed/dht/distance.js';
import { itemWellFormed, signItem } from '../../extension/peerd-distributed/dht/records.js';

// D1: a malformed ch=1 DHT RPC from an authenticated neighbour must never throw
// out of node.handle() (it is awaited in a fire-and-forget onEnvelope callback,
// so a throw is an unhandled rejection AND black-holes the RESP). handle() must
// stay total — answer {t:'ERR'} — and reject no legitimate frame.

const makeNode = async () => {
  const identity = await generateIdentity();
  const selfId = await nodeIdOf(identity.did);
  const store = createDhtStore();
  const rpc = async () => { throw new Error('unreachable'); };
  return { identity, node: createDhtNode({ identity, selfId, store, rpc }) };
};

const NEIGHBOUR = 'did:key:zSomeAuthenticatedNeighbour';

describe('dht node.handle — total over malformed RPC (D1)', () => {
  test('FIND_NODE with absent / odd / non-hex / wrong-length / uppercase target → ERR, never throws', async () => {
    const { node } = await makeNode();
    for (const target of [undefined, 'a', 'zz', 'AB'.repeat(32), '00'.repeat(31), '00'.repeat(33)]) {
      expect(await node.handle(NEIGHBOUR, { t: 'FIND_NODE', target })).toEqual({ t: 'ERR', reason: 'bad-target' });
    }
  });

  test('FIND_VALUE / GET_PROVIDERS with a bad key → ERR, never throw', async () => {
    const { node } = await makeNode();
    for (const t of ['FIND_VALUE', 'GET_PROVIDERS']) {
      expect(await node.handle(NEIGHBOUR, { t, key: undefined })).toEqual({ t: 'ERR', reason: 'bad-key' });
      expect(await node.handle(NEIGHBOUR, { t, key: 'nothex' })).toEqual({ t: 'ERR', reason: 'bad-key' });
    }
  });

  test('a well-formed 64-hex key still serves normally (no false reject)', async () => {
    const { node } = await makeNode();
    expect((await node.handle(NEIGHBOUR, { t: 'FIND_NODE', target: '00'.repeat(32) })).t).toBe('NODES');
    expect(['VALUE', 'NODES']).toContain((await node.handle(NEIGHBOUR, { t: 'FIND_VALUE', key: 'ab'.repeat(32) })).t);
  });

  test('STORE with a non-did publisher is rejected (malformed), not thrown', async () => {
    const { node } = await makeNode();
    const r = await node.handle(NEIGHBOUR, { t: 'STORE', item: { publisher: 'x', seq: 0, sig: 'aaaa', value: 0 } });
    expect(r).toEqual({ t: 'STORED', ok: false, reason: 'malformed' });
  });

  test('a genuinely-signed item still stores (no false reject)', async () => {
    const { node, identity } = await makeNode();
    const item = await signItem({ value: { ok: 1 }, seq: 1 }, identity);
    const r = await node.handle(identity.did, { t: 'STORE', item });
    expect(r.t).toBe('STORED');
    expect((r as { ok?: boolean }).ok).toBe(true);
  });
});

describe('itemWellFormed — publisher must be a did:key (D1)', () => {
  test('rejects a non-did publisher', () => {
    expect(itemWellFormed({ publisher: 'x', seq: 0, sig: 'a' })).toBe(false);
    expect(itemWellFormed({ publisher: 'did:key:notvalid!!', seq: 0, sig: 'a' })).toBe(false);
  });

  test('accepts a real signed item', async () => {
    const identity = await generateIdentity();
    const item = await signItem({ value: { ok: 1 }, seq: 1 }, identity);
    expect(itemWellFormed(item)).toBe(true);
  });
});

describe('transport REQ backstop wiring (D1)', () => {
  test('onEnvelope REQ wraps node.handle so a throw becomes {t:ERR}, never an unhandled rejection', async () => {
    const src = await Bun.file('extension/peerd-distributed/dht/transport.js').text();
    expect(src).toContain("catch { resp = { t: 'ERR', reason: 'handler-error' }; }");
    const tryAt = src.indexOf('try { resp = await node.handle');
    const sendAt = src.indexOf('mesh.send(env.from, await mesh.sign(CH_DHT, RESP');
    expect(tryAt).toBeGreaterThan(-1);
    expect(sendAt).toBeGreaterThan(tryAt); // the RESP is sent after the guarded handle
  });
});
