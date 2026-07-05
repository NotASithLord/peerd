// The mesh-op dispatcher + ask/reply correlation over the mesh. Injected IO, so
// the request/response protocol (tag → await matching reply → timeout), the
// first-contact signing gate, and inbound routing are provable without a mesh.

import { describe, test, expect } from 'bun:test';
import { makeMeshDispatch, isA2AEnvelope } from '../../extension/peerd-runtime/subagent/a2a-dispatch.js';

const DID = 'did:key:z6MkBob';
const tick = () => new Promise((r) => setTimeout(r, 0));

const harness = (over: any = {}) => {
  const sent: any[] = [];
  const deps = {
    sendDm: async (to: string, env: any) => { sent.push({ to, env }); return { ok: true, id: 'm1' }; },
    listPeers: async () => [{ did: DID, name: 'Bob' }, { did: 'did:key:z6MkAda', name: 'Ada' }],
    fetchCard: async (did: string) => (did === DID ? { name: 'Bob', skills: [] } : null),
    publishCard: async () => ({ ok: true, did: 'did:key:z6MkMe' }),
    newReqId: (() => { let n = 0; return () => `r${(n += 1)}`; })(),
    ...over,
  };
  return { ...makeMeshDispatch(deps), sent };
};

describe('reads — peers / card / inbox', () => {
  test('peers returns the roster; card fetches by did; unknown did → null', async () => {
    const d = harness();
    expect(await d.dispatch('peers', {})).toEqual({ ok: true, peers: [{ did: DID, name: 'Bob' }, { did: 'did:key:z6MkAda', name: 'Ada' }] });
    expect((await d.dispatch('card', { did: DID })).card).toEqual({ name: 'Bob', skills: [] });
    expect((await d.dispatch('card', { did: 'did:key:z6MkNobody' })).card).toBe(null);
  });
});

describe('the first-contact signing gate', () => {
  test('a signing op to an un-cleared did is refused; a cleared one passes', async () => {
    const d = harness();
    const refused = await d.dispatch('send', { did: DID, message: 'hi' }, { signs: true, allowed: () => false });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('first contact');
    expect(d.sent.length).toBe(0);
    const ok = await d.dispatch('send', { did: DID, message: 'hi' }, { signs: true, allowed: () => true });
    expect(ok.ok).toBe(true);
    expect(d.sent[0].env).toMatchObject({ __a2a: 1, kind: 'tell', message: 'hi' });
  });
  test('a signing op fails CLOSED when no allowed fn is provided', async () => {
    const d = harness();
    const r = await d.dispatch('send', { did: DID, message: 'x' }, { signs: true });
    expect(r.ok).toBe(false);
  });
});

describe('ask / reply correlation', () => {
  test('ask sends a tagged request and resolves when the matching reply lands', async () => {
    const d = harness();
    const p = d.dispatch('ask', { did: DID, message: 'free Tuesday?', timeoutMs: 5000 }, { signs: true, allowed: () => true });
    await tick();
    expect(d.sent[0].env).toMatchObject({ __a2a: 1, kind: 'ask', reqId: 'r1', message: 'free Tuesday?' });
    expect(d._pendingCount()).toBe(1);
    // the peer replies with the same reqId
    const routed = d.handleInbound(DID, { __a2a: 1, kind: 'reply', reqId: 'r1', message: 'yes, 2pm' });
    expect(routed.consumed).toBe(true);            // a reply is plumbing, never a wake
    expect(await p).toEqual({ ok: true, from: DID, reply: 'yes, 2pm' });
    expect(d._pendingCount()).toBe(0);
  });

  test('a reply from a DIFFERENT did than the ask targeted does NOT resolve it (forgery protection)', async () => {
    const d = harness();
    const p = d.dispatch('ask', { did: DID, message: 'free Tuesday?', timeoutMs: 40 }, { signs: true, allowed: () => true });
    await tick();
    expect(d._pendingCount()).toBe(1);
    // a THIRD peer guesses the reqId and injects a forged reply — dropped, but
    // still consumed (a reply-kind envelope is never a wake), and the ask stays
    // pending until the real peer answers or it times out.
    const routed = d.handleInbound('did:key:z6MkAttacker', { __a2a: 1, kind: 'reply', reqId: 'r1', message: 'forged' });
    expect(routed.consumed).toBe(true);
    expect(d._pendingCount()).toBe(1);
    // the genuine peer's reply (matching did) still resolves it
    d.handleInbound(DID, { __a2a: 1, kind: 'reply', reqId: 'r1', message: 'yes, 2pm' });
    expect(await p).toEqual({ ok: true, from: DID, reply: 'yes, 2pm' });
  });

  test('ask times out to { timedOut:true } when no reply arrives', async () => {
    const d = harness();
    const r = await d.dispatch('ask', { did: DID, message: 'x', timeoutMs: 5 }, { signs: true, allowed: () => true });
    expect(r).toEqual({ ok: true, from: null, reply: null, timedOut: true });
    expect(d._pendingCount()).toBe(0);
  });

  test('ask refuses (no pending) when the peer is unreachable', async () => {
    const d = harness({ sendDm: async () => ({ ok: false, error: 'no direct link to did' }) });
    const r = await d.dispatch('ask', { did: DID, message: 'x' }, { signs: true, allowed: () => true });
    expect(r.ok).toBe(false);
    expect(d._pendingCount()).toBe(0);
  });
});

describe('inbound routing', () => {
  test('an ask/tell is NOT consumed and is delivered for the actor wake + buffered for inbox()', async () => {
    const d = harness();
    const routed = d.handleInbound(DID, { __a2a: 1, kind: 'ask', reqId: 'q1', message: 'can you help?' });
    expect(routed.consumed).toBe(false);
    expect(routed.deliver).toMatchObject({ from: DID, kind: 'ask', reqId: 'q1', message: 'can you help?' });
    const drained = await d.dispatch('inbox', {});
    expect(drained.messages).toEqual([{ from: DID, message: 'can you help?', ts: expect.any(Number) }]);
    // drained once — a second inbox() is empty
    expect((await d.dispatch('inbox', {})).messages).toEqual([]);
  });

  test('inboxBuffer is bounded — a flooding peer cannot grow it without limit (oldest evicted)', async () => {
    const d = harness();
    for (let i = 0; i < 250; i += 1) d.handleInbound(DID, { __a2a: 1, kind: 'tell', reqId: `q${i}`, message: `m${i}` });
    const drained = await d.dispatch('inbox', {});
    expect(drained.messages.length).toBe(200);            // capped at MAX_INBOX
    expect(drained.messages[0].message).toBe('m50');      // the oldest 50 were evicted
    expect(drained.messages[199].message).toBe('m249');
  });

  test('a non-a2a DM is passed through untouched (the dweb bridge path is unaffected)', () => {
    const d = harness();
    expect(d.handleInbound(DID, { some: 'other proto' })).toEqual({ consumed: false });
    expect(d.handleInbound(DID, 'plain string')).toEqual({ consumed: false });
  });

  test('reply() sends a reply-tagged envelope back to the asker', async () => {
    const d = harness();
    await d.reply(DID, 'q1', 'sure, here you go');
    expect(d.sent[0]).toEqual({ to: DID, env: { __a2a: 1, kind: 'reply', reqId: 'q1', message: 'sure, here you go' } });
  });
});

describe('isA2AEnvelope', () => {
  test('recognizes the wire tag, rejects everything else', () => {
    expect(isA2AEnvelope({ __a2a: 1, kind: 'ask', reqId: 'r', message: 'm' })).toBe(true);
    expect(isA2AEnvelope({ kind: 'ask', reqId: 'r' })).toBe(false);
    expect(isA2AEnvelope(null)).toBe(false);
    expect(isA2AEnvelope('x')).toBe(false);
  });
});
