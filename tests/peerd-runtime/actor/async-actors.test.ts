import { describe, test, expect } from 'bun:test';
import { makeAsyncActors } from '../../../extension/peerd-runtime/actor/async-actors.js';
import { makeTurnSlots } from '../../../extension/peerd-runtime/loop/turn-slots.js';

// DESIGN-11 async spawned — the orchestration extracted from the SW so the
// spawn → settle → drain → re-enter flow is testable. The load-bearing test is
// the RUNAWAY: a wake turn that re-spawns must be bounded (the live bug forced a
// browser force-quit). The rest pin the contract: reintegration as a synthetic
// wake, untrusted-wrapping, coalescing, and vault-locked deferral.

const flush = () => new Promise((r) => setTimeout(r, 5));

const baseDeps = (over = {}) => ({
  spawnActor: async (req: any) => ({ result: `R:${req.task}`, sessionId: 'child' }),
  turnSlots: makeTurnSlots(),
  reenter: async (_o: any) => {},
  getActiveSessionId: async () => 'parent',
  isVaultLocked: () => false,
  wrapUntrusted: ({ body }: any) => `[UNTRUSTED]${body}[/UNTRUSTED]`,
  forwardEvent: () => {},
  notify: () => {},
  ...over,
});

describe('makeAsyncActors', () => {
  test('spawn returns a handle immediately, result re-enters as a synthetic wake', async () => {
    const reenters: any[] = [];
    const as = makeAsyncActors(baseDeps({
      spawnActor: async () => ({ result: 'BROMANTANE FACTS', sessionId: 'c1' }),
      reenter: async (o: any) => { reenters.push(o); },
    }));

    const handle = await as.spawnActorAsync({
      task: 'research bromantane', parentSessionId: 'parent', parentToolUseId: 'spawn-tool-1',
    });
    expect(handle.ok).toBe(true);
    expect(handle.taskId).toBe('as-1');
    expect(handle.content).toContain('(session c1, async)');
    expect(handle.content).toContain('Do NOT wait'); // the anti-poll instruction baked into the handle

    await flush();
    expect(reenters).toHaveLength(1);
    expect(reenters[0].sessionId).toBe('parent');
    expect(reenters[0].synthetic).toBe(true);
    expect(reenters[0].actorReply).toMatchObject({
      kind: 'spawned', instanceId: 'spawned', parentToolUseId: 'spawn-tool-1',
      parentToolUseIds: ['spawn-tool-1'],
    });
    expect(reenters[0].userText).toContain('BROMANTANE FACTS');
    expect(reenters[0].userText).toContain('[UNTRUSTED]'); // child result is wrapped
  });

  // PR #134 #2 (regression guard): a child that came back STOPPED (a user Stop
  // cascaded to it) must NOT re-enter the parent — the parent's own turn was
  // just stopped, so a reintegration wake would restart it seconds after Stop.
  test('a Stop-aborted child does not wake the parent (dropped like a cancel)', async () => {
    const reenters: any[] = [];
    const as = makeAsyncActors(baseDeps({
      spawnActor: async () => ({ result: 'partial', sessionId: 'c1', stopped: true }),
      reenter: async (o: any) => { reenters.push(o); },
    }));
    await as.spawnActorAsync({ task: 'long', parentSessionId: 'parent' });
    await flush();
    expect(reenters).toHaveLength(0); // no synthetic wake after a user Stop
  });

  test('a post-start Worker failure wakes the parent with unknown-outcome guidance', async () => {
    const reenters: any[] = [];
    const as = makeAsyncActors(baseDeps({
      spawnActor: async () => ({
        result: 'The actor worker crashed. Its outcome is unknown and must not be retried automatically.',
        sessionId: 'c1', stopped: true, executionFailed: true, outcomeKnown: false,
      }),
      reenter: async (o: any) => { reenters.push(o); },
    }));
    await as.spawnActorAsync({ task: 'write once', parentSessionId: 'parent' });
    await flush();
    expect(reenters).toHaveLength(1);
    expect(reenters[0].userText).toContain('execution failed after work began');
    expect(reenters[0].userText).toContain('outcome unknown');
    expect(reenters[0].userText).toContain('do not retry automatically');
    expect(reenters[0].userText).toContain('[UNTRUSTED]');
  });

  test('a post-start persistence exception wakes the parent as outcome unknown', async () => {
    const reenters: any[] = [];
    const failure = Object.assign(new Error('transcript write failed'), {
      executionFailed: true, performed: true, outcomeKnown: false, retryable: false,
    });
    const as = makeAsyncActors(baseDeps({
      spawnActor: async () => { throw failure; },
      reenter: async (o: any) => { reenters.push(o); },
    }));
    await as.spawnActorAsync({ task: 'write once', parentSessionId: 'parent' });
    await flush();
    expect(reenters).toHaveLength(1);
    expect(reenters[0].userText).toContain('outcome is unknown');
    expect(reenters[0].userText).toContain('Do not retry automatically');
    expect(reenters[0].userText).not.toContain('has finished');
  });

  test('a graceful pre-tool failure is not described as an unknown outcome', async () => {
    const reenters: any[] = [];
    const as = makeAsyncActors(baseDeps({
      spawnActor: async () => ({
        result: 'The actor model request was not run.', sessionId: 'c1',
        stopped: true, executionFailed: true, outcomeKnown: true,
      }),
      reenter: async (o: any) => { reenters.push(o); },
    }));
    await as.spawnActorAsync({ task: 'write once', parentSessionId: 'parent' });
    await flush();
    expect(reenters).toHaveLength(1);
    expect(reenters[0].userText).toContain('failed before target work ran');
    expect(reenters[0].userText).not.toContain('outcome unknown');
  });

  // A TIMEOUT is different from a user Stop — the parent is still working and
  // wants the partial, so a timed-out child DOES reintegrate.
  test('a timed-out child still wakes the parent with its partial', async () => {
    const reenters: any[] = [];
    const as = makeAsyncActors(baseDeps({
      spawnActor: async () => ({ result: 'partial', sessionId: 'c1', timedOut: true }),
      reenter: async (o: any) => { reenters.push(o); },
    }));
    await as.spawnActorAsync({ task: 'slow', parentSessionId: 'parent' });
    await flush();
    expect(reenters).toHaveLength(1);
    expect(reenters[0].userText).toContain('wall-clock timeout');
  });

  // The status-bar feed (DESIGN-11 UI): every transition must push so the bar
  // never goes stale. Spawn makes the task appear; settle flips it done.
  test('onTasksChanged fires on spawn and on settle (feeds the live status bar)', async () => {
    const calls: string[] = [];
    const as = makeAsyncActors(baseDeps({
      spawnActor: async () => ({ result: 'ok', sessionId: 'c1' }),
      onTasksChanged: (sid: string) => { calls.push(sid); },
    }));
    await as.spawnActorAsync({ task: 'T', parentSessionId: 'parent' });
    await flush();
    // Pushes for the active parent only, and more than once: spawn (task
    // appears) plus the settle/deliver transitions (status changes). Exact
    // count is timing-dependent (the mock settles synchronously), so assert
    // the contract — keyed pushes, fired repeatedly — not a magic number.
    expect(calls.every((s) => s === 'parent')).toBe(true);
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  test('task snapshots gain the child id + server-resolved grants when the actor starts', async () => {
    let finish!: (value: any) => void;
    const as = makeAsyncActors(baseDeps({
      spawnActor: async (req: any) => {
        req.onEvent({ type: 'actor-start', sessionId: 'c1', grantedTools: ['script', 'message_actor'] });
        return new Promise((resolve) => { finish = resolve; });
      },
    }));
    await as.spawnActorAsync({ task: 'T', parentSessionId: 'parent' });
    const live = as.actorTasks('parent')[0];
    expect(live).toMatchObject({
      status: 'running', childSessionId: 'c1', grantedTools: ['script', 'message_actor'],
    });
    finish({ result: 'ok', sessionId: 'c1' });
    await flush();
  });

  // THE BUG: a wake turn whose model re-spawns → its child wakes → re-spawn …
  // unbounded. The rate cap must stop the burst instead of looping forever.
  test('a re-spawning wake turn is bounded by the rate cap (runaway guard)', async () => {
    let childRuns = 0;
    let as: any;
    as = makeAsyncActors(baseDeps({
      caps: { rateCap: 5, rateWindowMs: 60_000, outstanding: 4 },
      // child "fails" fast (the live case: interrupted/empty) so the model retries
      spawnActor: async () => { childRuns += 1; return { result: 'failed', interrupted: true }; },
      // the model reacting to the wake by RE-SPAWNING — the loop engine
      reenter: async ({ sessionId }: any) => { await as.spawnActorAsync({ task: 'retry', parentSessionId: sessionId }); },
    }));

    await as.spawnActorAsync({ task: 'start', parentSessionId: 'parent' });
    await flush(); await flush(); await flush();

    expect(childRuns).toBeGreaterThan(1);          // it DID loop (bug reproduced)
    expect(childRuns).toBeLessThanOrEqual(5);       // …but the cap bounded it (no runaway)

    // past the cap, the spawn is refused with a STOP instruction (not a silent fail)
    const refused = await as.spawnActorAsync({ task: 'one more', parentSessionId: 'parent' });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('loop_guard');
    expect(refused.error).toContain('STOP');
  });

  test('outstanding cap refuses a 5th concurrent child (separate from the rate cap)', async () => {
    // children never settle → they stay "running" and fill the outstanding cap
    const as = makeAsyncActors(baseDeps({
      caps: { outstanding: 4, rateCap: 100 },
      spawnActor: (req: any) => {
        req.onEvent({ type: 'actor-start', sessionId: `child-${req.task}`, grantedTools: [] });
        return new Promise(() => {});
      }, // never resolves after allocation
    }));
    for (let i = 0; i < 4; i++) {
      expect((await as.spawnActorAsync({ task: `t${i}`, parentSessionId: 'parent' })).ok).toBe(true);
    }
    const fifth = await as.spawnActorAsync({ task: 't4', parentSessionId: 'parent' });
    expect(fifth.ok).toBe(false);
    expect(fifth.error).toContain('async_actor_cap');
  });

  test('coalesces multiple finished children into ONE wake; re-drain is a no-op (idempotent)', async () => {
    const reenters: any[] = [];
    const slots = makeTurnSlots();
    const live = slots.claim('parent'); // a parent turn is in flight → wakes queue
    const as = makeAsyncActors(baseDeps({
      turnSlots: slots,
      reenter: async (o: any) => { reenters.push(o); },
    }));

    await as.spawnActorAsync({ task: 'A', parentSessionId: 'parent', parentToolUseId: 'spawn-a' });
    await as.spawnActorAsync({ task: 'B', parentSessionId: 'parent', parentToolUseId: 'spawn-b' });
    await flush();
    expect(reenters).toHaveLength(0);   // nothing fires while the parent turn is busy

    live.release();                      // parent turn ends → one drain runs
    await flush();
    expect(reenters).toHaveLength(1);    // ONE coalesced wake…
    expect(reenters[0].userText).toContain('R:A');
    expect(reenters[0].userText).toContain('R:B');
    expect(reenters[0].actorReply.parentToolUseIds).toEqual(['spawn-a', 'spawn-b']);

    // a redelivered drain finds nothing un-reintegrated → no second wake
    await as.drainReintegration('parent');
    await flush();
    expect(reenters).toHaveLength(1);
  });

  test('claims the idle parent before setup so a human turn cannot be stolen', async () => {
    const slots = makeTurnSlots();
    let resolveActive: ((id: string) => void) | undefined;
    const active = new Promise<string>((resolve) => { resolveActive = resolve; });
    let finishReentry: (() => void) | undefined;
    const heldReentry = new Promise<void>((resolve) => { finishReentry = resolve; });
    const reenters: any[] = [];
    const as = makeAsyncActors(baseDeps({
      turnSlots: slots,
      getActiveSessionId: () => active,
      reenter: async (opts: any) => {
        reenters.push(opts);
        // Model the turn driver's historical fallback: without a threaded
        // lease it would claim here, after setup, and abort a newer user turn.
        const lease = opts.turnLease ?? slots.claim(opts.sessionId);
        await heldReentry;
        lease.release();
      },
    }));

    await as.spawnActorAsync({
      task: 'A', parentSessionId: 'parent', parentToolUseId: 'spawn-a',
    });
    await flush();
    expect(reenters).toHaveLength(1); // active-session lookup is still pending
    expect(reenters[0].turnLease).toBeDefined();

    const actorLease = reenters[0].turnLease;
    const humanLease = slots.claim('parent');
    expect(actorLease.controller.signal.aborted).toBe(true);
    expect(humanLease.controller.signal.aborted).toBe(false);

    resolveActive?.('parent');
    finishReentry?.();
    await flush();
    humanLease.release();
  });

  test('a finished child queued behind its parent cannot wake after Stop', async () => {
    const slots = makeTurnSlots({ forceReleaseMs: 1 });
    const liveParent = slots.claim('parent');
    const reenters: any[] = [];
    const as = makeAsyncActors(baseDeps({
      turnSlots: slots,
      reenter: async (opts: any) => { reenters.push(opts); },
    }));

    await as.spawnActorAsync({
      task: 'done just before Stop', parentSessionId: 'parent', parentToolUseId: 'spawn-a',
    });
    await flush();
    expect(reenters).toHaveLength(0);

    expect(slots.stop('parent')).toBe(true);
    liveParent.release();
    await flush();
    expect(reenters).toHaveLength(0);
    expect(as.actorTasks('parent')[0].status).toBe('cancelled');
  });

  test('vault-locked defers the wake (notify only); onVaultUnlock drains it', async () => {
    const reenters: any[] = [];
    let locked = true;
    let notified = 0;
    const as = makeAsyncActors(baseDeps({
      isVaultLocked: () => locked,
      reenter: async (o: any) => { reenters.push(o); },
      notify: () => { notified += 1; },
    }));

    await as.spawnActorAsync({ task: 'X', parentSessionId: 'parent' });
    await flush();
    expect(reenters).toHaveLength(0);   // locked → no model turn
    expect(notified).toBeGreaterThan(0); // …but the user is notified

    locked = false;
    as.onVaultUnlock();
    await flush();
    expect(reenters).toHaveLength(1);    // unlock re-drains the held result
    expect(reenters[0].userText).toContain('R:X');
  });

  test('cancel drops the result (no wake) and frees the slot', async () => {
    const reenters: any[] = [];
    const as = makeAsyncActors(baseDeps({
      spawnActor: (req: any) => {
        req.onEvent({ type: 'actor-start', sessionId: 'child-cancel', grantedTools: [] });
        return new Promise(() => {});
      }, // never settles on its own
      reenter: async (o: any) => { reenters.push(o); },
    }));
    const h = await as.spawnActorAsync({ task: 'cancel me', parentSessionId: 'parent' });
    const c = as.actorCancel('parent', h.taskId);
    expect(c.ok).toBe(true);
    expect(as.actorTasks('parent')[0].status).toBe('cancelled');
    await flush();
    expect(reenters).toHaveLength(0);
  });
});
