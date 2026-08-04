// The heap-split SW-side client: the Stop-cascade `aborted` stamping (so an aborted
// offscreen turn renders 'cancelled', not a blank 'ok') and the security-critical
// 'actor/tool-dispatch' route (SW-side pin + gate + the web actor's owned-tab thread).
import { describe, test, expect } from 'bun:test';
import { makeOffscreenActorClient } from '../../extension/background/offscreen-actor-client.js';

// Stand-ins for the two senders that matter. The relay routes must accept only the
// first: `runtime.sendMessage` from the SW broadcasts to EVERY extension context, so
// the grant token is visible to the side panel and to the three engine tab pages that
// host agent-authored content — which makes the sender check, not the token, the
// actual boundary.
const OFFSCREEN = { id: 'ext', url: 'chrome-extension://ext/offscreen/offscreen.html' };
const ENGINE_TAB = { id: 'ext', url: 'chrome-extension://ext/engine-tabs/vm-tab/vm-tab.html' };

const baseDeps = (over: any = {}) => ({
  ensureOffscreen: async () => {},
  isOffscreenSender: (s: any) => s?.url === OFFSCREEN.url,
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

/**
 * Build a client plus a `during` helper that invokes a relay route with a LIVE
 * grant token, from inside the run the token was minted for — which is the only
 * window in which the token is valid, and exactly how the offscreen runner
 * relays in production. Every route test goes through this: calling a route with
 * a hand-written session id is precisely the forgery the grant now refuses.
 */
const clientWithRelay = (over: any = {}) => {
  let relay: ((token: string) => Promise<any>) | null = null;
  let captured: any = null;
  const client = makeOffscreenActorClient(baseDeps({
    ...over,
    // Last, so it wins over any baseDeps-derived `over` (subDeps is a full
    // baseDeps result): this IS the relay window the helper exists to open.
    sendMessage: async (m: any) => {
      if (m.type === 'actor/run' && relay) captured = await relay(m.job.relayToken);
      return { ok: true, started: true, finalText: '' };
    },
  }));
  return {
    client,
    during: async (fn: (token: string) => Promise<any>, actorSessionId = 's1', onEvent?: (ev: any) => void) => {
      relay = fn;
      await client.run(
        { actorSessionId, message: 'm', systemPrompt: 's', provider: 'anthropic', model: 'm' } as any,
        onEvent ? { onEvent } : undefined,
      );
      return captured;
    },
  };
};

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
    const { client, during } = clientWithRelay({
      sessions: { get: async () => ({ kind: 'actor', actorType: 'web', backing: undefined, instanceId: 'web' }) },
      ownedTabFor: () => 42,
      buildToolContext: async (o: any) => { ctxOpts = o; return { ctx: true }; },
      pinActorCall: (call: any, at: string, id: string) => { pinned = { call, at, id }; },
      dispatchToolCall: async () => ({ ok: true, content: 'snapshot' }),
    });
    const out = await during((relayToken) => client.routes['actor/tool-dispatch']({ relayToken, call: { name: 'snapshot', args: {} } }, OFFSCREEN));
    expect(out).toEqual({ ok: true, result: { ok: true, content: 'snapshot' } });
    expect(ctxOpts.activeTabId).toBe(42);           // the owned tab reached the ctx
    expect(ctxOpts.actorType).toBe('web');
    expect(pinned.id).toBe('web');                  // re-pinned to the bound instance
  });

  test('an API actor (backing api) gets NO tab (fetch-only, no DOM)', async () => {
    let ctxOpts: any = null;
    const { client, during } = clientWithRelay({
      sessions: { get: async () => ({ kind: 'actor', actorType: 'web', backing: 'api', instanceId: 'https://api.example.com' }) },
      ownedTabFor: () => 42,   // even if a tab existed, an API actor must not receive it
      buildToolContext: async (o: any) => { ctxOpts = o; return {}; },
      dispatchToolCall: async () => ({ ok: true }),
    });
    await during((relayToken) => client.routes['actor/tool-dispatch']({ relayToken, call: { name: 'fetch_url', args: {} } }, OFFSCREEN));
    expect(ctxOpts.activeTabId).toBeUndefined();
  });

  test('an ENGINE actor gets no tab; refuses a non-actor/non-actor session', async () => {
    let ctxOpts: any = null;
    const { client, during } = clientWithRelay({
      sessions: { get: async (id: string) => (id === 'engine' ? { kind: 'actor', actorType: 'webvm', instanceId: 'vm-1' } : { kind: 'chat' }) },
      ownedTabFor: () => 99,
      buildToolContext: async (o: any) => { ctxOpts = o; return {}; },
      dispatchToolCall: async () => ({ ok: true }),
    });
    await during((relayToken) => client.routes['actor/tool-dispatch']({ relayToken, call: { name: 'vm_boot', args: {} } }, OFFSCREEN), 'engine');
    expect(ctxOpts.activeTabId).toBeUndefined();     // engine acts on its instance, not a tab
    // The grant now decides WHICH session is dispatched against, so a chat-session
    // grant reaches the kind check and is refused there.
    const refused = await during((relayToken) => client.routes['actor/tool-dispatch']({ relayToken, call: { name: 'x', args: {} } }, OFFSCREEN), 'chatSession');
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('not an actor or actor session');
  });
});

// The relay grant (P0-2): identity comes from a per-run token minted SW-side, not
// from the message. why it matters: these routes ride the one runtime.onMessage
// surface whose only guard is "some first-party extension context" — which is every
// engine tab page and the side panel. Before the grant, any of them could dispatch a
// tool as an arbitrary actor session (inheriting its instance pin and granted tools)
// or spend the user's key on a dead run just by naming it in the payload.
describe('relay grant — routes refuse anything without a live token', () => {
  const dispatchDeps = {
    sessions: { get: async () => ({ kind: 'actor', actorType: 'webvm', instanceId: 'vm-1' }) },
    buildToolContext: async () => ({}),
    dispatchToolCall: async () => ({ ok: true, content: 'ran' }),
  };

  test('tool-dispatch with a FORGED session id and no token is refused', async () => {
    let dispatched = false;
    const client = makeOffscreenActorClient(baseDeps({
      ...dispatchDeps,
      dispatchToolCall: async () => { dispatched = true; return { ok: true }; },
    }));
    const out: any = await client.routes['actor/tool-dispatch']({ actorSessionId: 'victim-actor', call: { name: 'vm_exec', args: {} } } as any, OFFSCREEN);
    expect(out.ok).toBe(false);
    expect(out.error).toContain('unauthorized relay');
    expect(dispatched).toBe(false);   // refused BEFORE any ctx build or dispatch
  });

  test('model-call without a token never reaches the key-bearing provider call', async () => {
    let called = false;
    const client = makeOffscreenActorClient(baseDeps({
      callModel: async function* () { called = true; yield { type: 'text', text: 'x' }; },
    }));
    const out: any = await client.routes['actor/model-call']({ runId: 'aw-guess', args: {} } as any, OFFSCREEN);
    expect(out.ok).toBe(false);
    expect(out.error).toContain('unauthorized relay');
    expect(called).toBe(false);
  });

  test('a token is RETIRED when its run settles — a replayed relay is refused', async () => {
    let leaked = '';
    const { client, during } = clientWithRelay(dispatchDeps);
    await during(async (relayToken) => { leaked = relayToken; return null; });
    // Same token, after the run — the liveness half of the grant.
    const out: any = await client.routes['actor/tool-dispatch']({ relayToken: leaked, call: { name: 'vm_exec', args: {} } }, OFFSCREEN);
    expect(out.ok).toBe(false);
    expect(out.error).toContain('unauthorized relay');
  });

  test("one run's token cannot dispatch against another run's session", async () => {
    // Two concurrent runs; each grant resolves to its OWN session, so the session a
    // relay acts on is decided by the token, never by the caller.
    const seen: string[] = [];
    const { client, during } = clientWithRelay({
      sessions: { get: async (id: string) => { seen.push(id); return { kind: 'actor', actorType: 'webvm', instanceId: id }; } },
      buildToolContext: async () => ({}),
      dispatchToolCall: async () => ({ ok: true }),
    });
    await during((relayToken) => client.routes['actor/tool-dispatch']({ relayToken, call: { name: 'vm_exec', args: {} } }, OFFSCREEN), 'actor-A');
    await during((relayToken) => client.routes['actor/tool-dispatch']({ relayToken, call: { name: 'vm_exec', args: {} } }, OFFSCREEN), 'actor-B');
    expect(seen).toEqual(['actor-A', 'actor-B']);
  });

  test('loop-event without a token cannot inject progress into a run', async () => {
    // Assert the event is NOT DELIVERED, not merely that the reply says no: a route
    // that forwarded first and returned {ok:false} after would pass the weaker check
    // while doing exactly the injection this forbids.
    const seen: any[] = [];
    const { client, during } = clientWithRelay({});
    const out: any = await during(async (relayToken) => {
      // A live run exists (its onEvent is recording), but this relay carries no token.
      const r = await client.routes['actor/loop-event']({ event: { type: 'fake' } } as any, OFFSCREEN);
      // ...and a live token from a page that is not the offscreen doc is equally refused.
      await client.routes['actor/loop-event']({ relayToken, event: { type: 'forged' } }, ENGINE_TAB);
      return r;
    }, 's1', (ev: any) => seen.push(ev));
    expect(out.ok).toBe(false);
    expect(seen).toEqual([]);
  });
});

// The sender pin. `runtime.sendMessage` from the SW cannot address one context, so
// the actor/run job — grant token included — is broadcast to the side panel and to
// every engine tab page. A page that keeps the token must still get nowhere.
describe('relay sender pin — a leaked token is useless from any other page', () => {
  const dispatchDeps = {
    sessions: { get: async () => ({ kind: 'actor', actorType: 'webvm', instanceId: 'vm-1' }) },
    buildToolContext: async () => ({}),
  };

  test('an engine tab replaying a LIVE token cannot dispatch a tool', async () => {
    let dispatched = false;
    const { client, during } = clientWithRelay({
      ...dispatchDeps,
      dispatchToolCall: async () => { dispatched = true; return { ok: true }; },
    });
    const out: any = await during((relayToken) =>
      client.routes['actor/tool-dispatch']({ relayToken, call: { name: 'vm_exec', args: {} } }, ENGINE_TAB));
    expect(out.ok).toBe(false);
    expect(out.error).toContain('unauthorized relay');
    expect(dispatched).toBe(false);
  });

  test('an engine tab replaying a LIVE token cannot spend the key', async () => {
    let called = false;
    const { client, during } = clientWithRelay({
      callModel: async function* () { called = true; yield { type: 'text', text: 'x' }; },
    });
    const out: any = await during((relayToken) =>
      client.routes['actor/model-call']({ relayToken, args: {} }, ENGINE_TAB));
    expect(out.ok).toBe(false);
    expect(called).toBe(false);
  });

  test('an unwired client refuses every relay (fail-closed, not fail-open)', async () => {
    // isOffscreenSender defaults to () => false: forgetting to wire the predicate
    // must break the lane loudly rather than silently drop the boundary.
    let relayed: any = null;
    const client = makeOffscreenActorClient({ ...baseDeps({ ...dispatchDeps }), isOffscreenSender: undefined } as any);
    const r = await client.run({ actorSessionId: 's1', message: 'm', systemPrompt: 's', provider: 'anthropic', model: 'm' } as any)
      .catch(() => null);
    relayed = await client.routes['actor/tool-dispatch']({ relayToken: 'anything', call: { name: 'vm_exec', args: {} } }, OFFSCREEN);
    expect(relayed.ok).toBe(false);
    expect(relayed.error).toContain('unauthorized relay');
    expect(r).not.toBeUndefined();
  });
});

// The actor lane's spend-limit preflight (P0-3): actors spend the user's money on
// the owning chat session, and this relay is where the key is added — so a session
// past the hard cap must not be pushed further by delegating to an actor.
describe('actor/model-call — spend-limit preflight', () => {
  test('refuses before the key-bearing call when the owning chat is past the cap', async () => {
    let called = false;
    const { client, during } = clientWithRelay({
      callModel: async function* () { called = true; yield { type: 'text', text: 'x' }; },
      spendRefusalFor: async () => 'actor refused: the session spend limit ($5) is reached',
    });
    const out: any = await during((relayToken) => client.routes['actor/model-call']({ relayToken, args: {} }, OFFSCREEN));
    expect(out.ok).toBe(false);
    expect(out.error).toContain('spend limit');
    expect(called).toBe(false);
  });

  test('proceeds when under the cap, and is asked about the RUN\'s session', async () => {
    const asked: string[] = [];
    const { client, during } = clientWithRelay({
      callModel: async function* () { yield { type: 'text', text: 'hi' }; },
      spendRefusalFor: async (sid: string) => { asked.push(sid); return null; },
    });
    const out: any = await during((relayToken) => client.routes['actor/model-call']({ relayToken, args: {} }, OFFSCREEN), 'actor-A');
    expect(out.ok).toBe(true);
    expect(asked).toEqual(['actor-A']);
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
    const { client, during } = clientWithRelay(subDeps());
    const out: any = await during((relayToken) => client.routes['actor/tool-dispatch']({ relayToken, call: { name: 'script', args: { code: 'x' } } }, OFFSCREEN));
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
    const { client, during } = clientWithRelay(subDeps({
      sessions: { get: async () => ({ kind: 'spawned', parentSessionId: 'p1', depth: 1, grantedTools: ['js_read_file'], review: true }) },
      dispatchToolCall: async (_call: any, ctx: any) => { seenCtx = ctx; return { ok: true }; },
      EXPOSURE_REVIEW: 'review',
    }));
    const out: any = await during((relayToken) => client.routes['actor/tool-dispatch']({ relayToken, call: { name: 'js_read_file', args: {} } }, OFFSCREEN));
    expect(out.ok).toBe(true);
    expect(seenCtx.exposure).toBe('review');
  });

  test('a NON-review spawned child gets NO exposure from the relay (fail-closed)', async () => {
    let seenCtx: any = null;
    const { client, during } = clientWithRelay(subDeps({
      dispatchToolCall: async (_call: any, ctx: any) => { seenCtx = ctx; return { ok: true }; },
      EXPOSURE_REVIEW: 'review',
    }));
    await during((relayToken) => client.routes['actor/tool-dispatch']({ relayToken, call: { name: 'script', args: {} } }, OFFSCREEN));
    expect(seenCtx.exposure).toBeUndefined();
  });

  test('a truthy-but-not-true review field stamps nothing (strict boolean, like the record write)', async () => {
    let seenCtx: any = null;
    const { client, during } = clientWithRelay(subDeps({
      sessions: { get: async () => ({ kind: 'spawned', parentSessionId: 'p1', depth: 1, grantedTools: ['script'], review: 'yes' }) },
      dispatchToolCall: async (_call: any, ctx: any) => { seenCtx = ctx; return { ok: true }; },
      EXPOSURE_REVIEW: 'review',
    }));
    await during((relayToken) => client.routes['actor/tool-dispatch']({ relayToken, call: { name: 'script', args: {} } }, OFFSCREEN));
    expect(seenCtx.exposure).toBeUndefined();
  });

  test('an UNGRANTED tool the worker asks for is REFUSED before any dispatch (never trust the worker)', async () => {
    let dispatched = false;
    const { client, during } = clientWithRelay(subDeps({ dispatchToolCall: async () => { dispatched = true; return { ok: true }; } }));
    const out: any = await during((relayToken) => client.routes['actor/tool-dispatch']({ relayToken, call: { name: 'actor_create', args: {} } }, OFFSCREEN));
    expect(out.ok).toBe(false);
    expect(out.error).toContain('tool_not_available_to_actor');
    expect(dispatched).toBe(false);
  });

  test('an actor tool-dispatch needs restrictCtxCapabilities wired (fails closed without it)', async () => {
    const { client, during } = clientWithRelay(subDeps({ restrictCtxCapabilities: undefined }));
    const out: any = await during((relayToken) => client.routes['actor/tool-dispatch']({ relayToken, call: { name: 'script', args: {} } }, OFFSCREEN));
    expect(out.ok).toBe(false);
    expect(out.error).toContain('not wired');
  });
});
