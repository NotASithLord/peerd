// Goal mode (the mode-row Goal toggle): makeGoalRunner keeps re-entering the
// agent turn until the agent calls complete_goal, the user halts, or a cap is
// hit. These tests pin the control loop with a fake runTurn (no real model):
// the visible-goal-then-synthetic-continuation shape, the three exits
// (complete / halt / cap), the terminal events, and the exposure filter that
// reveals complete_goal only during a run.

import { describe, it, expect } from 'bun:test';
import {
  makeGoalRunner, goalContinuationPrompt, GOAL_MAX_ITERATIONS,
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
