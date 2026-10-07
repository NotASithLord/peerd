import { expect, test } from 'bun:test';
import { createUserPeerPolicy, setUserPeerBlocked, USER_PEER_POLICY_KEY } from '../../extension/background/dweb-peer-policy.js';
import { MAX_USER_BANS } from '../../extension/shared/peer-policy.js';
import { createPeerPolicyView } from '../../extension/offscreen/peer-policy.js';
import { encodeDidKey } from '../../extension/shared/address/did.js';
const did = (n: number) => { const b = new Uint8Array(32); new DataView(b.buffer).setUint32(0, n); return encodeDidKey(b); };
const store = () => {
  let value: any = null; let fail = false;
  return { get: async () => structuredClone(value), set: async (_k: string, next: any) => { if (fail) throw new Error('disk'); value = structuredClone(next); },
    corrupt: (v: any) => { value = v; }, fail: () => { fail = true; } };
};
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

test('durable bans survive new owners, capacity never evicts a ban, and failed writes preserve state', async () => {
  const kv = store(); const policy = createUserPeerPolicy(kv);
  await policy.set(did(1), true);
  expect(await createUserPeerPolicy(kv).snapshot()).toEqual({ v: 1, revision: 1, blocked: [did(1)] });
  kv.fail(); await expect(policy.set(did(1), false)).rejects.toThrow('disk');
  expect((await policy.snapshot()).blocked).toEqual([did(1)]);
  const full = store(); full.corrupt({ v: 1, revision: 7, blocked: Array.from({ length: MAX_USER_BANS }, (_, i) => did(i)) });
  await expect(createUserPeerPolicy(full).set(did(MAX_USER_BANS), true)).rejects.toThrow('full');
  expect((await full.get()).blocked).toHaveLength(MAX_USER_BANS);
});

test('policy is canonical, corruption refuses access, revision projections never roll back', async () => {
  const kv = store(); const policy = createUserPeerPolicy(kv);
  await expect(policy.set('did:key:forged', true)).rejects.toThrow();
  kv.corrupt({ v: 1, revision: 2, blocked: [did(1), did(1)] });
  await expect(policy.snapshot()).rejects.toThrow('invalid-peer-policy');
  const view = createPeerPolicyView();
  expect(view.isBlocked(did(1))).toBe(true);
  view.apply({ v: 1, revision: 2, blocked: [did(1)] });
  view.apply({ v: 1, revision: 1, blocked: [] });
  expect(view.isBlocked(did(1))).toBe(true);
  expect(view.isBlocked(did(2))).toBe(false);
  expect(() => view.apply({ v: 1, revision: 3, blocked: ['bad'] })).toThrow();
  expect(view.isBlocked(did(2))).toBe(true);
});

test('ban enforcement is serialized through acknowledgment; newer unblock cannot overtake it', async () => {
  const kv = store(), entered = deferred(), release = deferred(); const policy = createUserPeerPolicy(kv);
  const ban = policy.set(did(1), true, async p => { entered.resolve(); await release.promise; return p; });
  await entered.promise;
  const unblock = policy.set(did(1), false);
  expect((await kv.get()).blocked).toEqual([did(1)]);
  release.resolve(); expect((await ban).revision).toBe(1);
  expect((await unblock).revision).toBe(2);
});

test('storage publication owns the policy ordering until commit; later bans fence later writes', async () => {
  const kv = store(), entered = deferred(), release = deferred(); const policy = createUserPeerPolicy(kv);
  let commits = 0;
  const write = policy.withPublisher(did(1), async () => { entered.resolve(); await release.promise; commits++; });
  await entered.promise;
  const ban = policy.set(did(1), true);
  release.resolve(); await write; await ban;
  await expect(policy.withPublisher(did(1), async () => { commits++; })).rejects.toThrow('publisher-user-blocked');
  expect(commits).toBe(1);
});

test('actual physical absence allows offline durable policy without send or acquisition', async () => {
  const kv = store(); let revoked = 0, sends = 0;
  const deps = { kv, vault: { isLocked: () => false }, revokePeer: async () => { revoked++; },
    browser: { runtime: { getContexts: async () => [], sendMessage: async () => { sends++; throw new Error('no host'); } } } };
  expect(await setUserPeerBlocked(deps, { did: did(1) })).toMatchObject({ ok: true, inactive: true, durable: true });
  expect(await setUserPeerBlocked(deps, { did: did(1), block: false })).toMatchObject({ ok: true, inactive: true });
  expect(revoked).toBe(1); expect(sends).toBe(0);
  expect((await kv.get()).blocked).toEqual([]);
});

test('missing/stale acknowledgment never reports enforcement success; durable receipt remains truthful', async () => {
  const kv = store();
  const deps = { kv, vault: { isLocked: () => false }, browser: { runtime: {
    getContexts: async () => [{ contextType: 'OFFSCREEN_DOCUMENT' }],
    sendMessage: async () => ({ ok: true, revision: 0 }),
  } } };
  expect(await setUserPeerBlocked(deps, { did: did(1) })).toMatchObject({ ok: false, durable: true, outcomeKnown: false });
  expect((await createUserPeerPolicy(kv).snapshot()).blocked).toEqual([did(1)]);
  expect(USER_PEER_POLICY_KEY).toBe('dweb.userPeerPolicy');
});

test('a queued unblock cannot spend authority after lock or generation retirement', async () => {
  const kv = store(), entered = deferred(), release = deferred();
  const { userPeerPolicy } = await import('../../extension/background/dweb-peer-policy.js');
  const owner = userPeerPolicy(kv); await owner.set(did(1), true);
  const held = owner.withPublisher(did(2), async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  let current = true;
  const deps = { kv, vault: { isLocked: () => !current }, current: () => current,
    browser: { runtime: { getContexts: async () => [], sendMessage: async () => { throw new Error('unexpected'); } } } };
  const unblock = setUserPeerBlocked(deps, { did: did(1), block: false });
  current = false; release.resolve(); await held;
  expect(await unblock).toMatchObject({ ok: false });
  expect((await owner.snapshot()).blocked).toEqual([did(1)]);
});

test('stalled storage retains a bounded number of queued policy owners', async () => {
  const gate = deferred(); let reads = 0;
  const policy = createUserPeerPolicy({ get: async () => { reads++; await gate.promise; return null; }, set: async () => {} });
  const pending = Array.from({ length: 32 }, () => policy.snapshot());
  await expect(policy.snapshot()).rejects.toThrow('peer-policy-busy');
  expect(reads).toBe(1);
  gate.resolve(); await Promise.all(pending);
  expect((await policy.snapshot()).revision).toBe(0);
});
