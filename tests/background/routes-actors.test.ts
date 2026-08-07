// The actors-in-code route is the authority bridge behind script's actors.*
// client. Prove the full caller classes here: chat manifests, persisted spawned
// grants, bound-actor refusal, live-run owner binding, sender-gate propagation,
// actor_list narrowing, and Stop cancellation.

import { describe, test, expect } from 'bun:test';
import { makeActorsRoutes } from '../../extension/background/routes/actors.js';
import {
  actorsCallToOp, shapeActorsResult, askOutcome, ACTORS_ASK_DEFAULT_TIMEOUT_MS,
  ACTORS_ADDRESS_MAX_CHARS, ACTORS_GOAL_MAX_CHARS,
  ACTORS_TRACE_TARGET_MAX_CHARS, ACTORS_TRACE_ERROR_MAX_CHARS,
} from '../../extension/peerd-runtime/actor/actors-api.js';
import { resolveManifestAllow } from '../../extension/peerd-runtime/tools/manifests.js';
import { createScriptRunRegistry } from '../../extension/background/script-runs.js';

type Owner = {
  sessionId: string;
  kind?: string;
  grantedTools?: string[];
  toolManifest?: unknown;
};

const OFFSCREEN = { id: 'peerd', url: 'chrome-extension://peerd/offscreen/offscreen.html' };
const ENGINE_TAB = { id: 'peerd', url: 'chrome-extension://peerd/engine-tabs/notebook-tab/index.html' };

const makeHarness = ({
  owner = { sessionId: 'chat-1' },
  runOwner,
  actorsAllowed = true,
  actorOpAllowed = true,
  messageActor,
  buildToolContext,
  scriptRuns,
  getOwner,
}: {
  owner?: Owner | null;
  runOwner?: string | null;
  actorsAllowed?: boolean;
  actorOpAllowed?: boolean;
  messageActor?: (req: any) => Promise<any>;
  buildToolContext?: (args: any) => Promise<any>;
  scriptRuns?: ReturnType<typeof createScriptRunRegistry>;
  getOwner?: (id: string) => Promise<Owner | null>;
} = {}) => {
  const resolvedRunOwner = runOwner === undefined ? owner?.sessionId ?? null : runOwner;
  const calls: any[] = [];
  const broadcasts: any[] = [];
  const mirrored: any[] = [];
  const runController = new AbortController();
  const route = makeActorsRoutes({
    sessions: { get: getOwner ?? (async (id: string) => owner?.sessionId === id ? owner : null) },
    uiPorts: { broadcast: (event: any) => broadcasts.push(event) },
    buildToolContext: buildToolContext ?? (async (args: any) => ({ builtFor: args })),
    dispatchToolCall: async (call: any, ctx: any) => {
      calls.push({ kind: 'dispatch', call, ctx });
      return { ok: true, content: 'ROSTER', structured: { refs: [{ ref: 'vm-1', type: 'webvm' }] } };
    },
    actorMessaging: {
      messageActor: async (req: any) => {
        calls.push({ kind: 'message', req });
        return messageActor ? messageActor(req) : { ok: true, content: 'done' };
      },
    },
    scriptRuns: scriptRuns ?? {
      ownerFor: (runId: string) => runId === 'run-1' ? resolvedRunOwner : null,
      allows: (runId: string, capability: string) => runId === 'run-1'
        && capability === 'actors' && actorsAllowed,
      admitActorOp: (runId: string) => runId === 'run-1' && actorOpAllowed,
      signalFor: (runId: string) => runId === 'run-1' ? runController.signal : null,
      recordOp: (_runId: string, op: any) => {
        const index = mirrored.findIndex((candidate) => candidate.seq === op.seq);
        if (index >= 0) mirrored[index] = { ...mirrored[index], ...op };
        else mirrored.push(op);
      },
    },
    actorsCallToOp,
    shapeActorsResult,
    askOutcome,
    ACTORS_ASK_DEFAULT_TIMEOUT_MS,
    ACTORS_TRACE_TARGET_MAX_CHARS,
    ACTORS_TRACE_ERROR_MAX_CHARS,
    resolveManifestAllow,
    isOffscreenSender: (sender: unknown) => sender === OFFSCREEN,
  })['actors/call'];
  const callFrom = (sender: unknown, method: string, args: any = {}) => route({
    method, args, ownerSessionId: owner?.sessionId ?? 'missing',
    ownerToolUseId: 'tu-1', runId: 'run-1', seq: 1,
  }, sender);
  const call = (method: string, args: any = {}) => callFrom(OFFSCREEN, method, args);
  return { call, callFrom, calls, broadcasts, mirrored, runController };
};

describe('actors/call — owner and grant walls', () => {
  test('a chat with no manifest keeps the historical delegation surface', async () => {
    const h = makeHarness();
    expect(await h.call('ask', { to: 'web', goal: 'find it' }))
      .toEqual({ ok: true, value: { reply: 'done', failed: false } });
    expect(h.calls[0].req.senderSessionId).toBe('chat-1');
    expect(h.calls[0].req.via).toBe('script');
  });

  test('a chat manifest cannot be bypassed through script', async () => {
    const h = makeHarness({
      owner: { sessionId: 'chat-1', toolManifest: { allow: ['script'] } },
    });
    const result = await h.call('ask', { to: 'web', goal: 'find it' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("'message_actor' is not granted");
    expect(h.calls).toEqual([]);
  });

  test('a spawned actor with script + message_actor gets exact direct-call parity', async () => {
    const h = makeHarness({
      owner: {
        sessionId: 'spawn-1', kind: 'spawned',
        grantedTools: ['script', 'message_actor'],
      },
    });
    expect(await h.call('ask', { to: 'vm-1', goal: 'run tests' }))
      .toEqual({ ok: true, value: { reply: 'done', failed: false } });
    const req = h.calls[0].req;
    expect(req.senderSessionId).toBe('spawn-1');
    expect(req.awaitReply).toBe(true);
    // Chained actor-derived bytes keep messageActor's untrusted envelope.
    expect(req.bareReply).toBeUndefined();
  });

  test('a spawned actor without message_actor is refused before the sender gate', async () => {
    const h = makeHarness({
      owner: { sessionId: 'spawn-1', kind: 'spawned', grantedTools: ['script'] },
    });
    const result = await h.call('ask', { to: 'vm-1', goal: 'run tests' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("'message_actor' is not granted");
    expect(h.calls).toEqual([]);
  });

  test('a bound environment actor remains unable to cross-delegate', async () => {
    const h = makeHarness({
      owner: { sessionId: 'bound-1', kind: 'actor', grantedTools: ['script', 'message_actor'] },
    });
    const result = await h.call('ask', { to: 'web', goal: 'escape the pin' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('chat session or a granted spawned actor');
    expect(h.calls).toEqual([]);
  });

  test('a missing, finished, or foreign run id buys no delegation', async () => {
    const h = makeHarness({ runOwner: 'other-session' });
    const result = await h.call('ask', { to: 'web', goal: 'find it' });
    expect(result).toEqual({ ok: false, error: 'actors: unknown, finished, or foreign script run' });
    expect(h.calls).toEqual([]);
  });

  test('only the offscreen job host may redeem a live actors run', async () => {
    const h = makeHarness();
    expect(await h.callFrom(ENGINE_TAB, 'ask', { to: 'web', goal: 'find it' }))
      .toEqual({ ok: false, error: 'actors: unauthorized relay' });
    expect(await h.callFrom(undefined, 'ask', { to: 'web', goal: 'find it' }))
      .toEqual({ ok: false, error: 'actors: unauthorized relay' });
    expect(h.calls).toEqual([]);
  });

  test('an owner-bound non-actors run id buys no delegation', async () => {
    const h = makeHarness({ actorsAllowed: false });
    expect(await h.call('ask', { to: 'web', goal: 'find it' }))
      .toEqual({ ok: false, error: 'actors: unknown, finished, or foreign script run' });
    expect(h.calls).toEqual([]);
  });
});

describe('actors/call — per-operation authority', () => {
  test('oversized addresses and goals stop before actor dispatch, UI broadcast, or trace retention', async () => {
    const cases = [
      { address: 'a'.repeat(ACTORS_ADDRESS_MAX_CHARS + 1), message: 'x' },
      { address: 'web', message: 'g'.repeat(ACTORS_GOAL_MAX_CHARS + 1) },
    ];
    for (const args of cases) {
      const h = makeHarness();
      const result = await h.call('call', args);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('at most');
      expect(h.calls).toEqual([]);
      expect(h.broadcasts).toEqual([]);
      expect(h.mirrored).toEqual([]);
    }
  });

  test('live UI and crash-mirror trace fields retain bounded projections only', async () => {
    const target = 't'.repeat(ACTORS_TRACE_TARGET_MAX_CHARS + 20);
    const actorError = `message_actor: ${'e'.repeat(ACTORS_TRACE_ERROR_MAX_CHARS + 100)}`;
    const h = makeHarness({ messageActor: async () => ({ ok: false, error: actorError }) });
    expect((await h.call('call', { address: target, message: 'inspect it' })).ok).toBe(false);
    expect(h.calls[0].req.to).toBe(target);
    expect(h.broadcasts[0].to).toBe(target.slice(0, ACTORS_TRACE_TARGET_MAX_CHARS));
    expect(h.mirrored[0].to).toBe(target.slice(0, ACTORS_TRACE_TARGET_MAX_CHARS));
    expect(h.mirrored[0].goal).toBe('inspect it');
    expect(h.mirrored[0].settled).toBe(true);
    expect(h.mirrored[0].error.length).toBe(ACTORS_TRACE_ERROR_MAX_CHARS);
  });

  test('the real registry exposes one bounded in-flight row and upserts settlement', async () => {
    const registry = createScriptRunRegistry();
    registry.register('run-1', undefined, 'chat-1', { actors: true });
    let settleActor: (value: any) => void = () => {};
    const h = makeHarness({
      scriptRuns: registry,
      messageActor: () => new Promise((resolve) => { settleActor = resolve; }),
    });
    const target = 't'.repeat(ACTORS_TRACE_TARGET_MAX_CHARS + 20);
    const goal = 'g'.repeat(100);
    const pending = h.call('call', { address: target, message: goal });
    for (let attempt = 0; attempt < 10 && h.calls.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    expect(registry.opsFor('run-1')).toEqual([expect.objectContaining({
      seq: 1, method: 'call', ok: false, ms: 0, settled: false,
      to: target.slice(0, ACTORS_TRACE_TARGET_MAX_CHARS),
      goal: `${'g'.repeat(59)}…`,
    })]);
    settleActor({ ok: true, content: 'done' });
    expect(await pending).toEqual({ ok: true, value: { reply: 'done', failed: false } });
    expect(registry.opsFor('run-1')).toEqual([expect.objectContaining({
      seq: 1, ok: true, settled: true,
      to: target.slice(0, ACTORS_TRACE_TARGET_MAX_CHARS),
      goal: `${'g'.repeat(59)}…`,
    })]);
    registry.release('run-1');
  });

  test('the SW-side run ceiling refuses work before dispatch', async () => {
    const h = makeHarness({ actorOpAllowed: false });
    expect(await h.call('ask', { to: 'web', goal: 'find it' }))
      .toEqual({ ok: false, error: 'actors: this script run reached its delegation-operation limit' });
    expect(h.calls).toEqual([]);
  });

  test('actors.list requires actor_list in a spawned actor grant', async () => {
    const refused = makeHarness({
      owner: {
        sessionId: 'spawn-1', kind: 'spawned',
        grantedTools: ['script', 'message_actor'],
      },
    });
    expect((await refused.call('list')).error).toContain("'actor_list' is not granted");
    expect(refused.calls).toEqual([]);

    const allowed = makeHarness({
      owner: {
        sessionId: 'spawn-1', kind: 'spawned',
        grantedTools: ['script', 'message_actor', 'actor_list'],
      },
    });
    expect(await allowed.call('list')).toEqual({ ok: true, value: { refs: [{ ref: 'vm-1', type: 'webvm' }] } });
    expect(allowed.calls[0].call.name).toBe('actor_list');
    expect(allowed.calls[0].ctx.abortSignal).toBe(allowed.runController.signal);
  });

  test('Stop during deferred roster context construction prevents dispatch', async () => {
    let finishContext: (ctx: any) => void = () => {};
    const h = makeHarness({
      buildToolContext: () => new Promise((resolve) => { finishContext = resolve; }),
    });
    const pending = h.call('list');
    await Promise.resolve();
    h.runController.abort();
    finishContext({ built: true });
    expect(await pending).toEqual({
      ok: false,
      cancelled: true,
      error: 'actors.list: aborted (Stop) before roster dispatch',
    });
    expect(h.calls).toEqual([]);
  });

  test('Stop during deferred owner lookup prevents actor delivery', async () => {
    let finishOwnerLookup: (owner: Owner | null) => void = () => {};
    const h = makeHarness({
      getOwner: () => new Promise((resolve) => { finishOwnerLookup = resolve; }),
    });
    const pending = h.call('ask', { to: 'web', goal: 'do not start' });
    await Promise.resolve();
    h.runController.abort();
    finishOwnerLookup({ sessionId: 'chat-1' });
    expect(await pending).toEqual({
      ok: false,
      cancelled: true,
      error: 'actors.call: aborted (Stop) before delegation dispatch',
    });
    expect(h.calls).toEqual([]);
    expect(h.broadcasts).toEqual([]);
    expect(h.mirrored).toEqual([]);
  });

  test('the existing sender-gate refusal propagates unchanged', async () => {
    const refusal = 'message_actor: only the active foreground chat or a trusted-lineage actor may message an actor';
    const h = makeHarness({
      owner: {
        sessionId: 'spawn-1', kind: 'spawned',
        grantedTools: ['script', 'message_actor'],
      },
      messageActor: async () => ({ ok: false, error: refusal }),
    });
    expect(await h.call('ask', { to: 'web', goal: 'find it' }))
      .toEqual({ ok: false, error: refusal });
  });

  test('Stop aborts an awaited actors.call through the live run signal', async () => {
    const h = makeHarness({
      owner: {
        sessionId: 'spawn-1', kind: 'spawned',
        grantedTools: ['script', 'message_actor'],
      },
      messageActor: (req: any) => new Promise((resolve) => {
        const settle = () => resolve({ ok: false, error: 'the request was aborted before the actor replied' });
        if (req.awaitSignal.aborted) settle();
        else req.awaitSignal.addEventListener('abort', settle, { once: true });
      }),
    });
    const pending = h.call('ask', { to: 'vm-1', goal: 'long task', timeoutMs: 5_000 });
    for (let attempt = 0; attempt < 10 && h.calls.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    expect(h.calls).toHaveLength(1);
    h.runController.abort();
    expect(await pending).toEqual({
      ok: false,
      cancelled: true,
      error: "actors.call: aborted (Stop) while awaiting 'vm-1'",
    });
    expect(h.broadcasts.at(-1)).toMatchObject({ phase: 'cancelled', cancelled: true, error: 'aborted' });
    expect(h.mirrored).toEqual([expect.objectContaining({
      ok: false, settled: true, cancelled: true,
      error: "actors.call: aborted (Stop) while awaiting 'vm-1'",
    })]);
  });
});
