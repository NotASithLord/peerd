import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { collectStaticModuleGraph } from '../../packaging/static-module-graph.ts';
import { EXTENSION_DIR } from '../../packaging/lib.ts';
import { createKernelTurnRuntime } from '../../extension/background/kernel-turn-runtime.js';

const until = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('condition-not-met');
};

const makeKv = () => {
  const values: Record<string, any> = {};
  return {
    values,
    get: async (key: string) => structuredClone(values[key]),
    set: async (key: string, value: any) => { values[key] = structuredClone(value); },
    delete: async (key: string) => { delete values[key]; },
  };
};

describe('kernel turn runtime assembly', () => {
  test('keeps semantic turn and Goal implementations out of the authority runtime graph', async () => {
    const graph = [...await collectStaticModuleGraph(
      EXTENSION_DIR, join(EXTENSION_DIR, 'background/kernel-turn-runtime.js'),
    )].map((path) => path.slice(EXTENSION_DIR.length + 1));
    expect(graph).not.toContain('peerd-runtime/loop/turn-driver.js');
    expect(graph).not.toContain('peerd-runtime/loop/turn-authority-driver.js');
    expect(graph).not.toContain('peerd-runtime/loop/goal-runner.js');
    expect(graph).not.toContain('peerd-runtime/todo/core.js');
    expect(graph).not.toContain('peerd-runtime/kernel-turn.js');
    expect(graph).not.toContain('peerd-runtime/kernel.js');
    expect(graph).not.toContain('background/service-worker.js');
    expect(graph).not.toContain('peerd-runtime/loop/agent-loop.js');
    expect(graph).not.toContain('offscreen/controller-turn-runtime.js');
  });

  test('pins controller seams, Goal lifecycle, and route ownership to one assembly', async () => {
    const sequence: string[] = [];
    const goalEvents: any[] = [];
    const runArgs: any[] = [];
    const kv = makeKv();
    const hostile = () => { throw new Error('hostile seam used'); };
    const seams = {
      runUserTurn: async () => {},
      renderSystemPrompt: async () => 'sealed-system',
      projectTurnTools: async () => [],
      planToolsCommand: async () => ({ action: 'note', note: 'planned' }),
      withRun: async (operation: () => Promise<void>) => {
        sequence.push('withRun');
        await operation();
      },
    };
    let driverDeps: any;
    let boundGoals: any;
    const runtime = createKernelTurnRuntime({
      seams,
      turnDriverDeps: {
        runUserTurn: hostile, renderSystemPrompt: hostile, goalActiveFor: hostile,
      },
      turnRouteDeps: {
        sessions: { get: async () => ({ todos: [] }) },
        turnSlots: { stop: () => {} },
        runAgentTurn: hostile, startGoalRun: hostile, haltGoalRun: hostile,
        preservedTurnAuthority: true,
      },
      sessionDeps: { haltGoalRun: hostile, preservedSessionAuthority: true },
      isolationDeps: { retryActorIsolation: async () => ({ ok: true }) },
      goal: {
        kv,
        beforeStart: async () => { sequence.push('beforeStart'); },
        hasUnresolvedSideEffects: async () => false,
        onEvent: (event) => { goalEvents.push(event); },
        onRunEnd: (_sessionId, info) => { sequence.push(`end:${info.phase}`); },
        bind: (goals) => { boundGoals = goals; },
        maxIterations: 1,
      },
      ensureReady: async () => { sequence.push('ready'); },
      actorProjection: {
        actorCount: async () => ({ activeActors: 3 }),
        actorOverview: async () => ({ roots: [{ sessionId: 'root', activity: 'live' }] }),
      },
      makeDriver: ((deps: any) => {
        driverDeps = deps;
        return {
          runAgentTurn: async (args: any) => {
            sequence.push('turn');
            runArgs.push({ ...args, goalActive: deps.goalActiveFor(args.sessionId) });
            return { ok: true, stopReason: 'end_turn' };
          },
          maybeAutoResume: async () => {},
        };
      }) as any,
      makeGoals: ((deps: any) => {
        let active = false;
        return {
          start: async (request: any) => {
            active = true;
            await deps.withRun(async () => {
              await deps.runTurn({
                sessionId: request.sessionId, userText: request.goal,
                synthetic: false, trusted: true,
              });
              active = false;
              deps.onEvent({ phase: 'capped', active: false });
              deps.onRunEnd(request.sessionId, { phase: 'capped' });
            });
            return { ok: true };
          },
          stop: async () => { active = false; },
          resume: async () => {},
          isActive: () => active,
          activeStates: () => [],
        };
      }) as any,
      goalMaxIterations: 12,
    });

    expect(driverDeps.runUserTurn).toBe(seams.runUserTurn);
    expect(driverDeps.renderSystemPrompt).toBe(seams.renderSystemPrompt);
    expect((runtime.turnDeps as any).preservedTurnAuthority).toBe(true);
    expect((runtime.sessionDeps as any).preservedSessionAuthority).toBe(true);
    expect(runtime.turnDeps.runAgentTurn).not.toBe(hostile);
    expect(runtime.turnDeps.startGoalRun).not.toBe(hostile);
    expect(runtime.turnDeps.haltGoalRun).toBe(runtime.sessionDeps.haltGoalRun);
    expect(boundGoals).toBe(runtime.goalRunner);

    await expect(runtime.turnDeps.startGoalRun({ sessionId: 'root', goal: 'finish' }))
      .resolves.toEqual({ ok: true });
    await until(() => sequence.includes('end:capped'));
    expect(sequence).toEqual(['beforeStart', 'withRun', 'ready', 'turn', 'end:capped']);
    expect(runArgs).toEqual([{
      sessionId: 'root', userText: 'finish', synthetic: false, trusted: true,
      goalActive: true,
    }]);
    expect(goalEvents.at(-1)).toMatchObject({ phase: 'capped', active: false });

    await expect(runtime.maybeAutoResume('root')).resolves.toBeUndefined();
    expect(sequence.at(-1)).toBe('ready');
    await expect(runtime.actorCount()).resolves.toEqual({ activeActors: 3 });
    await expect(runtime.actorOverview()).resolves.toEqual({
      roots: [{ sessionId: 'root', activity: 'live' }],
    });
  });

  test('fails closed instead of fabricating actor projections', async () => {
    const runtime = createKernelTurnRuntime({
      seams: {
        runUserTurn: async () => {}, renderSystemPrompt: async () => '',
        projectTurnTools: async () => [],
        planToolsCommand: async () => ({ action: 'note', note: 'planned' }),
        withRun: async (operation: () => Promise<void>) => operation(),
      },
      turnDriverDeps: {},
      turnRouteDeps: { sessions: { get: async () => null } },
      sessionDeps: {}, isolationDeps: {},
      goal: {
        kv: makeKv(), beforeStart: async () => {},
        hasUnresolvedSideEffects: async () => false,
        onEvent: () => {}, onRunEnd: () => {}, bind: () => {},
      },
      ensureReady: async () => {},
      actorProjection: {
        actorCount: async () => ({ activeActors: -1 }),
        actorOverview: async () => ({ roots: null as any }),
      },
      makeDriver: (() => ({
        runAgentTurn: async () => ({ ok: true }), maybeAutoResume: async () => {},
      })) as any,
      makeGoals: (() => ({
        start: async () => ({ ok: true }), stop: async () => {}, resume: async () => {},
      })) as any,
      goalMaxIterations: 12,
    });

    await expect(runtime.actorCount()).rejects.toThrow('kernel-actor-count-invalid');
    await expect(runtime.actorOverview()).rejects.toThrow('kernel-actor-overview-invalid');
  });
});
