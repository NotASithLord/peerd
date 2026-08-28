import { describe, test, expect } from 'bun:test';
import {
  ActorPersistenceError,
  makeSpawnActor,
  narrowTools,
  finalActorTurnReply, finalAssistantText,
  DEFAULT_MAX_DEPTH,
} from '../../extension/peerd-runtime/actor/spawn.js';
import { ACTOR_CREDENTIAL_BOUNDARY_FAILURE } from '../../extension/peerd-runtime/errors.js';

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

  test('explicit list intersects with available tools', () => {
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

describe('finalActorTurnReply', () => {
  test('preserves a persisted provider refusal as a failed actor reply', () => {
    expect(finalActorTurnReply({ messages: [
      { role: 'assistant', content: 'partial text', error: ACTOR_CREDENTIAL_BOUNDARY_FAILURE },
    ] } as any)).toEqual({
      result: ACTOR_CREDENTIAL_BOUNDARY_FAILURE,
      stopped: true,
    });
  });

  test('returns clean text and keeps the empty-turn Stop fallback', () => {
    expect(finalActorTurnReply({ messages: [
      { role: 'assistant', content: 'done' },
    ] } as any)).toEqual({ result: 'done' });
    expect(finalActorTurnReply({ messages: [] } as any)).toEqual({
      result: 'the actor turn was stopped before it produced a reply.',
      stopped: true,
    });
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
        ...(opts.toolManifest !== undefined ? { toolManifest: opts.toolManifest } : {}),
        ...(opts.grantedOperations !== undefined
          ? { grantedOperations: opts.grantedOperations } : {}),
        ...(opts.spawnedTrusted !== undefined ? { spawnedTrusted: opts.spawnedTrusted } : {}),
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
  const renderSystemPrompt = extra.renderSystemPrompt
    ?? (async ({ taskOverride }: any) => `sys task=${taskOverride}`);
  const runChildOffscreen = Object.hasOwn(extra, 'runChildOffscreen')
    ? extra.runChildOffscreen
    : async (job: any, opts: any = {}) => {
    const newMessages: any[] = [];
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let toolCalls = 0;
    let stopReason = 'end_turn';
    const callModel = async function* (args: any) {
      modelCalls.push({ ...args, maxTokens: job.maxOutputTokens });
      yield { type: 'message-stop', stopReason: 'end_turn' };
    };
    const sessions = {
      appendMessage: async (_sessionId: string, message: any) => {
        newMessages.push(message);
        return message;
      },
    };
    for await (const event of loop({
      sessionId: job.sessionId,
      userText: job.task,
      callModel,
      sessions,
      tools: job.tools,
      maxSteps: job.maxSteps,
      maxOutputTokens: job.maxOutputTokens,
      getSystemPrompt: async () => job.systemPrompt,
      signal: opts.signal,
    })) {
      opts.onEvent?.(event);
      if (event.type === 'tool-use') toolCalls++;
      if (event.type === 'stop') stopReason = event.stopReason;
      if (event.type === 'usage') {
        usage.inputTokens += event.usage?.inputTokens ?? 0;
        usage.outputTokens += event.usage?.outputTokens ?? 0;
        usage.cacheReadTokens += event.usage?.cacheReadTokens ?? 0;
        usage.cacheWriteTokens += event.usage?.cacheWriteTokens ?? 0;
      }
    }
    const finalText = [...newMessages].reverse()
      .find((message) => message.role === 'assistant' && message.content)?.content ?? '';
    return { ok: true, started: true, finalText, newMessages, usage, stopReason, toolCalls };
    };
  const availableTools = [
    { name: 'a', description: 'A', schema: {} },
    { name: 'b', description: 'B', schema: {} },
    { name: 'actor_create', description: 'S', schema: {} },
  ];
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
      renderSystemPrompt,
      renderSystemPromptForChild: (task: string) => renderSystemPrompt({ taskOverride: task }),
      runChildOffscreen,
      projectChildSurface: async (input: any) => ({
        tools: narrowTools(availableTools, {
          tools: input.toolNames,
          allowRecursion: input.allowRecursion,
          allow: Array.isArray(input.toolManifest?.allow)
            ? new Set(input.toolManifest.allow) : null,
        }),
        operations: [],
      }),
      now: (() => { let t = 1000; return () => (t += 25); })(),
      ...extra,
    },
  };
};

describe('makeSpawnActor', () => {
  test('refuses when no dedicated worker host is wired', async () => {
    const store = makeStore();
    const parent = await store.create({});
    let loopRuns = 0;
    async function* loop() { loopRuns++; yield { type: 'stop', stopReason: 'end_turn' }; }
    const { deps, audits, modelCalls } = baseDeps(store, loop, {
      runChildOffscreen: null,
      renderSystemPromptForChild: null,
      buildToolContext: async () => { throw new Error('tool context must not be built'); },
    });

    const result = await makeSpawnActor(deps)({ task: 't', parentSessionId: parent.sessionId });

    expect(result.refused).toBe(true);
    expect(result.result).toContain('no dedicated worker host is wired');
    expect(loopRuns).toBe(0);
    expect(modelCalls).toEqual([]);
    expect(audits).toContainEqual(expect.objectContaining({
      type: 'actor_isolation_failure', details: expect.objectContaining({ performed: false }),
    }));
  });

  test('a worker startup failure never falls back to the background loop', async () => {
    const store = makeStore();
    const parent = await store.create({});
    let loopRuns = 0;
    async function* loop() { loopRuns++; yield { type: 'stop', stopReason: 'end_turn' }; }
    const { deps, audits, modelCalls } = baseDeps(store, loop, {
      runChildOffscreen: async () => ({
        ok: false, started: false, phase: 'startup',
        code: 'actor_worker_spawn_failed', error: 'worker failed to start',
      }),
    });

    const result = await makeSpawnActor(deps)({ task: 't', parentSessionId: parent.sessionId });

    expect(result.refused).toBe(true);
    expect(result.result).toBe('Temporarily unavailable. Try again.');
    expect(loopRuns).toBe(0);
    expect(modelCalls).toEqual([]);
    expect(audits).toContainEqual(expect.objectContaining({
      type: 'actor_isolation_failure', details: expect.objectContaining({ performed: false }),
    }));
  });

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

  test('fails explicitly when an isolated result cannot be persisted', async () => {
    const store = makeStore();
    const parent = await store.create({});
    const { loop } = makeMockLoop({ finalText: 'work may have happened' });
    const { deps, audits } = baseDeps(store, loop);
    store.appendMessage = async () => { throw new Error('idb unavailable'); };
    const spawn = makeSpawnActor(deps);

    try {
      await spawn({ task: 'do a thing', parentSessionId: parent.sessionId });
      throw new Error('expected persistence failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ActorPersistenceError);
      expect((error as Error).message).toContain('outcome is unknown');
      expect((error as Error).message).toContain('must not be retried automatically');
    }
    expect(audits).toContainEqual(expect.objectContaining({
      type: 'actor_persistence_failed',
      details: expect.objectContaining({ performed: true, outcomeKnown: false }),
    }));
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

  test('intersects controller descriptors and operations with exact run ceilings', async () => {
    const store = makeStore();
    const parent = await store.create({});
    let job: any = null;
    const { loop } = makeMockLoop();
    const { deps } = baseDeps(store, loop, {
      projectChildSurface: async (input: any) => {
        expect(input).toEqual({
          surface: 'spawn', toolManifest: null,
          toolNames: ['a'], allowRecursion: false,
        });
        return {
          tools: [{ name: 'a', primitive: 'read', sideEffect: 'none' }],
          operations: ['turn.test.read'],
        };
      },
      runChildOffscreen: async (value: any) => {
        job = value;
        return {
          ok: true, started: true, finalText: 'done',
          newMessages: [{ role: 'assistant', content: 'done' }],
        };
      },
    });
    const out = await makeSpawnActor(deps)({
      task: 't', parentSessionId: parent.sessionId, tools: ['a', 'b'],
      grantedToolNames: ['a'], grantedOperations: ['turn.test.read'],
    });

    expect(job.tools.map((tool: any) => tool.name)).toEqual(['a']);
    expect(store.map.get(out.sessionId!).grantedOperations).toEqual(['turn.test.read']);
  });

  test.each([
    {
      name: 'crossed run operation',
      surface: { tools: [{ name: 'a' }], operations: ['turn.test.read'] },
      grantedToolNames: ['a'] as string[],
      grantedOperations: ['turn.test.write'] as string[],
    },
    {
      name: 'crossed controller descriptor',
      surface: { tools: [{ name: 'b' }], operations: ['turn.test.read'] },
      grantedToolNames: ['a'] as string[],
      grantedOperations: ['turn.test.read'] as string[],
    },
  ])('fails before session creation on a $name projection', async ({
    surface, grantedToolNames, grantedOperations,
  }) => {
    const store = makeStore();
    const parent = await store.create({});
    const { loop } = makeMockLoop();
    const { deps } = baseDeps(store, loop, {
      projectChildSurface: async () => surface,
    });
    const before = store.map.size;

    await expect(makeSpawnActor(deps)({
      task: 't', parentSessionId: parent.sessionId, tools: ['a'],
      grantedToolNames, grantedOperations,
    })).rejects.toThrow('actor spawn projection mismatch');
    expect(store.map.size).toBe(before);
  });

  test('a tool-bearing projection fails before session creation without exact run ceilings', async () => {
    const store = makeStore();
    const parent = await store.create({});
    const { loop } = makeMockLoop();
    const { deps } = baseDeps(store, loop, {
      projectChildSurface: async () => ({
        tools: [{ name: 'a' }], operations: ['turn.test.read'],
      }),
    });
    const before = store.map.size;

    await expect(makeSpawnActor(deps)({ task: 't', parentSessionId: parent.sessionId }))
      .rejects.toThrow('actor spawn run ceiling unavailable');
    expect(store.map.size).toBe(before);
  });

  test('a spawned parent cannot widen a child beyond its persisted operation grant', async () => {
    const store = makeStore();
    const parent = await store.create({
      kind: 'spawned', grantedOperations: ['turn.test.read'], spawnedTrusted: true,
    });
    const { loop } = makeMockLoop();
    const { deps } = baseDeps(store, loop, {
      projectChildSurface: async () => ({
        tools: [{ name: 'a' }, { name: 'b' }],
        operations: ['turn.test.read', 'turn.test.write'],
      }),
    });
    const out = await makeSpawnActor(deps)({
      task: 't', parentSessionId: parent.sessionId,
      grantedToolNames: ['a', 'b'],
      grantedOperations: ['turn.test.read', 'turn.test.write'],
    });

    expect(store.map.get(out.sessionId!).grantedOperations).toEqual(['turn.test.read']);
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
    expect(events[0].rootSessionId).toBe(parent.sessionId);
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

  test('does not build a privileged tool context in the spawning heap', async () => {
    const store = makeStore();
    const parent = await store.create({});
    const ctxArgs: any[] = [];
    const { loop } = makeMockLoop();
    const { deps } = baseDeps(store, loop, {
      buildToolContext: async (args: any) => { ctxArgs.push(args); return { session: { sessionId: args.sessionId }, audit: async () => {} }; },
    });
    const spawn = makeSpawnActor(deps);
    await spawn({ task: 'a thing', parentSessionId: parent.sessionId });
    expect(ctxArgs.length).toBe(0);
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

describe('makeSpawnActor: isolated job inputs', () => {
  test('the worker receives the exact task and provenance remains visible', async () => {
    const store = makeStore();
    const parent = await store.create({});
    const seen: any[] = [];
    async function* loop(ctx: any) {
      seen.push({ userText: ctx.userText });
      await ctx.sessions.appendMessage(ctx.sessionId, { role: 'assistant', content: 'ok' });
      yield { type: 'stop', sessionId: ctx.sessionId, stopReason: 'end_turn' };
    }
    const { deps, audits } = baseDeps(store, loop);
    const spawn = makeSpawnActor(deps);

    const events: any[] = [];
    await spawn({
      task: 'find the price',
      parentSessionId: parent.sessionId,
      parentDepth: 0,
      onEvent: (ev: any) => events.push(ev),
    });

    expect(seen[0].userText).toBe('find the price');
    const child = [...store.map.values()].find((s: any) => s.kind === 'spawned');
    expect(child.task).toBe('find the price');
    const spawned = audits.find((a: any) => a.type === 'actor_spawned');
    expect(spawned.details.task).toBe('find the price');
    const startEv = events.find((e: any) => e.type === 'actor-start');
    expect(startEv.task).toBe('find the price');
  });
});
