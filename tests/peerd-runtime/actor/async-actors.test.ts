import { describe, test, expect } from 'bun:test';
import { makeAsyncActors } from '../../../extension/peerd-runtime/actor/async-actors.js';
import { createSessionStore } from '../../../extension/peerd-runtime/sessions/store.js';
import { runUserTurn } from '../../../extension/peerd-runtime/loop/agent-loop.js';
import { makeMockIdb } from '../../../extension/tests/mocks/idb.js';
import { makeTurnSlots } from '../../../extension/peerd-runtime/loop/turn-slots.js';

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

const makeCommittedActors = (over: any = {}) => {
  const deps = baseDeps(over);
  const actors = makeAsyncActors({
    ...deps,
    reenter: async (request) => {
      actors.acknowledgeDelivery(request.sessionId, request.actorReply!.actorDeliveryId!);
      await deps.reenter(request);
    },
  });
  return actors;
};

describe('makeAsyncActors', () => {
  test.each(['setup', 'body', 'index', 'projection', 'effect', 'hook'])('delivery survives a %s failure without duplicate work', async (failure) => {
    const idb = makeMockIdb();
    const pending: (() => void)[] = [], attempts: any[] = [];
    let armed = false, effects = 0;
    const put = idb.put, getMany = idb.getMany;
    idb.put = async (store, value) => {
      if (armed && ((failure === 'body' && store === 'session_messages')
          || (failure === 'index' && store === 'sessions'))) {
        armed = false; throw new Error('storage unavailable');
      }
      await put(store, value);
    };
    idb.getMany = async (store, keys) => {
      if (armed && failure === 'projection' && keys.length) {
        armed = false; throw new Error('storage read failed after append');
      }
      return getMany(store, keys);
    };
    const sessions = createSessionStore({
      idb, makeId: () => 'parent',
      onMessageAppended: (sessionId, message: any) => {
        actors.acknowledgeDelivery(sessionId, message.actorReply?.actorDeliveryId);
        if (failure === 'hook') throw new Error('optional cleanup failed');
      },
    });
    await sessions.create();
    const actors = makeAsyncActors(baseDeps({
      schedule: (fn: () => void) => pending.push(fn),
      reenter: async (request: any) => {
        attempts.push(request);
        if (failure === 'setup' && attempts.length === 1) throw new Error('setup unavailable');
        for await (const _ of runUserTurn({
          ...request, sessions, oneShot: true,
          getSecret: async () => '', safeFetch: async () => new Response(),
          getSystemPrompt: async () => '', appendAudit: async () => {},
          tools: [{ name: 'write', description: '', schema: {} }],
          callModel: async function* () {
            yield { type: 'tool-use-start', id: 'write-1', name: 'write' };
            yield { type: 'tool-use-delta', id: 'write-1', partialJson: '{}' };
            yield { type: 'tool-use-stop', id: 'write-1' };
            yield { type: 'message-stop', stopReason: 'tool_use' };
          },
          toolDispatch: async () => { effects += 1; return { ok: true, content: 'saved' }; },
        })) { /* consume the real loop */ }
        if (failure === 'effect') throw new Error('turn failed after target write');
      },
    }));
    armed = true;
    await actors.spawnActorAsync({ task: 'A', parentSessionId: 'parent' });
    await flush();
    const retried = ['setup', 'body', 'index'].includes(failure);
    expect(actors.actorTasks('parent')[0].status).toBe(retried ? 'done' : 'delivered');
    expect(pending.length).toBe(retried ? 1 : 0);
    pending.shift()?.();
    await flush();
    await actors.drainReintegration('parent');
    const replies = (await sessions.get('parent'))!.messages.filter((message: any) => message.actorReply);
    expect(replies).toHaveLength(1);
    expect(replies[0].id).toBe(attempts[0].actorReply.actorDeliveryId);
    expect(attempts).toHaveLength(retried ? 2 : 1);
    expect(effects).toBe(failure === 'projection' ? 0 : 1);
    expect(actors.actorTasks('parent')[0].status).toBe('delivered');
  });

  test('coalesces results and keeps a failed batch stable while later results wait', async () => {
    const pending: (() => void)[] = [], attempts: any[] = [];
    const slots = makeTurnSlots(), parent = slots.claim('parent');
    let fail!: () => void;
    const actors = makeAsyncActors(baseDeps({
      turnSlots: slots, schedule: (fn: () => void) => pending.push(fn),
      reenter: async (request: any) => {
        attempts.push(request);
        if (attempts.length === 1) await new Promise((_, reject) => { fail = () => reject(new Error('unavailable')); });
        else actors.acknowledgeDelivery(request.sessionId, request.actorReply.actorDeliveryId);
      },
    }));
    await actors.spawnActorAsync({ task: 'A', parentSessionId: 'parent', parentToolUseId: 'spawn-a' });
    await actors.spawnActorAsync({ task: 'B', parentSessionId: 'parent', parentToolUseId: 'spawn-b' });
    await flush();
    expect(attempts).toHaveLength(0);
    parent.release();
    await flush();
    await actors.drainReintegration('parent');
    await actors.spawnActorAsync({ task: 'C', parentSessionId: 'parent' });
    fail();
    await flush();
    actors.onVaultUnlock();
    await flush();
    expect(attempts).toHaveLength(1);
    expect(actors.acknowledgeDelivery('other-parent', attempts[0].actorReply.actorDeliveryId)).toBe(false);
    pending.shift()!();
    await flush();
    expect(attempts).toHaveLength(3);
    expect(attempts[1].actorReply).toEqual(attempts[0].actorReply);
    expect(attempts[1].userText).toBe(attempts[0].userText);
    expect(attempts[1].userText).toContain('R:A');
    expect(attempts[1].userText).toContain('R:B');
    expect(attempts[1].actorReply.parentToolUseIds).toEqual(['spawn-a', 'spawn-b']);
    expect(attempts[1].userText).not.toContain('R:C');
    expect(attempts[2].userText).toContain('R:C');
    expect(attempts[2].actorReply.actorDeliveryId).not.toBe(attempts[1].actorReply.actorDeliveryId);
    expect(actors.actorTasks('parent').map((child) => child.status)).toEqual(['delivered', 'delivered', 'delivered']);
    await actors.drainReintegration('parent');
    expect(attempts).toHaveLength(3);
  });

  test.each(['Stop', 'close'])('%s cancels a failed delivery before its retry', async (action) => {
    const pending: (() => void)[] = [], slots = makeTurnSlots();
    let attempts = 0;
    const actors = makeAsyncActors(baseDeps({
      turnSlots: slots, schedule: (fn: () => void) => pending.push(fn),
      reenter: async () => { attempts += 1; throw new Error('storage unavailable'); },
    }));
    await actors.spawnActorAsync({ task: 'A', parentSessionId: 'parent' });
    await flush();
    if (action === 'Stop') slots.stop('parent');
    else actors.close();
    pending.shift()!();
    await flush();
    actors.onVaultUnlock();
    await flush();
    expect(attempts).toBe(1);
    expect(actors.actorTasks('parent').map((child) => child.status)).toEqual(action === 'Stop' ? ['cancelled'] : []);
    expect(pending).toHaveLength(0);
  });

  test('spawn returns a handle immediately, result re-enters as a synthetic wake', async () => {
    const reenters: any[] = [];
    const as = makeCommittedActors({
      spawnActor: async () => ({ result: 'BROMANTANE FACTS', sessionId: 'c1' }),
      reenter: async (o: any) => { reenters.push(o); },
    });

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

  test('a Stop-aborted child does not wake the parent (dropped like a cancel)', async () => {
    const reenters: any[] = [];
    const as = makeCommittedActors({
      spawnActor: async () => ({ result: 'partial', sessionId: 'c1', stopped: true }),
      reenter: async (o: any) => { reenters.push(o); },
    });
    await as.spawnActorAsync({ task: 'long', parentSessionId: 'parent' });
    await flush();
    expect(reenters).toHaveLength(0); // no synthetic wake after a user Stop
  });

  test('a post-start Worker failure wakes the parent with unknown-outcome guidance', async () => {
    const reenters: any[] = [];
    const as = makeCommittedActors({
      spawnActor: async () => ({
        result: 'The actor worker crashed. Its outcome is unknown and must not be retried automatically.',
        sessionId: 'c1', stopped: true, executionFailed: true, outcomeKnown: false,
      }),
      reenter: async (o: any) => { reenters.push(o); },
    });
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
    const as = makeCommittedActors({
      spawnActor: async () => { throw failure; },
      reenter: async (o: any) => { reenters.push(o); },
    });
    await as.spawnActorAsync({ task: 'write once', parentSessionId: 'parent' });
    await flush();
    expect(reenters).toHaveLength(1);
    expect(reenters[0].userText).toContain('outcome is unknown');
    expect(reenters[0].userText).toContain('Do not retry automatically');
    expect(reenters[0].userText).not.toContain('has finished');
  });

  test('a graceful pre-tool failure is not described as an unknown outcome', async () => {
    const reenters: any[] = [];
    const as = makeCommittedActors({
      spawnActor: async () => ({
        result: 'The actor model request was not run.', sessionId: 'c1',
        stopped: true, executionFailed: true, outcomeKnown: true,
      }),
      reenter: async (o: any) => { reenters.push(o); },
    });
    await as.spawnActorAsync({ task: 'write once', parentSessionId: 'parent' });
    await flush();
    expect(reenters).toHaveLength(1);
    expect(reenters[0].userText).toContain('failed before target work ran');
    expect(reenters[0].userText).not.toContain('outcome unknown');
  });

  test('a timed-out child still wakes the parent with its partial', async () => {
    const reenters: any[] = [];
    const as = makeCommittedActors({
      spawnActor: async () => ({ result: 'partial', sessionId: 'c1', timedOut: true }),
      reenter: async (o: any) => { reenters.push(o); },
    });
    await as.spawnActorAsync({ task: 'slow', parentSessionId: 'parent' });
    await flush();
    expect(reenters).toHaveLength(1);
    expect(reenters[0].userText).toContain('wall-clock timeout');
  });

  test('onTasksChanged fires on spawn and on settle (feeds the live status bar)', async () => {
    const calls: string[] = [];
    const as = makeCommittedActors({
      spawnActor: async () => ({ result: 'ok', sessionId: 'c1' }),
      onTasksChanged: (sid: string) => { calls.push(sid); },
    });
    await as.spawnActorAsync({ task: 'T', parentSessionId: 'parent' });
    await flush();
    expect(calls.every((s) => s === 'parent')).toBe(true);
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  test('task snapshots gain the child id + server-resolved grants when the actor starts', async () => {
    let finish!: (value: any) => void;
    const as = makeCommittedActors({
      spawnActor: async (req: any) => {
        req.onEvent({ type: 'actor-start', sessionId: 'c1', visibleTools: ['script', 'message_actor'] });
        return new Promise((resolve) => { finish = resolve; });
      },
    });
    await as.spawnActorAsync({ task: 'T', parentSessionId: 'parent' });
    const live = as.actorTasks('parent')[0];
    expect(live).toMatchObject({
      status: 'running', childSessionId: 'c1', visibleTools: ['script', 'message_actor'],
    });
    finish({ result: 'ok', sessionId: 'c1' });
    await flush();
  });

  test('a re-spawning wake turn is bounded by the rate cap (runaway guard)', async () => {
    let childRuns = 0;
    let as: any;
    as = makeCommittedActors({
      caps: { rateCap: 5, rateWindowMs: 60_000, outstanding: 4 },
      spawnActor: async () => { childRuns += 1; return { result: 'failed', interrupted: true }; },
      reenter: async ({ sessionId }: any) => { await as.spawnActorAsync({ task: 'retry', parentSessionId: sessionId }); },
    });

    await as.spawnActorAsync({ task: 'start', parentSessionId: 'parent' });
    await flush(); await flush(); await flush();

    expect(childRuns).toBeGreaterThan(1);          // it DID loop (bug reproduced)
    expect(childRuns).toBeLessThanOrEqual(5);       // …but the cap bounded it (no runaway)

    const refused = await as.spawnActorAsync({ task: 'one more', parentSessionId: 'parent' });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('loop_guard');
    expect(refused.error).toContain('STOP');
  });

  test('outstanding cap refuses a 5th concurrent child (separate from the rate cap)', async () => {
    const as = makeCommittedActors({
      caps: { outstanding: 4, rateCap: 100 },
      spawnActor: (req: any) => {
        req.onEvent({ type: 'actor-start', sessionId: `child-${req.task}`, visibleTools: [] });
        return new Promise(() => {});
      }, // never resolves after allocation
    });
    for (let i = 0; i < 4; i++) {
      expect((await as.spawnActorAsync({ task: `t${i}`, parentSessionId: 'parent' })).ok).toBe(true);
    }
    const fifth = await as.spawnActorAsync({ task: 't4', parentSessionId: 'parent' });
    expect(fifth.ok).toBe(false);
    expect(fifth.error).toContain('async_actor_cap');
  });

  test('claims the idle parent before setup so a human turn cannot be stolen', async () => {
    const slots = makeTurnSlots();
    let resolveActive: ((id: string) => void) | undefined;
    const active = new Promise<string>((resolve) => { resolveActive = resolve; });
    let finishReentry: (() => void) | undefined;
    const heldReentry = new Promise<void>((resolve) => { finishReentry = resolve; });
    const reenters: any[] = [];
    const as = makeCommittedActors({
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
    });

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
    const as = makeCommittedActors({
      turnSlots: slots,
      reenter: async (opts: any) => { reenters.push(opts); },
    });

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

  test('Stop during child allocation cancels it as soon as actor-start reveals its id', async () => {
    const slots = makeTurnSlots();
    const parentLease = slots.claim('parent');
    const stoppedSubtrees: string[] = [];
    const reenters: any[] = [];
    let childLease: ReturnType<typeof slots.claim> | undefined;
    let publishStart!: () => void;
    let finishChild!: (value: any) => void;
    const as = makeCommittedActors({
      turnSlots: slots,
      stopSubtree: (sessionId: string) => { stoppedSubtrees.push(sessionId); return [sessionId]; },
      spawnActor: (req: any) => new Promise((resolve) => {
        publishStart = () => {
          childLease = slots.claim('child-delayed');
          req.onEvent({ type: 'actor-start', sessionId: 'child-delayed', visibleTools: [] });
        };
        finishChild = resolve;
      }),
      reenter: async (opts: any) => { reenters.push(opts); },
    });

    const spawning = as.spawnActorAsync({ task: 'delayed allocation', parentSessionId: 'parent' });
    await Promise.resolve();
    expect(slots.stop('parent')).toBe(true);
    publishStart();
    const handle = await spawning;

    expect(handle.ok).toBe(true);
    expect(stoppedSubtrees).toEqual(['child-delayed']);
    expect(childLease?.controller.signal.aborted).toBe(true);
    expect(as.actorTasks('parent')[0].status).toBe('cancelled');

    finishChild({ result: 'must not return', sessionId: 'child-delayed', stopped: true });
    await flush();
    expect(reenters).toHaveLength(0);
    childLease?.release();
    parentLease.release();
  });

  test('vault-locked defers the wake (notify only); onVaultUnlock drains it', async () => {
    const reenters: any[] = [];
    let locked = true;
    let notified = 0;
    const as = makeCommittedActors({
      isVaultLocked: () => locked,
      reenter: async (o: any) => { reenters.push(o); },
      notify: () => { notified += 1; },
    });

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
    const as = makeCommittedActors({
      spawnActor: (req: any) => {
        req.onEvent({ type: 'actor-start', sessionId: 'child-cancel', visibleTools: [] });
        return new Promise(() => {});
      }, // never settles on its own
      reenter: async (o: any) => { reenters.push(o); },
    });
    const h = await as.spawnActorAsync({ task: 'cancel me', parentSessionId: 'parent' });
    const c = as.actorCancel('parent', h.taskId);
    expect(c.ok).toBe(true);
    expect(as.actorTasks('parent')[0].status).toBe('cancelled');
    await flush();
    expect(reenters).toHaveLength(0);
  });
});
