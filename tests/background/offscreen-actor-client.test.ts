// The heap-split SW-side client: the Stop-cascade `aborted` stamping (so an aborted
// offscreen turn renders 'cancelled', not a blank 'ok') and the security-critical
// 'actor/tool-dispatch' route (SW-side pin + gate + the web actor's owned-tab thread).
import { describe, test, expect } from 'bun:test';
import { makeOffscreenActorClient } from '../../extension/background/offscreen-actor-client.js';
import { makeDirectActorHost } from '../../extension/background/direct-actor-host.js';
import { DWEB_INBOUND_TOOL_NAMES } from '../../extension/peerd-runtime/actor/capability-manifest.js';

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
  inboundDwebToolNames: DWEB_INBOUND_TOOL_NAMES,
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
    during: async (
      fn: (token: string) => Promise<any>,
      actorSessionId = 's1',
      onEvent?: (ev: any) => void,
      job: Record<string, any> = {},
      runOptions: Record<string, any> = {},
    ) => {
      relay = fn;
      await client.run(
        { actorSessionId, message: 'm', systemPrompt: 's', provider: 'anthropic', model: 'm', ...job } as any,
        { ...(onEvent ? { onEvent } : {}), ...runOptions },
      );
      return captured;
    },
  };
};

describe('run() — Stop-cascade aborted stamping', () => {
  test('stamps aborted when the signal fired and the turn produced NO reply', async () => {
    // The worker can unwind an abort CLEANLY (empty reply, no error) → looks ok at the
    // result shape. signal.aborted here is the authoritative proof a Stop hit this run.
    const ac = new AbortController();
    const client = makeOffscreenActorClient(baseDeps({
      sendMessage: async (m: any) => {
        if (m.type === 'actor/run') { ac.abort(); return { ok: true, started: true, finalText: '' }; }
        return { ok: true };
      },
    }));
    const r = await client.run({ actorSessionId: 'a', message: 'm', systemPrompt: 's', provider: 'anthropic', model: 'm' } as any, { signal: ac.signal });
    expect(r.aborted).toBe(true);
  });

  test('does NOT stamp aborted when the turn produced text just before Stop (raced)', async () => {
    const ac = new AbortController();
    const client = makeOffscreenActorClient(baseDeps({
      sendMessage: async (m: any) => {
        if (m.type === 'actor/run') { ac.abort(); return { ok: true, started: true, finalText: 'a real reply' }; }
        return { ok: true };
      },
    }));
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

  test('Stop during offscreen startup prevents actor/run from being dispatched', async () => {
    let finishStartup: (() => void) | undefined;
    const startup = new Promise<void>((resolve) => { finishStartup = resolve; });
    const sent: string[] = [];
    const ac = new AbortController();
    const client = makeOffscreenActorClient(baseDeps({
      ensureOffscreen: () => startup,
      sendMessage: async (m: any) => { sent.push(m.type); return { ok: true }; },
    }));
    const pending = client.run(
      { actorSessionId: 'a', message: 'm', systemPrompt: 's', provider: 'anthropic', model: 'm' } as any,
      { signal: ac.signal },
    );
    ac.abort();
    finishStartup?.();
    const result: any = await pending;
    expect(result).toEqual(expect.objectContaining({ ok: false, started: true, aborted: true }));
    expect(sent).toEqual([]);
  });

  test('runner settlement aborts an already-admitted SW tool relay', async () => {
    let relay: Promise<any> | null = null;
    let dispatchStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { dispatchStarted = resolve; });
    let relaySignal: AbortSignal | undefined;
    let client: ReturnType<typeof makeOffscreenActorClient>;
    client = makeOffscreenActorClient(baseDeps({
      sessions: { get: async () => ({ kind: 'actor', actorType: 'webvm', instanceId: 'vm-1' }) },
      buildToolContext: async () => ({}),
      dispatchToolCall: async (_call: any, ctx: any) => {
        relaySignal = ctx.abortSignal;
        dispatchStarted?.();
        return await new Promise((resolve) => {
          const finish = () => resolve({ ok: false, error: 'cancelled with actor run' });
          if (ctx.abortSignal.aborted) finish();
          else ctx.abortSignal.addEventListener('abort', finish, { once: true });
        });
      },
      sendMessage: async (m: any) => {
        if (m.type !== 'actor/run') return { ok: true };
        relay = client.routes['actor/tool-dispatch']({
          relayToken: m.job.relayToken, call: { name: 'vm_boot', args: {} },
        }, OFFSCREEN);
        await started;
        return { ok: false, started: true, aborted: true, error: 'actor timed out' };
      },
    }));

    const result: any = await client.run({
      actorSessionId: 'a', message: 'm', systemPrompt: 's', provider: 'anthropic', model: 'm',
    } as any);
    const relayResult: any = await relay;
    expect(result.aborted).toBe(true);
    expect(relaySignal?.aborted).toBe(true);
    expect(relayResult).toEqual({ ok: false, error: 'aborted' });
  });

  test('runner settlement aborts an already-admitted SW model relay', async () => {
    let relay: Promise<any> | null = null;
    let modelStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { modelStarted = resolve; });
    let modelSignal: AbortSignal | undefined;
    let client: ReturnType<typeof makeOffscreenActorClient>;
    client = makeOffscreenActorClient(baseDeps({
      callModel: async function* ({ signal }: any) {
        modelSignal = signal;
        modelStarted?.();
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
      sendMessage: async (m: any) => {
        if (m.type !== 'actor/run') return { ok: true };
        relay = client.routes['actor/model-call']({
          relayToken: m.job.relayToken, args: { provider: 'anthropic', model: 'm' },
        }, OFFSCREEN);
        await started;
        return { ok: false, started: true, aborted: true, error: 'actor timed out' };
      },
    }));

    const result: any = await client.run({
      actorSessionId: 'a', message: 'm', systemPrompt: 's', provider: 'anthropic', model: 'm',
    } as any);
    const relayResult: any = await relay;
    expect(result.aborted).toBe(true);
    expect(modelSignal?.aborted).toBe(true);
    expect(relayResult).toEqual({ ok: false, error: 'aborted' });
  });

  test('Firefox lease loss revokes a pending model relay before late bytes arrive', async () => {
    let modelStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { modelStarted = resolve; });
    let releaseModel: (() => void) | undefined;
    const modelRelease = new Promise<void>((resolve) => { releaseModel = resolve; });
    let modelSignal: AbortSignal | undefined;
    let relayResult: Promise<any> | null = null;
    let relayToken = '';
    let relayAgain: ((type: string, payload: any) => Promise<any>) | null = null;
    const workerAborts: string[] = [];
    const host = makeDirectActorHost({
      workerUrl: 'worker.js',
      run: async (job: any, { sendToSW }: any) => {
        relayToken = job.relayToken;
        relayAgain = sendToSW;
        relayResult = sendToSW('actor/model-call', {
          relayToken,
          args: { provider: 'anthropic', model: 'm' },
        });
        await relayResult;
        return { ok: true, started: true, finalText: 'late response' };
      },
      abort: (runId: string) => { workerAborts.push(runId); },
    });
    const client = makeOffscreenActorClient(baseDeps({
      ensureHost: async () => {},
      isRelaySender: host.isRelaySender,
      sendMessage: host.sendMessage,
      callModel: async function* ({ signal }: any) {
        modelSignal = signal;
        modelStarted?.();
        await modelRelease;
        yield { type: 'text_delta', text: 'late provider bytes' };
      },
    }));
    host.bindRelayRoutes(client.routes);

    const run = client.run({
      actorSessionId: 'a', message: 'm', systemPrompt: 's', provider: 'anthropic', model: 'm',
    } as any);
    await started;
    host.failKeepAlive(new Error('session heartbeat stopped'));

    expect(await run).toEqual(expect.objectContaining({
      ok: false,
      started: true,
      code: 'actor_host_keepalive_lost',
      outcomeKnown: false,
    }));
    expect(workerAborts).toHaveLength(1);
    expect(modelSignal?.aborted).toBe(true);
    expect(relayAgain).not.toBeNull();
    const replayResult = await (relayAgain as unknown as (type: string, payload: any) => Promise<any>)(
      'actor/model-call', {
      relayToken,
      args: { provider: 'anthropic', model: 'm' },
      });
    expect(replayResult).toEqual({ ok: false, error: 'actor/model-call: unauthorized relay' });

    releaseModel?.();
    expect(relayResult).not.toBeNull();
    expect(await (relayResult as unknown as Promise<any>)).toEqual({ ok: false, error: 'aborted' });
  });
});

describe('inbound provenance — monotonic SW grant', () => {
  test('advertises only the positive read/moderation dweb set to an inbound worker', async () => {
    let sentJob: any = null;
    const client = makeOffscreenActorClient(baseDeps({
      sendMessage: async (m: any) => {
        if (m.type === 'actor/run') sentJob = m.job;
        return { ok: true, started: true, finalText: '' };
      },
    }));
    const names = [
      'dweb_discover', 'dweb_peers', 'dweb_block',
      'dweb_discovery', 'dweb_guide', 'dweb_share', 'dweb_install', 'a2a_run',
      'message_actor', 'actor_create', 'request_review', 'script',
    ];
    await client.run({
      actorSessionId: 'dweb', message: 'peer bytes', systemPrompt: 's',
      provider: 'anthropic', model: 'm', actorType: 'dweb', inbound: true,
      tools: names.map((name) => ({ name, description: name, schema: {} })),
    });
    expect(sentJob.inbound).toBe(true);
    expect(sentJob.tools.map((tool: any) => tool.name)).toEqual([
      'dweb_discover', 'dweb_peers', 'dweb_block',
    ]);
  });

  test('rechecks the inbound grant at dispatch and rebuilds an untrusted stripped ctx', async () => {
    const buildOpts: any[] = [];
    const dispatches: string[] = [];
    let dispatchedCtx: any = null;
    let restrictedTo: string[] = [];
    const { client, during } = clientWithRelay({
      sessions: { get: async () => ({ kind: 'actor', actorType: 'dweb', instanceId: 'dweb' }) },
      buildToolContext: async (opts: any) => {
        buildOpts.push(opts);
        // Simulate a ctx builder that forgot the derived bit. The live SW grant
        // must still stamp inbound and strip the signing-worker closure.
        return { inbound: false, synthetic: false, jsOffscreenClient: { run: true }, dweb: { peers: true } };
      },
      restrictCtxCapabilities: (ctx: any, allowed: Set<string>) => {
        restrictedTo = [...allowed];
        const narrowed = { ...ctx };
        if (!allowed.has('a2a_run')) delete narrowed.jsOffscreenClient;
        return narrowed;
      },
      dispatchToolCall: async (call: any, ctx: any) => {
        dispatches.push(call.name);
        dispatchedCtx = ctx;
        return { ok: true, content: 'safe read' };
      },
    });
    const out = await during(async (relayToken) => {
      const forbidden = await client.routes['actor/tool-dispatch']({
        relayToken, call: { name: 'a2a_run', args: { code: 'await mesh.send(...)' } },
      }, OFFSCREEN);
      const allowed = await client.routes['actor/tool-dispatch']({
        relayToken, call: { name: 'dweb_peers', args: {} },
      }, OFFSCREEN);
      return { forbidden, allowed };
    }, 'dweb', undefined, {
      actorType: 'dweb', inbound: true,
      tools: ['dweb_peers', 'a2a_run', 'dweb_share', 'dweb_install']
        .map((name) => ({ name, description: name, schema: {} })),
    });

    expect(out.forbidden.ok).toBe(false);
    expect(out.forbidden.error).toContain('tool_not_available_to_inbound_actor');
    expect(out.allowed).toEqual({ ok: true, result: { ok: true, content: 'safe read' } });
    expect(dispatches).toEqual(['dweb_peers']);
    expect(buildOpts).toEqual([expect.objectContaining({ synthetic: true, trusted: false })]);
    expect(dispatchedCtx).toEqual(expect.objectContaining({ synthetic: true, trusted: false, inbound: true }));
    expect(dispatchedCtx.jsOffscreenClient).toBeUndefined();
    expect(restrictedTo).toEqual(['dweb_peers']);
  });

  test('fails closed when an inbound ctx capability filter is not wired', async () => {
    let dispatched = false;
    const { client, during } = clientWithRelay({
      sessions: { get: async () => ({ kind: 'actor', actorType: 'dweb', instanceId: 'dweb' }) },
      dispatchToolCall: async () => { dispatched = true; return { ok: true }; },
    });
    const out = await during((relayToken) => client.routes['actor/tool-dispatch']({
      relayToken, call: { name: 'dweb_peers', args: {} },
    }, OFFSCREEN), 'dweb', undefined, {
      actorType: 'dweb', inbound: true,
      tools: [{ name: 'dweb_peers', description: 'peers', schema: {} }],
    });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('inbound capability filter not wired');
    expect(dispatched).toBe(false);
  });
});

describe("routes['actor/tool-dispatch'] — SW-side pin + gate + owned-tab thread", () => {
  test('a bound actor tool receives the live turn AbortSignal', async () => {
    let seenSignal: AbortSignal | undefined;
    const controller = new AbortController();
    const { client, during } = clientWithRelay({
      sessions: { get: async () => ({ kind: 'actor', actorType: 'webvm', instanceId: 'vm-1' }) },
      buildToolContext: async () => ({}),
      dispatchToolCall: async (_call: any, ctx: any) => {
        seenSignal = ctx.abortSignal;
        return { ok: true };
      },
    });
    const out = await during(
      (relayToken) => client.routes['actor/tool-dispatch']({
        relayToken, call: { name: 'vm_boot', args: {} },
      }, OFFSCREEN),
      's1', undefined, {}, { signal: controller.signal },
    );
    expect(out.ok).toBe(true);
    expect(seenSignal).not.toBe(controller.signal);   // host-owned run signal
    expect(seenSignal?.aborted).toBe(true);            // settlement cancels relays
  });

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

  test('a WEB actor relay keeps the surface resolved at turn start', async () => {
    let liveSetting = 'code';
    let ctxOpts: any = null;
    const { client, during } = clientWithRelay({
      sessions: { get: async () => ({ kind: 'actor', actorType: 'web', instanceId: 'web' }) },
      buildToolContext: async (o: any) => { ctxOpts = { ...o, liveSetting }; return {}; },
      dispatchToolCall: async () => ({ ok: true }),
    });
    await during(async (relayToken) => {
      // Settings can change while the Worker is reasoning. The SW-owned grant
      // must carry the already-advertised surface into every relayed dispatch.
      liveSetting = 'tools';
      return client.routes['actor/tool-dispatch']({
        relayToken, call: { name: 'page_code', args: { code: 'return 1' } },
      }, OFFSCREEN);
    }, 's1', undefined, { actorType: 'web', actorSurface: 'code' });
    expect(ctxOpts.liveSetting).toBe('tools');
    expect(ctxOpts.actorSurface).toBe('code');
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

describe('actor/model-call — trusted run metadata wins over worker args', () => {
  test('pins provider, model, and Ollama host at the key-bearing boundary', async () => {
    let seen: any = null;
    const { client, during } = clientWithRelay({
      callModel: async function* (args: any) { seen = args; yield { type: 'text', text: 'ok' }; },
      sendMessage: undefined,
    });
    // The helper's job is anthropic/model m. The worker-controlled payload tries
    // to switch all three fields; the live grant must overwrite it.
    const out: any = await during((relayToken) => client.routes['actor/model-call']({
      relayToken,
      args: { provider: 'openai', model: 'expensive-unknown', ollamaHost: 'http://attacker.test' },
    }, OFFSCREEN));
    expect(out.ok).toBe(true);
    expect(seen.provider).toBe('anthropic');
    expect(seen.model).toBe('m');
    expect(seen.ollamaHost).toBeUndefined();
  });
});

describe('run() — relay lifetime', () => {
  test('aborts the SW-side relay signal whenever the host settles', async () => {
    let relaySignal: AbortSignal | null = null;
    let client: any;
    client = makeOffscreenActorClient(baseDeps({
      sessions: { get: async () => ({ kind: 'spawned', grantedTools: ['script'] }) },
      restrictCtxCapabilities: (ctx: any) => ctx,
      buildToolContext: async () => ({}),
      dispatchToolCall: async (_call: any, ctx: any) => {
        relaySignal = ctx.abortSignal;
        return { ok: true };
      },
      sendMessage: async (message: any) => {
        if (message.type === 'actor/run') {
          await client.routes['actor/tool-dispatch']({
            relayToken: message.job.relayToken,
            call: { name: 'script', args: {} },
          }, OFFSCREEN);
          return { ok: true, started: true, finalText: 'done' };
        }
        return { ok: true };
      },
    }));

    await client.run({ actorSessionId: 's1', message: 'm', systemPrompt: 's', provider: 'anthropic', model: 'm' });
    await Promise.resolve();
    expect(relaySignal).not.toBeNull();
    expect((relaySignal as unknown as AbortSignal).aborted).toBe(true);
  });

  test('a model relay suspended in preflight cannot start after its host settles', async () => {
    let releasePreflight!: () => void;
    const preflightGate = new Promise<void>((resolve) => { releasePreflight = resolve; });
    let enteredPreflight!: () => void;
    const preflightEntered = new Promise<void>((resolve) => { enteredPreflight = resolve; });
    let routeResult: Promise<any> = Promise.resolve(null);
    let modelCalled = false;
    let client: any;
    client = makeOffscreenActorClient(baseDeps({
      spendRefusalFor: async () => {
        enteredPreflight();
        await preflightGate;
        return null;
      },
      callModel: async function* () { modelCalled = true; yield { type: 'text', text: 'forbidden' }; },
      sendMessage: async (message: any) => {
        if (message.type === 'actor/run') {
          routeResult = client.routes['actor/model-call']({
            relayToken: message.job.relayToken,
            args: {},
          }, OFFSCREEN);
          await preflightEntered;
          return { ok: true, started: true, finalText: 'host settled' };
        }
        return { ok: true };
      },
    }));

    await client.run({ actorSessionId: 's1', message: 'm', systemPrompt: 's', provider: 'anthropic', model: 'm' });
    releasePreflight();
    expect(await routeResult).toEqual({ ok: false, error: 'aborted' });
    expect(modelCalled).toBe(false);
  });

  test('a tool relay suspended in session lookup cannot dispatch after its host settles', async () => {
    let releaseSession!: () => void;
    const sessionGate = new Promise<void>((resolve) => { releaseSession = resolve; });
    let enteredSession!: () => void;
    const sessionEntered = new Promise<void>((resolve) => { enteredSession = resolve; });
    let routeResult: Promise<any> = Promise.resolve(null);
    let dispatched = false;
    let client: any;
    client = makeOffscreenActorClient(baseDeps({
      sessions: {
        get: async () => {
          enteredSession();
          await sessionGate;
          return { kind: 'actor', actorType: 'webvm', instanceId: 'vm-1' };
        },
      },
      dispatchToolCall: async () => { dispatched = true; return { ok: true }; },
      sendMessage: async (message: any) => {
        if (message.type === 'actor/run') {
          routeResult = client.routes['actor/tool-dispatch']({
            relayToken: message.job.relayToken,
            call: { name: 'vm_exec', args: {} },
          }, OFFSCREEN);
          await sessionEntered;
          return { ok: true, started: true, finalText: 'host settled' };
        }
        return { ok: true };
      },
    }));

    await client.run({ actorSessionId: 's1', message: 'm', systemPrompt: 's', provider: 'anthropic', model: 'm' });
    releaseSession();
    expect(await routeResult).toEqual({ ok: false, error: 'aborted' });
    expect(dispatched).toBe(false);
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
