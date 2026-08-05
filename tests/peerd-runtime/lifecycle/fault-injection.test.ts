// Fault injection at the hardest kill points (contract §15 / §16.3).
//
// The other lifecycle suites kill the process BETWEEN calls — a second boot
// over surviving storage IS the eviction. This one kills it INSIDE the
// calls: the nth durable write rejects, or persists and then takes the
// whole storage layer down with it, or lands a truncated value before
// rejecting. Storage is the only thing that survives an eviction, so a
// write that half-happened is the one failure the contract cannot reason
// its way out of after the fact.
//
// What is asserted, and why it is never an internal error: the operation
// log serializes mutations through an internal queue, and both boot() and
// the dispatch tracker swallow storage errors BY DESIGN (per-record
// isolation on the reconcile sweep; "settling must never mask the tool's
// own outcome"). So the observable contract lives in the DURABLE OUTCOME —
// what a fresh boot over the surviving bytes reports — not in which promise
// rejected. Every test below ends at a fresh boot.

import { describe, test, expect } from 'bun:test';
import {
  makeLifecycleBoot, GENERATION_KEY, PENDING_NOTICES_KEY,
} from '../../../extension/peerd-runtime/lifecycle/boot.js';
import {
  createOperationLog, OPERATION_LOG_KEY,
} from '../../../extension/peerd-runtime/lifecycle/operation-log.js';
import { makeDispatchTracker } from '../../../extension/peerd-runtime/lifecycle/dispatch-tracking.js';
import { OPERATION_STATES } from '../../../extension/peerd-runtime/lifecycle/operation-state.js';
import { retryClassForTool } from '../../../extension/peerd-runtime/lifecycle/tool-retry-class.js';
import {
  classifyStoreVersion, guardStore, runMigration,
} from '../../../extension/peerd-runtime/lifecycle/store-version.js';

const S = OPERATION_STATES;

// --- the fault-injecting storage adapter ------------------------------------
//
// Wraps an in-memory map with programmable faults and a journal of every op.
// Named error subclasses (house style) so a swallowed rejection is still
// identifiable in the journal.

class StorageWriteError extends Error {
  constructor(key: string) {
    super(`injected write failure on ${key}`);
    this.name = 'StorageWriteError';
  }
}

class StorageDeadError extends Error {
  constructor(key: string) {
    super(`storage layer is gone (op on ${key} after the injected death)`);
    this.name = 'StorageDeadError';
  }
}

class TornWriteError extends Error {
  constructor(key: string) {
    super(`torn write on ${key}: a truncated value landed, the write rejected`);
    this.name = 'TornWriteError';
  }
}

type JournalEntry = {
  op: 'get' | 'set';
  key: string;
  outcome: 'ok' | 'write-failed' | 'torn' | 'dead';
};

/**
 * Fault counts are 1-based and start over each time a fault is armed, so a
 * test says "the 2nd write from HERE" without counting the setup's writes.
 */
const makeFaultyStorage = () => {
  const map = new Map<string, unknown>();
  const journal: JournalEntry[] = [];
  const torn = new Map<string, unknown>();
  let writes = 0;
  let failAt: number | null = null;
  let dieAfter: number | null = null;
  let dead = false;

  const note = (op: JournalEntry['op'], key: string, outcome: JournalEntry['outcome']) => {
    journal.push({ op, key, outcome });
  };

  return {
    // ---- the adapter the lifecycle modules see (get/set only) ----
    get: async (key: string): Promise<unknown> => {
      if (dead) { note('get', key, 'dead'); throw new StorageDeadError(key); }
      note('get', key, 'ok');
      return structuredClone(map.get(key));
    },
    set: async (key: string, value: unknown): Promise<void> => {
      writes += 1;
      if (dead) { note('set', key, 'dead'); throw new StorageDeadError(key); }
      if (torn.has(key)) {
        // A torn write: the truncated bytes ARE durable, the write still
        // reports failure. Nobody gets to "roll back" what already landed.
        map.set(key, torn.get(key));
        torn.delete(key);
        note('set', key, 'torn');
        throw new TornWriteError(key);
      }
      if (failAt === writes) { note('set', key, 'write-failed'); throw new StorageWriteError(key); }
      map.set(key, structuredClone(value));
      note('set', key, 'ok');
      // Persisted, THEN died — the mid-sequence death the contract's
      // "created before dispatch, dispatched before the effect" ordering
      // exists to survive.
      if (dieAfter === writes) dead = true;
    },

    // ---- fault programming ----
    /** The nth set() from now rejects; nothing is persisted for it. */
    failWriteAt: (nth: number) => { writes = 0; failAt = nth; dieAfter = null; },
    /** The nth set() from now persists; every op after it rejects. */
    dieAfterWrites: (nth: number) => { writes = 0; dieAfter = nth; failAt = null; },
    /** The next set() of `key` persists `corrupted`, then rejects. */
    tornWrite: (key: string, corrupted: unknown) => { torn.set(key, corrupted); },

    // ---- test-side inspection of what SURVIVED ----
    /** Clear the faults, keep the bytes — this is the next browser start. */
    heal: () => { dead = false; failAt = null; dieAfter = null; torn.clear(); writes = 0; },
    journal,
    peek: (key: string): unknown => map.get(key),
    poke: (key: string, value: unknown) => { map.set(key, value); },
    wipe: (keys: string[]) => { for (const key of keys) map.delete(key); },
  };
};

type FaultyStorage = ReturnType<typeof makeFaultyStorage>;

// --- shared harness ---------------------------------------------------------

let clock = 1_700_000_000_000;
const tick = () => (clock += 1);
let mints = 0;
const nonces: string[] = [];
const nextNonce = () => {
  mints += 1;
  const nonce = `nonce-${mints}-b0a7c9de`;
  nonces.push(nonce);
  return nonce;
};

const bootOver = (storage: FaultyStorage, extra: Record<string, unknown> = {}) =>
  makeLifecycleBoot({ storage, nonce: nextNonce, now: tick, ...extra });

const logOver = (storage: FaultyStorage) =>
  createOperationLog({ storage, now: tick });

// Real descriptors, classified by the LIVE classifier — the kill-point
// matrix must ride the same class the dispatcher would compute.
const TOOLS = {
  B: { name: 'fetch_url', sideEffect: 'read', primitive: 'web' },
  C: { name: 'notebook_write', sideEffect: 'write', primitive: 'notebook' },
  D: { name: 'dweb_share', sideEffect: 'write', primitive: 'dweb' },
  E: { name: 'submit_form', sideEffect: 'mutate_external', primitive: 'tab' },
} as const;

type ClassKey = keyof typeof TOOLS;

const swallow = (promise: Promise<unknown>) => promise.then(() => {}, () => {});

/**
 * Drive one operation to a kill point and leave the storage healed (the
 * bytes that survived the death). `writesBeforeDeath` picks the moment:
 *   1 → died right after begin()            (created, dispatched:false)
 *   2 → died after the running transition   (running, dispatched:false)
 *   3 → died right after markDispatched()   (awaiting_remote, dispatched:true)
 * Every rejection after the death IS the death — the caller never sees it,
 * exactly as a killed service worker never sees anything.
 */
const killDuringDispatch = async (storage: FaultyStorage, input: {
  operationId: string, sessionId: string, tool: { name: string },
  generationId: string, writesBeforeDeath: number,
}) => {
  const log = logOver(storage);
  storage.dieAfterWrites(input.writesBeforeDeath);
  await swallow(log.begin({
    operationId: input.operationId,
    sessionId: input.sessionId,
    toolName: input.tool.name,
    retryClass: retryClassForTool(input.tool),
    generationId: input.generationId,
  }));
  await swallow(log.transition(input.operationId, S.RUNNING));
  await swallow(log.markDispatched(input.operationId));
  storage.heal();
};

const trackerOn = (storage: FaultyStorage, generationId: string) =>
  makeDispatchTracker({
    operationLog: logOver(storage),
    generationId: () => generationId,
    retryClassFor: retryClassForTool,
  });

// --- 1. death BETWEEN begin() and markDispatched() --------------------------

describe('kill point: between begin() and markDispatched()', () => {
  test('the descriptors under test classify as B/C/D/E on the live classifier', () => {
    for (const key of Object.keys(TOOLS) as ClassKey[]) {
      expect(retryClassForTool(TOOLS[key])).toBe(key);
    }
  });

  test('B/C/D/E all survive as undispatched and a fresh boot settles every one interrupted', async () => {
    const storage = makeFaultyStorage();
    const first = await bootOver(storage).init();

    // Two parking spots, both strictly before the dispatch stamp: the log
    // write landed and the process died (created), and the running
    // transition landed and the process died (running).
    const killPoints: Array<[ClassKey, number]> = [['B', 2], ['C', 1], ['D', 2], ['E', 1]];
    for (const [key, writesBeforeDeath] of killPoints) {
      await killDuringDispatch(storage, {
        operationId: `op-${key}`, sessionId: 'sess-1', tool: TOOLS[key],
        generationId: first.generation.id, writesBeforeDeath,
      });
    }

    // What survived: a record that never claims the effect left peerd.
    const survivors = storage.peek(OPERATION_LOG_KEY) as Record<string, {
      state: string, dispatched?: boolean }>;
    for (const key of Object.keys(TOOLS) as ClassKey[]) {
      const record = survivors[`op-${key}`];
      expect([S.CREATED, S.RUNNING] as string[]).toContain(record.state);
      expect(record.dispatched).not.toBe(true);
    }

    const second = bootOver(storage);
    const { plan } = await second.init();
    expect(plan.transitions.length).toBe(4);

    for (const key of Object.keys(TOOLS) as ClassKey[]) {
      // Nothing was dispatched, so nothing is uncertain — even Class E.
      expect((await second.operationLog.get(`op-${key}`)).state).toBe(S.INTERRUPTED);
    }
    const verdictFor = (id: string) =>
      plan.transitions.find((t) => t.operationId === id)!.verdict;
    // Class E interrupted pre-dispatch is SAFE but still not automatic.
    expect(verdictFor('op-E').autoRetry).toBe(false);
    expect(verdictFor('op-E').retryRequires).toContain('user-instruction');
    // Class C/D keep the original idempotency key on the retry.
    expect(verdictFor('op-C').keepIdempotencyKey).toBe(true);
    expect(verdictFor('op-D').keepIdempotencyKey).toBe(true);
    expect(verdictFor('op-B').autoRetry).toBe(true);
  });

  test('Class D — the sanctioned re-drive works over the reconciled record', async () => {
    const storage = makeFaultyStorage();
    const first = await bootOver(storage).init();
    await killDuringDispatch(storage, {
      operationId: 'sess-1:call-1', sessionId: 'sess-1', tool: TOOLS.D,
      generationId: first.generation.id, writesBeforeDeath: 2,
    });

    const second = bootOver(storage);
    const { generation } = await second.init();
    expect((await second.operationLog.get('sess-1:call-1')).state).toBe(S.INTERRUPTED);

    const begun = await trackerOn(storage, generation.id).beginTracking({
      callId: 'call-1', tool: TOOLS.D, sessionId: 'sess-1',
    });
    expect(begun && 'handle' in begun).toBe(true);
    const record = await second.operationLog.get('sess-1:call-1');
    expect(record.attempt).toBe(2);
    // The re-drive mirrors a fresh dispatch: live generation stamped and
    // dispatched marked BEFORE the effect can leave, so a second death
    // reconciles it as dispatched-unproven, never as "never attempted".
    expect(record.state).toBe(S.AWAITING_REMOTE);
    expect(record.dispatched).toBe(true);
    expect(record.generationId).toBe(generation.id);
  });
});

// --- 2. death IMMEDIATELY AFTER markDispatched() ----------------------------

describe('kill point: immediately after markDispatched()', () => {
  for (const key of ['D', 'E'] as ClassKey[]) {
    test(`Class ${key} lands outcome_unknown and the tracker refuses the same-id re-dispatch`, async () => {
      const storage = makeFaultyStorage();
      const first = await bootOver(storage).init();
      await killDuringDispatch(storage, {
        operationId: 'sess-1:call-1', sessionId: 'sess-1', tool: TOOLS[key],
        generationId: first.generation.id, writesBeforeDeath: 3,
      });

      // The evidence the reconciler rides: the effect may already have left.
      const survivor = (storage.peek(OPERATION_LOG_KEY) as Record<string, {
        state: string, dispatched?: boolean }>)['sess-1:call-1'];
      expect(survivor.state).toBe(S.AWAITING_REMOTE);
      expect(survivor.dispatched).toBe(true);

      const second = bootOver(storage);
      const { generation, plan } = await second.init();
      expect((await second.operationLog.get('sess-1:call-1')).state).toBe(S.OUTCOME_UNKNOWN);
      expect(plan.transitions[0].verdict.verificationRequired).toBe(true);
      expect(plan.notifications[0].recoveryRecord.sideEffectStatus).toBe('outcome_unknown');

      // …and the replay guard refuses the automatic re-dispatch outright.
      const begun = await trackerOn(storage, generation.id).beginTracking({
        callId: 'call-1', tool: TOOLS[key], sessionId: 'sess-1',
      });
      expect(begun && 'refuse' in begun).toBe(true);
      expect((begun as { refuse: { error: string } }).refuse.error).toStartWith('outcome_unknown:');
      expect((await second.operationLog.get('sess-1:call-1')).attempt).toBe(1); // no re-drive
    });
  }
});

// --- 3. death DURING settle persistence -------------------------------------

describe("kill point: inside settleTracking's own persistence", () => {
  const dispatchThenLoseTheSettle = async (
    outcome: { ok: boolean, error?: string, resultDigest?: string },
  ) => {
    const storage = makeFaultyStorage();
    const tracker = trackerOn(storage, 'gen-1-b0a7c9de');
    const begun = await tracker.beginTracking({
      callId: 'call-1', tool: TOOLS.E, sessionId: 'sess-1',
    });
    const handle = (begun as { handle: { operationId: string, retryClass: 'E', toolName: string } }).handle;
    // The settle's transition write is the one that dies.
    storage.failWriteAt(1);
    const rewrite = await tracker.settleTracking(handle, outcome);
    storage.heal();
    return { storage, rewrite };
  };

  test('a Class E SUCCESS whose settle write is lost never becomes completed-without-evidence', async () => {
    const { storage, rewrite } = await dispatchThenLoseTheSettle({
      ok: true, resultDigest: 'sha256:abc',
    });

    const survivor = (storage.peek(OPERATION_LOG_KEY) as Record<string, {
      state: string, dispatched?: boolean, evidence?: unknown }>)['sess-1:call-1'];
    expect(survivor.state).toBe(S.AWAITING_REMOTE); // the completion never landed
    expect(survivor.evidence).toBeUndefined();

    const boot = bootOver(storage);
    await boot.init();
    // The safe direction: peerd forgot a success rather than inventing one.
    expect((await boot.operationLog.get('sess-1:call-1')).state).toBe(S.OUTCOME_UNKNOWN);

    // gap (safe direction, so not a FIXME): settleTracking swallows the
    // persistence failure and returns null, so the DISPATCHER still reports
    // the tool's success to the agent while the durable log says nothing
    // landed — §8's persist-before-report ordering is inverted here. The
    // consequence is a false UNCERTAINTY on the next boot (the agent is told
    // to verify an operation that actually completed), never a false claim.
    expect(rewrite).toBeNull();
  });

  test('a Class E AMBIGUOUS failure whose settle write is lost never becomes failed-without-evidence', async () => {
    const { storage, rewrite } = await dispatchThenLoseTheSettle({
      ok: false, error: 'request timed out after 30000ms',
    });

    const survivor = (storage.peek(OPERATION_LOG_KEY) as Record<string, {
      state: string }>)['sess-1:call-1'];
    expect(survivor.state).toBe(S.AWAITING_REMOTE); // NOT failed

    const boot = bootOver(storage);
    await boot.init();
    expect((await boot.operationLog.get('sess-1:call-1')).state).toBe(S.OUTCOME_UNKNOWN);

    // FIXED (was FIXME §16.2): the semantic report no longer depends on the
    // settle write landing — a persist failure defers the durable copy to
    // the next boot's reconcile, but the agent STILL hears outcome_unknown
    // now, so it cannot read a generic timeout as a definite failure and
    // re-issue the Class E action under a fresh call id.
    expect(rewrite).not.toBeNull();
    expect(rewrite!.error).toStartWith('outcome_unknown:');
    expect((rewrite!.recovery as { category: string }).category).toBe('verify_before_retry');
  });
});

// --- 4. death DURING boot's own reconcile -----------------------------------

describe("kill point: inside boot's own reconcile sweep", () => {
  test('a second boot settles what the dying sweep never applied (idempotence under partial application)', async () => {
    const storage = makeFaultyStorage();
    const first = await bootOver(storage).init();
    for (const id of ['op-1', 'op-2', 'op-3']) {
      await killDuringDispatch(storage, {
        operationId: id, sessionId: 'sess-1', tool: TOOLS.E,
        generationId: first.generation.id, writesBeforeDeath: 3,
      });
    }

    // Writes in init(): 1 = the generation, 2 = the first settle, then the
    // storage is gone — the remaining settles, the audit and the notice
    // parking all reject into their per-record isolation catches.
    const lostNotices: string[] = [];
    storage.dieAfterWrites(2);
    const second = bootOver(storage, {
      notify: (_sessionId: string, text: string) => { lostNotices.push(text); },
    });
    const { plan } = await second.init();
    expect(plan.transitions.length).toBe(3); // the PLAN was complete…
    storage.heal();

    const applied = storage.peek(OPERATION_LOG_KEY) as Record<string, { state: string }>;
    expect(applied['op-1'].state).toBe(S.OUTCOME_UNKNOWN); // …its application was not
    expect(applied['op-2'].state).toBe(S.AWAITING_REMOTE);
    expect(applied['op-3'].state).toBe(S.AWAITING_REMOTE);
    // The user-facing notify still fired for all three (best effort, memory
    // only); the DURABLE agent-facing copy died with the storage.
    expect(lostNotices.length).toBe(3);
    expect(await second.drainNoticesFor('sess-1')).toBe('');

    const third = bootOver(storage);
    const { plan: replan } = await third.init();
    expect(replan.transitions.length).toBe(2); // only the unapplied two
    for (const id of ['op-1', 'op-2', 'op-3']) {
      expect((await third.operationLog.get(id)).state).toBe(S.OUTCOME_UNKNOWN);
    }
    // Re-settling is not re-notifying: op-1 was already terminal, so the
    // agent hears about the two the dead sweep dropped, once.
    const block = await third.drainNoticesFor('sess-1');
    expect(block).toContain('<interruption-recovery>');
    expect(block.match(/outcome_unknown/g)!.length).toBeGreaterThanOrEqual(2);
    expect(await third.drainNoticesFor('sess-1')).toBe('');

    const fourth = bootOver(storage);
    expect((await fourth.init()).plan.transitions.length).toBe(0); // fixpoint
  });
});

// --- 5. death DURING generation persistence ---------------------------------

describe('kill point: the generation write itself', () => {
  test('the next boot still mints a strictly newer generation (the nonce disambiguates) and reconciles', async () => {
    const storage = makeFaultyStorage();
    const first = await bootOver(storage).init();
    expect(first.generation.seq).toBe(1);
    await killDuringDispatch(storage, {
      operationId: 'op-e', sessionId: 'sess-1', tool: TOOLS.E,
      generationId: first.generation.id, writesBeforeDeath: 3,
    });

    // The generation is persisted BEFORE reconciling, on purpose — so this
    // failure takes the whole boot down rather than reconciling under an id
    // no later boot could recognize.
    storage.failWriteAt(1);
    const doomed = bootOver(storage);
    await expect(doomed.init()).rejects.toThrow(StorageWriteError);
    const doomedNonce = nonces[nonces.length - 1];
    storage.heal();

    // Nothing of the dead generation is durable: the seq is untouched and
    // its orphan is still nonterminal.
    expect((storage.peek(GENERATION_KEY) as { seq: number, id: string }).seq).toBe(1);
    expect((storage.peek(GENERATION_KEY) as { id: string }).id).toBe(first.generation.id);
    expect((storage.peek(OPERATION_LOG_KEY) as Record<string, { state: string }>)['op-e'].state)
      .toBe(S.AWAITING_REMOTE);

    const next = bootOver(storage);
    const { generation, plan } = await next.init();
    // Strictly newer than the last DURABLE generation…
    expect(generation.seq).toBeGreaterThan(1);
    expect(generation.id).not.toBe(first.generation.id);
    // …and distinct from the id the dead boot handed out at the same seq —
    // the seq alone repeats when its write is lost; the nonce cannot.
    expect(generation.id).not.toBe(`gen-${generation.seq}-${doomedNonce}`);
    expect(doomedNonce).not.toBe(nonces[nonces.length - 1]);
    // The reconcile the dead boot never reached happens here.
    expect(plan.transitions.length).toBe(1);
    expect((await next.operationLog.get('op-e')).state).toBe(S.OUTCOME_UNKNOWN);
  });
});

// --- 6. migration kill points -----------------------------------------------

describe('kill point: mid-migration (checkpointed, write-through)', () => {
  const STORE = 'sessions';
  const DATA_KEY = 'peerd.test.sessions.data';
  const CHECKPOINT_KEY = 'peerd.test.sessions.checkpoint';

  const steps = [
    {
      from: 1, to: 2, drops: ['old'],
      migrate: (d: Record<string, unknown>) => {
        const { old, ...rest } = d;
        return { ...rest, renamed: old };
      },
    },
    {
      from: 2, to: 3, drops: ['legacy'],
      migrate: (d: Record<string, unknown>) => {
        const { legacy, ...rest } = d;
        return { ...rest, count: 0 };
      },
    },
  ];

  // runMigration is PURE — the write-through checkpoint is the shell's job.
  // This is that shell: one step, persist the migrated data, persist the
  // cursor, repeat. A death anywhere in it leaves exactly what had landed.
  const migrateWithCheckpoint = async (storage: FaultyStorage, input: {
    data: unknown, fromVersion: number, toVersion: number, checkpointVersion?: number,
  }) => {
    let current: unknown = input.data;
    let version = input.checkpointVersion ?? input.fromVersion;
    for (const step of steps.filter((s) => s.to > version)) {
      const result = runMigration({
        store: STORE, data: current, fromVersion: version, toVersion: step.to, steps: [step],
      });
      if (!result.ok) return result;
      current = result.data;
      version = result.version;
      await storage.set(DATA_KEY, current);
      await storage.set(CHECKPOINT_KEY, version);
    }
    return { ok: true as const, data: current, version };
  };

  test('killed after the step-1 checkpoint, the resume completes idempotently', async () => {
    const storage = makeFaultyStorage();
    storage.poke(DATA_KEY, { old: 'x', legacy: true, mystery: 'keep-me' });

    // Writes: 1 = the v2 data, 2 = the v2 cursor, then the process dies —
    // the v1→v2 step is durable, the v2→v3 step never gets to write.
    storage.dieAfterWrites(2);
    await expect(migrateWithCheckpoint(storage, {
      data: storage.peek(DATA_KEY), fromVersion: 1, toVersion: 3,
    })).rejects.toThrow(StorageDeadError);
    storage.heal();

    expect(storage.peek(CHECKPOINT_KEY)).toBe(2);
    expect(storage.peek(DATA_KEY)).toEqual({ renamed: 'x', legacy: true, mystery: 'keep-me' });

    // The resume: steps at or below the durable cursor are skipped, so the
    // already-migrated data is never re-migrated.
    const resumed = runMigration({
      store: STORE, data: storage.peek(DATA_KEY), fromVersion: 1, toVersion: 3, steps,
      checkpointVersion: storage.peek(CHECKPOINT_KEY) as number,
    });
    if (!resumed.ok) throw new Error(resumed.reason);
    expect(resumed.completedSteps).toEqual([3]);
    expect(resumed.data).toEqual({ renamed: 'x', mystery: 'keep-me', count: 0 });

    // Idempotent on rerun: the same resume twice, and a full rerun over the
    // FINISHED data at the finished cursor, are both no-op successes.
    const again = runMigration({
      store: STORE, data: storage.peek(DATA_KEY), fromVersion: 1, toVersion: 3, steps,
      checkpointVersion: 2,
    });
    expect(again).toEqual(resumed);
    const afterCompletion = runMigration({
      store: STORE, data: resumed.data, fromVersion: 1, toVersion: 3, steps,
      checkpointVersion: 3,
    });
    if (!afterCompletion.ok) throw new Error(afterCompletion.reason);
    expect(afterCompletion.data).toEqual(resumed.data);
    expect(afterCompletion.completedSteps).toEqual([]);
  });

  test('a TORN data write at the kill point fails closed — original retained, cursor unmoved', async () => {
    const storage = makeFaultyStorage();
    const original = { old: 'x', legacy: true, mystery: 'keep-me' };
    storage.poke(DATA_KEY, original);

    // The migrated v2 payload lands truncated and the write reports failure:
    // the durable store now holds bytes that are not a record at all.
    const truncated = '{"renamed":"x","legacy":tr';
    storage.tornWrite(DATA_KEY, truncated);
    await expect(migrateWithCheckpoint(storage, {
      data: storage.peek(DATA_KEY), fromVersion: 1, toVersion: 3,
    })).rejects.toThrow(TornWriteError);

    // The cursor never advanced past the torn write…
    expect(storage.peek(CHECKPOINT_KEY)).toBeUndefined();
    expect(storage.peek(DATA_KEY)).toBe(truncated);

    // …so the resume classifies the survivor, and both the guard and the
    // migration driver fail closed with a deterministic diagnostic and the
    // stored bytes handed back untouched — never an empty replacement.
    expect(classifyStoreVersion({ found: undefined, supported: 3 })).toBe('malformed');
    const guard = guardStore({ store: STORE, found: undefined, supported: 3 });
    expect(guard.mode).toBe('read-only');
    expect(guard.diagnosticId).toBe('store-sessions-malformed-version');

    const resumed = runMigration({
      store: STORE, data: storage.peek(DATA_KEY), fromVersion: 1, toVersion: 3, steps,
    });
    expect(resumed.ok).toBe(false);
    if (resumed.ok) return;
    expect(resumed.diagnosticId).toBe('migrate-sessions-malformed-data');
    expect(resumed.data).toBe(truncated); // the corrupt original, for diagnosis
    expect(resumed.resumeFrom).toBe(1);
  });
});

// --- 7. browser restart: the session tier is wiped, the profile tier is not --

describe('kill point: a browser restart (session tier cleared, profile tier kept)', () => {
  test('the generation and the operation log survive, and reconcile still settles the orphans', async () => {
    const storage = makeFaultyStorage();
    const first = await bootOver(storage).init();
    await killDuringDispatch(storage, {
      operationId: 'op-e', sessionId: 'sess-1', tool: TOOLS.E,
      generationId: first.generation.id, writesBeforeDeath: 3,
    });

    // The session tier, by name, from the mirror contract in
    // peerd-egress/storage/session-cache.js (chrome.storage.session: RAM
    // only, cleared on browser restart). Named here rather than imported —
    // this suite must not pull the vault into a pure-logic test.
    const SESSION_TIER = ['currentSessionId', 'vault.unlockedAt', 'vault.unlocked.v1'];
    for (const key of SESSION_TIER) storage.poke(key, { mirrored: true });

    // The restart.
    storage.wipe(SESSION_TIER);

    for (const key of SESSION_TIER) expect(storage.peek(key)).toBeUndefined();
    expect(storage.peek(GENERATION_KEY)).toBeDefined();
    expect(storage.peek(OPERATION_LOG_KEY)).toBeDefined();

    const next = bootOver(storage);
    const { generation, plan } = await next.init();
    // Profile tier: the seq kept counting across the restart, so authority
    // stamped by the pre-restart generation can still be recognized as stale.
    expect(generation.seq).toBe(first.generation.seq + 1);
    expect(plan.transitions.length).toBe(1);
    expect((await next.operationLog.get('op-e')).state).toBe(S.OUTCOME_UNKNOWN);
    expect(await next.drainNoticesFor('sess-1')).toContain('outcome_unknown');
  });
});

// --- 8. torn pending-notices write ------------------------------------------

describe('kill point: a torn pending-notices write', () => {
  test('the drain never throws into a turn — but a later boot that must park notices does', async () => {
    const storage = makeFaultyStorage();
    const first = await bootOver(storage).init();
    await killDuringDispatch(storage, {
      operationId: 'op-1', sessionId: 'sess-1', tool: TOOLS.E,
      generationId: first.generation.id, writesBeforeDeath: 3,
    });

    // Boot 2 settles the orphan and parks its notice — and THAT write tears.
    const truncated = '{"sess-1":[{"user":"submit_form was dispatch';
    storage.tornWrite(PENDING_NOTICES_KEY, truncated);
    const second = bootOver(storage);
    const { generation } = await second.init(); // the parked write is best-effort
    expect(storage.peek(PENDING_NOTICES_KEY)).toBe(truncated);
    expect((await second.operationLog.get('op-1')).state).toBe(S.OUTCOME_UNKNOWN);

    // The turn driver's read path holds: garbage in, empty string out, no
    // throw into the agent's turn (the notice itself is lost with the write).
    expect(await second.drainNoticesFor('sess-1')).toBe('');
    expect(await second.drainNoticesFor('sess-other')).toBe('');

    // A LATER interruption, with the corrupted value still on disk.
    await killDuringDispatch(storage, {
      operationId: 'op-2', sessionId: 'sess-1', tool: TOOLS.E,
      generationId: generation.id, writesBeforeDeath: 3,
    });
    const third = bootOver(storage);

    // FIXED (was FIXME §14): a primitive left by a torn write is treated as
    // an empty notices store and REPAIRED by overwrite — init() completes,
    // the settles apply, the new notice parks, and the fail-closed tracker
    // is never armed off one bad kv value.
    await third.init();
    expect((await third.operationLog.get('op-2')).state).toBe(S.OUTCOME_UNKNOWN);
    const repaired = storage.peek(PENDING_NOTICES_KEY);
    expect(typeof repaired).toBe('object');
    expect(await third.drainNoticesFor('sess-1')).toContain('outcome_unknown');
  });

  test('an OBJECT-shaped corruption is survivable — a boot repairs it by overwriting', async () => {
    const storage = makeFaultyStorage();
    const first = await bootOver(storage).init();
    await killDuringDispatch(storage, {
      operationId: 'op-1', sessionId: 'sess-1', tool: TOOLS.E,
      generationId: first.generation.id, writesBeforeDeath: 3,
    });
    // Right shape, wrong contents: the per-session value is not a list.
    storage.poke(PENDING_NOTICES_KEY, { 'sess-1': 'not-a-list', 'sess-2': 42 });

    const second = bootOver(storage);
    expect(await second.drainNoticesFor('sess-1')).toBe('');
    await second.init();
    const block = await second.drainNoticesFor('sess-1');
    expect(block).toContain('<interruption-recovery>');
    expect(block).toContain('outcome_unknown');
  });
});
