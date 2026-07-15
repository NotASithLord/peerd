// Prewalk lifecycle against the REAL session store — the layer between the
// pure gate (prewalk.test.ts) and the full SW. Drives the exact sequence the
// SW glue runs (arm on start → gate on a mutating call → reconcile-swap at the
// next turn → restore at run end) over a fake IDB, so the persisted state
// transitions and the model swap/restore are pinned without a browser.
//
// setPrewalk (store): set/clear-with-absent-key + the atomic model restore.

import { describe, test, expect } from 'bun:test';
import { createSessionStore } from '../../extension/peerd-runtime/sessions/store.js';
import {
  resolvePrewalkExecutor, armPrewalk, shouldPrewalkSwap, markPrewalkSwapped,
} from '../../extension/peerd-runtime/loop/prewalk.js';
import type { Session } from '../../extension/peerd-runtime/sessions/types.js';

const makeIdb = () => {
  const stores = new Map<string, Map<string, any>>();
  const tbl = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name)!;
  };
  return {
    get: async (store: string, key: string) => tbl(store).get(key),
    put: async (store: string, val: any) => { tbl(store).set(val.id ?? val.sessionId, val); },
    getAll: async (store: string) => [...tbl(store).values()],
  };
};
const makeStore = () => {
  let i = 0;
  return createSessionStore({ idb: makeIdb(), now: () => 1000, makeId: () => `id-${++i}` });
};

// A known tool → its sideEffect class (the SW reads this off the registry).
const SIDE_EFFECT: Record<string, string> = {
  message_actor: 'write', edit_file: 'write', remember: 'write', open_tab: 'mutate_external',
  read_page: 'read', todo_init: 'read',
};

describe('session store — setPrewalk', () => {
  test('sets state, clears with the key ABSENT, and restores the model atomically', async () => {
    const store = makeStore();
    const s = await store.create({ provider: 'anthropic', model: 'claude-opus-4-8' });
    const state = armPrewalk(s, { provider: 'anthropic', model: 'claude-haiku-4-5' }, 1000)!;

    const armed: Session = await store.setPrewalk(s.sessionId, state);
    expect(armed.prewalk!.phase).toBe('planning');
    expect((await store.get(s.sessionId))!.prewalk!.plannerModel).toBe('claude-opus-4-8');

    // Clear + restore the planner model in one write.
    const cleared = await store.setPrewalk(s.sessionId, null, { provider: 'anthropic', model: 'claude-opus-4-8' });
    expect('prewalk' in cleared).toBe(false);
    expect(cleared.model).toBe('claude-opus-4-8');
    expect('prewalk' in (await store.get(s.sessionId))!).toBe(false);
  });

  test('clearing preserves every other field (todos, messages, provider)', async () => {
    const store = makeStore();
    const s = await store.create({ provider: 'anthropic', model: 'm-1' });
    await store.appendMessage(s.sessionId, { role: 'user', content: 'hi', id: 'm1', when: 1 });
    await store.update(s.sessionId, { todos: [{ id: 1, text: 'a', status: 'pending' }] });
    const state = armPrewalk({ provider: 'anthropic', model: 'm-1' }, { provider: 'anthropic', model: 'm-2' }, 1000)!;
    await store.setPrewalk(s.sessionId, state);

    const cleared = await store.setPrewalk(s.sessionId, null, { provider: 'anthropic', model: 'm-1' });
    expect(cleared.provider).toBe('anthropic');
    expect(cleared.messages.length).toBe(1);
    expect((cleared as any).todos).toHaveLength(1);
  });
});

describe('prewalk full lifecycle over the store', () => {
  // The SW glue, distilled: arm → (planning turns) → first mutating call fires
  // the gate → next turn reconciles the model swap → run end restores.
  test('opus plans, haiku executes after the first landed mutation, opus restored at end', async () => {
    const store = makeStore();
    const s = await store.create({ provider: 'anthropic', model: 'claude-opus-4-8' });

    // 1. ARM (startGoalRun → armPrewalkForRun).
    const executor = resolvePrewalkExecutor({
      settings: { prewalkExecutorModel: 'claude-haiku-4-5' },
      provider: { name: 'anthropic', defaultRunnerModel: 'claude-haiku-4-5' },
    });
    const state = armPrewalk(s, executor, 1000)!;
    await store.setPrewalk(s.sessionId, state);
    expect((await store.get(s.sessionId))!.model).toBe('claude-opus-4-8'); // still the planner

    // 2. Planning turn commits the plan (todo_init is exempt — no swap).
    await store.update(s.sessionId, { todos: [{ id: 1, text: 'do it', status: 'pending' }] });
    const beforePlan = await store.get(s.sessionId);
    expect(shouldPrewalkSwap({
      prewalk: beforePlan!.prewalk, todosCount: beforePlan!.todos!.length,
      toolName: 'todo_init', sideEffect: SIDE_EFFECT.todo_init, ok: true,
    })).toBe(false);
    expect(beforePlan!.prewalk!.phase).toBe('planning'); // unchanged

    // 3. First NON-exempt mutating call succeeds → gate fires (maybePrewalkSwap).
    const preSwap = await store.get(s.sessionId);
    const fire = shouldPrewalkSwap({
      prewalk: preSwap!.prewalk, todosCount: preSwap!.todos!.length,
      toolName: 'message_actor', sideEffect: SIDE_EFFECT.message_actor, ok: true,
    });
    expect(fire).toBe(true);
    await store.setPrewalk(s.sessionId, markPrewalkSwapped(preSwap!.prewalk!, 1001));
    const swapped = await store.get(s.sessionId);
    expect(swapped!.prewalk!.phase).toBe('executing');
    expect(swapped!.model).toBe('claude-opus-4-8'); // model NOT changed yet — that's the reconcile's job

    // 4. Next turn boundary reconciles: phase 'executing' + model mismatch → swap the model.
    const pw = swapped!.prewalk!;
    if (swapped!.provider !== pw.executorProvider || swapped!.model !== pw.executorModel) {
      await store.update(s.sessionId, { provider: pw.executorProvider, model: pw.executorModel });
    }
    expect((await store.get(s.sessionId))!.model).toBe('claude-haiku-4-5'); // now on the executor

    // 5. Run end (restorePrewalkForRun): planner restored, state cleared.
    const atEnd = await store.get(s.sessionId);
    await store.setPrewalk(s.sessionId, null, {
      provider: atEnd!.prewalk!.plannerProvider, model: atEnd!.prewalk!.plannerModel,
    });
    const restored = await store.get(s.sessionId);
    expect(restored!.model).toBe('claude-opus-4-8');
    expect('prewalk' in restored!).toBe(false);
  });

  test('a failed mutating call does NOT swap (the action was not evidence the plan works)', async () => {
    const store = makeStore();
    const s = await store.create({ provider: 'anthropic', model: 'claude-opus-4-8' });
    await store.setPrewalk(s.sessionId, armPrewalk(s, { provider: 'anthropic', model: 'claude-haiku-4-5' }, 1000)!);
    await store.update(s.sessionId, { todos: [{ id: 1, text: 'x', status: 'pending' }] });
    const rec = await store.get(s.sessionId);
    expect(shouldPrewalkSwap({
      prewalk: rec!.prewalk, todosCount: rec!.todos!.length,
      toolName: 'edit_file', sideEffect: SIDE_EFFECT.edit_file, ok: false,
    })).toBe(false);
  });

  test('stale reconcile: an orphaned prewalk (run gone) restores the planner and clears', async () => {
    // Models the reconcile path when goalRunner.isActive() is false but the
    // session still carries prewalk state (a run that died without restore).
    const store = makeStore();
    const s = await store.create({ provider: 'anthropic', model: 'claude-haiku-4-5' }); // stuck on executor
    await store.setPrewalk(s.sessionId, markPrewalkSwapped(
      armPrewalk({ provider: 'anthropic', model: 'claude-opus-4-8' }, { provider: 'anthropic', model: 'claude-haiku-4-5' }, 1000)!, 1001));

    const stale = await store.get(s.sessionId);
    const restored = await store.setPrewalk(s.sessionId, null, {
      provider: stale!.prewalk!.plannerProvider, model: stale!.prewalk!.plannerModel,
    });
    expect(restored.model).toBe('claude-opus-4-8'); // back on the planner
    expect('prewalk' in restored).toBe(false);
  });
});
