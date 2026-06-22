// Ralph loop — standalone controller test with a fake fresh-context
// runner + mocked gates + an in-memory kv. Exercises the four required
// behaviours:
//   1. a 3-task plan runs to completion
//   2. a failing gate blocks the commit + retries, then blocks the task
//   3. loop state survives a simulated SW restart (rehydrate from kv)
//   4. clean termination when the plan is exhausted
//
// No browser, no real WebVM, no real model. Every IO surface is mocked,
// which is exactly the standalone-testability the DI design buys.

import { describe, test, expect } from 'bun:test';
import {
  createRalphLoop,
  createPlanStore,
  createGateRunner,
  serializePlan,
  parsePlan,
  pickNextTask,
  failTask,
  decideNext,
  initLoopState,
  LOOP_STATE_KEY,
  PLAN_KEY,
} from '../../extension/peerd-runtime/ralph/index.js';

// ── in-memory kv (mirrors chrome.storage.local's get/set/delete) ──────
const makeKv = () => {
  const m = new Map<string, any>();
  return {
    map: m,
    get: async (k: string) => m.get(k),
    set: async (k: string, v: any) => { m.set(k, v); },
    delete: async (k: string) => { m.delete(k); },
  };
};

const PLAN_3 = serializePlan({
  title: 'demo',
  goal: 'ship the thing',
  mode: 'building',
  version: 1,
  tasks: [
    { id: 't0-a', title: 'task A', status: 'pending' },
    { id: 't1-b', title: 'task B', status: 'pending' },
    { id: 't2-c', title: 'task C', status: 'pending' },
  ],
});

// Default harness: all gates pass, fresh runner always succeeds.
const makeHarness = (over: any = {}) => {
  const kv = over.kv ?? makeKv();
  if (!kv.map.has(PLAN_KEY)) kv.map.set(PLAN_KEY, over.planText ?? PLAN_3);
  const planStore = createPlanStore({ kv });
  const events: any[] = [];
  const checkpoints: string[] = [];
  const runs: any[] = [];

  const gateRunner = over.gateRunner ?? createGateRunner([
    { name: 'lint', kind: 'webvm', run: async () => ({ pass: true }) },
    { name: 'console-clean', kind: 'browser', run: async () => ({ pass: true }) },
  ]);

  let t = 1000;
  const loop = createRalphLoop({
    planStore,
    kv,
    runFresh: over.runFresh ?? (async (req: any) => { runs.push(req); return { ok: true, text: `did ${req.task}` }; }),
    gateRunner,
    gateContext: () => ({ vmExec: async () => ({ exitCode: 0, stdout: '', stderr: '' }), inspect: async () => ({ consoleErrors: [], dom: '' }) }),
    checkpoint: over.checkpoint ?? (async (msg: string) => { checkpoints.push(msg); return { ok: true, ref: `sha-${checkpoints.length}` }; }),
    canRunUnattended: over.canRunUnattended,
    shouldHalt: over.shouldHalt,
    onEvent: (e: any) => events.push(e),
    now: () => (t += 10),
    maxAttempts: over.maxAttempts ?? 3,
  });
  return { kv, planStore, loop, events, checkpoints, runs };
};

// ── 1. happy path: 3 tasks run to completion ──────────────────────────
describe('ralph loop — 3-task plan to completion', () => {
  test('drives all three tasks, commits each, terminates done', async () => {
    const { loop, planStore, checkpoints, runs } = makeHarness();
    await loop.start();
    const res = await loop.drive();

    expect(res.ok).toBe(true);
    expect(res.state!.status).toBe('done');
    // 3 commits, one per task, in order.
    expect(checkpoints).toEqual([
      'ralph: task A', 'ralph: task B', 'ralph: task C',
    ]);
    // Each ran in a FRESH context: one runFresh call per task, no carried history.
    expect(runs.map((r) => r.task)).toEqual(['task A', 'task B', 'task C']);
    // Plan file is the durable record: all done.
    const plan = await planStore.load();
    expect(plan.tasks.every((t) => t.status === 'done')).toBe(true);
  });
});

// ── 2. failing gate blocks the commit, retries, then blocks the task ──
describe('ralph loop — failing gate blocks commit', () => {
  test('no checkpoint on gate failure; task retried then blocked after maxAttempts', async () => {
    const failing = createGateRunner([
      { name: 'lint', kind: 'webvm', run: async () => ({ pass: false, detail: 'lint error: unused var' }) },
    ]);
    // Single-task plan so we isolate the retry behaviour.
    const planText = serializePlan({
      title: 'p', goal: 'g', mode: 'building', version: 1,
      tasks: [{ id: 't0-only', title: 'only task', status: 'pending' }],
    });
    const { loop, planStore, checkpoints, events } = makeHarness({ gateRunner: failing, planText, maxAttempts: 2 });
    await loop.start();
    const res = await loop.drive();

    // Never committed a failed gate.
    expect(checkpoints).toEqual([]);
    // Task ended up blocked after 2 attempts.
    const plan = await planStore.load();
    expect(plan.tasks[0].status).toBe('blocked');
    expect(plan.tasks[0].attempts).toBe(2);
    expect(plan.tasks[0].note).toContain('lint error');
    // One retry event then a blocked event.
    expect(events.filter((e) => e.type === 'ralph/retry').length).toBe(1);
    expect(events.some((e) => e.type === 'ralph/blocked')).toBe(true);
    // Loop terminates done (nothing left runnable).
    expect(res.state!.status).toBe('done');
  });

  test('a failing fresh-context RUN also blocks the commit', async () => {
    const { loop, checkpoints } = makeHarness({
      runFresh: async () => ({ ok: false, text: 'model errored' }),
      planText: serializePlan({
        title: 'p', goal: 'g', mode: 'building', version: 1,
        tasks: [{ id: 't0-x', title: 'x', status: 'pending' }],
      }),
      maxAttempts: 1,
    });
    await loop.start();
    await loop.drive();
    expect(checkpoints).toEqual([]);
  });
});

// ── 3. SW-restart resumability ────────────────────────────────────────
describe('ralph loop — survives a simulated SW restart', () => {
  test('drive one iteration, throw away the controller, rehydrate from kv, finish', async () => {
    const kv = makeKv();
    kv.map.set(PLAN_KEY, PLAN_3);

    // First "SW lifetime": start + drive a SINGLE iteration, then die.
    const h1 = makeHarness({ kv });
    await h1.loop.start();
    await h1.loop.drive({ budget: 1 });
    const midState = await h1.kv.get(LOOP_STATE_KEY);
    expect(midState.iteration).toBe(1);          // one task committed
    expect(midState.status).toBe('building');    // not done yet
    expect(h1.checkpoints).toEqual(['ralph: task A']);

    // Simulate SW cold start: brand-new controller bound to the SAME kv.
    // No in-memory context carried — only the persisted plan + state.
    const h2 = makeHarness({ kv });
    const res = await h2.loop.resume();
    expect(res.ok).toBe(true);
    expect(res.state!.status).toBe('done');
    // The resumed controller committed the REMAINING two tasks only.
    expect(h2.checkpoints).toEqual(['ralph: task B', 'ralph: task C']);
    const plan = await h2.planStore.load();
    expect(plan.tasks.map((t) => t.status)).toEqual(['done', 'done', 'done']);
  });

  test('an in-progress [~] marker is re-done with fresh context after a crash mid-task', async () => {
    const kv = makeKv();
    // Simulate a crash AFTER pickNextTask wrote [~] but BEFORE commit:
    // task A is in-progress in the plan file, state says iteration 0.
    const crashed = parsePlan(PLAN_3);
    const picked = pickNextTask(crashed);       // flips task A to in-progress
    kv.map.set(PLAN_KEY, serializePlan(picked.plan));
    kv.map.set(LOOP_STATE_KEY, initLoopState({ status: 'building', iteration: 0, currentTaskId: 't0-a' }));

    const h = makeHarness({ kv });
    const res = await h.loop.resume();
    expect(res.state!.status).toBe('done');
    // Task A was re-run (its [~] was resumed, not skipped) and committed.
    expect(h.runs[0].task).toBe('task A');
    expect(h.checkpoints[0]).toBe('ralph: task A');
  });
});

// ── 4. clean termination when plan exhausted ──────────────────────────
describe('ralph loop — clean termination', () => {
  test('an already-complete plan terminates done with no work', async () => {
    const done = serializePlan({
      title: 'p', goal: 'g', mode: 'building', version: 1,
      tasks: [{ id: 't0-a', title: 'a', status: 'done' }],
    });
    const { loop, checkpoints, runs } = makeHarness({ planText: done });
    await loop.start();
    const res = await loop.drive();
    expect(res.state!.status).toBe('done');
    expect(checkpoints).toEqual([]);
    expect(runs).toEqual([]);
  });

  test('halt stops the loop cleanly mid-run', async () => {
    let halted = false;
    const { loop } = makeHarness({ shouldHalt: () => halted });
    await loop.start();
    halted = true;
    const res = await loop.drive();
    expect(res.state!.status).toBe('halted');
  });

  test('canRunUnattended=false refuses to start (feature-03 adapter)', async () => {
    const { loop } = makeHarness({ canRunUnattended: async () => false });
    const res = await loop.start();
    expect(res.ok).toBe(false);
    expect((res as any).error).toBe('confirmations-on');
  });
});

// ── pure-core unit checks (the reducer + plan format) ─────────────────
describe('ralph plan format + reducer (pure)', () => {
  test('round-trips a plan through serialize/parse', () => {
    const p = parsePlan(PLAN_3);
    expect(p.goal).toBe('ship the thing');
    expect(p.mode).toBe('building');
    expect(p.tasks.map((t) => t.status)).toEqual(['pending', 'pending', 'pending']);
    const again = parsePlan(serializePlan(p));
    expect(again.tasks.map((t) => t.title)).toEqual(p.tasks.map((t) => t.title));
  });

  test('single-writer: pickNextTask only ever yields one in-progress', () => {
    const p = parsePlan(PLAN_3);
    const a = pickNextTask(p);
    expect(a.task!.status).toBe('in-progress');
    // Re-picking the resulting plan returns the SAME in-progress task, not a 2nd.
    const b = pickNextTask(a.plan);
    expect(b.task!.id).toBe(a.task!.id);
    expect(a.plan.tasks.filter((t) => t.status === 'in-progress').length).toBe(1);
  });

  test('failTask drops back to pending until maxAttempts, then blocks', () => {
    let p = parsePlan(PLAN_3);
    const id = p.tasks[0].id;
    let r = failTask(p, id, 'boom', 3);
    expect(r.plan.tasks[0].status).toBe('pending');
    expect(r.blocked).toBe(false);
    r = failTask(r.plan, id, 'boom', 3);
    r = failTask(r.plan, id, 'boom', 3);
    expect(r.plan.tasks[0].status).toBe('blocked');
    expect(r.blocked).toBe(true);
  });

  test('decideNext: planning mode → plan; building done → done; halt → halted', () => {
    const planning = parsePlan(serializePlan({ ...parsePlan(PLAN_3), mode: 'planning' }));
    expect(decideNext(initLoopState({ status: 'planning' }), planning).kind).toBe('plan');
    const doneState = initLoopState({ status: 'building' });
    const donePlan = parsePlan(serializePlan({
      title: 'p', goal: 'g', mode: 'building', version: 1,
      tasks: [{ id: 'x', title: 'x', status: 'done' }],
    }));
    expect(decideNext(doneState, donePlan).kind).toBe('done');
    expect(decideNext(doneState, parsePlan(PLAN_3), { halt: true }).kind).toBe('halted');
  });
});
