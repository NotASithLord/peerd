import { describe, test, expect } from 'bun:test';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import {
  nodeIdOf, keyOf, xor, compareBytes, closerTo, bucketIndex, byDistanceTo,
} from '../../extension/peerd-distributed/dht/distance.js';
import { createRoutingTable } from '../../extension/peerd-distributed/dht/routing-table.js';
import { signItem, verifyItem, itemKey, mutableKey, MAX_ITEM_BYTES } from '../../extension/peerd-distributed/dht/records.js';
import { createDhtStore } from '../../extension/peerd-distributed/dht/store.js';
import { toHex } from '../../extension/shared/bundle/bytes.js';

const id = (...bytes: number[]) => { const a = new Uint8Array(32); a.set(bytes); return a; };
const contact = (did: string, idBytes: Uint8Array) => ({ did, id: idBytes });

describe('dht/distance', () => {
  test('nodeIdOf is a stable 32-byte hash of the pubkey', async () => {
    const me = await generateIdentity();
    const a = await nodeIdOf(me.did);
    const b = await nodeIdOf(me.did);
    expect(a).toHaveLength(32);
    expect(toHex(a)).toBe(toHex(b));
  });

  test('xor / compare / closerTo', () => {
    expect([...xor(id(0xff), id(0x0f))]).toEqual([...id(0xf0)]);
    expect(compareBytes(id(1), id(2))).toBe(-1);
    expect(compareBytes(id(2), id(2))).toBe(0);
    // target 0x00…: id(1) is closer than id(2)
    expect(closerTo(id(0), id(1), id(2))).toBe(-1);
  });

  test('bucketIndex = shared-prefix length with self', () => {
    const self = id(); // all zeros
    expect(bucketIndex(self, id(0x80))).toBe(0);   // differ at bit 0
    expect(bucketIndex(self, id(0x01))).toBe(7);   // differ at bit 7
    const lastBit = new Uint8Array(32); lastBit[31] = 0x01;
    expect(bucketIndex(self, lastBit)).toBe(255);  // share 255 bits
  });

  test('byDistanceTo sorts nearest-first', () => {
    const target = id(0);
    const sorted = byDistanceTo(target, [contact('c', id(8)), contact('a', id(1)), contact('b', id(4))]);
    expect(sorted.map((c) => c.did)).toEqual(['a', 'b', 'c']);
  });
});

describe('dht/routing-table', () => {
  test('seen inserts, refreshes to MRU, and reports a full bucket', () => {
    const rt = createRoutingTable({ selfId: id(), k: 2 });
    // three contacts that all share bucket 0 (top bit set → differ at bit 0)
    const c1 = contact('c1', id(0x80, 0x01));
    const c2 = contact('c2', id(0x80, 0x02));
    const c3 = contact('c3', id(0x80, 0x03));
    expect(rt.seen(c1).added).toBe(true);
    expect(rt.seen(c2).added).toBe(true);
    const full = rt.seen(c3);
    expect(full.added).toBe(false);
    expect(full.evictCandidate?.did).toBe('c1'); // LRS incumbent
    // re-seeing c1 bumps it to MRU; now c2 is the LRS
    rt.seen(c1);
    expect(rt.seen(c3).evictCandidate?.did).toBe('c2');
  });

  test('replace swaps a dead incumbent', () => {
    const rt = createRoutingTable({ selfId: id(), k: 1 });
    rt.seen(contact('dead', id(0x80, 0x01)));
    expect(rt.replace('dead', contact('fresh', id(0x80, 0x02)))).toBe(true);
    expect(rt.has('dead')).toBe(false);
    expect(rt.has('fresh')).toBe(true);
  });

  test('closest returns the k nearest across buckets', () => {
    const rt = createRoutingTable({ selfId: id(), k: 8 });
    for (const n of [1, 2, 4, 8, 16]) rt.seen(contact(`c${n}`, id(n)));
    const near = rt.closest(id(0), 3);
    expect(near.map((c) => c.did)).toEqual(['c1', 'c2', 'c4']);
  });
});

describe('dht/records', () => {
  test('sign → verify roundtrip; tamper fails', async () => {
    const me = await generateIdentity();
    const item = await signItem({ value: { dwapp: 'commons', v: 3 }, seq: 1 }, me);
    expect(await verifyItem(item)).toBe(true);
    expect(await verifyItem({ ...item, value: { dwapp: 'evil' } })).toBe(false);
    expect(await verifyItem({ ...item, seq: 99 })).toBe(false);
  });

  test('itemKey == mutableKey(pubkey, salt) and salt separates pointers', async () => {
    const me = await generateIdentity();
    const a = await signItem({ value: 1, seq: 1, salt: 'app-a' }, me);
    const b = await signItem({ value: 2, seq: 1, salt: 'app-b' }, me);
    expect(toHex(await itemKey(a))).not.toBe(toHex(await itemKey(b)));
  });

  test('oversize value is rejected', async () => {
    const me = await generateIdentity();
    const big = await signItem({ value: 'x'.repeat(MAX_ITEM_BYTES + 10), seq: 1 }, me);
    expect(await verifyItem(big)).toBe(false);
  });
});

describe('dht/store', () => {
  test('accepts a valid PUT, serves it by derived key, rejects downgrade + forgery', async () => {
    const me = await generateIdentity();
    const store = createDhtStore();
    const v1 = await signItem({ value: { n: 1 }, seq: 1 }, me);
    expect((await store.put(v1)).ok).toBe(true);

    const key = toHex(await itemKey(v1));
    expect(store.get(key).value).toEqual({ n: 1 });

    const v2 = await signItem({ value: { n: 2 }, seq: 2 }, me);
    expect((await store.put(v2)).ok).toBe(true);
    expect(store.get(key).value).toEqual({ n: 2 }); // upgraded

    // a stale replay (seq 1) must NOT downgrade the key
    expect((await store.put(v1)).reason).toBe('seq-downgrade');
    expect(store.get(key).value).toEqual({ n: 2 });

    // a forged signature is refused
    const forged = { ...v2, sig: v1.sig };
    expect((await store.put(forged)).ok).toBe(false);
  });

  test('expired items are not served', async () => {
    const me = await generateIdentity();
    let clock = 1000;
    const store = createDhtStore({ now: () => clock });
    const item = await signItem({ value: 'x', seq: 1 }, me);
    await store.put(item);
    const key = toHex(await itemKey(item));
    expect(store.get(key)).not.toBeNull();
    clock += 2 * 60 * 60 * 1000; // +2h, past the 1h TTL
    expect(store.get(key)).toBeNull();
  });
});
