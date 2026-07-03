// PR #134 — subagents as async actors: the lifecycle (turn slots, abort,
// wall-clock timeout, transitive Stop), the trusted-lineage sender gate wiring,
// root-keyed budgets, mechanical dedupe, the subagent awaitReply mode, and the
// redrain reroute. Complements delegation-lineage.test.ts (the pure predicate)
// and actor-messaging.test.ts / spawn.test.ts (the pre-#134 behaviors, which
// must all still hold).
import { describe, test, expect } from 'bun:test';
import { makeSpawnSubagent, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from '../../extension/peerd-runtime/subagent/spawn.js';
import { makeActorMessaging } from '../../extension/peerd-runtime/subagent/actor-messaging.js';
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
  getToolDescriptors: () => [{ name: 'a', description: 'A', schema: {} }],
  now: (() => { let t = 1000; return () => (t += 25); })(),
  ...extra,
});

describe('spawn lifecycle — spawnedTrusted stamping (phase 3, fail-closed)', () => {
  const stampFor = async (parentInbound: boolean | undefined) => {
    const store = makeStore();
    const parent = await store.create({});
    const spawn = makeSpawnSubagent(spawnDeps(store, makeFastLoop()) as any);
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
    const spawn = makeSpawnSubagent(spawnDeps(store, makeAbortableLoop(), { turnSlots }) as any);
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
    const spawn = makeSpawnSubagent(spawnDeps(store, makeAbortableLoop(), { turnSlots }) as any);
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
    const spawn = makeSpawnSubagent(spawnDeps(store, makeAbortableLoop(), {
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
    const spawn = makeSpawnSubagent(spawnDeps(store, makeFastLoop(), {
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
    const spawn = makeSpawnSubagent(spawnDeps(store, makeFastLoop('all good'), {
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
    const spawn = makeSpawnSubagent(spawnDeps(store, makeFastLoop('complete'), {
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

describe('heap-split phase 1 — routing a pure-reasoning child offscreen', () => {
  const withOffscreen = (store: any, offscreen: any, extra: any = {}) => {
    // A distinctively-texted in-SW loop so we can tell which path ran.
    const inSwLoop = makeFastLoop('IN-SW answer');
    return makeSpawnSubagent(spawnDeps(store, inSwLoop, {
      runReasoningOffscreen: offscreen,
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
    const child = [...store.map.values()].find((s: any) => s.kind === 'subagent');
    expect(child.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'OFFSCREEN answer' });
  });

  test('a child WITH tools stays in the in-SW loop (keyless worker cannot hold tools)', async () => {
    const store = makeStore();
    const parent = await store.create({});
    let offscreenCalled = false;
    const spawn = withOffscreen(store, async () => { offscreenCalled = true; return { ok: true, finalText: 'x' }; });
    const out = await spawn({ task: 't', tools: ['a'], parentSessionId: parent.sessionId });
    expect(offscreenCalled).toBe(false);
    expect(out.result).toBe('IN-SW answer');
  });

  test('a NEVER-STARTED offscreen failure falls back to the in-SW loop (never dies on infra)', async () => {
    const store = makeStore();
    const parent = await store.create({});
    const spawn = withOffscreen(store, async () => ({ ok: false, started: false, error: 'offscreen doc unavailable' }));
    const out = await spawn({ task: 'reason', tools: [], parentSessionId: parent.sessionId });
    expect(out.result).toBe('IN-SW answer');           // fell back, didn't die
  });

  test('a STARTED-but-errored offscreen run does NOT re-run in-SW (would double-bill)', async () => {
    const store = makeStore();
    const parent = await store.create({});
    let inSwRan = false;
    const inSwLoop = async function* (ctx: any) { inSwRan = true; await ctx.sessions.appendMessage(ctx.sessionId, { role: 'assistant', content: 'IN-SW answer' }); yield { type: 'stop', stopReason: 'end_turn' }; };
    const spawn = makeSpawnSubagent(spawnDeps(store, inSwLoop, {
      runReasoningOffscreen: async () => ({ ok: false, started: true, error: 'provider-http-500', finalText: '' }),
      renderSystemPromptForChild: (t: string) => `SYS:${t}`,
    }) as any);
    const out = await spawn({ task: 'reason', tools: [], parentSessionId: parent.sessionId });
    expect(inSwRan).toBe(false);                        // did NOT double-run
    expect(out.result).toBe('');                        // surfaced the (empty) offscreen result
  });
});

// ---- actor-messaging: the lineage gate + arbitration ------------------------

type Reenter = { userText: string; sessionId: string; synthetic: boolean };
type Hop = { sessionId: string; parentSessionId: string | null; spawnedTrusted: boolean };

const gateHarness = (over: Partial<Parameters<typeof makeActorMessaging>[0]> = {}) => {
  const reentries: Reenter[] = [];
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
  return { ...makeActorMessaging(deps), reentries, turnsRun, appended };
};

// A trusted direct child of the active chat.
const trustedChild: Hop[] = [
  { sessionId: 'sub-1', parentSessionId: 'chat-1', spawnedTrusted: true },
];
const ancestryOf = (hops: Hop[]) => async (_sessionId: string) => hops;

describe('message_actor — the trusted-lineage sender gate (phase 3)', () => {
  test('ACCEPTS a trusted-lineage subagent (non-active sender with a clean chain)', async () => {
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

describe('message_actor — root-keyed budgets (phase 4)', () => {
  test('a subagent\'s sends draw from its ROOT\'s rate budget (one bound per delegation tree)', async () => {
    const { messageActor } = gateHarness({
      getAncestry: ancestryOf(trustedChild),
      caps: { rateCap: 2 },
    });
    // Two sends from the root chat itself…
    expect((await messageActor({ to: 'app-1', message: 'a', senderSessionId: 'chat-1' })).ok).toBe(true);
    await tick();
    expect((await messageActor({ to: 'app-1', message: 'b', senderSessionId: 'chat-1' })).ok).toBe(true);
    await tick();
    // …exhaust the budget for the subagent too — it shares the root's window.
    const r = await messageActor({ to: 'app-1', message: 'c', senderSessionId: 'sub-1', inbound: false });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('delegation tree');
  });

  test('stopActorsFor(root chat) covers an actor turn a SUBAGENT started', async () => {
    // Hold the actor turn in the queue so it stays in flight.
    const queued: Array<() => void> = [];
    const { messageActor, stopActorsFor } = gateHarness({
      getAncestry: ancestryOf(trustedChild),
      turnSlots: { runWhenIdle: (_sid: string, fn: () => void) => { queued.push(fn); } },
    });
    // Fire-and-forget: awaitReply resolves only after the queued turn runs.
    const pending = messageActor({ to: 'app-1', message: 'go', senderSessionId: 'sub-1', inbound: false, awaitReply: true });
    await tick();
    // The user hits Stop on the CHAT — the root — and the subagent's in-flight
    // actor session is returned for the slot-abort cascade.
    expect(stopActorsFor('chat-1')).toEqual(['res-1']);
    queued.forEach((fn) => fn()); // drain: the stopped-generation path settles the await
    const r = await pending;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('stopped');
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
});

describe('message_actor — the subagent awaitReply mode', () => {
  test('resolves the fenced reply INTO the tool result (no reentry wake)', async () => {
    const { messageActor, reentries } = gateHarness({ getAncestry: ancestryOf(trustedChild) });
    const r = await messageActor({ to: 'app-1', message: 'build', senderSessionId: 'sub-1', inbound: false, awaitReply: true });
    expect(r.ok).toBe(true);
    expect(r.content).toContain('<u origin="app-1">built the thing</u>');
    expect(r.content).toContain('has replied');
    await tick();
    expect(reentries.length).toBe(0); // the child is never woken
  });
  test('an aborted subagent unblocks even if the actor turn never settles (#1/#3)', async () => {
    // The actor turn is held in the queue (never run), so onReply never fires.
    // The child's abort signal must still unwind the await — and stop the
    // actor slot it was waiting on.
    const stopped: string[] = [];
    const controller = new AbortController();
    const { messageActor } = gateHarness({
      getAncestry: ancestryOf(trustedChild),
      turnSlots: {
        runWhenIdle: (_sid: string, _fn: () => void) => { /* hold: never run the actor turn */ },
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
    // the delegated actor turn was stopped, not left running orphaned
    expect(stopped).toContain('res-1');
  });

  test('an already-aborted signal resolves immediately and stops the actor', async () => {
    const stopped: string[] = [];
    const controller = new AbortController();
    controller.abort();
    const { messageActor } = gateHarness({
      getAncestry: ancestryOf(trustedChild),
      turnSlots: {
        runWhenIdle: (_sid: string, _fn: () => void) => { /* hold */ },
        stop: (id: string) => { stopped.push(id); return true; },
      } as any,
    });
    const r = await messageActor({
      to: 'app-1', message: 'x', senderSessionId: 'sub-1', inbound: false,
      awaitReply: true, awaitSignal: controller.signal,
    });
    expect(r.ok).toBe(false);
    expect(stopped).toContain('res-1');
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

  test('a redrained reply whose sender was an ephemeral subagent is rerouted to the ROOT', async () => {
    const audits: any[] = [];
    const { redrain, reentries } = gateHarness({
      appendAudit: async (e: any) => { audits.push(e); },
      mailbox: {
        append: async () => {},
        remove: async () => {},
        load: async () => [{
          id: 'c-1', senderSessionId: 'sub-9', to: 'app-1', message: 'finish it',
          createdAt: 1, provenance: { rootSessionId: 'chat-1', lineagePath: ['chat-1', 'sub-9'] },
        }],
      },
    });
    const r = await redrain();
    expect(r.redrained).toBe(1);
    await tick();
    // The wake reached the CHAT, not the dead child.
    expect(reentries.length).toBe(1);
    expect(reentries[0].sessionId).toBe('chat-1');
    expect(audits.some((a) => a.type === 'actor_reply_rerouted')).toBe(true);
  });

  test('a redrained in-flight twin still counts against dedupe (#4 symmetry)', async () => {
    // Hold every queued turn so the redrained turn stays in flight; its intent
    // must be tracked so an identical fresh send is refused and — critically —
    // the redrained turn's settle doesn't decrement a DIFFERENT send's refcount.
    const queued: Array<() => void> = [];
    const { messageActor, redrain } = gateHarness({
      turnSlots: { runWhenIdle: (_sid: string, fn: () => void) => { queued.push(fn); } },
      mailbox: {
        append: async () => {},
        remove: async () => {},
        load: async () => [{ id: 'c-1', senderSessionId: 'chat-1', to: 'app-1', message: 'reprice', createdAt: 1 }],
      },
    });
    await redrain(); // re-queues (chat-1 → app-1, 'reprice'); intent now tracked
    // An identical fresh send from the same chat is refused as a duplicate.
    const dup = await messageActor({ to: 'app-1', message: 'reprice', senderSessionId: 'chat-1' });
    expect(dup.ok).toBe(false);
    expect(dup.error).toContain('already in flight');
  });

  test('a pre-#134 envelope (no provenance) keeps the sender-addressed wake', async () => {
    const { redrain, reentries } = gateHarness({
      mailbox: {
        append: async () => {},
        remove: async () => {},
        load: async () => [{ id: 'c-2', senderSessionId: 'chat-1', to: 'app-1', message: 'redo', createdAt: 1 }],
      },
    });
    await redrain();
    await tick();
    expect(reentries.length).toBe(1);
    expect(reentries[0].sessionId).toBe('chat-1');
  });
});
