import { describe, test, expect } from 'bun:test';
import { makeAsyncSubagents } from '../../../extension/peerd-runtime/subagent/async-subagents.js';
import { makeTurnSlots } from '../../../extension/peerd-runtime/loop/turn-slots.js';

// DESIGN-11 async subagents — the orchestration extracted from the SW so the
// spawn → settle → drain → re-enter flow is testable. The load-bearing test is
// the RUNAWAY: a wake turn that re-spawns must be bounded (the live bug forced a
// browser force-quit). The rest pin the contract: reintegration as a synthetic
// wake, untrusted-wrapping, coalescing, and vault-locked deferral.

const flush = () => new Promise((r) => setTimeout(r, 5));

const baseDeps = (over = {}) => ({
  spawnSubagent: async (req: any) => ({ result: `R:${req.task}`, sessionId: 'child' }),
  turnSlots: makeTurnSlots(),
  reenter: async (_o: any) => {},
  getActiveSessionId: async () => 'parent',
  isVaultLocked: () => false,
  wrapUntrusted: ({ body }: any) => `[UNTRUSTED]${body}[/UNTRUSTED]`,
  forwardEvent: () => {},
  notify: () => {},
  ...over,
});

describe('makeAsyncSubagents', () => {
  test('spawn returns a handle immediately, result re-enters as a synthetic wake', async () => {
    const reenters: any[] = [];
    const as = makeAsyncSubagents(baseDeps({
      spawnSubagent: async () => ({ result: 'BROMANTANE FACTS', sessionId: 'c1' }),
      reenter: async (o: any) => { reenters.push(o); },
    }));

    const handle = await as.spawnSubagentAsync({ task: 'research bromantane', parentSessionId: 'parent' });
    expect(handle.ok).toBe(true);
    expect(handle.taskId).toBe('as-1');
    expect(handle.content).toContain('Do NOT wait'); // the anti-poll instruction baked into the handle

    await flush();
    expect(reenters).toHaveLength(1);
    expect(reenters[0].sessionId).toBe('parent');
    expect(reenters[0].synthetic).toBe(true);
    expect(reenters[0].userText).toContain('BROMANTANE FACTS');
    expect(reenters[0].userText).toContain('[UNTRUSTED]'); // child result is wrapped
  });

  // The status-bar feed (DESIGN-11 UI): every transition must push so the bar
  // never goes stale. Spawn makes the task appear; settle flips it done.
  test('onTasksChanged fires on spawn and on settle (feeds the live status bar)', async () => {
    const calls: string[] = [];
    const as = makeAsyncSubagents(baseDeps({
      spawnSubagent: async () => ({ result: 'ok', sessionId: 'c1' }),
      onTasksChanged: (sid: string) => { calls.push(sid); },
    }));
    await as.spawnSubagentAsync({ task: 'T', parentSessionId: 'parent' });
    await flush();
    // Pushes for the active parent only, and more than once: spawn (task
    // appears) plus the settle/deliver transitions (status changes). Exact
    // count is timing-dependent (the mock settles synchronously), so assert
    // the contract — keyed pushes, fired repeatedly — not a magic number.
    expect(calls.every((s) => s === 'parent')).toBe(true);
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  // THE BUG: a wake turn whose model re-spawns → its child wakes → re-spawn …
  // unbounded. The rate cap must stop the burst instead of looping forever.
  test('a re-spawning wake turn is bounded by the rate cap (runaway guard)', async () => {
    let childRuns = 0;
    let as: any;
    as = makeAsyncSubagents(baseDeps({
      caps: { rateCap: 5, rateWindowMs: 60_000, outstanding: 4 },
      // child "fails" fast (the live case: interrupted/empty) so the model retries
      spawnSubagent: async () => { childRuns += 1; return { result: 'failed', interrupted: true }; },
      // the model reacting to the wake by RE-SPAWNING — the loop engine
      reenter: async ({ sessionId }: any) => { await as.spawnSubagentAsync({ task: 'retry', parentSessionId: sessionId }); },
    }));

    await as.spawnSubagentAsync({ task: 'start', parentSessionId: 'parent' });
    await flush(); await flush(); await flush();

    expect(childRuns).toBeGreaterThan(1);          // it DID loop (bug reproduced)
    expect(childRuns).toBeLessThanOrEqual(5);       // …but the cap bounded it (no runaway)

    // past the cap, the spawn is refused with a STOP instruction (not a silent fail)
    const refused = await as.spawnSubagentAsync({ task: 'one more', parentSessionId: 'parent' });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('loop_guard');
    expect(refused.error).toContain('STOP');
  });

  test('outstanding cap refuses a 5th concurrent child (separate from the rate cap)', async () => {
    // children never settle → they stay "running" and fill the outstanding cap
    const as = makeAsyncSubagents(baseDeps({
      caps: { outstanding: 4, rateCap: 100 },
      spawnSubagent: () => new Promise(() => {}), // never resolves
    }));
    for (let i = 0; i < 4; i++) {
      expect((await as.spawnSubagentAsync({ task: `t${i}`, parentSessionId: 'parent' })).ok).toBe(true);
    }
    const fifth = await as.spawnSubagentAsync({ task: 't4', parentSessionId: 'parent' });
    expect(fifth.ok).toBe(false);
    expect(fifth.error).toContain('async_subagent_cap');
  });

  test('coalesces multiple finished children into ONE wake; re-drain is a no-op (idempotent)', async () => {
    const reenters: any[] = [];
    const slots = makeTurnSlots();
    const live = slots.claim('parent'); // a parent turn is in flight → wakes queue
    const as = makeAsyncSubagents(baseDeps({
      turnSlots: slots,
      reenter: async (o: any) => { reenters.push(o); },
    }));

    await as.spawnSubagentAsync({ task: 'A', parentSessionId: 'parent' });
    await as.spawnSubagentAsync({ task: 'B', parentSessionId: 'parent' });
    await flush();
    expect(reenters).toHaveLength(0);   // nothing fires while the parent turn is busy

    live.release();                      // parent turn ends → one drain runs
    await flush();
    expect(reenters).toHaveLength(1);    // ONE coalesced wake…
    expect(reenters[0].userText).toContain('R:A');
    expect(reenters[0].userText).toContain('R:B');

    // a redelivered drain finds nothing un-reintegrated → no second wake
    await as.drainReintegration('parent');
    await flush();
    expect(reenters).toHaveLength(1);
  });

  test('vault-locked defers the wake (notify only); onVaultUnlock drains it', async () => {
    const reenters: any[] = [];
    let locked = true;
    let notified = 0;
    const as = makeAsyncSubagents(baseDeps({
      isVaultLocked: () => locked,
      reenter: async (o: any) => { reenters.push(o); },
      notify: () => { notified += 1; },
    }));

    await as.spawnSubagentAsync({ task: 'X', parentSessionId: 'parent' });
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
    const as = makeAsyncSubagents(baseDeps({
      spawnSubagent: () => new Promise(() => {}), // never settles on its own
      reenter: async (o: any) => { reenters.push(o); },
    }));
    const h = await as.spawnSubagentAsync({ task: 'cancel me', parentSessionId: 'parent' });
    const c = as.subagentCancel('parent', h.taskId);
    expect(c.ok).toBe(true);
    expect(as.subagentTasks('parent')[0].status).toBe('cancelled');
    await flush();
    expect(reenters).toHaveLength(0);
  });
});
