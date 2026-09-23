import { describe, expect, test } from 'bun:test';
import { captureSessionAuthority } from '../../extension/shared/session-authority-epoch.js';
import { createSessionStore } from '../../extension/peerd-runtime/sessions/store.js';
import { createKernelSessionReader } from '../../extension/background/kernel-session-reader.js';
import { bindCurrentChat } from '../../extension/shared/current-session-binding.js';
import { makeGoalRunner } from '../../extension/peerd-runtime/loop/goal-runner.js';

describe('host session authority epoch', () => {
  test.each(['rich', 'cold'])('%s permission writes invalidate before storage and through failure', async (kind) => {
    const gate = Promise.withResolvers<void>();
    const idb = {
      get: async () => ({ sessionId: 'chat', messagesV2: true, msgIndex: [], permissionMode: 'act' }),
      getAll: async () => [],
      put: async () => { await gate.promise; },
      patch: async () => { await gate.promise; return {}; },
    };
    const before = captureSessionAuthority(idb);
    const pending = kind === 'rich'
      ? createSessionStore({ idb }).update('chat', { permissionMode: 'plan' })
      : createKernelSessionReader(idb).updateMetadata('chat', { permissionMode: 'plan' });
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
    const cache = { sessionSet: async () => { await gate.promise; }, sessionDelete: async () => {} };
    const before = captureSessionAuthority(cache);
    const binding = bindCurrentChat(cache, { sessionId: 'next', permissionMode: 'plan' });
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
