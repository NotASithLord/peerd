// Goal mode (the mode-row Goal toggle): makeGoalRunner keeps re-entering the
// agent turn until the agent calls complete_goal, the user halts, or a cap is
// hit. These tests pin the control loop with a fake runTurn (no real model):
// the visible-goal-then-synthetic-continuation shape, the three exits
// (complete / halt / cap), the terminal events, and the exposure filter that
// reveals complete_goal only during a run.

import { describe, it, expect } from 'bun:test';
import {
  makeGoalRunner, goalContinuationPrompt, GOAL_MAX_ITERATIONS, GOAL_RUNS_KEY,
} from '../../extension/peerd-runtime/loop/goal-runner.js';
import { filterByGoalActive } from '../../extension/peerd-runtime/tools/exposure.js';

/** Yield to the event loop until `pred` holds (the fire-and-forget drive settles). */
const settle = async (pred: () => boolean, tries = 500) => {
  for (let i = 0; i < tries && !pred(); i++) await new Promise((r) => setTimeout(r, 0));
};

type TurnArgs = { sessionId: string; userText: string; synthetic: boolean };

describe('makeGoalRunner — the goal loop', () => {
  it('runs turn 1 as the visible goal, later turns as synthetic continuations, until complete_goal', async () => {
    const calls: TurnArgs[] = [];
    const events: any[] = [];
    let runner: ReturnType<typeof makeGoalRunner>;
    runner = makeGoalRunner({
      // Agent "works" two turns, then declares the goal met on the 2nd.
      runTurn: async (args: TurnArgs) => {
        calls.push(args);
        if (calls.length === 2) runner.complete('s1', 'shipped it');
      },
      onEvent: (ev) => events.push(ev),
      maxIterations: 10,
    });

    expect((await runner.start({ sessionId: 's1', goal: 'do the thing' })).ok).toBe(true);
    await settle(() => !runner.isActive('s1'));

    expect(calls.length).toBe(2);
    // Turn 1: the user's real goal, NOT synthetic (renders in the chat).
    expect(calls[0]).toEqual({ sessionId: 's1', userText: 'do the thing', synthetic: false });
    // Turn 2: a hidden continuation that still carries the goal text.
    expect(calls[1].synthetic).toBe(true);
    expect(calls[1].userText).toContain('do the thing');

    const last = events[events.length - 1];
    expect(last.type).toBe('goal/state');
    expect(last.phase).toBe('done');
    expect(last.active).toBe(false);
    expect(last.summary).toBe('shipped it');
    // The run is cleaned up after it ends.
    expect(runner.isActive('s1')).toBe(false);
    expect(runner.get('s1')).toBe(null);
  });

  it('halt() stops it after the in-flight turn (terminal phase = halted)', async () => {
    const calls: TurnArgs[] = [];
    const events: any[] = [];
    let runner: ReturnType<typeof makeGoalRunner>;
    runner = makeGoalRunner({
      runTurn: async (args: TurnArgs) => { calls.push(args); runner.halt('s2'); },
      onEvent: (ev) => events.push(ev),
      maxIterations: 5,
    });
    await runner.start({ sessionId: 's2', goal: 'g' });
    await settle(() => !runner.isActive('s2'));

    expect(calls.length).toBe(1);
    expect(events[events.length - 1].phase).toBe('halted');
  });

  it('stops at the iteration cap when complete_goal is never called (phase = capped)', async () => {
    const calls: TurnArgs[] = [];
    const events: any[] = [];
    const runner = makeGoalRunner({
      runTurn: async (args: TurnArgs) => { calls.push(args); },
      onEvent: (ev) => events.push(ev),
      maxIterations: 3,
    });
    await runner.start({ sessionId: 's3', goal: 'g' });
    await settle(() => !runner.isActive('s3'));

    expect(calls.length).toBe(3);
    expect(events[events.length - 1].phase).toBe('capped');
  });

  it('rejects an empty goal and never drives a turn', async () => {
    const calls: TurnArgs[] = [];
    const runner = makeGoalRunner({ runTurn: async (a: TurnArgs) => { calls.push(a); } });
    expect((await runner.start({ sessionId: 's4', goal: '   ' })).ok).toBe(false);
    await settle(() => true, 3);
    expect(calls.length).toBe(0);
  });

  it('complete() outside an active run is a harmless false (the tool reports a no-op)', () => {
    const runner = makeGoalRunner({ runTurn: async () => {} });
    expect(runner.complete('nobody', 'x')).toBe(false);
  });

  it('a fresh start() for the same session supersedes the prior run (one run per chat)', async () => {
    const goals: string[] = [];
    let runner: ReturnType<typeof makeGoalRunner>;
    runner = makeGoalRunner({
      // Each turn records the goal it's pursuing, then halts so the loop yields.
      runTurn: async (args: TurnArgs) => { goals.push(args.userText); runner.halt(args.sessionId); },
      maxIterations: 5,
    });
    await runner.start({ sessionId: 's5', goal: 'first' });
    await settle(() => !runner.isActive('s5'));
    await runner.start({ sessionId: 's5', goal: 'second' });
    await settle(() => !runner.isActive('s5'));
    expect(goals).toEqual(['first', 'second']);
  });

  it('the continuation prompt carries the goal and points at complete_goal', () => {
    const p = goalContinuationPrompt('build a drum machine');
    expect(p).toContain('build a drum machine');
    expect(p).toContain('complete_goal');
    expect(GOAL_MAX_ITERATIONS).toBeGreaterThan(0);
  });
});

describe('filterByGoalActive — complete_goal exposure', () => {
  const tools = [{ name: 'do' }, { name: 'complete_goal' }, { name: 'get' }];

  it('hides complete_goal when no goal run is active', () => {
    const names = filterByGoalActive(tools, false).map((t) => t.name);
    expect(names).toEqual(['do', 'get']);
  });

  it('reveals complete_goal while a goal run is active', () => {
    const names = filterByGoalActive(tools, true).map((t) => t.name);
    expect(names).toContain('complete_goal');
    expect(names.length).toBe(3);
  });
});

const makeKv = () => {
  const store = new Map<string, any>();
  return {
    store,
    get: async (k: string) => store.get(k),
    set: async (k: string, v: any) => { store.set(k, v); },
    delete: async (k: string) => { store.delete(k); },
  };
};

describe('makeGoalRunner — persistence + resume (survives SW restart / other chats)', () => {
  it('mirrors a live run to kv while running and clears it on a terminal phase', async () => {
    const kv = makeKv();
    let seenWhileLive: any = null;
    let runner: ReturnType<typeof makeGoalRunner>;
    runner = makeGoalRunner({
      runTurn: async () => { seenWhileLive = kv.store.get(GOAL_RUNS_KEY); runner.halt('s1'); },
      kv,
    });
    await runner.start({ sessionId: 's1', goal: 'do it' });
    await settle(() => !runner.isActive('s1'));
    // Was mirrored to storage while the run was live (so an SW restart finds it).
    expect(seenWhileLive?.s1).toMatchObject({ goal: 'do it' });
    // Cleared once the run ends — a terminal run must not resume.
    expect(kv.store.get(GOAL_RUNS_KEY)).toEqual({});
  });

  it('resume() rehydrates a persisted run and continues it as a synthetic continuation', async () => {
    const kv = makeKv();
    // Seed storage as if the SW died mid-run at iteration 2.
    kv.store.set(GOAL_RUNS_KEY, { sBoot: { goal: 'keep building', iteration: 2, startedAt: 1 } });
    const calls: TurnArgs[] = [];
    let runner: ReturnType<typeof makeGoalRunner>;
    runner = makeGoalRunner({
      runTurn: async (a: TurnArgs) => { calls.push(a); runner.complete('sBoot', 'done'); },
      kv,
    });
    const res = await runner.resume();
    expect(res.resumed).toBe(1);
    await settle(() => !runner.isActive('sBoot'));
    // Continues from the persisted iteration → a HIDDEN continuation that still
    // carries the goal, NOT the goal replayed as a fresh visible message.
    expect(calls[0].synthetic).toBe(true);
    expect(calls[0].userText).toContain('keep building');
    expect(kv.store.get(GOAL_RUNS_KEY)).toEqual({});
  });

  it('resume() is a no-op with no kv or nothing stored', async () => {
    expect((await makeGoalRunner({ runTurn: async () => {} }).resume())).toEqual({ resumed: 0 });
    const kv = makeKv();
    expect((await makeGoalRunner({ runTurn: async () => {}, kv }).resume())).toEqual({ resumed: 0 });
  });

  it('resume() re-runs a final turn interrupted at the cap, not dropping it as capped', async () => {
    const kv = makeKv();
    // SW died DURING the last allowed turn → stored iteration === maxIterations.
    kv.store.set(GOAL_RUNS_KEY, { s: { goal: 'finish it', iteration: 3, startedAt: 1 } });
    const calls: TurnArgs[] = [];
    const events: any[] = [];
    const runner = makeGoalRunner({
      runTurn: async (a: TurnArgs) => { calls.push(a); },
      onEvent: (ev) => events.push(ev),
      maxIterations: 3,
      kv,
    });
    await runner.resume();
    await settle(() => !runner.isActive('s'));
    // The interrupted final turn re-ran exactly once, THEN the run caps — without
    // the clamp the loop would exit immediately (0 turns) and still report capped.
    expect(calls.length).toBe(1);
    expect(events[events.length - 1].phase).toBe('capped');
  });
});

describe('makeGoalRunner — outcome hardening (no runaway on failure)', () => {
  it('stops after ONE turn when the turn reports failure (not the whole cap)', async () => {
    const calls: TurnArgs[] = [];
    const runner = makeGoalRunner({
      runTurn: async (a: TurnArgs) => { calls.push(a); return { ok: false }; },
      maxIterations: 20,
    });
    await runner.start({ sessionId: 's', goal: 'g' });
    await settle(() => !runner.isActive('s'));
    expect(calls.length).toBe(1);
  });

  it('stops when a turn is aborted (Stop / steer / spend limit)', async () => {
    const calls: TurnArgs[] = [];
    const runner = makeGoalRunner({
      runTurn: async (a: TurnArgs) => { calls.push(a); return { stopReason: 'aborted' }; },
      maxIterations: 20,
    });
    await runner.start({ sessionId: 's', goal: 'g' });
    await settle(() => !runner.isActive('s'));
    expect(calls.length).toBe(1);
  });

  it('fires onRunEnd once on a terminal phase, carrying phase/summary', async () => {
    const ends: any[] = [];
    let runner: ReturnType<typeof makeGoalRunner>;
    runner = makeGoalRunner({
      runTurn: async () => { runner.complete('s', 'shipped'); },
      onRunEnd: (sid, info) => ends.push({ sid, ...info }),
    });
    await runner.start({ sessionId: 's', goal: 'g' });
    await settle(() => !runner.isActive('s'));
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ sid: 's', phase: 'done', summary: 'shipped' });
  });

  it('a VaultLockedError pauses (keeps kv, no onRunEnd) so resume() re-drives', async () => {
    const kv = makeKv();
    const ends: any[] = [];
    let throwOnce = true;
    let runner: ReturnType<typeof makeGoalRunner>;
    runner = makeGoalRunner({
      runTurn: async () => {
        if (throwOnce) { throwOnce = false; const e: any = new Error('locked'); e.name = 'VaultLockedError'; throw e; }
        runner.complete('s', 'ok');
      },
      onRunEnd: (_sid, info) => ends.push(info),
      kv,
    });
    await runner.start({ sessionId: 's', goal: 'keep going' });
    await settle(() => !runner.isActive('s'));
    // Paused, NOT terminal: no onRunEnd, and the record survives in kv for resume.
    expect(ends).toHaveLength(0);
    expect(kv.store.get(GOAL_RUNS_KEY).s).toMatchObject({ goal: 'keep going' });
    // resume() re-drives; this time it completes → terminal, onRunEnd, kv cleared.
    await runner.resume();
    await settle(() => !runner.isActive('s'));
    expect(ends).toHaveLength(1);
    expect(kv.store.get(GOAL_RUNS_KEY)).toEqual({});
  });

  it('stop() on a vault-lock-PAUSED run drops its kv record so it does NOT resurrect on resume()', async () => {
    const kv = makeKv();
    let throwOnce = true;
    const calls: TurnArgs[] = [];
    let runner: ReturnType<typeof makeGoalRunner>;
    runner = makeGoalRunner({
      runTurn: async (a: TurnArgs) => {
        calls.push(a);
        if (throwOnce) { throwOnce = false; const e: any = new Error('locked'); e.name = 'VaultLockedError'; throw e; }
      },
      kv,
    });
    await runner.start({ sessionId: 's', goal: 'keep going' });
    await settle(() => !runner.isActive('s'));
    // Paused: evicted from the in-memory map, but the record survives in kv.
    expect(runner.get('s')).toBe(null);
    expect(kv.store.get(GOAL_RUNS_KEY).s).toMatchObject({ goal: 'keep going' });

    // The user clicks Stop on the (still-visible) paused run. halt() alone would
    // be a no-op (not in the map); stop() durably forgets the record.
    await runner.stop('s');
    expect(kv.store.get(GOAL_RUNS_KEY)).toEqual({});

    // resume() must NOT re-drive a stopped run.
    const before = calls.length;
    await runner.resume();
    await settle(() => true, 5);
    expect(calls.length).toBe(before);
  });
});
