import { describe, test, expect } from 'bun:test';
import { makeSessionMutationRoutes } from '../../extension/background/routes/session-mutations.js';

class SessionNotFoundError extends Error {}

const baseDeps = (over: any = {}) => {
  const calls: any = { extract: [], updated: [], cacheSet: null, cacheCleared: false };
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
    maybeAutoResume: () => {},
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
  test('switch sets cache + extracts from previous (only when different)', async () => {
    const { deps, calls } = baseDeps();
    await makeSessionMutationRoutes(deps)['session/switch']({ sessionId: 's2' });
    expect(calls.cacheSet).toEqual({ sessionId: 's2' });
    expect(calls.extract).toEqual([['cur', 'switch']]);
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
    const { deps } = baseDeps({ sessions: { archive: async () => { throw new SessionNotFoundError(); } } });
    expect(await makeSessionMutationRoutes(deps)['session/archive']({ sessionId: 'x' })).toEqual({ ok: false, error: 'session-not-found' });
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
