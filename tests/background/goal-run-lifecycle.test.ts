import { describe, expect, test } from 'bun:test';
import { makeGoalRunner, GOAL_RUNS_KEY } from '../../extension/peerd-runtime/loop/goal-runner.js';
import { makeTurnSlots } from '../../extension/peerd-runtime/loop/turn-slots.js';
import { makeSessionRoutes } from '../../extension/background/routes/sessions.js';
import { createKernelTurnRuntime } from '../../extension/background/kernel-turn-runtime.js';
import { makeAgentSendCustody } from '../../extension/peerd-egress/storage/session-cache.js';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
type Turn = { sessionId: string, userText: string, synthetic: boolean };
type Outcome = { ok: boolean, stopReason?: string };

const fixture = ({ withRun, runTurn, maxIterations = 1, readGoals,
  hasUnresolvedSideEffects = async () => false, getTodoBlock, initialGoals = {} }: {
  withRun: (operation: () => Promise<void>) => Promise<void>,
  runTurn: (args: Turn, signal: AbortSignal) => Promise<Outcome>,
  maxIterations?: number,
  readGoals?: () => Promise<void>,
  hasUnresolvedSideEffects?: () => Promise<boolean>,
  getTodoBlock?: () => Promise<string>,
  initialGoals?: Record<string, any>,
}) => {
  const turnSlots = makeTurnSlots();
  const events: any[] = [];
  const ends: any[] = [];
  let stored: Record<string, any> = structuredClone(initialGoals);
  const cache = new Map<string, any>([['currentSessionId', 'same']]);
  const sessionCache = {
    sessionGet: async (key: string) => cache.get(key),
    sessionSet: async (key: string, value: any) => { cache.set(key, value); },
  };
  const runtime = createKernelTurnRuntime({
    seams: { withRun, runUserTurn() {}, renderSystemPrompt() {}, projectTurnTools() {} },
    turnDriverDeps: {},
    turnRouteDeps: { turnSlots, sessions: { get: async () => ({ todos: [] }) } },
    sessionDeps: {}, isolationDeps: {},
    goal: {
      kv: {
        set: async (key: string, value: any) => {
          expect(key).toBe(GOAL_RUNS_KEY);
          stored = structuredClone(value);
        },
        get: async () => {
          const snapshot = structuredClone(stored);
          await readGoals?.();
          return snapshot;
        },
        delete: async () => {},
      },
      beforeStart: async () => {}, hasUnresolvedSideEffects, getTodoBlock,
      onEvent: (event) => events.push(event),
      onRunEnd: (sessionId, info) => ends.push({ sessionId, ...info }),
      bind() {}, maxIterations,
    },
    ensureReady: async () => {},
    actorProjection: { actorCount: () => ({ activeActors: 0 }), actorOverview: () => ({ roots: [] }) },
    makeDriver: () => ({
      maybeAutoResume: async () => {},
      runAgentTurn: async (args: Turn) => {
        // why: the real slot makes an accidental second drive abort its predecessor.
        const lease = turnSlots.claim(args.sessionId);
        try { return await runTurn(args, lease.controller.signal); }
        finally { lease.release(); }
      },
    }),
    makeGoals: (deps) => makeGoalRunner(deps as Parameters<typeof makeGoalRunner>[0]),
    goalMaxIterations: maxIterations,
  });
  const routes = makeSessionRoutes({
    ...runtime.turnDeps, sessionCache, makeAgentSendCustody,
    ensureSession: async () => 'same', actorRecoveryReady: async () => true,
    pushState: async () => {}, postChatNote() {},
  });
  const send = (text: string) => routes['agent/send']({
    text, goal: true, sessionId: 'same', operationId: `send.${crypto.randomUUID()}`,
  });
  const stop = () => routes['agent/stop']({ sessionId: 'same' });
  return { runtime, send, stop, events, ends, turnSlots, stored: () => stored };
};

describe('goal send lifecycle ownership', () => {
  test('recovery started during Stop waits for its durable clear before controller acquisition', async () => {
    const entered = deferred<void>();
    const clear = deferred<void>();
    const controller = deferred<void>();
    const turns: string[] = [];
    let firstRead = true;
    let acquisitions = 0;
    const f = fixture({
      initialGoals: { same: { goal: 'old', iteration: 0, startedAt: 1 } },
      readGoals: async () => {
        if (!firstRead) return;
        firstRead = false;
        entered.resolve();
        await clear.promise;
      },
      withRun: async (operation) => {
        acquisitions += 1;
        await controller.promise;
        await operation();
      },
      runTurn: async ({ userText }) => { turns.push(userText); return { ok: true }; },
    });
    const stopping = f.stop();
    await entered.promise;
    const recovery = f.runtime.goalRunner.resume();
    try {
      await tick();
      expect(acquisitions).toBe(0);
      clear.resolve();
      expect(await stopping).toMatchObject({ ok: true });
      expect(await recovery).toEqual({ resumed: 0 });
      controller.resolve();
      await tick();
      expect(turns).toEqual([]);
      expect(f.runtime.goalRunner.isActive('same')).toBe(false);
      expect(f.turnSlots.isBusy('same')).toBe(false);
      expect(f.stored()).toEqual({});
    } finally {
      clear.resolve();
      controller.resolve();
    }
  });

  test('concurrent recovery snapshots preserve other chats without replaying a completed recovery', async () => {
    const entered = deferred<void>();
    const reads = [deferred<void>(), deferred<void>()];
    const turns: string[] = [];
    let readCount = 0;
    const f = fixture({
      initialGoals: {
        same: { goal: 'stopped', iteration: 0, startedAt: 1 },
        other: { goal: 'other chat', iteration: 0, startedAt: 1 },
      },
      readGoals: async () => {
        const index = readCount++;
        if (index === 1) entered.resolve();
        if (index < reads.length) await reads[index].promise;
      },
      withRun: (operation) => operation(),
      runTurn: async ({ userText }) => { turns.push(userText); return { ok: true }; },
    });
    const first = f.runtime.goalRunner.resume();
    const second = f.runtime.goalRunner.resume();
    await entered.promise;
    try {
      expect(await f.stop()).toMatchObject({ ok: true });
      reads[0].resolve();
      expect(await first).toEqual({ resumed: 1 });
      await tick();
      expect(f.runtime.goalRunner.get('other')).toBeNull();
      reads[1].resolve();
      expect(await second).toEqual({ resumed: 0 });
      await tick();
      expect(turns).toEqual(['other chat']);
      expect(f.runtime.goalRunner.activeStates()).toEqual([]);
      expect(f.stored()).toEqual({});
    } finally {
      for (const read of reads) read.resolve();
    }
  });

  test.each(['stop', 'replacement'] as const)(
    'a stale recovery snapshot cannot undo a completed %s', async (action) => {
      const entered = deferred<void>();
      const release = deferred<void>();
      const turns: string[] = [];
      let firstRead = true;
      const f = fixture({
        initialGoals: { same: { goal: 'old', iteration: 0, startedAt: 1 } },
        readGoals: async () => {
          if (!firstRead) return;
          firstRead = false;
          entered.resolve();
          await release.promise;
        },
        withRun: (operation) => operation(),
        runTurn: async ({ userText }) => { turns.push(userText); return { ok: true }; },
      });
      const recovery = f.runtime.goalRunner.resume();
      await entered.promise;
      if (action === 'stop') expect(await f.stop()).toMatchObject({ ok: true });
      else {
        expect(await f.send('replacement')).toMatchObject({ ok: true });
        await tick();
      }
      expect(f.runtime.goalRunner.get('same')).toBeNull();
      expect(f.stored()).toEqual({});
      release.resolve();
      expect(await recovery).toEqual({ resumed: 0 });
      await tick();
      expect(turns).toEqual(action === 'stop' ? [] : ['replacement']);
      expect(f.runtime.goalRunner.isActive('same')).toBe(false);
      expect(f.turnSlots.isBusy('same')).toBe(false);
      expect(f.stored()).toEqual({});
    },
  );
  test('a replacement remains live and durable when prior terminal storage cleanup finishes', async () => {
    const cleanupEntered = deferred<void>();
    const cleanup = deferred<void>();
    const newTurn = deferred<Outcome>();
    const f = fixture({
      readGoals: async () => { cleanupEntered.resolve(); await cleanup.promise; },
      withRun: (operation) => operation(),
      runTurn: async ({ userText }) => userText === 'old' ? { ok: true } : newTurn.promise,
    });
    expect(await f.send('old')).toMatchObject({ ok: true });
    await cleanupEntered.promise;
    expect(await f.send('new')).toMatchObject({ ok: true });
    cleanup.resolve();
    await tick();
    expect(f.turnSlots.isBusy('same')).toBe(true);
    expect(f.runtime.goalRunner.get('same')).toMatchObject({ goal: 'new' });
    expect(f.runtime.goalRunner.isActive('same')).toBe(true);
    expect(f.stored().same.goal).toBe('new');
    expect(f.events.at(-1)).toMatchObject({ goal: 'new', active: true });
    expect(f.ends).toEqual([]);
    newTurn.resolve({ ok: true });
    await tick();
    expect(f.runtime.goalRunner.get('same')).toBeNull();
    expect(f.stored()).toEqual({});
    expect(f.ends).toHaveLength(1);
  });

  test.each(['ready', 'failed'] as const)(
    'an obsolete controller acquisition that becomes %s cannot drive or halt a replacement',
    async (outcome) => {
      const acquisitions: ReturnType<typeof deferred<void>>[] = [];
      const turns: (Turn & { signal: AbortSignal })[] = [];
      const turnEnd = deferred<Outcome>();
      const f = fixture({
        maxIterations: 3,
        withRun: async (operation) => {
          const acquisition = deferred<void>();
          acquisitions.push(acquisition);
          await acquisition.promise;
          await operation();
        },
        runTurn: async (args, signal) => { turns.push({ ...args, signal }); return turnEnd.promise; },
      });
      expect(await f.send('old')).toMatchObject({ ok: true });
      expect(await f.send('new')).toMatchObject({ ok: true });
      expect(acquisitions).toHaveLength(2);
      if (outcome === 'ready') acquisitions[0].resolve();
      else acquisitions[0].reject(new Error('old controller lost'));
      acquisitions[1].resolve();
      await tick();
      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatchObject({ userText: 'new', synthetic: false });
      expect(turns[0].signal.aborted).toBe(false);
      expect(f.runtime.goalRunner.get('same')).toMatchObject({ goal: 'new' });
      expect(f.runtime.goalRunner.isActive('same')).toBe(true);
      expect(f.ends).toEqual([]);
      f.runtime.goalRunner.complete('same');
      turnEnd.resolve({ ok: true });
      await tick();
      expect(f.runtime.goalRunner.get('same')).toBeNull();
      expect(f.ends).toHaveLength(1);
    },
  );

  test.each(['verification', 'todos'] as const)(
    'superseding during the awaited %s read cannot start an obsolete continuation',
    async (checkpoint) => {
      const entered = deferred<void>();
      const release = deferred<void>();
      const newTurn = deferred<Outcome>();
      const turns: (Turn & { signal: AbortSignal })[] = [];
      const wait = async () => { entered.resolve(); await release.promise; };
      const f = fixture({
        maxIterations: 3,
        withRun: (operation) => operation(),
        hasUnresolvedSideEffects: async () => {
          if (checkpoint === 'verification') await wait();
          return false;
        },
        getTodoBlock: async () => {
          if (checkpoint === 'todos') await wait();
          return '';
        },
        runTurn: async (args, signal) => {
          turns.push({ ...args, signal });
          return args.userText === 'old' ? { ok: true } : newTurn.promise;
        },
      });
      expect(await f.send('old')).toMatchObject({ ok: true });
      await entered.promise;
      expect(await f.send('new')).toMatchObject({ ok: true });
      release.resolve();
      await tick();
      expect(turns.map(({ userText }) => userText)).toEqual(['old', 'new']);
      expect(turns[1].signal.aborted).toBe(false);
      expect(f.runtime.goalRunner.isActive('same')).toBe(true);
      f.runtime.goalRunner.complete('same');
      newTurn.resolve({ ok: true });
      await tick();
      expect(f.runtime.goalRunner.get('same')).toBeNull();
      expect(f.ends).toHaveLength(1);
    },
  );
});
