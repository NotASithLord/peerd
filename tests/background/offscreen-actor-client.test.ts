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

const inferenceInput = (relayToken: string, over: Record<string, any> = {}) => ({
  relayToken,
  providerId: 'anthropic',
  modelId: 'm',
  nativeBody: {
    model: 'm', stream: true, messages: [], system: 'system', max_tokens: 128,
  },
  ...over,
});

const providerEgress = (over: Record<string, any> = {}) => ({
  openInference: async (input: any, grant: any) => grant.permits(input.providerId, input.modelId)
    ? {
        ok: true, outcomeKnown: true,
        value: { streamId: 'stream-1', status: 200, headers: {}, hasBody: true },
      }
    : { ok: false, error: 'model-egress-request-invalid', outcomeKnown: true },
  readInferenceChunk: async () => ({ ok: true, outcomeKnown: true, value: { done: true } }),
  cancelInference: async () => ({ ok: true, outcomeKnown: true, value: null }),
  closeOwner: async () => {},
  ...over,
});

const baseDeps = (over: any = {}) => ({
  ensureOffscreen: async () => {},
  isOffscreenSender: (s: any) => s?.url === OFFSCREEN.url,
  sendMessage: async () => ({ ok: true }),
  providerEgress: providerEgress(),
  sessions: { get: async () => null },
  buildToolContext: async () => ({}),
  dispatchToolCall: async () => ({ ok: true }),
  reviewToolAllowed: () => true,
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
        {
          actorSessionId, message: 'm', systemPrompt: 's', provider: 'anthropic',
          model: 'm', maxOutputTokens: 4096, ...job,
        } as any,
        { ...(onEvent ? { onEvent } : {}), ...runOptions },
      );
      return captured;
    },
  };
};

describe('run() — Stop-cascade aborted stamping', () => {
  test('channel transport binds a relay without serializing its grant', async () => {
    let sentJob: any = null;
    let relayResult: any = null;
    const client = makeOffscreenActorClient(baseDeps({
      sessions: { get: async () => ({ kind: 'actor', actorType: 'web', backing: 'api' }) },
      dispatchToolCall: async () => ({ ok: true, content: 'ran' }),
      runOnChannel: async (job: any, { relay }: any) => {
        sentJob = job;
        relayResult = await relay('actor/tool-dispatch', { call: { name: 'fetch_url', args: {} } });
        return { ok: true, started: true, finalText: 'done' };
      },
    }));
    const result = await client.run({
      actorSessionId: 'actor-channel', message: 'm', systemPrompt: 's',
      provider: 'anthropic', model: 'm',
    } as any);
    expect(sentJob.relayToken).toBeUndefined();
    expect(relayResult).toEqual({ ok: true, result: { ok: true, content: 'ran' } });
    expect(result.finalText).toBe('done');
  });

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

  test('Stop preserves a late successful receipt from an admitted SW tool relay', async () => {
    let relay: Promise<any> | null = null;
    let dispatchStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { dispatchStarted = resolve; });
    let releaseDispatch: (() => void) | undefined;
    const dispatchGate = new Promise<void>((resolve) => { releaseDispatch = resolve; });
    let relaySignal: AbortSignal | undefined;
    let effects = 0;
    const ac = new AbortController();
    let client: ReturnType<typeof makeOffscreenActorClient>;
    client = makeOffscreenActorClient(baseDeps({
      sessions: { get: async () => ({ kind: 'actor', actorType: 'webvm', instanceId: 'vm-1' }) },
      buildToolContext: async () => ({}),
      dispatchToolCall: async (_call: any, ctx: any) => {
        relaySignal = ctx.abortSignal;
        dispatchStarted?.();
        await dispatchGate;
        effects += 1;
        return { ok: true, content: 'effect landed', performed: true, outcomeKnown: true };
      },
      sendMessage: async (m: any) => {
        if (m.type !== 'actor/run') return { ok: true };
        relay = client.routes['actor/tool-dispatch']({
          relayToken: m.job.relayToken, call: { name: 'script', args: {} },
        }, OFFSCREEN);
        await started;
        ac.abort();
        releaseDispatch?.();
        const receipt = await relay;
        return {
          ok: true, started: true, finalText: '', stopReason: 'aborted', toolCalls: 1,
          performed: receipt?.result?.performed, outcomeKnown: receipt?.result?.outcomeKnown,
        };
      },
    }));

    const result: any = await client.run({
      actorSessionId: 'a', message: 'm', systemPrompt: 's', provider: 'anthropic', model: 'm',
    } as any, { signal: ac.signal });
    const relayResult: any = await relay;
    expect(result.aborted).toBe(true);
    expect(result).toMatchObject({ performed: true, outcomeKnown: true });
    expect(relaySignal?.aborted).toBe(true);
    expect(relayResult).toEqual({
      ok: true,
      result: { ok: true, content: 'effect landed', performed: true, outcomeKnown: true },
    });
    expect(effects).toBe(1);
  });

  test('unknown tool custody outranks Stop stamping', async () => {
    const ac = new AbortController();
    const client = makeOffscreenActorClient(baseDeps({
      sendMessage: async (m: any) => {
        if (m.type !== 'actor/run') return { ok: true };
        ac.abort();
        return {
          ok: false, started: true, code: 'actor_tool_outcome_unknown',
          error: 'outcome_unknown', performed: true,
          outcomeKnown: false, retryable: false,
        };
      },
    }));
    const result: any = await client.run({
      actorSessionId: 'a', message: 'm', systemPrompt: 's', provider: 'anthropic', model: 'm',
    } as any, { signal: ac.signal });
    expect(result).toMatchObject({
      code: 'actor_tool_outcome_unknown', performed: true,
      outcomeKnown: false, retryable: false,
    });
    expect(result.aborted).toBeUndefined();
  });

  test('runner settlement aborts an already-admitted SW model relay', async () => {
    let relay: Promise<any> | null = null;
    let modelStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { modelStarted = resolve; });
    let modelSignal: AbortSignal | undefined;
    let client: ReturnType<typeof makeOffscreenActorClient>;
    client = makeOffscreenActorClient(baseDeps({
      providerEgress: providerEgress({
        openInference: async (_input: any, grant: any) => {
          modelSignal = grant.signal;
          modelStarted?.();
          await new Promise<void>((resolve) => {
            if (grant.signal.aborted) resolve();
            else grant.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          return { ok: false, error: 'aborted', outcomeKnown: true };
        },
      }),
      sendMessage: async (m: any) => {
        if (m.type !== 'actor/run') return { ok: true };
        relay = client.routes['actor/model-open-inference'](
          inferenceInput(m.job.relayToken), OFFSCREEN,
        );
        await started;
        return { ok: false, started: true, aborted: true, error: 'actor timed out' };
      },
    }));

    const result: any = await client.run({
      actorSessionId: 'a', message: 'm', systemPrompt: 's', provider: 'anthropic',
      model: 'm', maxOutputTokens: 4096,
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
        relayResult = sendToSW(
          'actor/model-open-inference', inferenceInput(relayToken),
        );
        await relayResult;
        return { ok: true, started: true, finalText: 'late response' };
      },
      abort: (runId: string) => { workerAborts.push(runId); },
    });
    const client = makeOffscreenActorClient(baseDeps({
      ensureHost: async () => {},
      isRelaySender: host.isRelaySender,
      sendMessage: host.sendMessage,
      providerEgress: providerEgress({
        openInference: async (_input: any, grant: any) => {
          modelSignal = grant.signal;
          modelStarted?.();
          await modelRelease;
          return grant.signal.aborted
            ? { ok: false, error: 'aborted', outcomeKnown: true }
            : {
                ok: true, outcomeKnown: true,
                value: { streamId: 'late', status: 200, headers: {}, hasBody: true },
              };
        },
      }),
    }));
    host.bindRelayRoutes(client.routes);

    const run = client.run({
      actorSessionId: 'a', message: 'm', systemPrompt: 's', provider: 'anthropic',
      model: 'm', maxOutputTokens: 4096,
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
      'actor/model-open-inference', inferenceInput(relayToken));
    expect(replayResult).toEqual({
      ok: false, error: 'actor/model-open-inference: unauthorized relay',
    });

    releaseModel?.();
    expect(relayResult).not.toBeNull();
    expect(await (relayResult as unknown as Promise<any>)).toEqual({ ok: false, error: 'aborted' });
  });

  test('Firefox relay-drain expiry aborts the worker and retires its grant', async () => {
    let relayStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { relayStarted = resolve; });
    let fireDrain: (() => void) | undefined;
    let relayToken = '';
    let relayAgain: ((type: string, payload: any) => Promise<any>) | null = null;
    const workerAborts: string[] = [];
    const host = makeDirectActorHost({
      workerUrl: 'worker.js',
      relayDrainTimeoutMs: 10,
      setTimeoutFn: ((callback: () => void) => { fireDrain = callback; return 7; }) as typeof setTimeout,
      clearTimeoutFn: (() => {}) as typeof clearTimeout,
      abort: (runId: string) => { workerAborts.push(runId); },
      run: async (job: any, { sendToSW, onRelayDrain }: any) => {
        relayToken = job.relayToken;
        relayAgain = sendToSW;
        const relay = sendToSW('actor/tool-dispatch', {
          relayToken, call: { name: 'script', args: {} },
        });
        await started;
        onRelayDrain();
        return relay;
      },
    });
    const client = makeOffscreenActorClient(baseDeps({
      ensureHost: async () => {},
      isRelaySender: host.isRelaySender,
      sendMessage: host.sendMessage,
      sessions: { get: async () => ({ kind: 'actor', actorType: 'webvm', instanceId: 'vm-1' }) },
      dispatchToolCall: async () => {
        relayStarted?.();
        return new Promise(() => {});
      },
    }));
    host.bindRelayRoutes(client.routes);

    const run = client.run({
      actorSessionId: 'a', message: 'm', systemPrompt: 's', provider: 'anthropic', model: 'm',
    } as any);
    await started;
    await Promise.resolve();
    fireDrain?.();
    expect(await run).toMatchObject({
      ok: false, started: true, code: 'actor_relay_drain_timeout',
      outcomeKnown: false, retryable: false,
    });
    expect(workerAborts).toHaveLength(1);
    expect(relayAgain).not.toBeNull();
    expect(await (relayAgain as unknown as (type: string, payload: any) => Promise<any>)(
      'actor/tool-dispatch', { relayToken, call: { name: 'script', args: {} } },
    )).toEqual({ ok: false, error: 'actor/tool-dispatch: unauthorized relay' });
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
        relayToken, call: { name: 'script', args: {} },
      }, OFFSCREEN),
      's1', undefined, {}, { signal: controller.signal },
    );
    expect(out.ok).toBe(true);
    expect(seenSignal).not.toBe(controller.signal);   // host-owned run signal
    expect(seenSignal?.aborted).toBe(true);            // settlement cancels relays
  });

  test('an admitted dispatch throw has unknown custody', async () => {
    const { client, during } = clientWithRelay({
      sessions: { get: async () => ({ kind: 'actor', actorType: 'webvm', instanceId: 'vm-1' }) },
      buildToolContext: async () => ({}),
      dispatchToolCall: async () => { throw new Error('dispatch receipt lost'); },
    });
    const out = await during((relayToken) => client.routes['actor/tool-dispatch']({
      relayToken, call: { name: 'script', args: {} },
    }, OFFSCREEN));
    expect(out).toMatchObject({
      ok: false, error: 'dispatch receipt lost', outcomeKnown: false, retryable: false,
    });
  });

  test('a WEB (tab) actor threads its owned tab into buildToolContext + re-pins', async () => {
    let ctxOpts: any = null;
    let pinned: any = null;
    const { client, during } = clientWithRelay({
      sessions: { get: async () => ({ kind: 'actor', actorType: 'web', backing: undefined, instanceId: 'web' }) },
      ownedTabFor: () => 42,
      buildToolContext: async (o: any) => { ctxOpts = o; return { ctx: true }; },
      pinActorCall: (call: any, at: string, id: string) => { pinned = { call, at, id }; },
      dispatchToolCall: async () => ({ ok: true, content: 'pdf' }),
    });
    const out = await during((relayToken) => client.routes['actor/tool-dispatch']({ relayToken, call: { name: 'read_pdf', args: {} } }, OFFSCREEN));
    expect(out).toEqual({ ok: true, result: { ok: true, content: 'pdf' } });
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
    await during((relayToken) => client.routes['actor/tool-dispatch']({ relayToken, call: { name: 'script', args: {} } }, OFFSCREEN), 'engine');
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

  test('inference open without a token never reaches provider authority', async () => {
    let called = false;
    const client = makeOffscreenActorClient(baseDeps({
      providerEgress: providerEgress({
        openInference: async () => { called = true; return { ok: true }; },
      }),
    }));
    const out: any = await client.routes['actor/model-open-inference'](
      inferenceInput('') as any, OFFSCREEN,
    );
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

// Firefox's private background host still uses a token to bind each relay to a
// live run. Even there, a token-bearing call from a different extension page
// must get nowhere. Chrome closes the grant over a targeted MessageChannel.
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
      providerEgress: providerEgress({
        openInference: async () => { called = true; return { ok: true }; },
      }),
    });
    const out: any = await during((relayToken) =>
      client.routes['actor/model-open-inference'](inferenceInput(relayToken), ENGINE_TAB));
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
// the owning chat session, and this relay is where the key is added, so a session
// past the hard cap must not be pushed further by delegating to an actor.
describe('actor/model-open-inference spend-limit preflight', () => {
  test('refuses before the key-bearing call when the owning chat is past the cap', async () => {
    let called = false;
    const { client, during } = clientWithRelay({
      providerEgress: providerEgress({
        openInference: async () => { called = true; return { ok: true }; },
      }),
      spendRefusalFor: async () => 'actor refused: the session spend limit ($5) is reached',
    });
    const out: any = await during((relayToken) => client.routes['actor/model-open-inference'](
      inferenceInput(relayToken), OFFSCREEN,
    ));
    expect(out.ok).toBe(false);
    expect(out.error).toContain('spend limit');
    expect(called).toBe(false);
  });

  test('proceeds when under the cap, and is asked about the RUN\'s session', async () => {
    const asked: string[] = [];
    const { client, during } = clientWithRelay({
      spendRefusalFor: async (sid: string) => { asked.push(sid); return null; },
    });
    const out: any = await during((relayToken) => client.routes['actor/model-open-inference'](
      inferenceInput(relayToken), OFFSCREEN,
    ), 'actor-A');
    expect(out.ok).toBe(true);
    expect(asked).toEqual(['actor-A']);
  });
});

describe('actor inference: the live grant pins provider, model, and output limit', () => {
  test('refuses a provider/model pair outside the grant', async () => {
    let seen: any = null;
    const { client, during } = clientWithRelay({
      providerEgress: providerEgress({
        openInference: async (input: any, grant: any) => {
          seen = { input, grant };
          return grant.permits(input.providerId, input.modelId)
            ? { ok: true, value: { streamId: 'x' } }
            : { ok: false, error: 'model-egress-request-invalid', outcomeKnown: true };
        },
      }),
    });
    const out: any = await during((relayToken) => client.routes['actor/model-open-inference'](
      inferenceInput(relayToken, {
        providerId: 'openai', modelId: 'expensive-unknown',
        nativeBody: { model: 'expensive-unknown', stream: true, messages: [] },
      }), OFFSCREEN,
    ));
    expect(out.ok).toBe(false);
    expect(seen.grant.permits('anthropic', 'm')).toBe(true);
    expect(seen.grant.permits('openai', 'expensive-unknown')).toBe(false);
  });

  test('passes only the SW-stamped output cap to provider authority', async () => {
    let seen: any = null;
    const { client, during } = clientWithRelay({
      providerEgress: providerEgress({
        openInference: async (_input: any, grant: any) => {
          seen = grant;
          return { ok: true, value: { streamId: 'x' } };
        },
      }),
    });
    const out: any = await during((relayToken) => client.routes['actor/model-open-inference'](
      inferenceInput(relayToken, {
        nativeBody: {
          model: 'm', stream: true, messages: [], system: 'system',
          max_tokens: Number.MAX_SAFE_INTEGER,
        },
      }), OFFSCREEN,
    ), 'actor-A', undefined, { maxOutputTokens: 512 });
    expect(out.ok).toBe(true);
    expect(seen.maxOutputTokens).toBe(512);
  });
});

describe('relay quotas', () => {
  test('a model burst starts one call and settlement aborts it', async () => {
    let modelStarted!: () => void;
    const started = new Promise<void>((resolve) => { modelStarted = resolve; });
    let modelCalls = 0;
    let burst: Promise<any>[] = [];
    let client: ReturnType<typeof makeOffscreenActorClient>;
    client = makeOffscreenActorClient(baseDeps({
      providerEgress: providerEgress({
        openInference: async (_input: any, grant: any) => {
          modelCalls += 1;
          modelStarted();
          await new Promise<void>((resolve) => {
            if (grant.signal.aborted) resolve();
            else grant.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          return { ok: false, error: 'aborted', outcomeKnown: true };
        },
      }),
      sendMessage: async (message: any) => {
        if (message.type !== 'actor/run') return { ok: true };
        burst = Array.from({ length: 5 }, () =>
          client.routes['actor/model-open-inference'](
            inferenceInput(message.job.relayToken), OFFSCREEN,
          ));
        await started;
        return { ok: true, started: true, finalText: 'done' };
      },
    }));

    await client.run({
      actorSessionId: 'a', message: 'm', systemPrompt: 's', provider: 'anthropic',
      model: 'm', maxOutputTokens: 4096,
    } as any);
    const results = await Promise.all(burst);
    expect(modelCalls).toBe(1);
    expect(results.filter((result) => result.code === 'actor_model_relay_busy')).toHaveLength(4);
    expect(results.find((result) => result.code !== 'actor_model_relay_busy'))
      .toEqual({ ok: false, error: 'aborted' });
  });

  test('model and tool relay budgets refuse excess before dispatch', async () => {
    let modelCalls = 0;
    let toolCalls = 0;
    const { client, during } = clientWithRelay({
      maxModelRelaysPerRun: 1,
      maxToolRelaysPerRun: 1,
      sessions: { get: async () => ({ kind: 'actor', actorType: 'webvm', instanceId: 'vm-1' }) },
      buildToolContext: async () => ({}),
      providerEgress: providerEgress({
        openInference: async () => {
          modelCalls += 1;
          return {
            ok: true, outcomeKnown: true,
            value: { streamId: 'budget-stream', status: 200, headers: {}, hasBody: true },
          };
        },
      }),
      dispatchToolCall: async () => { toolCalls += 1; return { ok: true }; },
    });
    const results = await during(async (relayToken) => {
      const firstModel = await client.routes['actor/model-open-inference'](
        inferenceInput(relayToken), OFFSCREEN,
      );
      await client.routes['actor/model-cancel-inference']({
        relayToken, streamId: firstModel.value.streamId,
      }, OFFSCREEN);
      const secondModel = await client.routes['actor/model-open-inference'](
        inferenceInput(relayToken), OFFSCREEN,
      );
      const firstTool = await client.routes['actor/tool-dispatch']({
        relayToken, call: { name: 'script', args: {} },
      }, OFFSCREEN);
      const secondTool = await client.routes['actor/tool-dispatch']({
        relayToken, call: { name: 'script', args: {} },
      }, OFFSCREEN);
      return { firstModel, secondModel, firstTool, secondTool };
    });
    expect(results.firstModel.ok).toBe(true);
    expect(results.firstTool.ok).toBe(true);
    expect(results.secondModel).toMatchObject({
      code: 'actor_model_relay_limit', outcomeKnown: true, performed: false,
    });
    expect(results.secondTool).toMatchObject({
      code: 'actor_tool_relay_limit', outcomeKnown: true, performed: false,
    });
    expect({ modelCalls, toolCalls }).toEqual({ modelCalls: 1, toolCalls: 1 });
  });

  test('coalesces loop events after the run cap', async () => {
    const events: any[] = [];
    const { client, during } = clientWithRelay({ maxLoopEventsPerRun: 3 });
    const results = await during((relayToken) => Promise.all(
      Array.from({ length: 20 }, (_, index) => client.routes['actor/loop-event']({
        relayToken, event: { type: 'delta', index },
      }, OFFSCREEN)),
    ), 'actor-A', (event) => events.push(event));
    expect(events).toHaveLength(3);
    expect(results.filter((result: any) => result.coalesced === true)).toHaveLength(17);
  });
});

describe('run(): relay lifetime', () => {
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

    await client.run({
      actorSessionId: 's1', message: 'm', systemPrompt: 's', provider: 'anthropic',
      model: 'm', maxOutputTokens: 4096,
    });
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
      providerEgress: providerEgress({
        openInference: async () => { modelCalled = true; return { ok: true }; },
      }),
      sendMessage: async (message: any) => {
        if (message.type === 'actor/run') {
          routeResult = client.routes['actor/model-open-inference'](
            inferenceInput(message.job.relayToken), OFFSCREEN,
          );
          await preflightEntered;
          return { ok: true, started: true, finalText: 'host settled' };
        }
        return { ok: true };
      },
    }));

    await client.run({
      actorSessionId: 's1', message: 'm', systemPrompt: 's', provider: 'anthropic',
      model: 'm', maxOutputTokens: 4096,
    });
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
  // hand-build {exposure} ctxs, which would let a missing host-side stamp stay
  // invisible. These pin the isolated relay's own logic:
  // given a record with review:true it stamps, otherwise it doesn't. The OTHER
  // half — that create() actually persists review so a real record carries it —
  // is pinned in sessions/custom-system-prompt.test.ts (a real create→get
  // round-trip); the two together close the gap, since a mocked get here can't
  // prove the store keeps the field.
  test('a REVIEW child re-stamps exposure from the PERSISTED record', async () => {
    let seenCtx: any = null;
    const { client, during } = clientWithRelay(subDeps({
      sessions: { get: async () => ({ kind: 'spawned', parentSessionId: 'p1', depth: 1, grantedTools: ['script'], review: true }) },
      dispatchToolCall: async (_call: any, ctx: any) => { seenCtx = ctx; return { ok: true }; },
      EXPOSURE_REVIEW: 'review',
    }));
    const out: any = await during((relayToken) => client.routes['actor/tool-dispatch']({ relayToken, call: { name: 'script', args: {} } }, OFFSCREEN));
    expect(out.ok).toBe(true);
    expect(seenCtx.exposure).toBe('review');
  });

  test('a REVIEW child is refused at call time when the live allowlist drops a stale grant', async () => {
    let dispatched = false;
    const { client, during } = clientWithRelay(subDeps({
      sessions: { get: async () => ({
        kind: 'spawned', parentSessionId: 'p1', depth: 1,
        grantedTools: ['app_search'], review: true,
      }) },
      reviewToolAllowed: () => false,
      dispatchToolCall: async () => { dispatched = true; return { ok: true }; },
      EXPOSURE_REVIEW: 'review',
    }));
    const out: any = await during((relayToken) => client.routes['actor/tool-dispatch']({
      relayToken, call: { name: 'app_search', args: { query: 'x' } },
    }, OFFSCREEN));
    expect(out.ok).toBe(false);
    expect(out.error).toContain('tool_not_available_to_reviewer');
    expect(dispatched).toBe(false);
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

describe('controller-owned actor tools: exact isolated authority', () => {
  test('admits, executes, and settles actor_cancel without entering legacy dispatch', async () => {
    let legacyDispatches = 0;
    let cancelledTask = '';
    let settledResult: any = null;
    const { client, during } = clientWithRelay({
      sessions: { get: async () => ({ kind: 'actor', actorType: 'webvm', instanceId: 'vm-1' }) },
      buildToolContext: async () => ({
        session: { sessionId: 'actor-1', depth: 2, kind: 'spawned' },
        actorAuthority: {
          cancelTask: async (taskId: string) => {
            cancelledTask = taskId;
            return { ok: true, content: `cancelled ${taskId}` };
          },
        },
      }),
      dispatchToolCall: async () => { legacyDispatches += 1; return { ok: true }; },
      prepareToolCall: async (call: any, ctx: any) => ({
        prepared: true, call, ctx, args: call.args,
      }),
      settleToolCall: async (_prepared: any, execution: any) => {
        settledResult = execution.result;
        return { ...execution.result, settled: true };
      },
    });
    const observed: any = await during(async (relayToken) => {
      const prepared: any = await client.routes['actor/tool-prepare']({
        relayToken,
        call: { id: 'call-1', name: 'actor_cancel', args: { taskId: 'task-7' } },
      }, OFFSCREEN);
      const effect = await client.routes['actor/task-cancel']({
        relayToken, executionId: prepared.executionId, taskId: 'task-7',
      }, OFFSCREEN);
      const duplicate = await client.routes['actor/task-cancel']({
        relayToken, executionId: prepared.executionId, taskId: 'task-7',
      }, OFFSCREEN);
      const legacy = await client.routes['actor/tool-dispatch']({
        relayToken,
        call: { id: 'call-1', name: 'actor_cancel', args: { taskId: 'task-7' } },
      }, OFFSCREEN);
      const settled = await client.routes['actor/tool-settle']({
        relayToken, executionId: prepared.executionId,
        result: { ok: true, content: effect.value.content },
      }, OFFSCREEN);
      return { prepared, effect, duplicate, legacy, settled };
    }, 'actor-1');

    expect(observed.prepared).toMatchObject({
      ok: true, mode: 'execute', toolName: 'actor_cancel', callId: 'call-1',
      projection: { sessionId: 'actor-1', sessionDepth: 2, sessionKind: 'spawned' },
    });
    expect(observed.effect).toEqual({
      ok: true, value: { ok: true, content: 'cancelled task-7' },
    });
    expect(observed.duplicate).toMatchObject({ ok: false, outcomeKnown: true });
    expect(observed.legacy).toMatchObject({ ok: false });
    expect(observed.legacy.error).toContain('not legacy-owned');
    expect(observed.settled).toEqual({
      ok: true, result: { ok: true, content: 'cancelled task-7', settled: true },
    });
    expect(cancelledTask).toBe('task-7');
    expect(settledResult).toEqual({ ok: true, content: 'cancelled task-7' });
    expect(legacyDispatches).toBe(0);
  });

  test('refuses a controller attempt to alter admitted actor arguments', async () => {
    let cancelled = false;
    const { client, during } = clientWithRelay({
      sessions: { get: async () => ({ kind: 'actor', actorType: 'webvm', instanceId: 'vm-1' }) },
      buildToolContext: async () => ({
        session: { sessionId: 'actor-1', depth: 2, kind: 'spawned' },
        actorAuthority: {
          cancelTask: async () => { cancelled = true; return { ok: true, content: 'cancelled' }; },
        },
      }),
      prepareToolCall: async (call: any, ctx: any) => ({
        prepared: true, call, ctx, args: call.args,
      }),
      settleToolCall: async (_prepared: any, execution: any) => execution.result,
    });
    const refused: any = await during(async (relayToken) => {
      const prepared: any = await client.routes['actor/tool-prepare']({
        relayToken,
        call: { id: 'call-tamper', name: 'actor_cancel', args: { taskId: 'task-approved' } },
      }, OFFSCREEN);
      return client.routes['actor/task-cancel']({
        relayToken, executionId: prepared.executionId, taskId: 'task-altered',
      }, OFFSCREEN);
    }, 'actor-1');
    expect(refused).toMatchObject({ ok: false, outcomeKnown: true });
    expect(cancelled).toBe(false);
  });

  test('preserves unknown outcome when actor message custody throws after admission', async () => {
    const { client, during } = clientWithRelay({
      sessions: { get: async () => ({ kind: 'actor', actorType: 'webvm', instanceId: 'vm-1' }) },
      buildToolContext: async () => ({
        session: { sessionId: 'actor-1', depth: 1, kind: 'spawned' },
        actorAuthority: {
          deliverMessage: async () => { throw new Error('host vanished'); },
        },
      }),
      prepareToolCall: async (call: any, ctx: any) => ({
        prepared: true, call, ctx, args: call.args,
      }),
      settleToolCall: async (_prepared: any, execution: any) => execution.result,
    });
    const effect: any = await during(async (relayToken) => {
      const prepared: any = await client.routes['actor/tool-prepare']({
        relayToken,
        call: { id: 'call-2', name: 'message_actor', args: { to: 'web', message: 'go' } },
      }, OFFSCREEN);
      return client.routes['actor/message-deliver']({
        relayToken, executionId: prepared.executionId,
        to: 'web', message: 'go', oneShot: false, awaitReply: true,
        degradeToAsync: false, awaitCapMs: 1000,
      }, OFFSCREEN);
    }, 'actor-1');
    expect(effect).toMatchObject({
      ok: false, error: 'host vanished', outcomeKnown: false, retryable: false,
    });
  });
});

describe('controller-owned Pod tools: exact isolated authority', () => {
  test('pins pod_write arguments and preserves unknown post-entry failure', async () => {
    let writes = 0;
    let legacyDispatches = 0;
    const { client, during } = clientWithRelay({
      sessions: { get: async () => ({ kind: 'actor', actorType: 'pod', instanceId: 'pod-1' }) },
      buildToolContext: async () => ({
        session: { sessionId: 'actor-pod-1', kind: 'actor' },
        podClient: {
          writeFile: async () => { writes += 1; throw new Error('write receipt lost'); },
        },
      }),
      dispatchToolCall: async () => { legacyDispatches += 1; return { ok: true }; },
      prepareToolCall: async (call: any, ctx: any) => ({
        prepared: true, call, ctx, args: call.args,
      }),
      settleToolCall: async (_prepared: any, execution: any) => execution.result,
    });
    const observed: any = await during(async (relayToken) => {
      const prepared: any = await client.routes['actor/tool-prepare']({
        relayToken,
        call: {
          id: 'call-pod-write', name: 'pod_write',
          args: { podId: 'pod-1', path: 'main.js', content: 'approved' },
        },
      }, OFFSCREEN);
      const tampered = await client.routes['pod/write-file']({
        relayToken, executionId: prepared.executionId,
        podId: 'pod-1', path: 'main.js', content: 'altered',
      }, OFFSCREEN);
      const effect = await client.routes['pod/write-file']({
        relayToken, executionId: prepared.executionId,
        podId: 'pod-1', path: 'main.js', content: 'approved',
      }, OFFSCREEN);
      const legacy = await client.routes['actor/tool-dispatch']({
        relayToken,
        call: {
          id: 'call-pod-write', name: 'pod_write',
          args: { podId: 'pod-1', path: 'main.js', content: 'approved' },
        },
      }, OFFSCREEN);
      const settled = await client.routes['actor/tool-settle']({
        relayToken, executionId: prepared.executionId,
        result: { ok: false, error: 'pod_write_failed: write receipt lost' },
      }, OFFSCREEN);
      return { prepared, tampered, effect, legacy, settled };
    }, 'actor-pod-1');

    expect(observed.prepared).toMatchObject({
      ok: true, mode: 'execute', toolName: 'pod_write',
      projection: { sessionId: 'actor-pod-1' },
    });
    expect(observed.tampered).toMatchObject({ ok: false, outcomeKnown: true });
    expect(observed.effect).toMatchObject({
      ok: false, error: 'write receipt lost', outcomeKnown: false, retryable: false,
    });
    expect(observed.legacy.error).toContain('not legacy-owned');
    expect(observed.settled).toMatchObject({
      ok: true,
      result: { ok: false, code: 'tool-outcome-unknown', outcomeKnown: false, retryable: false },
    });
    expect(writes).toBe(1);
    expect(legacyDispatches).toBe(0);
  });
});

describe('controller-owned repository tools: exact isolated authority', () => {
  test('pins Pod destruction and preserves an unknown repository receipt', async () => {
    let destroys = 0;
    let legacyDispatches = 0;
    const { client, during } = clientWithRelay({
      sessions: { get: async () => ({ kind: 'actor', actorType: 'pod', instanceId: 'pod-1' }) },
      buildToolContext: async () => ({
        actorType: 'pod', actorInstanceId: 'pod-1',
        podRegistry: {
          get: async () => ({ id: 'pod-1', name: 'owned pod', pinned: false }),
          delete: async () => {},
        },
        podTabTracker: { closeTab: async () => {} },
        repositories: {
          coordinate: async (_ref: any, operation: () => Promise<any>) => operation(),
          destroy: async () => { destroys += 1; throw new Error('destroy receipt lost'); },
        },
      }),
      dispatchToolCall: async () => { legacyDispatches += 1; return { ok: true }; },
      prepareToolCall: async (call: any, ctx: any) => ({
        prepared: true, call, ctx, args: call.args,
      }),
      settleToolCall: async (_prepared: any, execution: any) => execution.result,
    });
    const observed: any = await during(async (relayToken) => {
      const tamperedPrepared: any = await client.routes['actor/tool-prepare']({
        relayToken,
        call: {
          id: 'call-remember-tampered', name: 'remember',
          args: { scope: 'user', body: 'approved' },
        },
      }, OFFSCREEN);
      const tampered = await client.routes['memory/write']({
        relayToken, executionId: tamperedPrepared.executionId,
        scope: { kind: 'user', workspace: '', subpath: undefined }, body: 'altered',
      }, OFFSCREEN);
      const prepared: any = await client.routes['actor/tool-prepare']({
        relayToken,
        call: { id: 'call-pod-destroy', name: 'pod_destroy', args: { podId: 'pod-1' } },
      }, OFFSCREEN);
      const read = await client.routes['repository/read-pod']({
        relayToken, executionId: prepared.executionId, podId: 'pod-1',
      }, OFFSCREEN);
      const effect = await client.routes['repository/destroy-pod']({
        relayToken, executionId: prepared.executionId, podId: 'pod-1',
      }, OFFSCREEN);
      const legacy = await client.routes['actor/tool-dispatch']({
        relayToken,
        call: { id: 'call-pod-destroy', name: 'pod_destroy', args: { podId: 'pod-1' } },
      }, OFFSCREEN);
      const settled = await client.routes['actor/tool-settle']({
        relayToken, executionId: prepared.executionId,
        result: { ok: false, error: 'pod_destroy_failed: destroy receipt lost' },
      }, OFFSCREEN);
      return { prepared, read, effect, legacy, settled };
    }, 'actor-pod-1');

    expect(observed.prepared).toMatchObject({
      ok: true, mode: 'execute', toolName: 'pod_destroy',
      projection: { actorType: 'pod', actorInstanceId: 'pod-1' },
    });
    expect(observed.read).toMatchObject({
      ok: true, value: { id: 'pod-1', name: 'owned pod', pinned: false },
    });
    expect(observed.effect).toMatchObject({
      ok: false, error: 'destroy receipt lost', outcomeKnown: false, retryable: false,
    });
    expect(observed.legacy.error).toContain('not legacy-owned');
    expect(observed.settled).toMatchObject({
      ok: true,
      result: { ok: false, code: 'tool-outcome-unknown', outcomeKnown: false, retryable: false },
    });
    expect(destroys).toBe(1);
    expect(legacyDispatches).toBe(0);
  });
});

describe('controller-owned App tools: exact isolated authority', () => {
  test('preserves unknown post-entry App write failure', async () => {
    let writes = 0;
    let legacyDispatches = 0;
    const { client, during } = clientWithRelay({
      sessions: { get: async () => ({ kind: 'actor', actorType: 'app', instanceId: 'app-1' }) },
      buildToolContext: async () => ({
        session: { sessionId: 'actor-app-1', kind: 'actor' },
        appClient: {
          writeFile: async () => { writes += 1; throw new Error('App write receipt lost'); },
        },
      }),
      dispatchToolCall: async () => { legacyDispatches += 1; return { ok: true }; },
      prepareToolCall: async (call: any, ctx: any) => ({
        prepared: true, call, ctx, args: call.args,
      }),
      settleToolCall: async (_prepared: any, execution: any) => execution.result,
    });
    const observed: any = await during(async (relayToken) => {
      const prepared: any = await client.routes['actor/tool-prepare']({
        relayToken,
        call: {
          id: 'call-app-write', name: 'app_write_file',
          args: { appId: 'app-1', path: 'main.js', content: 'approved' },
        },
      }, OFFSCREEN);
      const effect = await client.routes['app/write-file']({
        relayToken, executionId: prepared.executionId,
        appId: 'app-1', path: 'main.js', content: 'approved',
      }, OFFSCREEN);
      const legacy = await client.routes['actor/tool-dispatch']({
        relayToken,
        call: {
          id: 'call-app-write', name: 'app_write_file',
          args: { appId: 'app-1', path: 'main.js', content: 'approved' },
        },
      }, OFFSCREEN);
      const settled = await client.routes['actor/tool-settle']({
        relayToken, executionId: prepared.executionId,
        result: { ok: false, error: 'app_write_file_failed: App write receipt lost' },
      }, OFFSCREEN);
      return { prepared, effect, legacy, settled };
    }, 'actor-app-1');

    expect(observed.prepared).toMatchObject({
      ok: true, mode: 'execute', toolName: 'app_write_file',
      projection: { sessionId: 'actor-app-1' },
    });
    expect(observed.effect).toMatchObject({
      ok: false, error: 'App write receipt lost', outcomeKnown: false, retryable: false,
    });
    expect(observed.legacy.error).toContain('not legacy-owned');
    expect(observed.settled).toMatchObject({
      ok: true,
      result: { ok: false, code: 'tool-outcome-unknown', outcomeKnown: false, retryable: false },
    });
    expect(writes).toBe(1);
    expect(legacyDispatches).toBe(0);
  });
});

describe('controller-owned persistence tools: exact isolated authority', () => {
  test('pins a confirmed memory write and preserves an unknown lost receipt', async () => {
    let writes = 0;
    let legacyDispatches = 0;
    const { client, during } = clientWithRelay({
      sessions: { get: async () => ({ kind: 'spawned', grantedTools: ['remember'] }) },
      buildToolContext: async () => ({
        session: { sessionId: 'actor-memory-1', kind: 'spawned' },
        memory: {
          writeWithConfirm: async () => {
            writes += 1;
            throw new Error('memory receipt lost');
          },
        },
      }),
      restrictCtxCapabilities: (ctx: any) => ctx,
      dispatchToolCall: async () => { legacyDispatches += 1; return { ok: true }; },
      prepareToolCall: async (call: any, ctx: any) => ({
        prepared: true, call, ctx, args: call.args,
      }),
      settleToolCall: async (_prepared: any, execution: any) => execution.result,
    });
    const observed: any = await during(async (relayToken) => {
      const tamperedPrepared: any = await client.routes['actor/tool-prepare']({
        relayToken,
        call: {
          id: 'call-remember-tampered', name: 'remember',
          args: { scope: 'user', body: 'approved' },
        },
      }, OFFSCREEN);
      const tampered = await client.routes['memory/write']({
        relayToken, executionId: tamperedPrepared.executionId,
        scope: { kind: 'user', workspace: '', subpath: undefined }, body: 'altered',
      }, OFFSCREEN);
      const prepared: any = await client.routes['actor/tool-prepare']({
        relayToken,
        call: {
          id: 'call-remember', name: 'remember',
          args: { scope: 'user', body: 'approved' },
        },
      }, OFFSCREEN);
      const effect = await client.routes['memory/write']({
        relayToken, executionId: prepared.executionId,
        scope: { kind: 'user', workspace: '', subpath: undefined }, body: 'approved',
      }, OFFSCREEN);
      const legacy = await client.routes['actor/tool-dispatch']({
        relayToken,
        call: {
          id: 'call-remember', name: 'remember',
          args: { scope: 'user', body: 'approved' },
        },
      }, OFFSCREEN);
      const settled = await client.routes['actor/tool-settle']({
        relayToken, executionId: prepared.executionId,
        result: { ok: false, error: 'remember_failed: memory receipt lost' },
      }, OFFSCREEN);
      return { prepared, tampered, effect, legacy, settled };
    }, 'actor-memory-1');

    expect(observed.prepared).toMatchObject({
      ok: true, mode: 'execute', toolName: 'remember',
      projection: { sessionId: 'actor-memory-1', goalActive: false },
    });
    expect(observed.tampered).toMatchObject({ ok: false, outcomeKnown: true });
    expect(observed.effect).toMatchObject({
      ok: false, error: 'memory receipt lost', outcomeKnown: false, retryable: false,
    });
    expect(observed.legacy.error).toContain('not legacy-owned');
    expect(observed.settled).toMatchObject({
      ok: true,
      result: { ok: false, code: 'tool-outcome-unknown', outcomeKnown: false, retryable: false },
    });
    expect(writes).toBe(1);
    expect(legacyDispatches).toBe(0);
  });
});

describe('controller-owned page tools: exact isolated authority', () => {
  test('pins page_code to one authority-owned run and refuses legacy dispatch', async () => {
    let legacyDispatches = 0;
    const runEvents: any[] = [];
    const { client, during } = clientWithRelay({
      sessions: { get: async () => ({ kind: 'actor', actorType: 'web', instanceId: 'web' }) },
      buildToolContext: async () => ({
        session: { sessionId: 'actor-page-1', kind: 'actor' },
        jsOffscreenClient: {
          execHeadless: async (code: string, options: any) => {
            runEvents.push(['execute', code, options]);
            return { value: 'done', error: null };
          },
        },
        scriptRuns: {
          mintRunId: () => 'page-run-actor-1',
          register: (...args: any[]) => runEvents.push(['register', ...args]),
          release: (...args: any[]) => runEvents.push(['release', ...args]),
        },
      }),
      ownedTabFor: () => 42,
      dispatchToolCall: async () => { legacyDispatches += 1; return { ok: true }; },
      prepareToolCall: async (call: any, ctx: any) => ({
        prepared: true, call, ctx, args: call.args,
      }),
      settleToolCall: async (_prepared: any, execution: any) => execution.result,
    });
    const observed: any = await during(async (relayToken) => {
      const prepared: any = await client.routes['actor/tool-prepare']({
        relayToken,
        call: { id: 'call-page-code', name: 'page_code', args: { code: 'return 1' } },
      }, OFFSCREEN);
      const effect = await client.routes['page/run-program']({
        relayToken, executionId: prepared.executionId,
      }, OFFSCREEN);
      const legacy = await client.routes['actor/tool-dispatch']({
        relayToken,
        call: { id: 'call-page-code', name: 'page_code', args: { code: 'return 1' } },
      }, OFFSCREEN);
      const settled = await client.routes['actor/tool-settle']({
        relayToken, executionId: prepared.executionId,
        result: { ok: true, content: 'done' },
      }, OFFSCREEN);
      return { prepared, effect, legacy, settled };
    }, 'actor-page-1');

    expect(observed.prepared).toMatchObject({
      ok: true, mode: 'execute', toolName: 'page_code',
      projection: { sessionId: 'actor-page-1' },
    });
    expect(observed.effect).toMatchObject({
      ok: true, outcomeKnown: true, value: { value: 'done', error: null },
    });
    expect(observed.legacy.error).toContain('not legacy-owned');
    expect(observed.settled).toMatchObject({ ok: true, result: { ok: true, content: 'done' } });
    expect(runEvents[0]).toEqual([
      'register', 'page-run-actor-1', expect.anything(), 'actor-page-1', { page: true },
    ]);
    expect(runEvents.at(-1)).toEqual(['release', 'page-run-actor-1']);
    expect(legacyDispatches).toBe(0);
  });
});

describe('controller-owned introspection tools: exact isolated authority', () => {
  test('filters and relays inspect session tabs without legacy dispatch', async () => {
    let legacyDispatches = 0;
    const { client, during } = clientWithRelay({
      sessions: { get: async () => ({ kind: 'spawned', grantedTools: ['inspect'] }) },
      buildToolContext: async () => ({
        session: { sessionId: 'actor-inspect-1', kind: 'spawned' },
        tabs: { query: async () => [
          { id: 1, url: 'https://example.test/x', title: 'Docs', active: true },
          { id: 2, url: 'http://127.0.0.1/admin', title: 'Admin' },
        ] },
        denylist: [],
      }),
      restrictCtxCapabilities: (ctx: any) => ctx,
      dispatchToolCall: async () => { legacyDispatches += 1; return { ok: true }; },
      prepareToolCall: async (call: any, ctx: any) => ({
        prepared: true, call, ctx, args: call.args,
      }),
      settleToolCall: async (_prepared: any, execution: any) => execution.result,
    });
    const observed: any = await during(async (relayToken) => {
      const call = {
        id: 'call-inspect-tabs', name: 'inspect', args: { kind: 'session_access' },
      };
      const prepared: any = await client.routes['actor/tool-prepare']({
        relayToken, call,
      }, OFFSCREEN);
      const effect = await client.routes['introspection/automatable-tabs']({
        relayToken, executionId: prepared.executionId,
      }, OFFSCREEN);
      const legacy = await client.routes['actor/tool-dispatch']({ relayToken, call }, OFFSCREEN);
      const settled = await client.routes['actor/tool-settle']({
        relayToken, executionId: prepared.executionId,
        result: { ok: true, content: 'one tab' },
      }, OFFSCREEN);
      return { prepared, effect, legacy, settled };
    }, 'actor-inspect-1');

    expect(observed.prepared).toMatchObject({
      ok: true, mode: 'execute', toolName: 'inspect',
    });
    expect(observed.effect).toMatchObject({
      ok: true, outcomeKnown: true,
      value: [{ id: 1, url: 'https://example.test/x', title: 'Docs', active: true }],
    });
    expect(observed.legacy.error).toContain('not legacy-owned');
    expect(observed.settled).toMatchObject({
      ok: true, result: { ok: true, content: 'one tab' },
    });
    expect(legacyDispatches).toBe(0);
  });
});
