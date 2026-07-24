// The heap-split SW-side client: the Stop-cascade `aborted` stamping (so an aborted
// offscreen turn renders 'cancelled', not a blank 'ok') and the security-critical
// 'actor/tool-dispatch' route (SW-side pin + gate + the web actor's owned-tab thread).
import { describe, test, expect } from 'bun:test';
import { makeOffscreenActorClient } from '../../extension/background/offscreen-actor-client.js';

const baseDeps = (over: any = {}) => ({
  ensureOffscreen: async () => {},
  sendMessage: async () => ({ ok: true }),
  callModel: (async function* () {})(),
  getSecret: async () => 'sk',
  safeFetch: async () => new Response('x'),
  sessions: { get: async () => null },
  buildToolContext: async () => ({}),
  dispatchToolCall: async () => ({ ok: true }),
  pinActorCall: () => {},
  EXPOSURE_ACTOR: 'actor',
  ...over,
});

describe('run() — Stop-cascade aborted stamping', () => {
  test('stamps aborted when the signal fired and the turn produced NO reply', async () => {
    // The worker can unwind an abort CLEANLY (empty reply, no error) → looks ok at the
    // result shape. signal.aborted here is the authoritative proof a Stop hit this run.
    const client = makeOffscreenActorClient(baseDeps({
      sendMessage: async (m: any) => (m.type === 'actor/run' ? { ok: true, started: true, finalText: '' } : { ok: true }),
    }));
    const ac = new AbortController();
    ac.abort();
    const r = await client.run({ actorSessionId: 'a', message: 'm', systemPrompt: 's', provider: 'anthropic', model: 'm' } as any, { signal: ac.signal });
    expect(r.aborted).toBe(true);
  });

  test('does NOT stamp aborted when the turn produced text just before Stop (raced)', async () => {
    const client = makeOffscreenActorClient(baseDeps({
      sendMessage: async (m: any) => (m.type === 'actor/run' ? { ok: true, started: true, finalText: 'a real reply' } : { ok: true }),
    }));
    const ac = new AbortController();
    ac.abort();
    const r = await client.run({ actorSessionId: 'a', message: 'm', systemPrompt: 's', provider: 'anthropic', model: 'm' } as any, { signal: ac.signal });
    expect(r.aborted).toBeUndefined();
    expect(r.finalText).toBe('a real reply');
  });

  test('no signal → never stamps aborted', async () => {
    const client = makeOffscreenActorClient(baseDeps({
      sendMessage: async (m: any) => (m.type === 'actor/run' ? { ok: true, started: true, finalText: '' } : { ok: true }),
    }));
    const r = await client.run({ actorSessionId: 'a', message: 'm', systemPrompt: 's', provider: 'anthropic', model: 'm' } as any);
    expect(r.aborted).toBeUndefined();
  });
});

describe("routes['actor/tool-dispatch'] — SW-side pin + gate + owned-tab thread", () => {
  test('a WEB (tab) actor threads its owned tab into buildToolContext + re-pins', async () => {
    let ctxOpts: any = null;
    let pinned: any = null;
    const client = makeOffscreenActorClient(baseDeps({
      sessions: { get: async () => ({ kind: 'actor', actorType: 'web', backing: undefined, instanceId: 'web' }) },
      ownedTabFor: () => 42,
      buildToolContext: async (o: any) => { ctxOpts = o; return { ctx: true }; },
      pinActorCall: (call: any, at: string, id: string) => { pinned = { call, at, id }; },
      dispatchToolCall: async () => ({ ok: true, content: 'snapshot' }),
    }));
    const out = await client.routes['actor/tool-dispatch']({ actorSessionId: 's1', call: { name: 'snapshot', args: {} } });
    expect(out).toEqual({ ok: true, result: { ok: true, content: 'snapshot' } });
    expect(ctxOpts.activeTabId).toBe(42);           // the owned tab reached the ctx
    expect(ctxOpts.actorType).toBe('web');
    expect(pinned.id).toBe('web');                  // re-pinned to the bound instance
  });

  test('an API actor (backing api) gets NO tab (fetch-only, no DOM)', async () => {
    let ctxOpts: any = null;
    const client = makeOffscreenActorClient(baseDeps({
      sessions: { get: async () => ({ kind: 'actor', actorType: 'web', backing: 'api', instanceId: 'https://api.example.com' }) },
      ownedTabFor: () => 42,   // even if a tab existed, an API actor must not receive it
      buildToolContext: async (o: any) => { ctxOpts = o; return {}; },
      dispatchToolCall: async () => ({ ok: true }),
    }));
    await client.routes['actor/tool-dispatch']({ actorSessionId: 's1', call: { name: 'fetch_url', args: {} } });
    expect(ctxOpts.activeTabId).toBeUndefined();
  });

  test('an ENGINE actor gets no tab; refuses a non-actor/non-actor session', async () => {
    let ctxOpts: any = null;
    const client = makeOffscreenActorClient(baseDeps({
      sessions: { get: async (id: string) => (id === 'engine' ? { kind: 'actor', actorType: 'webvm', instanceId: 'vm-1' } : { kind: 'chat' }) },
      ownedTabFor: () => 99,
      buildToolContext: async (o: any) => { ctxOpts = o; return {}; },
      dispatchToolCall: async () => ({ ok: true }),
    }));
    await client.routes['actor/tool-dispatch']({ actorSessionId: 'engine', call: { name: 'vm_boot', args: {} } });
    expect(ctxOpts.activeTabId).toBeUndefined();     // engine acts on its instance, not a tab
    const refused = await client.routes['actor/tool-dispatch']({ actorSessionId: 'chatSession', call: { name: 'x', args: {} } });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('not an actor or actor session');
  });
});

describe("routes['actor/tool-dispatch'] — ACTOR (phase 4): narrowed-general ctx from grantedTools", () => {
  const subDeps = (over: any = {}) => baseDeps({
    sessions: { get: async () => ({ kind: 'spawned', parentSessionId: 'p1', depth: 1, grantedTools: ['script', 'read_memory'] }) },
    restrictCtxCapabilities: (ctx: any, allowed: Set<string>) => ({ ...ctx, _restrictedTo: [...allowed] }),
    buildToolContext: async (o: any) => ({ built: o, audit: async () => {} }),
    dispatchToolCall: async (call: any, ctx: any) => ({ ok: true, ran: call.name, restrictedTo: ctx._restrictedTo }),
    ...over,
  });

  test('a GRANTED tool builds the restricted ctx (from grantedTools) and dispatches', async () => {
    const client = makeOffscreenActorClient(subDeps());
    const out: any = await client.routes['actor/tool-dispatch']({ actorSessionId: 's1', call: { name: 'script', args: { code: 'x' } } });
    expect(out.ok).toBe(true);
    expect(out.result.ran).toBe('script');
    // the ctx was restricted to exactly the persisted granted set (never the worker's word)
    expect(out.result.restrictedTo.sort()).toEqual(['read_memory', 'script']);
  });

  // #160: the review exemption must fire on the LIVE relay path — the gate tests
  // hand-build {exposure} ctxs, which is how the "stamped only on the in-SW
  // fallback" regression stayed invisible. These pin the relay's own logic:
  // given a record with review:true it stamps, otherwise it doesn't. The OTHER
  // half — that create() actually persists review so a real record carries it —
  // is pinned in sessions/custom-system-prompt.test.ts (a real create→get
  // round-trip); the two together close the gap, since a mocked get here can't
  // prove the store keeps the field.
  test('a REVIEW child re-stamps exposure from the PERSISTED record', async () => {
    let seenCtx: any = null;
    const client = makeOffscreenActorClient(subDeps({
      sessions: { get: async () => ({ kind: 'spawned', parentSessionId: 'p1', depth: 1, grantedTools: ['js_read_file'], review: true }) },
      dispatchToolCall: async (_call: any, ctx: any) => { seenCtx = ctx; return { ok: true }; },
      EXPOSURE_REVIEW: 'review',
    }));
    const out: any = await client.routes['actor/tool-dispatch']({ actorSessionId: 's1', call: { name: 'js_read_file', args: {} } });
    expect(out.ok).toBe(true);
    expect(seenCtx.exposure).toBe('review');
  });

  test('a NON-review spawned child gets NO exposure from the relay (fail-closed)', async () => {
    let seenCtx: any = null;
    const client = makeOffscreenActorClient(subDeps({
      dispatchToolCall: async (_call: any, ctx: any) => { seenCtx = ctx; return { ok: true }; },
      EXPOSURE_REVIEW: 'review',
    }));
    await client.routes['actor/tool-dispatch']({ actorSessionId: 's1', call: { name: 'script', args: {} } });
    expect(seenCtx.exposure).toBeUndefined();
  });

  test('a truthy-but-not-true review field stamps nothing (strict boolean, like the record write)', async () => {
    let seenCtx: any = null;
    const client = makeOffscreenActorClient(subDeps({
      sessions: { get: async () => ({ kind: 'spawned', parentSessionId: 'p1', depth: 1, grantedTools: ['script'], review: 'yes' }) },
      dispatchToolCall: async (_call: any, ctx: any) => { seenCtx = ctx; return { ok: true }; },
      EXPOSURE_REVIEW: 'review',
    }));
    await client.routes['actor/tool-dispatch']({ actorSessionId: 's1', call: { name: 'script', args: {} } });
    expect(seenCtx.exposure).toBeUndefined();
  });

  test('an UNGRANTED tool the worker asks for is REFUSED before any dispatch (never trust the worker)', async () => {
    let dispatched = false;
    const client = makeOffscreenActorClient(subDeps({ dispatchToolCall: async () => { dispatched = true; return { ok: true }; } }));
    const out: any = await client.routes['actor/tool-dispatch']({ actorSessionId: 's1', call: { name: 'actor_create', args: {} } });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('tool_not_available_to_actor');
    expect(dispatched).toBe(false);
  });

  test('an actor tool-dispatch needs restrictCtxCapabilities wired (fails closed without it)', async () => {
    const client = makeOffscreenActorClient(subDeps({ restrictCtxCapabilities: undefined }));
    const out: any = await client.routes['actor/tool-dispatch']({ actorSessionId: 's1', call: { name: 'script', args: {} } });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('not wired');
  });
});
