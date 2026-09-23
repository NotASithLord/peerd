import { describe, expect, test } from 'bun:test';
import { beginSessionAuthorityChange, captureSessionAuthority } from '../../extension/shared/session-authority-epoch.js';
import { createSessionStore } from '../../extension/peerd-runtime/sessions/store.js';
import { makeSessionMutationRoutes } from '../../extension/background/routes/session-mutations.js';
import { makeGoalRunner } from '../../extension/peerd-runtime/loop/goal-runner.js';

describe('host session authority epoch', () => {
  test('permission writes invalidate before storage and through failure', async () => {
    const gate = Promise.withResolvers<void>();
    const idb = {
      get: async () => ({ sessionId: 'chat', messagesV2: true, msgIndex: [], permissionMode: 'act' }),
      getAll: async () => [],
      put: async () => { await gate.promise; },
      patch: async () => { await gate.promise; return {}; },
    };
    const before = captureSessionAuthority(idb);
    const pending = createSessionStore({ idb }).update('chat', { permissionMode: 'plan' });
    const outcome = pending.catch(() => undefined);
    expect(before()).toBe(false);
    const during = captureSessionAuthority(idb);
    expect(during()).toBe(false);
    gate.reject(new Error('storage failed'));
    await outcome;
    expect(before()).toBe(false);
    expect(during()).toBe(false);
    expect(captureSessionAuthority(idb)()).toBe(true);
  });

  test('changing the legacy permission cache invalidates an in-flight proof', async () => {
    const gate = Promise.withResolvers<void>();
    const cache = { sessionSet: async () => { await gate.promise; }, sessionGet: async () => null };
    const before = captureSessionAuthority(cache);
    const route = makeSessionMutationRoutes({ sessionCache: cache, beginSessionAuthorityChange,
      normalizeMode: (mode:string) => mode, normalizeConfirmActions: (value:boolean) => value,
      resolvePermission: async () => ({ mode: 'plan' }),
      auditLog: { append: async () => {} }, pushState: () => {},
    });
    const binding = route['permission/set']!({ mode: 'plan' });
    expect(before()).toBe(false);
    expect(captureSessionAuthority(cache)()).toBe(false);
    gate.resolve();
    await binding;
    expect(before()).toBe(false);
    expect(captureSessionAuthority(cache)()).toBe(true);
  });

  test('goal completion revokes temporary Act authority without a session write', async () => {
    const gate = Promise.withResolvers<any>();
    const runner = makeGoalRunner({ runTurn: () => gate.promise });
    const running = runner.start({ sessionId: 'chat', goal: 'finish' });
    const current = runner.captureAuthority();
    expect(current()).toBe(true);
    expect(runner.complete('chat', 'done')).toBe(true);
    expect(current()).toBe(false);
    gate.resolve({ status: 'done' });
    await running;
  });
});
