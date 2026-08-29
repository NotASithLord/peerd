import { describe, test, expect } from 'bun:test';
import { makeSessionMutationRoutes } from '../../extension/background/routes/session-mutations.js';
import { makeLifecycleBoot } from '../../extension/peerd-runtime/lifecycle/boot.js';

class SessionNotFoundError extends Error {}

const baseDeps = (over: any = {}) => {
  const calls: any = { extract: [], updated: [], cacheSet: null, cacheCleared: false, halted: [] };
  const cache: any = { current: { sessionId: 'cur', model: 'old' } };
  const deps = {
    vault: { isLocked: () => false },
    auditLog: { append: async () => {} },
    pushState: () => {},
    sessions: {
      get: async (id: string) => (id === 'cur' || id === 's2' ? { sessionId: id } : null),
      update: async (id: string, patch: any) => { calls.updated.push([id, patch]); },
      archive: async () => {},
    },
    sessionCache: {
      _store: { currentSessionId: 'cur' } as any,
      sessionGet: async (k: string) => (deps.sessionCache as any)._store[k],
      sessionSet: async (k: string, v: any) => { (deps.sessionCache as any)._store[k] = v; },
      sessionDelete: async (k: string) => { delete (deps.sessionCache as any)._store[k]; },
    },
    sessionState: {
      current: () => cache.current,
      set: (r: any) => { cache.current = r; calls.cacheSet = r; },
      clear: () => { cache.current = null; calls.cacheCleared = true; },
    },
    autoMemory: { maybeExtract: async (id: string, reason: string) => { calls.extract.push([id, reason]); } },
    maybeAutoResumeAfterRecovery: () => {},
    haltGoalRun: (sid: string) => { calls.halted.push(sid); },
    // session/reset stops the abandoned session's turn + cascades to its actors.
    // Defaults = "nothing in flight" so the other reset tests are unaffected.
    turnSlots: { stop: () => false },
    actorMessaging: { stopActorsFor: () => [] },
    actorLifecycle: { stopSubtree: () => [] },
    resolvePermission: async (s: any) => ({ mode: s ? 'act' : 'plan', confirmActions: false }),
    normalizeMode: (m: string) => (m === 'plan' ? 'plan' : 'act'),
    normalizeConfirmActions: (c: any) => c === true,
    SessionNotFoundError,
    ...over,
  };
  return { deps, calls };
};

describe('session/setModel', () => {
  test('no session → no-session', async () => {
    const { deps } = baseDeps();
    deps.sessionCache._store = {};
    expect(await makeSessionMutationRoutes(deps)['session/setModel']({ model: 'm' })).toEqual({ ok: false, error: 'no-session' });
  });
  test('invalid model rejected', async () => {
    const { deps } = baseDeps();
    expect(await makeSessionMutationRoutes(deps)['session/setModel']({ sessionId: 'cur', model: '  ' })).toEqual({ ok: false, error: 'invalid-model' });
  });
  test('updates record + keeps the active-session cache coherent', async () => {
    const { deps, calls } = baseDeps();
    const res = await makeSessionMutationRoutes(deps)['session/setModel']({ sessionId: 'cur', model: '  gpt-x  ' });
    expect(res).toEqual({ ok: true, model: 'gpt-x' });
    expect(calls.updated).toEqual([['cur', { model: 'gpt-x' }]]);
    expect(calls.cacheSet).toEqual({ sessionId: 'cur', model: 'gpt-x' });
  });
  test('does NOT touch cache when the edited session is not the cached one', async () => {
    const { deps, calls } = baseDeps();
    await makeSessionMutationRoutes(deps)['session/setModel']({ sessionId: 's2', model: 'z' });
    expect(calls.cacheSet).toBeNull();
  });
});

describe('session/reset + switch + archive auto-memory seams', () => {
  test('reset clears cache + extracts from the previous session', async () => {
    const { deps, calls } = baseDeps();
    await makeSessionMutationRoutes(deps)['session/reset']();
    expect(calls.cacheCleared).toBe(true);
    expect(calls.extract).toEqual([['cur', 'switch']]);
  });
  test('reset awaits the empty-chat projection before returning', async () => {
    let release!: () => void;
    const projected = new Promise<void>((resolve) => { release = resolve; });
    const { deps } = baseDeps({ pushState: () => projected });
    let returned = false;
    const reset = makeSessionMutationRoutes(deps)['session/reset']()
      .then(() => { returned = true; });

    await Promise.resolve();
    expect(returned).toBe(false);
    release();
    await reset;
    expect(returned).toBe(true);
  });
  test('switch sets cache + extracts from previous (only when different)', async () => {
    const { deps, calls } = baseDeps();
    await makeSessionMutationRoutes(deps)['session/switch']({ sessionId: 's2' });
    expect(calls.cacheSet).toEqual({ sessionId: 's2' });
    expect(calls.extract).toEqual([['cur', 'switch']]);
  });
  test('reset stops the root, bound actors, and spawned descendants', async () => {
    // The current chat is 'cur' with two actors in flight. "New chat" must abort
    // the orchestrator turn AND both actor slots — else they run on as zombies
    // (the OM2W harness wedge). Mirrors agent/stop's cascade.
    const stopped: string[] = [];
    const subtreeRoots: string[] = [];
    const { deps } = baseDeps({
      turnSlots: { stop: (sid: string) => { stopped.push(sid); return true; } },
      actorMessaging: { stopActorsFor: (sid: string) => (sid === 'cur' ? ['res-1', 'res-2'] : []) },
      actorLifecycle: { stopSubtree: (sid: string) => { subtreeRoots.push(sid); return ['child-1']; } },
    });
    await makeSessionMutationRoutes(deps)['session/reset']();
    expect(stopped).toEqual(['cur', 'res-1', 'res-2']);   // orchestrator first, then its actors
    expect(subtreeRoots).toEqual(['cur']);
  });
  test('reset with nothing in flight does not over-stop', async () => {
    const stopped: string[] = [];
    const { deps } = baseDeps({
      turnSlots: { stop: (sid: string) => { stopped.push(sid); return false; } },
      actorMessaging: { stopActorsFor: () => [] },
    });
    await makeSessionMutationRoutes(deps)['session/reset']();
    expect(stopped).toEqual(['cur']);   // only the orchestrator slot is probed; no actors
  });
  test('reset + archive halt the chat\'s goal run; switch does NOT', async () => {
    const reset = baseDeps();
    await makeSessionMutationRoutes(reset.deps)['session/reset']();
    expect(reset.calls.halted).toEqual(['cur']);   // new chat abandons the run

    const archive = baseDeps();
    await makeSessionMutationRoutes(archive.deps)['session/archive']({ sessionId: 's2' });
    expect(archive.calls.halted).toEqual(['s2']);  // archiving wraps it up

    const sw = baseDeps();
    await makeSessionMutationRoutes(sw.deps)['session/switch']({ sessionId: 's2' });
    expect(sw.calls.halted).toEqual([]);           // switching keeps it running
  });
  test('switch to the SAME (current) session does NOT re-extract', async () => {
    const { deps, calls } = baseDeps();
    await makeSessionMutationRoutes(deps)['session/switch']({ sessionId: 'cur' });
    expect(calls.cacheSet).toEqual({ sessionId: 'cur' });
    expect(calls.extract).toEqual([]); // previousId === sessionId → no auto-memory call
  });
  test('archiving a NON-active session leaves the active cache intact', async () => {
    const { deps, calls } = baseDeps();
    await makeSessionMutationRoutes(deps)['session/archive']({ sessionId: 's2' });
    expect(calls.cacheCleared).toBe(false); // currentId !== archived id → cache untouched
    expect(calls.extract).toEqual([['s2', 'archive']]);
  });
  test('archive stops the root and actor turns, then awaits lifecycle settlement', async () => {
    const events: string[] = [];
    let settled = false;
    const { deps } = baseDeps({
      turnSlots: { stop: (sid: string) => { events.push(`stop:${sid}`); return true; } },
      actorMessaging: { stopActorsFor: () => ['actor-1', 'actor-2'] },
      actorLifecycle: { stopSubtree: (sid: string) => { events.push(`subtree:${sid}`); return ['child-1']; } },
      purgeLifecycleSession: async (sid: string) => {
        events.push(`purge:${sid}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
        settled = true;
      },
    });
    await makeSessionMutationRoutes(deps)['session/archive']({ sessionId: 's2' });
    expect(events).toEqual([
      'stop:s2', 'stop:actor-1', 'stop:actor-2',
      'subtree:s2', 'purge:s2', 'purge:actor-1', 'purge:actor-2', 'purge:child-1',
    ]);
    expect(settled).toBe(true);
  });
  test('archive settles dispatched actor D/E operations before returning', async () => {
    const stored = new Map<string, unknown>();
    const lifecycle = makeLifecycleBoot({
      storage: {
        get: async (key: string) => structuredClone(stored.get(key)),
        set: async (key: string, value: unknown) => {
          stored.set(key, structuredClone(value));
        },
      },
      nonce: () => 'archive-test-generation',
      resolveNoticeSession: async (sid: string) =>
        (sid.startsWith('actor-') ? 's2' : sid),
    });
    const { generation } = await lifecycle.init();
    for (const [sessionId, retryClass] of [['actor-d', 'D'], ['actor-e', 'E']]) {
      const operationId = `${sessionId}:dispatch`;
      await lifecycle.operationLog.begin({
        operationId, sessionId, toolName: `tool-${retryClass}`,
        retryClass, generationId: generation.id,
      });
      await lifecycle.operationLog.transition(operationId, 'running');
      await lifecycle.operationLog.markDispatched(operationId);
    }
    const purged: string[] = [];
    const { deps } = baseDeps({
      turnSlots: { stop: () => true },
      actorMessaging: { stopActorsFor: () => ['actor-d', 'actor-e'] },
      purgeLifecycleSession: async (sid: string) => {
        purged.push(sid);
        await lifecycle.purgeSession(sid);
      },
    });

    await makeSessionMutationRoutes(deps)['session/archive']({ sessionId: 's2' });

    expect(purged).toEqual(['s2', 'actor-d', 'actor-e']);
    expect((await lifecycle.operationLog.get('actor-d:dispatch'))?.state)
      .toBe('outcome_unknown');
    expect((await lifecycle.operationLog.get('actor-e:dispatch'))?.state)
      .toBe('outcome_unknown');
    const notice = await lifecycle.drainNoticesFor('s2');
    expect(notice).toContain('tool-D');
    expect(notice).toContain('tool-E');
  });
  test('switch unknown session → session-not-found', async () => {
    const { deps } = baseDeps();
    expect(await makeSessionMutationRoutes(deps)['session/switch']({ sessionId: 'ghost' })).toEqual({ ok: false, error: 'session-not-found' });
  });
  test('archive of the active session clears cache + extracts with archive reason', async () => {
    const { deps, calls } = baseDeps();
    await makeSessionMutationRoutes(deps)['session/archive']({ sessionId: 'cur' });
    expect(calls.cacheCleared).toBe(true);
    expect(calls.extract).toEqual([['cur', 'archive']]);
  });
  test('archive maps SessionNotFoundError', async () => {
    const { deps } = baseDeps({ sessions: { get: async () => ({ sessionId: 'x' }),
      archive: async () => { throw new SessionNotFoundError(); } } });
    expect(await makeSessionMutationRoutes(deps)['session/archive']({ sessionId: 'x' })).toEqual({ ok: false, error: 'session-not-found' });
  });
  // Archive is the terminal session-lifecycle event (there is no delete route),
  // so it is where the session's durable script workspace subtree is torn down.
  test('archive nukes the session\'s script workspace (fire-and-forget, failure-tolerant)', async () => {
    const nuked: string[] = [];
    const { deps } = baseDeps({ nukeSessionWorkspace: (sid: string) => { nuked.push(sid); return Promise.resolve(); } });
    await makeSessionMutationRoutes(deps)['session/archive']({ sessionId: 's2' });
    expect(nuked).toEqual(['s2']);

    // a rejecting nuke must never fail the archive
    const rejecting = baseDeps({ nukeSessionWorkspace: () => Promise.reject(new Error('opfs gone')) });
    expect(await makeSessionMutationRoutes(rejecting.deps)['session/archive']({ sessionId: 's2' })).toEqual({ ok: true });

    // an absent dep (unit fixtures, Firefox edge) is a no-op, not a crash
    const absent = baseDeps();
    expect(await makeSessionMutationRoutes(absent.deps)['session/archive']({ sessionId: 's2' })).toEqual({ ok: true });
  });
  test('a FAILED archive (unknown session) does not nuke the workspace', async () => {
    const nuked: string[] = [];
    const { deps } = baseDeps({
      sessions: { get: async () => null },
      nukeSessionWorkspace: (sid: string) => { nuked.push(sid); return Promise.resolve(); },
    });
    await makeSessionMutationRoutes(deps)['session/archive']({ sessionId: 'ghost' });
    expect(nuked).toEqual([]);
  });
});

describe('permission/set', () => {
  test('no mode or confirm → error', async () => {
    const { deps } = baseDeps();
    expect(await makeSessionMutationRoutes(deps)['permission/set']({})).toEqual({ ok: false, error: 'no-mode-or-confirm' });
  });
  test('normalizes + caches + persists + returns resolved', async () => {
    const { deps, calls } = baseDeps();
    const res = await makeSessionMutationRoutes(deps)['permission/set']({ mode: 'plan', confirmActions: true });
    expect(res.ok).toBe(true);
    expect(res.permission).toEqual({ mode: 'act', confirmActions: false }); // from resolvePermission(session)
    expect(deps.sessionCache._store.currentPermissionMode).toBe('plan');
    expect(deps.sessionCache._store.currentConfirmActions).toBe(true);
    expect(calls.updated).toEqual([['cur', { permissionMode: 'plan', confirmActions: true }]]);
  });
});

// A route must finish durable Goal Stop before it resets or archives a session.
describe('durable goal Stop is awaited on new-chat / archive (#60)', () => {
  const slowHalt = () => {
    let done = false;
    const haltGoalRun = async () => { await new Promise((r) => setTimeout(r, 20)); done = true; };
    return { haltGoalRun, isDone: () => done };
  };

  test('session/reset awaits the durable Stop before returning', async () => {
    const halt = slowHalt();
    const { deps } = baseDeps({ haltGoalRun: halt.haltGoalRun });
    await makeSessionMutationRoutes(deps)['session/reset']();
    expect(halt.isDone()).toBe(true);
  });

  test('session/archive awaits the durable Stop before returning', async () => {
    const halt = slowHalt();
    let archivedAfterHalt = false;
    const { deps } = baseDeps({
      haltGoalRun: halt.haltGoalRun,
      sessions: { get: async () => ({ sessionId: 'cur' }),
        archive: async () => { archivedAfterHalt = halt.isDone(); } },
    });
    await makeSessionMutationRoutes(deps)['session/archive']({ sessionId: 'cur' });
    expect(archivedAfterHalt).toBe(true);
  });
});
