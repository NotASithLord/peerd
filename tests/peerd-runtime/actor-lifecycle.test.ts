// PR #134 — spawned as async actors: the lifecycle (turn slots, abort,
// wall-clock timeout, transitive Stop), the trusted-lineage sender gate wiring,
// root-keyed budgets, mechanical dedupe, the actor awaitReply mode, and the
// redrain reroute. Complements delegation-lineage.test.ts (the pure predicate)
// and actor-messaging.test.ts / spawn.test.ts (the pre-#134 behaviors, which
// must all still hold).
import { describe, test, expect } from 'bun:test';
import { makeSpawnActor, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from '../../extension/peerd-runtime/actor/spawn.js';
import { makeActorMessaging } from '../../extension/peerd-runtime/actor/actor-messaging.js';
import { buildAncestry } from '../../extension/peerd-runtime/actor/delegation-lineage.js';
import { makeTurnSlots } from '../../extension/peerd-runtime/loop/turn-slots.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

// ---- spawn lifecycle harness ----------------------------------------------

const makeStore = () => {
  const map = new Map<string, any>();
  const createOpts: any[] = [];
  let n = 0;
  return {
    map,
    createOpts,
    create: async (opts: any = {}) => {
      createOpts.push(opts);
      const s = {
        sessionId: `s-${++n}`,
        createdAt: n,
        messages: [] as any[],
        provider: opts.provider ?? 'anthropic',
        model: opts.model ?? 'inherited-model',
        kind: opts.kind ?? 'chat',
        depth: opts.depth ?? 0,
        ...(opts.parentSessionId ? { parentSessionId: opts.parentSessionId } : {}),
        ...(opts.spawnedTrusted !== undefined ? { spawnedTrusted: opts.spawnedTrusted } : {}),
        ...(opts.task ? { task: opts.task } : {}),
        ...(opts.grantedOperations ? { grantedOperations: opts.grantedOperations } : {}),
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

// A loop that finishes only when its signal aborts — the shape a hung tool
// call / stalled provider takes from the orchestrator's point of view.
const makeAbortableLoop = () => {
  async function* loop(ctx: any) {
    await ctx.sessions.appendMessage(ctx.sessionId, { role: 'assistant', content: 'partial work' });
    if (!ctx.signal) throw new Error('no signal threaded into the loop');
    await new Promise<void>((resolve) => {
      if (ctx.signal.aborted) { resolve(); return; }
      ctx.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    yield { type: 'stop', sessionId: ctx.sessionId, stopReason: 'aborted' };
  }
  return loop;
};

const makeFastLoop = (finalText = 'done') => {
  async function* loop(ctx: any) {
    await ctx.sessions.appendMessage(ctx.sessionId, { role: 'assistant', content: finalText });
    yield { type: 'stop', sessionId: ctx.sessionId, stopReason: 'end_turn' };
  }
  return loop;
};

const spawnDeps = (store: any, loop: any, extra: any = {}) => ({
  sessions: store,
  runUserTurn: loop,
  callModel: async function* () { yield { type: 'message-stop', stopReason: 'end_turn' }; },
  getSecret: async () => 'sk-test',
  safeFetch: async () => new Response('ok'),
  appendAudit: async () => {},
  buildToolContext: async ({ sessionId }: any) => ({ session: { sessionId }, audit: async () => {} }),
  dispatchToolCall: async () => ({ ok: true, content: 'tool ran' }),
  renderSystemPrompt: async ({ taskOverride }: any) => `sys task=${taskOverride}`,
  projectChildSurface: async ({ toolNames, allowRecursion }: any) => ({
    tools: toolNames?.includes('a') === false || allowRecursion === false && toolNames?.includes('actor_create')
      ? [] : [{ name: 'a', description: 'A', schema: {} }],
    operations: [],
  }),
  now: (() => { let t = 1000; return () => (t += 25); })(),
  // Lifecycle tests exercise the dedicated-worker contract through a portable
  // fake host. The loop still receives the child's abort signal, but no test
  // relies on the removed privileged-background fallback.
  runChildOffscreen: async (job: any, opts: any = {}) => {
    let stopReason: string | undefined;
    let toolCalls = 0;
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    for await (const event of loop({
      sessionId: job.sessionId,
      userText: job.task,
      sessions: store,
      signal: opts.signal,
    })) {
      if (event.type === 'stop') stopReason = event.stopReason;
      if (event.type === 'tool-use') toolCalls++;
      if (event.type === 'usage' && event.usage) Object.assign(usage, event.usage);
      opts.onEvent?.(event);
    }
    const session = await store.get(job.sessionId);
    const finalText = [...(session?.messages ?? [])].reverse()
      .find((message: any) => message.role === 'assistant' && typeof message.content === 'string')?.content ?? '';
    return { ok: true, started: true, finalText, stopReason, toolCalls, usage };
  },
  renderSystemPromptForChild: (task: string) => `SYS:${task}`,
  ...extra,
});

describe('spawn lifecycle — spawnedTrusted stamping (phase 3, fail-closed)', () => {
  const stampFor = async (parentInbound: boolean | undefined) => {
    const store = makeStore();
    const parent = await store.create({});
    const spawn = makeSpawnActor(spawnDeps(store, makeFastLoop()) as any);
    await spawn({ task: 't', tools: [], parentSessionId: parent.sessionId, ...(parentInbound === undefined ? {} : { parentInbound }) });
    // createOpts[0] is the parent; [1] the child.
    return store.createOpts[1].spawnedTrusted;
  };
  test('an explicitly non-inbound spawning turn yields a TRUSTED hop', async () => {
    expect(await stampFor(false)).toBe(true);
  });
  test('an inbound spawning turn taints the child', async () => {
    expect(await stampFor(true)).toBe(false);
  });
  test('an ABSENT verdict taints the child (fail-closed default)', async () => {
    expect(await stampFor(undefined)).toBe(false);
  });
});

describe('spawn lifecycle — abort + registry (phases 1 & 5)', () => {
  test('a child runs under a turn slot: turnSlots.stop() aborts it and the result is flagged stopped', async () => {
    const store = makeStore();
    const parent = await store.create({});
    const turnSlots = makeTurnSlots();
    const spawn = makeSpawnActor(spawnDeps(store, makeAbortableLoop(), { turnSlots }) as any);
    const running = spawn({ task: 'long job', tools: [], parentSessionId: parent.sessionId });
    await tick();
    const [childId] = spawn.liveChildrenOf(parent.sessionId);
    expect(childId).toBeDefined();
    expect(turnSlots.isBusy(childId)).toBe(true);
    turnSlots.stop(childId);
    const out = await running;
    expect(out.stopped).toBe(true);
    expect(out.timedOut).toBeUndefined();
    expect(out.result).toBe('partial work');
    expect(spawn.liveChildrenOf(parent.sessionId)).toEqual([]);
  });

  test('stopSubtree() aborts transitive descendants (grandchildren included)', async () => {
    const store = makeStore();
    const root = await store.create({});
    const turnSlots = makeTurnSlots();
    const spawn = makeSpawnActor(spawnDeps(store, makeAbortableLoop(), { turnSlots }) as any);
    const child = spawn({ task: 'c1', tools: [], parentSessionId: root.sessionId });
    await tick();
    const [childId] = spawn.liveChildrenOf(root.sessionId);
    const grandchild = spawn({ task: 'c2', tools: [], parentSessionId: childId, parentDepth: 1 });
    await tick();
    const [grandchildId] = spawn.liveChildrenOf(childId);
    expect(grandchildId).toBeDefined();

    const stopped = spawn.stopSubtree(root.sessionId);
    expect(new Set(stopped)).toEqual(new Set([childId, grandchildId]));
    const [c, g] = await Promise.all([child, grandchild]);
    expect(c.stopped).toBe(true);
    expect(g.stopped).toBe(true);
    expect(spawn.liveChildrenOf(root.sessionId)).toEqual([]);
  });
});

describe('spawn lifecycle — wall-clock timeout (phase 2)', () => {
  test('the timer aborts a parked child and flags timedOut', async () => {
    const store = makeStore();
    const parent = await store.create({});
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const cleared: unknown[] = [];
    const spawn = makeSpawnActor(spawnDeps(store, makeAbortableLoop(), {
      turnSlots: makeTurnSlots(),
      setTimer: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; },
      clearTimer: (h: unknown) => { cleared.push(h); },
    }) as any);
    const running = spawn({ task: 'will park', tools: [], parentSessionId: parent.sessionId });
    await tick();
    expect(timers.length).toBe(1);
    expect(timers[0].ms).toBe(DEFAULT_TIMEOUT_MS);
    timers[0].fn(); // the budget elapses
    const out = await running;
    expect(out.timedOut).toBe(true);
    expect(out.stopped).toBeUndefined();
    expect(cleared.length).toBe(1); // the timer is always cleared on settle
  });

  test('timeoutMs is caller-lowerable but clamped to MAX_TIMEOUT_MS', async () => {
    const store = makeStore();
    const parent = await store.create({});
    const budgets: number[] = [];
    const spawn = makeSpawnActor(spawnDeps(store, makeFastLoop(), {
      setTimer: (_fn: () => void, ms: number) => { budgets.push(ms); return 1; },
      clearTimer: () => {},
    }) as any);
    await spawn({ task: 'a', tools: [], parentSessionId: parent.sessionId, timeoutMs: 5_000 });
    await spawn({ task: 'b', tools: [], parentSessionId: parent.sessionId, timeoutMs: MAX_TIMEOUT_MS * 10 });
    await spawn({ task: 'c', tools: [], parentSessionId: parent.sessionId });
    expect(budgets).toEqual([5_000, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS]);
  });

  test('a clean finish clears the timer and sets no flag', async () => {
    const store = makeStore();
    const parent = await store.create({});
    const cleared: unknown[] = [];
    const spawn = makeSpawnActor(spawnDeps(store, makeFastLoop('all good'), {
      setTimer: () => 42,
      clearTimer: (h: unknown) => { cleared.push(h); },
    }) as any);
    const out = await spawn({ task: 't', tools: [], parentSessionId: parent.sessionId });
    expect(out.result).toBe('all good');
    expect(out.timedOut).toBeUndefined();
    expect(out.stopped).toBeUndefined();
    expect(cleared).toEqual([42]);
  });

  test('a timer that fires AFTER a clean finish does not mislabel the result timedOut (#5)', async () => {
    // The child finishes cleanly (end_turn); we fire the captured timer callback
    // AFTER the run resolved. timedOut is gated on lastStopReason==='aborted', so
    // a post-finish timer tick must not flip a complete result to partial.
    const store = makeStore();
    const parent = await store.create({});
    let timerCb: (() => void) | null = null;
    const spawn = makeSpawnActor(spawnDeps(store, makeFastLoop('complete'), {
      setTimer: (fn: () => void) => { timerCb = fn; return 1; },
      clearTimer: () => {},
    }) as any);
    const out = await spawn({ task: 't', tools: [], parentSessionId: parent.sessionId });
    (timerCb as null | (() => void))?.(); // the stray macrotask fires late
    expect(out.result).toBe('complete');
    expect(out.timedOut).toBeUndefined();
    expect(out.stopped).toBeUndefined();
  });
});

describe('heap split — routing a child offscreen (reasoning AND tool-bearing)', () => {
  const withOffscreen = (store: any, offscreen: any, extra: any = {}) => {
    // A distinctively-texted in-SW loop so we can tell which path ran.
    const inSwLoop = makeFastLoop('IN-SW answer');
    return makeSpawnActor(spawnDeps(store, inSwLoop, {
      runChildOffscreen: offscreen,
      renderSystemPromptForChild: (t: string) => `SYS:${t}`,
      ...extra,
    }) as any);
  };

  test('a tools:[] child runs OFFSCREEN (not the in-SW loop) and returns its finalText', async () => {
    const store = makeStore();
    const parent = await store.create({ model: 'parent-model' });
    let offscreenJob: any = null;
    const offscreen = async (job: any) => { offscreenJob = job; return { ok: true, finalText: 'OFFSCREEN answer', usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }, stopReason: 'end_turn', toolCalls: 0 }; };
    const spawn = withOffscreen(store, offscreen);
    const out = await spawn({ task: 'reason about X', tools: [], parentSessionId: parent.sessionId });
    expect(out.result).toBe('OFFSCREEN answer');       // came from the worker, not the in-SW loop
    expect(out.usage?.outputTokens).toBe(2);
    // the child's prompt was rendered SW-side and the session/provider threaded in
    expect(offscreenJob.systemPrompt).toBe('SYS:reason about X');
    expect(offscreenJob.provider).toBe('anthropic');
    expect(offscreenJob.model).toBe('parent-model');
    // the child transcript was reconstructed SW-side (finalAssistantText reads it)
    const child = [...store.map.values()].find((s: any) => s.kind === 'spawned');
    expect(child.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'OFFSCREEN answer' });
  });

  test('a child WITH tools ALSO runs offscreen (phase 4), carrying its granted descriptors', async () => {
    // Phase 4: a tool-bearing child is a tool-bearing ephemeral actor. It runs in its
    // own heap and relays each tool call; the keyless worker "holds" tools because the
    // SW executes them. The granted set is persisted on the child so the SW can rebuild
    // the restricted ctx and re-check every relayed call.
    const store = makeStore();
    const parent = await store.create({});
    let offscreenJob: any = null;
    const spawn = withOffscreen(store, async (job: any) => { offscreenJob = job; return { ok: true, started: true, finalText: 'did it', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, stopReason: 'end_turn', toolCalls: 1 }; });
    const out = await spawn({ task: 't', tools: ['a'], parentSessionId: parent.sessionId });
    expect(out.result).toBe('did it');                       // ran offscreen, not the in-SW loop
    expect(offscreenJob.tools.map((t: any) => t.name)).toContain('a');   // descriptors relayed to the worker
    // Names remain only in the sealed worker job; durable authority is operation-only.
    const child = [...store.map.values()].find((s: any) => s.kind === 'spawned');
    expect(child.grantedTools).toBeUndefined();
  });

  test('SECURITY: an actor CANNOT be granted actor-only tools (foreground-tab escalation is closed)', async () => {
    // DESIGN-17: read_page/click/navigate/fetch_url are MAIN_AGENT_HIDDEN
    // (actor-only), and edit_file is actor-mutating. narrowTools filters from the
    // MAIN-AGENT surface, so requesting them yields a child that holds NONE of them —
    // it must delegate web/DOM work to the web actor via message_actor.
    const store = makeStore();
    const parent = await store.create({});
    let offscreenJob: any = null;
    const spawn = makeSpawnActor(spawnDeps(store, makeFastLoop('IN-SW answer'), {
      runChildOffscreen: async (job: any) => { offscreenJob = job; return { ok: true, started: true, finalText: 'ok', stopReason: 'end_turn', toolCalls: 0 }; },
      renderSystemPromptForChild: (t: string) => `SYS:${t}`,
      // a registry that DOES include the actor-only tools (the real listTools surface)
      projectChildSurface: async () => ({
        tools: [{ name: 'script', description: 'script', schema: {} }],
        operations: [],
      }),
    }) as any);
    await spawn({ task: 'read the current page', tools: ['read_page', 'edit_file', 'script'], parentSessionId: parent.sessionId });
    // the actor-only DOM/page + mutating tools were dropped; only the legit one survives
    const visible = offscreenJob.tools.map((t: any) => t.name);
    expect(visible).toContain('script');
    for (const forbidden of ['read_page', 'click', 'navigate', 'fetch_url', 'edit_file']) {
      expect(visible).not.toContain(forbidden);
    }
    // and the worker is only advertised the surviving descriptor
    expect(offscreenJob.tools.map((t: any) => t.name)).toEqual(['script']);
    const child = [...store.map.values()].find((s: any) => s.kind === 'spawned');
    expect(child.grantedTools).toBeUndefined();
  });

  test('a NEVER-STARTED worker failure fails closed without running in the background heap', async () => {
    const store = makeStore();
    const parent = await store.create({});
    const spawn = withOffscreen(store, async () => ({ ok: false, started: false, error: 'offscreen doc unavailable' }));
    const out = await spawn({ task: 'reason', tools: [], parentSessionId: parent.sessionId });
    expect(out.result).toBe('offscreen doc unavailable');
    expect(out.refused).toBe(true);
  });

  test('a tool side effect followed by a Worker error does not re-run in-SW', async () => {
    const store = makeStore();
    const parent = await store.create({});
    let inSwRan = false;
    const inSwLoop = async function* (ctx: any) { inSwRan = true; await ctx.sessions.appendMessage(ctx.sessionId, { role: 'assistant', content: 'IN-SW answer' }); yield { type: 'stop', stopReason: 'end_turn' }; };
    const spawn = makeSpawnActor(spawnDeps(store, inSwLoop, {
      runChildOffscreen: async () => ({
        ok: false,
        started: true,
        error: 'provider-http-500',
        finalText: '',
        toolCalls: 1,
        newMessages: [
          { role: 'user', content: 'change the target' },
          { role: 'assistant', content: '', toolUses: [{ id: 'side-effect-1', name: 'script', input: { code: 'return 42' } }] },
          { role: 'user', content: '', toolResults: [{ tool_use_id: 'side-effect-1', is_error: false, content: '42' }] },
        ],
      }),
      renderSystemPromptForChild: (t: string) => `SYS:${t}`,
    }) as any);
    const out = await spawn({ task: 'reason', tools: [], parentSessionId: parent.sessionId });
    expect(inSwRan).toBe(false);                        // did NOT double-run
    expect(out.result).toContain('provider-http-500');  // surfaced the worker failure
    expect(out.result).toContain('outcome is unknown');
    expect(out.result).toContain('must not be retried automatically');
    expect(out.stopped).toBe(true);
    expect(out.executionFailed).toBe(true);
    expect(out.outcomeKnown).toBe(false);
    expect(out.toolCalls).toBe(1);
  });

  test('a transcript write failure after an isolated run throws structured unknown-outcome metadata', async () => {
    const store = makeStore();
    const parent = await store.create({});
    store.appendMessage = async () => { throw new Error('storage unavailable'); };
    const spawn = withOffscreen(store, async () => ({
      ok: true,
      started: true,
      finalText: 'target changed',
      newMessages: [{ role: 'assistant', content: 'target changed' }],
      toolCalls: 1,
    }));
    try {
      await spawn({ task: 'change it', tools: [], parentSessionId: parent.sessionId });
      throw new Error('expected persistence failure');
    } catch (error) {
      expect(error).toMatchObject({
        name: 'ActorPersistenceError',
        performed: true,
        outcomeKnown: false,
        retryable: false,
        executionFailed: true,
      });
    }
  });
});

// ---- actor-messaging: the lineage gate + arbitration ------------------------

type Reenter = { userText: string; sessionId: string; synthetic: boolean };
type RecoveryNotice = Reenter & { recoveryId: string };
type Hop = { sessionId: string; parentSessionId: string | null; spawnedTrusted: boolean };

const gateHarness = (over: Partial<Parameters<typeof makeActorMessaging>[0]> = {}) => {
  const reentries: Reenter[] = [];
  const recoveryNotices: RecoveryNotice[] = [];
  const turnsRun: Array<{ actorSessionId: string; message: string }> = [];
  const appended: any[] = [];
  const deps = {
    resolveActor: async (to: string) =>
      to === 'app-1'
        ? { instanceId: 'app-1', kind: 'app', actorSessionId: 'res-1', name: 'todo', tabId: 7 }
        : null,
    runActorTurn: async (o: { actorSessionId: string; message: string }) => {
      turnsRun.push({ actorSessionId: o.actorSessionId, message: o.message });
      return { result: 'built the thing' };
    },
    reenter: async (r: Reenter) => { reentries.push(r); },
    recordRecovery: async (r: RecoveryNotice) => { recoveryNotices.push(r); return true; },
    turnSlots: { runWhenIdle: (_sid: string, fn: () => void) => fn() },
    getActiveSessionId: async () => 'chat-1',
    isVaultLocked: () => false,
    wrapUntrusted: ({ origin, body }: { origin: string; body: string }) => `<u origin="${origin}">${body}</u>`,
    appendAudit: async () => {},
    mailbox: { append: async (e: any) => { appended.push(e); }, remove: async () => {}, load: async () => [] },
    now: () => 1000,
    log: () => {},
    ...over,
  } as Parameters<typeof makeActorMessaging>[0];
  return { ...makeActorMessaging(deps), reentries, recoveryNotices, turnsRun, appended };
};

// A trusted direct child of the active chat.
const trustedChild: Hop[] = [
  { sessionId: 'sub-1', parentSessionId: 'chat-1', spawnedTrusted: true },
];
const ancestryOf = (hops: Hop[]) => async (_sessionId: string) => hops;

describe('message_actor — the trusted-lineage sender gate (phase 3)', () => {
  test('ACCEPTS a trusted-lineage actor (non-active sender with a clean chain)', async () => {
    const { messageActor, turnsRun } = gateHarness({ getAncestry: ancestryOf(trustedChild) });
    const r = await messageActor({ to: 'app-1', message: 'do it', senderSessionId: 'sub-1', inbound: false });
    expect(r.ok).toBe(true);
    await tick();
    expect(turnsRun.length).toBe(1);
  });
  test('refuses a TAINTED chain (the child was spawned by an inbound turn)', async () => {
    const tainted: Hop[] = [{ sessionId: 'sub-1', parentSessionId: 'chat-1', spawnedTrusted: false }];
    const { messageActor } = gateHarness({ getAncestry: ancestryOf(tainted) });
    const r = await messageActor({ to: 'app-1', message: 'do it', senderSessionId: 'sub-1', inbound: false });
    expect(r.ok).toBe(false);
  });
  test('refuses a non-active sender with NO ancestry (fail-closed default walk)', async () => {
    const { messageActor } = gateHarness(); // default getAncestry → []
    const r = await messageActor({ to: 'app-1', message: 'do it', senderSessionId: 'sub-1', inbound: false });
    expect(r.ok).toBe(false);
  });
  test('refuses an INBOUND turn even on a trusted-lineage sender', async () => {
    const { messageActor } = gateHarness({ getAncestry: ancestryOf(trustedChild) });
    const r = await messageActor({ to: 'app-1', message: 'do it', senderSessionId: 'sub-1', inbound: true });
    expect(r.ok).toBe(false);
  });
  test('a throwing ancestry walk fails closed (refuse, not crash)', async () => {
    const { messageActor } = gateHarness({ getAncestry: async () => { throw new Error('store down'); } });
    const r = await messageActor({ to: 'app-1', message: 'do it', senderSessionId: 'sub-1', inbound: false });
    expect(r.ok).toBe(false);
  });
});

describe('message_actor — the stamp→walk→gate contract, end to end (no mocked seam) (#6)', () => {
  // Findings #5/#6: every OTHER gate test injects a hand-built ancestry, so the
  // stamp↔read contract (spawn.js WRITES spawnedTrusted; buildAncestry READS it
  // and applies the fail-closed default) is never exercised as one wire. Here a
  // REAL spawn persists the child, a REAL buildAncestry walks that store, and the
  // REAL gate decides — so a drift in the field name or the default breaks a test.
  const wire = async (parentInbound: boolean | undefined) => {
    const store = makeStore();
    const root = await store.create({});                       // s-1 — the active chat
    const spawn = makeSpawnActor(spawnDeps(store, makeFastLoop()) as any);
    const child = await spawn({
      task: 'go', tools: [], parentSessionId: root.sessionId,
      ...(parentInbound === undefined ? {} : { parentInbound }),
    });
    const { messageActor } = gateHarness({
      getActiveSessionId: async () => root.sessionId,
      // the REAL walk over the REAL store the spawn just wrote into
      getAncestry: (sessionId: string) => buildAncestry({ sessionId, getRecord: store.get }),
    });
    return { messageActor, childId: child.sessionId as string };
  };

  test('a child spawned by a TRUSTED (non-inbound) turn is admitted through the real walk', async () => {
    const { messageActor, childId } = await wire(false);
    const r = await messageActor({ to: 'app-1', message: 'do it', senderSessionId: childId, inbound: false });
    expect(r.ok).toBe(true);
  });

  test('a child spawned by an INBOUND turn is refused through the real walk (laundering hole stays shut)', async () => {
    const { messageActor, childId } = await wire(true);
    const r = await messageActor({ to: 'app-1', message: 'do it', senderSessionId: childId, inbound: false });
    expect(r.ok).toBe(false);
  });

  test('a child of an UNKNOWN-verdict spawn (fail-closed default) is refused through the real walk', async () => {
    const { messageActor, childId } = await wire(undefined);   // no parentInbound → tainted
    const r = await messageActor({ to: 'app-1', message: 'do it', senderSessionId: childId, inbound: false });
    expect(r.ok).toBe(false);
  });
});

describe('message_actor — root-keyed budgets (phase 4)', () => {
  test('an actor\'s sends draw from its ROOT\'s rate budget (one bound per delegation tree)', async () => {
    const { messageActor } = gateHarness({
      getAncestry: ancestryOf(trustedChild),
      caps: { rateCap: 2 },
    });
    // Two sends from the root chat itself…
    expect((await messageActor({ to: 'app-1', message: 'a', senderSessionId: 'chat-1' })).ok).toBe(true);
    await tick();
    expect((await messageActor({ to: 'app-1', message: 'b', senderSessionId: 'chat-1' })).ok).toBe(true);
    await tick();
    // …exhaust the budget for the actor too — it shares the root's window.
    const r = await messageActor({ to: 'app-1', message: 'c', senderSessionId: 'sub-1', inbound: false });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('delegation tree');
  });

  test('stopActorsFor(root chat) covers an actor turn a ACTOR started', async () => {
    // Hold the actor turn in the queue so it stays in flight.
    const queued: Array<() => void> = [];
    const { messageActor, stopActorsFor } = gateHarness({
      getAncestry: ancestryOf(trustedChild),
      turnSlots: { runWhenIdle: (_sid: string, fn: () => void) => { queued.push(fn); } },
    });
    // Fire-and-forget: awaitReply resolves only after the queued turn runs.
    const pending = messageActor({ to: 'app-1', message: 'go', senderSessionId: 'sub-1', inbound: false, awaitReply: true });
    await tick();
    // The user hits Stop on the CHAT — the root — and the actor's in-flight
    // actor session is returned for the slot-abort cascade.
    expect(stopActorsFor('chat-1')).toEqual(['res-1']);
    queued.forEach((fn) => fn()); // drain: the stopped-generation path settles the await
    const r = await pending;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('stopped');
  });

  test('the post-Stop gen-skip hands the actor slot on (advanceQueue) so the queue is not stranded', async () => {
    // The gen-skip branch DECLINES to run a turn, so no claim/release re-drains
    // the actor's queue. It must call turnSlots.advanceQueue to keep the pump
    // going, or every turn queued behind it strands until an unrelated message.
    const queued: Array<() => void> = [];
    const advanced: string[] = [];
    const { messageActor, stopActorsFor } = gateHarness({
      getAncestry: ancestryOf(trustedChild),
      turnSlots: {
        runWhenIdle: (_sid: string, fn: () => void) => { queued.push(fn); },
        advanceQueue: (sid: string) => { advanced.push(sid); },
      } as any,
    });
    const pending = messageActor({ to: 'app-1', message: 'go', senderSessionId: 'sub-1', inbound: false, awaitReply: true });
    await tick();
    stopActorsFor('chat-1');       // Stop the root before the queued turn runs
    queued.forEach((fn) => fn());  // drain → the queued turn hits the gen-skip
    const r = await pending;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('stopped');
    expect(advanced).toContain('res-1');   // the declining skip advanced the actor's queue
  });
});

describe('message_actor — mechanical dedupe (phase 7)', () => {
  test('an identical (instance, message) intent already in flight for the tree is refused', async () => {
    const queued: Array<() => void> = [];
    const { messageActor } = gateHarness({
      turnSlots: { runWhenIdle: (_sid: string, fn: () => void) => { queued.push(fn); } },
    });
    expect((await messageActor({ to: 'app-1', message: 'same ask', senderSessionId: 'chat-1' })).ok).toBe(true);
    const dup = await messageActor({ to: 'app-1', message: 'same ask', senderSessionId: 'chat-1' });
    expect(dup.ok).toBe(false);
    expect(dup.error).toContain('identical request');
    // A DIFFERENT message to the same actor is not a duplicate.
    expect((await messageActor({ to: 'app-1', message: 'other ask', senderSessionId: 'chat-1' })).ok).toBe(true);
    queued.forEach((fn) => fn());
    await tick();
    // Settled → the same intent may be sent again.
    expect((await messageActor({ to: 'app-1', message: 'same ask', senderSessionId: 'chat-1' })).ok).toBe(true);
  });

  test('MED-7 — the SAME intent from a DIFFERENT root is admitted (dedupe is per-tree, no false positive)', async () => {
    // The dedupe key is (rootSessionId, instance+message): a parent and its child
    // (one tree) asking the same thing collapses, but two UNRELATED lineage trees
    // must never suppress each other. Real case: two foreground conversations both
    // driving one shared actor. Model it by flipping the active chat between sends —
    // each roots at its OWN chat, so both identical intents must go through.
    const queued: Array<() => void> = [];
    let active = 'chat-1';
    const { messageActor, turnsRun } = gateHarness({
      getActiveSessionId: async () => active,
      turnSlots: { runWhenIdle: (_sid: string, fn: () => void) => { queued.push(fn); } },
    });
    // Tree A (root chat-1) sends and stays in flight (held in the queue).
    expect((await messageActor({ to: 'app-1', message: 'reprice', senderSessionId: 'chat-1' })).ok).toBe(true);
    // A SECOND, unrelated tree (root chat-2) sends the identical intent to the same
    // actor while A is still in flight. Different root → different intent bucket → admitted.
    active = 'chat-2';
    const other = await messageActor({ to: 'app-1', message: 'reprice', senderSessionId: 'chat-2' });
    expect(other.ok).toBe(true);
    expect(other.error).toBeUndefined();
    // Control: the SAME tree re-asking IS still a duplicate (the guard didn't just go slack).
    const dupSameTree = await messageActor({ to: 'app-1', message: 'reprice', senderSessionId: 'chat-2' });
    expect(dupSameTree.ok).toBe(false);
    expect(dupSameTree.error).toContain('identical request');
    // Both distinct-tree sends reached the actor once each.
    queued.forEach((fn) => fn());
    await tick();
    expect(turnsRun.length).toBe(2);
  });

  test('#8 — two sibling spawned\' independent web actors do NOT alias-collapse under the shared root', async () => {
    // The web actor is SENDER-scoped: resolveWebActor keys by ownerChatId =
    // senderSessionId, so each actor gets its OWN actorSession — yet all share
    // the constant instanceId 'web'. Keying dedupe on instanceId would collapse
    // two siblings' independent web actors into one entry under their shared root,
    // wrongly refusing the second (which has no channel to observe the first's
    // reply). Keying on the resolved actorSessionId keeps them distinct.
    const queued: Array<() => void> = [];
    const { messageActor, turnsRun } = gateHarness({
      getActiveSessionId: async () => 'chat-1',
      getAncestry: async (sid: string) => [{ sessionId: sid, parentSessionId: 'chat-1', spawnedTrusted: true }],
      resolveActor: async (to: string, opts: any) =>
        to === 'web'
          ? { instanceId: 'web', kind: 'web', actorSessionId: `web-${opts?.senderSessionId}`, tabId: undefined }
          : null,
      turnSlots: { runWhenIdle: (_sid: string, fn: () => void) => { queued.push(fn); } },
    });
    // S1 and S2 (siblings, shared root chat-1) each drive their OWN web actor with
    // the identical message. Under the old instanceId keying both keyed on 'web' → S2 refused.
    const r1 = await messageActor({ to: 'web', message: 'get BTC price', senderSessionId: 'sub-1', inbound: false });
    const r2 = await messageActor({ to: 'web', message: 'get BTC price', senderSessionId: 'sub-2', inbound: false });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);                 // the fix: S2's own web actor is NOT alias-collapsed
    // Control: the SAME actor re-sending the SAME intent to ITS web actor IS still deduped.
    const dup = await messageActor({ to: 'web', message: 'get BTC price', senderSessionId: 'sub-1', inbound: false });
    expect(dup.ok).toBe(false);
    expect(dup.error).toContain('identical request');
    queued.forEach((fn) => fn());
    await tick();
    expect(turnsRun.length).toBe(2);          // both independent web actors ran
  });
});

describe('message_actor — the actor awaitReply mode', () => {
  test('resolves the fenced reply INTO the tool result (no reentry wake)', async () => {
    const { messageActor, reentries } = gateHarness({ getAncestry: ancestryOf(trustedChild) });
    const r = await messageActor({ to: 'app-1', message: 'build', senderSessionId: 'sub-1', inbound: false, awaitReply: true });
    expect(r.ok).toBe(true);
    expect(r.content).toContain('<u origin="app-1">built the thing</u>');
    expect(r.content).toContain('has replied');
    await tick();
    expect(reentries.length).toBe(0); // the child is never woken
  });
  test('an aborted actor unblocks even if the actor turn never settles (#1/#3)', async () => {
    // The actor turn is held in the queue (never run), so onReply never fires.
    // The child's abort signal must still unwind the await. The QUEUED delivery
    // is marked cancelled — it skips when the slot drains — and the slot is NOT
    // stopped (nothing of ours is running; a stop would hit whatever sibling
    // turn holds the shared actor).
    const stopped: string[] = [];
    const queued: Array<() => void> = [];
    const controller = new AbortController();
    const { messageActor, turnsRun } = gateHarness({
      getAncestry: ancestryOf(trustedChild),
      turnSlots: {
        runWhenIdle: (_sid: string, fn: () => void) => { queued.push(fn); },
        stop: (id: string) => { stopped.push(id); return true; },
      } as any,
    });
    const pending = messageActor({
      to: 'app-1', message: 'hang', senderSessionId: 'sub-1', inbound: false,
      awaitReply: true, awaitSignal: controller.signal,
    });
    await tick();
    controller.abort(); // the child's wall-clock timeout / cancel fires
    const r = await pending;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('aborted');
    expect(stopped).toEqual([]);      // nothing was RUNNING → no slot stop
    queued.forEach((fn) => fn());     // the slot frees later
    await tick();
    expect(turnsRun.length).toBe(0);  // the cancelled delivery never ran the actor
  });

  test('an already-aborted signal resolves immediately and cancels the queued delivery', async () => {
    const stopped: string[] = [];
    const queued: Array<() => void> = [];
    const controller = new AbortController();
    controller.abort();
    const { messageActor, turnsRun } = gateHarness({
      getAncestry: ancestryOf(trustedChild),
      turnSlots: {
        runWhenIdle: (_sid: string, fn: () => void) => { queued.push(fn); },
        stop: (id: string) => { stopped.push(id); return true; },
      } as any,
    });
    const r = await messageActor({
      to: 'app-1', message: 'x', senderSessionId: 'sub-1', inbound: false,
      awaitReply: true, awaitSignal: controller.signal,
    });
    expect(r.ok).toBe(false);
    expect(stopped).toEqual([]);      // queued, not running → no slot stop
    queued.forEach((fn) => fn());
    await tick();
    expect(turnsRun.length).toBe(0);  // and it never runs
  });

  test("a sibling's DIFFERENT queued message to the SAME actor survives another child's abort", async () => {
    // THE COLLATERAL FIX: A's timeout/cancel used to bump the ROOT-wide Stop
    // generation, gen-skipping B's distinct queued turn under the same root.
    // Cancellation is now correlation-scoped: A's delivery skips, B's still runs.
    const queued: Array<() => void> = [];
    const controller = new AbortController();
    const { messageActor, turnsRun } = gateHarness({
      getAncestry: async (sid: string) => [{ sessionId: sid, parentSessionId: 'chat-1', spawnedTrusted: true }],
      turnSlots: { runWhenIdle: (_sid: string, fn: () => void) => { queued.push(fn); } },
    });
    const a = messageActor({ to: 'app-1', message: 'task A', senderSessionId: 'sub-1', inbound: false, awaitReply: true, awaitSignal: controller.signal });
    const b = messageActor({ to: 'app-1', message: 'task B', senderSessionId: 'sub-2', inbound: false, awaitReply: true });
    await tick();
    controller.abort();                    // A's wall-clock timeout fires
    const ra = await a;
    expect(ra.ok).toBe(false);
    queued.forEach((fn) => fn());          // the actor's slot drains
    const rb = await b;
    expect(rb.ok).toBe(true);              // B was NOT collateral
    expect(turnsRun.map((t) => t.message)).toEqual(['task B']); // A skipped, B ran
  });

  test("an abort while a SIBLING's message is RUNNING on the shared actor leaves it untouched", async () => {
    const queued: Array<() => void> = [];
    const stopped: string[] = [];
    const controller = new AbortController();
    let releaseB: any;
    const { messageActor } = gateHarness({
      getAncestry: async (sid: string) => [{ sessionId: sid, parentSessionId: 'chat-1', spawnedTrusted: true }],
      runActorTurn: ({ message }: any) => new Promise((res) => { if (message === 'task B') releaseB = res; }),
      turnSlots: {
        runWhenIdle: (_sid: string, fn: () => void) => { queued.push(fn); },
        stop: (id: string) => { stopped.push(id); return true; },
      } as any,
    });
    const b = messageActor({ to: 'app-1', message: 'task B', senderSessionId: 'sub-2', inbound: false, awaitReply: true });
    await tick();
    queued.shift()!();                     // B's turn starts RUNNING (hangs)
    const a = messageActor({ to: 'app-1', message: 'task A', senderSessionId: 'sub-1', inbound: false, awaitReply: true, awaitSignal: controller.signal });
    await tick();                          // A queued behind B on the same actor
    controller.abort();                    // A aborts while B's turn is running
    const ra = await a;
    expect(ra.ok).toBe(false);
    expect(stopped).toEqual([]);           // B's RUNNING turn was NOT slot-stopped
    releaseB({ result: 'B done' });        // B finishes normally
    const rb = await b;
    expect(rb.ok).toBe(true);
  });

  test("the abort DOES slot-stop the actor when the child's OWN message is the one running", async () => {
    const stopped: string[] = [];
    const controller = new AbortController();
    let hangResolve: any;
    const { messageActor } = gateHarness({
      getAncestry: ancestryOf(trustedChild),
      runActorTurn: () => new Promise((res) => { hangResolve = res; }),  // hangs until stopped
      turnSlots: {
        runWhenIdle: (_sid: string, fn: () => void) => fn(),             // idle slot → runs NOW
        stop: (id: string) => { stopped.push(id); hangResolve({ result: 'stopped', stopped: true }); return true; },
      } as any,
    });
    const pending = messageActor({ to: 'app-1', message: 'go', senderSessionId: 'sub-1', inbound: false, awaitReply: true, awaitSignal: controller.signal });
    await tick();                          // the turn is now RUNNING (hanging)
    controller.abort();
    const r = await pending;
    expect(r.ok).toBe(false);              // the abort unwound the await
    expect(stopped).toEqual(['res-1']);    // and stopped the child's OWN running turn
  });

  test('a STALE abort AFTER the reply settled does NOT stop the (possibly shared) actor (#HIGH-1)', async () => {
    // The child got its reply; its abort listener is still on its long-lived
    // signal, and its OWN wall-clock timeout / cancel fires LATER. That stale
    // abort must be a no-op — a shared engine actor may be serving a SIBLING by
    // then, and stopping it (or bumping the root's Stop gen) is collateral.
    const stopped: string[] = [];
    const controller = new AbortController();
    const { messageActor } = gateHarness({
      getAncestry: ancestryOf(trustedChild),
      turnSlots: {
        runWhenIdle: (_sid: string, fn: () => void) => fn(),   // the reply resolves
        stop: (id: string) => { stopped.push(id); return true; },
      } as any,
    });
    const r = await messageActor({
      to: 'app-1', message: 'go', senderSessionId: 'sub-1', inbound: false,
      awaitReply: true, awaitSignal: controller.signal,
    });
    expect(r.ok).toBe(true);          // got its reply
    controller.abort();               // the child's later timeout / cancel fires the stale abort
    await tick();
    expect(stopped).toEqual([]);      // NOT stopped — the stale abort was a no-op
  });

  test('a failed actor turn resolves ok:false with the fenced error', async () => {
    const { messageActor, reentries } = gateHarness({
      getAncestry: ancestryOf(trustedChild),
      runActorTurn: async () => { throw new Error('exploded'); },
    });
    const r = await messageActor({ to: 'app-1', message: 'build', senderSessionId: 'sub-1', inbound: false, awaitReply: true });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('exploded');
    await tick();
    expect(reentries.length).toBe(0);
  });
  test('the ORCHESTRATOR default (no awaitReply) still gets the later-turn wake', async () => {
    const { messageActor, reentries } = gateHarness();
    const r = await messageActor({ to: 'app-1', message: 'build', senderSessionId: 'chat-1' });
    expect(r.ok).toBe(true);
    expect(r.content).toContain('LATER turn');
    await tick();
    expect(reentries.length).toBe(1);
    expect(reentries[0].sessionId).toBe('chat-1');
  });
});

describe('message_actor — envelope provenance + redrain reroute (phase 7)', () => {
  test('the durable envelope carries { rootSessionId, lineagePath }', async () => {
    const { messageActor, appended } = gateHarness({ getAncestry: ancestryOf(trustedChild) });
    await messageActor({ to: 'app-1', message: 'go', senderSessionId: 'sub-1', inbound: false });
    await tick();
    expect(appended.length).toBe(1);
    expect(appended[0].provenance).toEqual({ rootSessionId: 'chat-1', lineagePath: ['chat-1', 'sub-1'] });
    expect(appended[0].senderSessionId).toBe('sub-1');
  });

  test('a recovery notice whose sender was an ephemeral actor is rerouted to the ROOT', async () => {
    const audits: any[] = [];
    const { redrain, reentries, recoveryNotices } = gateHarness({
      appendAudit: async (e: any) => { audits.push(e); },
      mailbox: {
        append: async () => {},
        remove: async () => {},
        load: async () => [{
          id: 'c-1', senderSessionId: 'sub-9', to: 'app-1', message: 'finish it',
          createdAt: 1, state: 'started', kind: 'app',
          provenance: { rootSessionId: 'chat-1', lineagePath: ['chat-1', 'sub-9'] },
        }],
      },
    });
    const r = await redrain();
    expect(r.redrained).toBe(0);
    await tick();
    // The passive notice reached the CHAT, not the dead child, and no model turn ran.
    expect(reentries).toEqual([]);
    expect(recoveryNotices.length).toBe(1);
    expect(recoveryNotices[0].sessionId).toBe('chat-1');
    expect(audits.some((a) => a.type === 'actor_reply_rerouted')).toBe(true);
  });

  test('a queued recovery notice never creates an in-flight actor intent', async () => {
    const { messageActor, redrain, turnsRun } = gateHarness({
      mailbox: {
        append: async () => {},
        remove: async () => {},
        load: async () => [{
          id: 'c-1', senderSessionId: 'chat-1', to: 'app-1', message: 'reprice',
          createdAt: 1, state: 'queued', kind: 'app',
        }],
      },
    });
    await redrain();
    expect(turnsRun).toEqual([]);
    const retry = await messageActor({ to: 'app-1', message: 'reprice', senderSessionId: 'chat-1' });
    expect(retry.ok).toBe(true);
  });

  test('a pre-#134 envelope (no provenance) keeps the sender-addressed wake', async () => {
    const { redrain, reentries, recoveryNotices } = gateHarness({
      mailbox: {
        append: async () => {},
        remove: async () => {},
        load: async () => [{ id: 'c-2', senderSessionId: 'chat-1', to: 'app-1', message: 'redo', createdAt: 1 }],
      },
    });
    await redrain();
    await tick();
    expect(reentries).toEqual([]);
    expect(recoveryNotices.length).toBe(1);
    expect(recoveryNotices[0].sessionId).toBe('chat-1');
  });
});
