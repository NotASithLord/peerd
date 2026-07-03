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

  test('an ENGINE actor gets no tab; refuses a non-actor session', async () => {
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
    expect(refused.error).toContain('not an actor session');
  });
});
