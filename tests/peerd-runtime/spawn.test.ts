import { describe, test, expect } from 'bun:test';
import {
  makeSpawnActor,
  narrowTools,
  finalAssistantText,
  restrictCtxCapabilities,
  CAPABILITY_CONSUMERS,
  DEFAULT_MAX_DEPTH,
} from '../../extension/peerd-runtime/actor/spawn.js';

// ---- pure helpers ---------------------------------------------------------

describe('narrowTools', () => {
  const all = [{ name: 'a' }, { name: 'b' }, { name: 'actor_create' }];

  test('default: inherits all parent tools MINUS actor_create', () => {
    expect(narrowTools(all, {}).map((t) => t.name)).toEqual(['a', 'b']);
  });

  test('allowRecursion keeps actor_create', () => {
    expect(narrowTools(all, { allowRecursion: true }).map((t) => t.name))
      .toEqual(['a', 'b', 'actor_create']);
  });

  test('explicit list intersects with registered tools', () => {
    expect(narrowTools(all, { tools: ['a', 'nope'] }).map((t) => t.name)).toEqual(['a']);
  });

  test('explicit list still drops actor_create unless allowRecursion', () => {
    expect(narrowTools(all, { tools: ['a', 'actor_create'] }).map((t) => t.name)).toEqual(['a']);
    expect(narrowTools(all, { tools: ['a', 'actor_create'], allowRecursion: true }).map((t) => t.name))
      .toEqual(['a', 'actor_create']);
  });

  test('empty array means NO tools', () => {
    expect(narrowTools(all, { tools: [] })).toEqual([]);
  });
});

describe('finalAssistantText', () => {
  test('returns the last non-empty assistant message', () => {
    const session = {
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '', toolUses: [{ id: 't1' }] },
        { role: 'user', content: '', toolResults: [{ tool_use_id: 't1' }] },
        { role: 'assistant', content: 'the answer' },
      ],
    };
    expect(finalAssistantText(session as any)).toBe('the answer');
  });

  test('empty string when there is no assistant text', () => {
    expect(finalAssistantText({ messages: [{ role: 'user', content: 'hi' }] } as any)).toBe('');
    expect(finalAssistantText(undefined)).toBe('');
  });
});

describe('restrictCtxCapabilities', () => {
  // A stand-in for the full ctx buildToolContext hands every context: every
  // capability closure present, plus non-capability fields that must survive.
  const fullCtx = () => ({
    getSecret: () => 'KEY',
    safeFetch: () => {},
    webFetch: () => {},
    webCache: { get: () => {}, put: () => {}, key: () => 'k' },
    memory: { read: () => {} },
    kv: { get: () => {} },
    idb: { getAll: () => {} },
    spawnActor: () => {},
    spawnActorAsync: () => {},
    actorTasks: () => {},
    actorCancel: () => {},
    requestReview: () => {},
    dweb: { share: () => {} },
    // non-capability fields — always retained
    denylist: ['evil.com'],
    allowlist: ['https://api.anthropic.com'],
    activeTab: { id: 1 },
    debuggerPool: {},
    scripting: {},
    domRefs: {},
    audit: () => {},
    confirm: () => {},
  });

  const CAP_KEYS = Object.keys(CAPABILITY_CONSUMERS);

  test("a DOM-only runner toolset strips EVERY capability — no path to secrets/egress/spawn", () => {
    // read_page is deliberately EXCLUDED here: it consumes webCache (its
    // mode:'content' spill pager), so it is not a no-capability DOM tool — the
    // read_page→webCache grant is asserted on its own below. The rest of the
    // DOM toolset consumes nothing, so this set must strip every capability.
    const allowed = new Set(['snapshot', 'click', 'type', 'navigate', 'query_dom']);
    const out = restrictCtxCapabilities(fullCtx(), allowed);
    for (const cap of CAP_KEYS) expect(out[cap as keyof typeof out]).toBeUndefined();
    // the high-value ones, called out explicitly
    expect('getSecret' in out).toBe(false);
    expect('safeFetch' in out).toBe(false);
    expect('webFetch' in out).toBe(false);
    expect('spawnActor' in out).toBe(false);
    expect('dweb' in out).toBe(false);
    // non-capability fields survive
    expect(out.activeTab).toEqual({ id: 1 });
    expect(out.denylist).toEqual(['evil.com']);
    expect(typeof out.audit).toBe('function');
  });

  test('a capability is KEPT when a granted tool consumes it', () => {
    expect('webFetch' in restrictCtxCapabilities(fullCtx(), new Set(['fetch_url']))).toBe(true);
    expect('webFetch' in restrictCtxCapabilities(fullCtx(), new Set(['vm_import']))).toBe(true);
    // read_page mode:'content' pages its overflow through webCache — the grant
    // that #189 added to CAPABILITY_CONSUMERS.webCache must survive narrowing.
    expect('webCache' in restrictCtxCapabilities(fullCtx(), new Set(['read_page']))).toBe(true);
    expect('webCache' in restrictCtxCapabilities(fullCtx(), new Set(['read_web_cache']))).toBe(true);
    expect('memory' in restrictCtxCapabilities(fullCtx(), new Set(['remember']))).toBe(true);
    expect('requestReview' in restrictCtxCapabilities(fullCtx(), new Set(['request_review']))).toBe(true);
    // sandbox_create keeps the dweb closure (its app arm reads ctx.dweb for the dwapp flag)
    expect('dweb' in restrictCtxCapabilities(fullCtx(), new Set(['sandbox_create']))).toBe(true);
    expect('dweb' in restrictCtxCapabilities(fullCtx(), new Set(['dweb_share']))).toBe(true);
  });

  test('getSecret / safeFetch have NO tool consumer — always stripped', () => {
    // even a child granted EVERY known consumer keeps neither.
    const everyConsumer = new Set(Object.values(CAPABILITY_CONSUMERS).flat());
    const out = restrictCtxCapabilities(fullCtx(), everyConsumer);
    expect('getSecret' in out).toBe(false);
    expect('safeFetch' in out).toBe(false);
    // but the ones with consumers are all kept
    expect('webFetch' in out).toBe(true);
    expect('spawnActor' in out).toBe(true);
  });

  test('spawn closure is stripped for a non-recursive actor (no actor_create granted)', () => {
    // the inherit-all-but-spawn case: tools present but actor_create narrowed out.
    const allowed = new Set(['fetch_url', 'read_memory', 'request_review']);
    const out = restrictCtxCapabilities(fullCtx(), allowed);
    expect('spawnActor' in out).toBe(false);
    expect('spawnActorAsync' in out).toBe(false);
    expect('webFetch' in out).toBe(true);   // fetch_url needs it
    expect('memory' in out).toBe(true);     // read_memory needs it
  });

  test('does not mutate the input ctx (parent ctx closures stay intact)', () => {
    const ctx = fullCtx();
    restrictCtxCapabilities(ctx, new Set(['click']));
    expect(typeof ctx.getSecret).toBe('function'); // original untouched
  });
});

// ---- orchestrator ---------------------------------------------------------

// Minimal in-memory session store with the actor fields the
// orchestrator reads/writes. Mirrors createSessionStore's create/get
// surface without pulling the `/shared`-rooted real implementation.
const makeStore = () => {
  const map = new Map<string, any>();
  let n = 0;
  return {
    map,
    create: async (opts: any = {}) => {
      const s = {
        sessionId: `s-${++n}`,
        createdAt: n,
        messages: [] as any[],
        provider: opts.provider ?? 'anthropic',
        model: opts.model ?? 'inherited-model',
        kind: opts.kind ?? 'chat',
        depth: opts.depth ?? 0,
        // Mirror createSessionStore: Plan/Act fields persist only when
        // explicitly provided (absent keys mean "fall back to the global
        // cached permission at read time").
        ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
        ...(opts.confirmActions !== undefined ? { confirmActions: opts.confirmActions } : {}),
        ...(opts.parentSessionId ? { parentSessionId: opts.parentSessionId } : {}),
        ...(opts.task ? { task: opts.task } : {}),
      };
      map.set(s.sessionId, s);
      return s;
    },
    get: async (id: string) => map.get(id),
    appendMessage: async (id: string, msg: any) => {
      const s = map.get(id);
      s.messages.push(msg);
      return s;
    },
  };
};

// Configurable mock loop standing in for runUserTurn. It exercises the
// injected callModel (so the output cap is observable), appends a final
// assistant message to the store, and yields tool-use + stop events so
// the orchestrator's counting/exceeded logic runs against real events.
const makeMockLoop = (opts: { finalText?: string; toolUses?: number; stopReason?: string } = {}) => {
  const { finalText = 'actor done', toolUses = 0, stopReason = 'end_turn' } = opts;
  const calls: any[] = [];
  async function* loop(ctx: any) {
    // drive the model once so cappedCallModel's injected maxTokens shows up
    const stream = ctx.callModel({ messages: [], system: 'sys', tools: ctx.tools });
    for await (const _ of stream) { /* drain */ }
    for (let i = 0; i < toolUses; i++) {
      yield { type: 'tool-use', sessionId: ctx.sessionId, toolUseId: `tu-${i}`, name: 'a', input: {} };
    }
    await ctx.sessions.appendMessage(ctx.sessionId, { role: 'assistant', content: finalText });
    yield { type: 'stop', sessionId: ctx.sessionId, stopReason };
  }
  return { loop, calls };
};

const baseDeps = (store: any, loop: any, extra: any = {}) => {
  const audits: any[] = [];
  const modelCalls: any[] = [];
  return {
    audits,
    modelCalls,
    deps: {
      sessions: store,
      runUserTurn: loop,
      callModel: async function* (args: any) { modelCalls.push(args); yield { type: 'message-stop', stopReason: 'end_turn' }; },
      getSecret: async () => 'sk-test',
      safeFetch: async () => new Response('ok'),
      appendAudit: async (e: any) => { audits.push(e); },
      buildToolContext: async ({ sessionId }: any) => ({ session: { sessionId }, audit: async () => {} }),
      dispatchToolCall: async () => ({ ok: true, content: 'tool ran' }),
      renderSystemPrompt: async ({ taskOverride }: any) => `sys task=${taskOverride}`,
      getToolDescriptors: () => [
        { name: 'a', description: 'A', schema: {} },
        { name: 'b', description: 'B', schema: {} },
        { name: 'actor_create', description: 'S', schema: {} },
      ],
      now: (() => { let t = 1000; return () => (t += 25); })(),
      ...extra,
    },
  };
};

// The in-SW fallback path (Firefox / a run that never started offscreen) has no
// heap separation — that is the standing residual. What it MUST have is the
// offscreen path's credential custody: the child loop is handed throwing stubs and
// the real getSecret/safeFetch are added by the SW-owned callModel wrapper at the
// call boundary. Before this, the live credentials went straight into runUserTurn,
// so the "keyless fallback" claim held for the tool context but not for the loop.
describe('makeSpawnActor — the in-SW fallback loop is keyless', () => {
  test('the loop gets THROWING credential stubs, never the live ones', async () => {
    const store = makeStore();
    const parent = await store.create({});
    let loopCtx: any = null;
    async function* loop(ctx: any) {
      loopCtx = ctx;
      for await (const _ of ctx.callModel({ messages: [], system: 's', tools: [] })) { /* drain */ }
      await ctx.sessions.appendMessage(ctx.sessionId, { role: 'assistant', content: 'done' });
      yield { type: 'stop', sessionId: ctx.sessionId, stopReason: 'end_turn' };
    }
    const { deps } = baseDeps(store, loop);
    await makeSpawnActor(deps)({ task: 't', parentSessionId: parent.sessionId });

    expect(loopCtx).not.toBeNull();
    // Not the injected live credentials — and not merely absent: calling them
    // throws, so a loop (or anything reachable from its frame) that reaches for
    // the key fails loudly instead of silently succeeding.
    await expect(loopCtx.getSecret('anthropic')).rejects.toThrow(/no secret access/);
    await expect(loopCtx.safeFetch('https://example.com')).rejects.toThrow(/no egress/);
  });

  test('the model call still receives the REAL credentials from the wrapper', async () => {
    const store = makeStore();
    const parent = await store.create({});
    // The loop must forward ctx.getSecret/ctx.safeFetch into ctx.callModel, exactly as
    // the real agent-loop does. why that matters here: the stubs and the real
    // credentials COLLIDE in cappedCallModel's object literal, and only the spread
    // order ({...modelArgs, getSecret, safeFetch}) decides which wins. A mock that
    // omits the forward never creates the collision, so the natural deps-first
    // ordering — which hands every in-SW model call a getSecret that throws and kills
    // the whole fallback lane — would pass. Mutation-checked: flipping the order in
    // spawn.js fails this test.
    let loopCtx: any = null;
    async function* loop(ctx: any) {
      loopCtx = ctx;
      const stream = ctx.callModel({
        messages: [], system: 's', tools: [],
        getSecret: ctx.getSecret, safeFetch: ctx.safeFetch,
      });
      for await (const _ of stream) { /* drain */ }
      await ctx.sessions.appendMessage(ctx.sessionId, { role: 'assistant', content: 'done' });
      yield { type: 'stop', sessionId: ctx.sessionId, stopReason: 'end_turn' };
    }
    const { deps, modelCalls } = baseDeps(store, loop);
    await makeSpawnActor(deps)({ task: 't', parentSessionId: parent.sessionId });

    // Custody moved to the call boundary, so the child can still think — the
    // point is WHERE the key is reachable, not that the lane stops working.
    expect(modelCalls.length).toBeGreaterThan(0);
    expect(await modelCalls[0].getSecret('anthropic')).toBe('sk-test');
    expect(typeof modelCalls[0].safeFetch).toBe('function');
    // And the loop's own view is still the stub, even though it forwarded it.
    await expect(loopCtx.getSecret('anthropic')).rejects.toThrow(/no secret access/);
  });
});

describe('makeSpawnActor', () => {
  test('creates an actor session with parentage and inherits the parent model', async () => {
    const store = makeStore();
    const parent = await store.create({ model: 'parent-model' });
    const { loop } = makeMockLoop({ finalText: 'hello from child' });
    const { deps } = baseDeps(store, loop);
    const spawn = makeSpawnActor(deps);

    const out = await spawn({ task: 'do a thing', parentSessionId: parent.sessionId, parentDepth: 0 });

    if (out.sessionId === null) throw new Error('expected a child session');
    const child = store.map.get(out.sessionId);
    expect(child.kind).toBe('spawned');
    expect(child.parentSessionId).toBe(parent.sessionId);
    expect(child.depth).toBe(1);
    expect(child.task).toBe('do a thing');
    expect(child.model).toBe('parent-model');   // inherited model
    expect(out.result).toBe('hello from child');
    expect(out.depth).toBe(1);
  });

  test('inherits the parent Plan/Act permission into the child record', async () => {
    const store = makeStore();
    // A Plan-mode parent: without inheritance the child record carries no
    // permission fields and resolvePermission falls back to the GLOBAL
    // cached mode — i.e. the child could silently run in Act while its
    // parent is locked to Plan.
    const parent = await store.create({ permissionMode: 'plan', confirmActions: true });
    const { loop } = makeMockLoop();
    const { deps } = baseDeps(store, loop);
    const spawn = makeSpawnActor(deps);

    const out = await spawn({ task: 't', parentSessionId: parent.sessionId });

    if (out.sessionId === null) throw new Error('expected a child session');
    const child = store.map.get(out.sessionId);
    expect(child.permissionMode).toBe('plan');
    expect(child.confirmActions).toBe(true);
  });

  test('parent without explicit permission leaves the child record clean', async () => {
    const store = makeStore();
    const parent = await store.create({});
    const { loop } = makeMockLoop();
    const { deps } = baseDeps(store, loop);
    const spawn = makeSpawnActor(deps);

    const out = await spawn({ task: 't', parentSessionId: parent.sessionId });

    // Absent keys, not undefined values — the child must keep the normal
    // "resolve from cache/defaults at read time" path.
    if (out.sessionId === null) throw new Error('expected a child session');
    const child = store.map.get(out.sessionId);
    expect('permissionMode' in child).toBe(false);
    expect('confirmActions' in child).toBe(false);
  });

  test('inherits confirmActions alone when the parent has no explicit mode', async () => {
    const store = makeStore();
    const parent = await store.create({ confirmActions: false });
    const { loop } = makeMockLoop();
    const { deps } = baseDeps(store, loop);
    const spawn = makeSpawnActor(deps);

    const out = await spawn({ task: 't', parentSessionId: parent.sessionId });

    if (out.sessionId === null) throw new Error('expected a child session');
    const child = store.map.get(out.sessionId);
    expect('permissionMode' in child).toBe(false);
    expect(child.confirmActions).toBe(false);
  });

  test('refuses past maxDepth without creating a session', async () => {
    const store = makeStore();
    const parent = await store.create({});
    const { loop } = makeMockLoop();
    const { deps, audits } = baseDeps(store, loop);
    const spawn = makeSpawnActor(deps);

    const before = store.map.size;
    const out = await spawn({
      task: 't', parentSessionId: parent.sessionId, parentDepth: DEFAULT_MAX_DEPTH,
    });

    expect(out.refused).toBe(true);
    expect(out.exceeded).toBe(true);
    expect(out.sessionId).toBeNull();
    expect(store.map.size).toBe(before);        // no child session created
    expect(audits.some((a) => a.type === 'actor_refused')).toBe(true);
  });

  test('respects a custom maxDepth', async () => {
    const store = makeStore();
    const parent = await store.create({});
    const { loop } = makeMockLoop();
    const { deps } = baseDeps(store, loop);
    const spawn = makeSpawnActor(deps);

    // parentDepth 1 → child depth 2; maxDepth 1 refuses.
    const out = await spawn({ task: 't', parentSessionId: parent.sessionId, parentDepth: 1, maxDepth: 1 });
    expect(out.refused).toBe(true);
  });

  test('narrows tools and forbids actor_create by default', async () => {
    const store = makeStore();
    const parent = await store.create({});
    let seenTools: any[] = [];
    async function* loop(ctx: any) {
      seenTools = ctx.tools;
      await ctx.sessions.appendMessage(ctx.sessionId, { role: 'assistant', content: 'ok' });
      yield { type: 'stop', sessionId: ctx.sessionId, stopReason: 'end_turn' };
    }
    const { deps } = baseDeps(store, loop);
    const spawn = makeSpawnActor(deps);

    await spawn({ task: 't', parentSessionId: parent.sessionId });
    expect(seenTools.map((t: any) => t.name)).toEqual(['a', 'b']);
  });

  test('explicit empty tools array → pure-reasoning actor (no tools)', async () => {
    const store = makeStore();
    const parent = await store.create({});
    let seenTools: any[] = [];
    let ctxBuilt = false;
    async function* loop(ctx: any) {
      seenTools = ctx.tools;
      await ctx.sessions.appendMessage(ctx.sessionId, { role: 'assistant', content: 'ok' });
      yield { type: 'stop', sessionId: ctx.sessionId, stopReason: 'end_turn' };
    }
    const { deps } = baseDeps(store, loop, {
      buildToolContext: async () => { ctxBuilt = true; return { session: {}, audit: async () => {} }; },
    });
    const spawn = makeSpawnActor(deps);

    await spawn({ task: 't', parentSessionId: parent.sessionId, tools: [] });
    expect(seenTools).toEqual([]);
    expect(ctxBuilt).toBe(false);   // no dispatcher plumbing for a tool-less actor
  });

  test('counts tool calls and reports the result shape', async () => {
    const store = makeStore();
    const parent = await store.create({});
    const { loop } = makeMockLoop({ finalText: 'R', toolUses: 3 });
    const { deps } = baseDeps(store, loop);
    const spawn = makeSpawnActor(deps);

    const out = await spawn({ task: 't', parentSessionId: parent.sessionId });
    expect(out.toolCalls).toBe(3);
    expect(out.result).toBe('R');
    expect(typeof out.durationMs).toBe('number');
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
    expect(out.exceeded).toBeUndefined();
  });

  test('flags exceeded when the loop stops on max_steps', async () => {
    const store = makeStore();
    const parent = await store.create({});
    const { loop } = makeMockLoop({ stopReason: 'max_steps' });
    const { deps } = baseDeps(store, loop);
    const spawn = makeSpawnActor(deps);

    const out = await spawn({ task: 't', parentSessionId: parent.sessionId, maxSteps: 5 });
    expect(out.exceeded).toBe(true);
  });

  test('injects the output-token cap into model calls', async () => {
    const store = makeStore();
    const parent = await store.create({});
    const { loop } = makeMockLoop();
    const { deps, modelCalls } = baseDeps(store, loop);
    const spawn = makeSpawnActor(deps);

    await spawn({ task: 't', parentSessionId: parent.sessionId, maxOutputTokens: 256 });
    expect(modelCalls.length).toBeGreaterThan(0);
    expect(modelCalls[0].maxTokens).toBe(256);
  });

  test('tags every audit entry with parentage + depth', async () => {
    const store = makeStore();
    const parent = await store.create({});
    const { loop } = makeMockLoop();
    const { deps, audits } = baseDeps(store, loop);
    const spawn = makeSpawnActor(deps);

    const out = await spawn({ task: 't', parentSessionId: parent.sessionId });
    const tagged = audits.filter((a) => a.details?.parentSessionId === parent.sessionId);
    expect(tagged.length).toBeGreaterThan(0);
    for (const a of tagged) {
      expect(a.details.depth).toBe(1);
      expect(a.details.actorSessionId).toBe(out.sessionId);
    }
    expect(audits.some((a) => a.type === 'actor_spawned')).toBe(true);
    expect(audits.some((a) => a.type === 'actor_completed')).toBe(true);
  });

  test('forwards live events with actor-start / actor-stop bookends', async () => {
    const store = makeStore();
    const parent = await store.create({});
    const { loop } = makeMockLoop({ toolUses: 1 });
    const { deps } = baseDeps(store, loop);
    const spawn = makeSpawnActor(deps);

    const events: any[] = [];
    const out = await spawn({
      task: 't', parentSessionId: parent.sessionId,
      onEvent: (ev: any) => events.push(ev), parentToolUseId: 'card-1',
    });

    expect(events[0].type).toBe('actor-start');
    expect(events[0].parentToolUseId).toBe('card-1');
    expect(events[0].sessionId).toBe(out.sessionId);
    expect(events[events.length - 1].type).toBe('actor-stop');
    expect(events.some((e) => e.type === 'tool-use')).toBe(true);
  });

  test('refuses an empty task', async () => {
    const store = makeStore();
    const parent = await store.create({});
    const { loop } = makeMockLoop();
    const { deps } = baseDeps(store, loop);
    const spawn = makeSpawnActor(deps);
    const out = await spawn({ task: '   ', parentSessionId: parent.sessionId });
    expect(out.refused).toBe(true);
    expect(out.sessionId).toBeNull();
  });
});

// ---- actor context building ---------------------------------------------

describe('actor context building', () => {
  test('getSystemPrompt renders the normal actor prompt (base + taskOverride)', async () => {
    const store = makeStore();
    const parent = await store.create({});
    let seenSystem = '';
    async function* loop(ctx: any) {
      seenSystem = await ctx.getSystemPrompt();
      await ctx.sessions.appendMessage(ctx.sessionId, { role: 'assistant', content: 'ok' });
      yield { type: 'stop', sessionId: ctx.sessionId, stopReason: 'end_turn' };
    }
    const { deps } = baseDeps(store, loop);
    const spawn = makeSpawnActor(deps);
    await spawn({ task: 'a thing', parentSessionId: parent.sessionId });
    expect(seenSystem).toBe('sys task=a thing'); // base+taskOverride path
  });

  test('buildToolContext is called without a tab pin (no activeTabId)', async () => {
    const store = makeStore();
    const parent = await store.create({});
    const ctxArgs: any[] = [];
    const { loop } = makeMockLoop();
    const { deps } = baseDeps(store, loop, {
      buildToolContext: async (args: any) => { ctxArgs.push(args); return { session: { sessionId: args.sessionId }, audit: async () => {} }; },
    });
    const spawn = makeSpawnActor(deps);
    await spawn({ task: 'a thing', parentSessionId: parent.sessionId });
    expect(ctxArgs.length).toBe(1);
    expect(ctxArgs[0].activeTabId).toBeUndefined();
  });

  test('accumulates child model usage and returns it (separate from the parent tally)', async () => {
    const store = makeStore();
    const parent = await store.create({});
    async function* loop(ctx: any) {
      yield { type: 'usage', sessionId: ctx.sessionId, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 3000, cacheWriteTokens: 50 } };
      yield { type: 'usage', sessionId: ctx.sessionId, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 1000, cacheWriteTokens: 0 } };
      await ctx.sessions.appendMessage(ctx.sessionId, { role: 'assistant', content: 'done' });
      yield { type: 'stop', sessionId: ctx.sessionId, stopReason: 'end_turn' };
    }
    const { deps } = baseDeps(store, loop);
    const spawn = makeSpawnActor(deps);
    const out = await spawn({ task: 't', parentSessionId: parent.sessionId });
    expect(out.usage).toEqual({ inputTokens: 110, outputTokens: 25, cacheReadTokens: 4000, cacheWriteTokens: 50 });
  });
});

describe('makeSpawnActor — persistDeltas (ephemeral speed path)', () => {
  test('persistDeltas:false threads to the loop; userText is exactly the task', async () => {
    const store = makeStore();
    const parent = await store.create({});
    const seen: any[] = [];
    async function* loop(ctx: any) {
      seen.push({ userText: ctx.userText, persistDeltas: ctx.persistDeltas });
      await ctx.sessions.appendMessage(ctx.sessionId, { role: 'assistant', content: 'ok' });
      yield { type: 'stop', sessionId: ctx.sessionId, stopReason: 'end_turn' };
    }
    const { deps, audits } = baseDeps(store, loop);
    const spawn = makeSpawnActor(deps);

    const events: any[] = [];
    await spawn({
      task: 'find the price',
      persistDeltas: false,
      parentSessionId: parent.sessionId,
      parentDepth: 0,
      onEvent: (ev: any) => events.push(ev),
    });

    expect(seen[0].userText).toBe('find the price');
    expect(seen[0].persistDeltas).toBe(false);
    const child = [...store.map.values()].find((s: any) => s.kind === 'spawned');
    expect(child.task).toBe('find the price');
    const spawned = audits.find((a: any) => a.type === 'actor_spawned');
    expect(spawned.details.task).toBe('find the price');
    const startEv = events.find((e: any) => e.type === 'actor-start');
    expect(startEv.task).toBe('find the price');
  });

  test('persistDeltas defaults true', async () => {
    const store = makeStore();
    const parent = await store.create({});
    const seen: any[] = [];
    async function* loop(ctx: any) {
      seen.push({ userText: ctx.userText, persistDeltas: ctx.persistDeltas });
      await ctx.sessions.appendMessage(ctx.sessionId, { role: 'assistant', content: 'ok' });
      yield { type: 'stop', sessionId: ctx.sessionId, stopReason: 'end_turn' };
    }
    const { deps } = baseDeps(store, loop);
    const spawn = makeSpawnActor(deps);
    await spawn({ task: 'plain task', parentSessionId: parent.sessionId, parentDepth: 0 });
    expect(seen[0].userText).toBe('plain task');
    expect(seen[0].persistDeltas).toBe(true);
  });
});
