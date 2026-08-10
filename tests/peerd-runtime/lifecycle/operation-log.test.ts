// The durable operation log — persist-before-report, legality-enforced
// transitions, sanitized result metadata, attempt numbering for Class B.

import { describe, test, expect } from 'bun:test';
import {
  createOperationLog, OperationNotFoundError, OperationExistsError,
  RetryRefusedError, OPERATION_LOG_KEY, OPERATION_LOG_MAX_TERMINAL,
  OPERATION_LOG_MAX_UNKNOWN, TOMBSTONES_KEY,
} from '../../../extension/peerd-runtime/lifecycle/operation-log.js';
import {
  OPERATION_STATES, IllegalTransitionError, UnknownOutcomeUnresolvedError,
} from '../../../extension/peerd-runtime/lifecycle/operation-state.js';

const S = OPERATION_STATES;

const makeStorage = () => {
  const map = new Map<string, unknown>();
  const writes: unknown[] = [];
  return {
    adapter: {
      get: async (key: string) => map.get(key),
      set: async (key: string, value: unknown) => {
        map.set(key, structuredClone(value));
        // why: these tests assert only the number of durable writes. Keeping
        // a second full snapshot per write makes the bounded-log cases retain
        // quadratic test data that the production adapter never keeps.
        writes.push(undefined);
      },
    },
    map, writes,
  };
};

const beginInput = {
  operationId: 'op-1', sessionId: 'sess-1', toolName: 'submit_form',
  retryClass: 'E', generationId: 'gen-1-aaaa', target: 'https://example.com',
};

describe('begin — recorded before dispatch', () => {
  test('persists the §8 record shape with created state, attempt 1, class normalized', async () => {
    const { adapter, writes } = makeStorage();
    const log = createOperationLog({ storage: adapter, now: () => 42 });
    const record = await log.begin(beginInput);
    expect(record).toMatchObject({
      operationId: 'op-1', sessionId: 'sess-1', toolName: 'submit_form',
      retryClass: 'E', createdAt: 42, attempt: 1, state: S.CREATED,
      generationId: 'gen-1-aaaa', dispatched: false,
    });
    expect(writes.length).toBe(1); // durably written before begin() returned
  });

  test('unclassified tools are stored as Class E (fail closed)', async () => {
    const { adapter } = makeStorage();
    const log = createOperationLog({ storage: adapter, now: () => 1 });
    const record = await log.begin({ ...beginInput, retryClass: 'nonsense' });
    expect(record.retryClass).toBe('E');
  });

  test('missing identities throw', async () => {
    const { adapter } = makeStorage();
    const log = createOperationLog({ storage: adapter });
    await expect(log.begin({ ...beginInput, generationId: '' } as any))
      .rejects.toThrow(TypeError);
  });

  test('a duplicate operationId refuses — a re-drive must not erase dispatch evidence', async () => {
    const { adapter } = makeStorage();
    const log = createOperationLog({ storage: adapter, now: () => 1 });
    await log.begin(beginInput);
    await log.transition('op-1', S.RUNNING);
    await log.markDispatched('op-1');
    await expect(log.begin(beginInput)).rejects.toThrow(OperationExistsError);
    // The dispatched flag — what decides interrupted vs outcome_unknown on
    // recovery — survived the attempted overwrite.
    expect((await log.get('op-1'))!.dispatched).toBe(true);
  });

  test('concurrent begins both land — the mutation queue prevents lost updates', async () => {
    const { adapter } = makeStorage();
    const log = createOperationLog({ storage: adapter, now: () => 1 });
    await Promise.all([
      log.begin({ ...beginInput, operationId: 'op-A' }),
      log.begin({ ...beginInput, operationId: 'op-B' }),
      log.begin({ ...beginInput, operationId: 'op-C' }),
    ]);
    const open = await log.listNonterminal();
    expect(open.map((r) => r.operationId).sort()).toEqual(['op-A', 'op-B', 'op-C']);
  });
});

describe('transitions', () => {
  test('the dispatch path: created → running → awaiting_remote (dispatched) → completed', async () => {
    const { adapter } = makeStorage();
    const log = createOperationLog({ storage: adapter, now: () => 1 });
    await log.begin(beginInput);
    await log.transition('op-1', S.RUNNING);
    const dispatched = await log.markDispatched('op-1');
    expect(dispatched.state).toBe(S.AWAITING_REMOTE);
    expect(dispatched.dispatched).toBe(true);
    const done = await log.transition('op-1', S.COMPLETED,
      { evidence: { kind: 'success-response' }, resultDigest: 'sha256:abc' });
    expect(done.state).toBe(S.COMPLETED);
    expect(done.resultDigest).toBe('sha256:abc');
  });

  test('illegal transitions throw and persist nothing', async () => {
    const { adapter, writes } = makeStorage();
    const log = createOperationLog({ storage: adapter, now: () => 1 });
    await log.begin(beginInput);
    const before = writes.length;
    await expect(log.transition('op-1', S.OUTCOME_UNKNOWN))
      .rejects.toThrow(IllegalTransitionError);
    expect(writes.length).toBe(before);
  });

  test('unknown operations throw the named error', async () => {
    const { adapter } = makeStorage();
    const log = createOperationLog({ storage: adapter });
    await expect(log.transition('nope', S.RUNNING))
      .rejects.toThrow(OperationNotFoundError);
  });
});

describe('listNonterminal — the reconciler input', () => {
  test('returns only unsettled records', async () => {
    const { adapter } = makeStorage();
    const log = createOperationLog({ storage: adapter, now: () => 1 });
    await log.begin(beginInput);
    await log.begin({ ...beginInput, operationId: 'op-2' });
    await log.transition('op-2', S.RUNNING);
    await log.transition('op-2', S.COMPLETED);
    const open = await log.listNonterminal();
    expect(open.map((r) => r.operationId)).toEqual(['op-1']);
  });
});

describe('settle and resolveUnknown — the recovery regime', () => {
  test('settle applies a reconcile verdict the live table would refuse', async () => {
    const { adapter } = makeStorage();
    const log = createOperationLog({ storage: adapter, now: () => 1 });
    await log.begin(beginInput);
    await log.transition('op-1', S.RUNNING);
    await log.markDispatched('op-1'); // awaiting_remote
    // awaiting_remote → cancelled is illegal live (the route is via
    // cancelling) but legal as a recovery settle.
    const settled = await log.settle('op-1', {
      state: S.CANCELLED, autoRetry: false, retryRequires: [],
      keepIdempotencyKey: false, verificationRequired: false,
      recreateResource: false, reason: 'cancel won the race',
    });
    expect(settled.state).toBe(S.CANCELLED);
  });

  test('settle refuses the awaiting_user → outcome_unknown carve-out and terminal sources', async () => {
    const { adapter } = makeStorage();
    const log = createOperationLog({ storage: adapter, now: () => 1 });
    await log.begin(beginInput);
    await log.transition('op-1', S.RUNNING);
    await log.transition('op-1', S.AWAITING_USER);
    const unknownVerdict = {
      state: S.OUTCOME_UNKNOWN, autoRetry: false, retryRequires: [],
      keepIdempotencyKey: false, verificationRequired: true,
      recreateResource: false, reason: 'x',
    };
    await expect(log.settle('op-1', unknownVerdict)).rejects.toThrow('refused');
  });

  test('resolveUnknown is the one exit: positive evidence settles, a timeout does not', async () => {
    const { adapter } = makeStorage();
    const log = createOperationLog({ storage: adapter, now: () => 1 });
    await log.begin(beginInput);
    await log.transition('op-1', S.RUNNING);
    await log.transition('op-1', S.OUTCOME_UNKNOWN, { dispatched: true });
    await expect(log.resolveUnknown('op-1', { kind: 'timeout' }))
      .rejects.toThrow(UnknownOutcomeUnresolvedError);
    const resolved = await log.resolveUnknown('op-1', { kind: 'verified-state' });
    expect(resolved.state).toBe(S.COMPLETED);
    expect(resolved.evidence).toEqual({ kind: 'verified-state' });
    // Only outcome_unknown records qualify.
    await expect(log.resolveUnknown('op-1', { kind: 'verified-state' }))
      .rejects.toThrow('outcome_unknown');
  });
});

describe('newAttempt — Class B retries', () => {
  test('re-queues an interrupted operation with a fresh attempt number', async () => {
    const { adapter } = makeStorage();
    const log = createOperationLog({ storage: adapter, now: () => 1 });
    await log.begin({ ...beginInput, retryClass: 'B' });
    await log.transition('op-1', S.RUNNING);
    await log.transition('op-1', S.INTERRUPTED);
    const retried = await log.newAttempt('op-1');
    expect(retried.attempt).toBe(2);
    expect(retried.state).toBe(S.QUEUED);
    expect(retried.dispatched).toBe(false);
  });

  test('refused for any state but interrupted — settled outcomes are never re-driven', async () => {
    const { adapter } = makeStorage();
    const log = createOperationLog({ storage: adapter, now: () => 1 });
    await log.begin({ ...beginInput, retryClass: 'B' });
    await log.transition('op-1', S.RUNNING);
    await log.transition('op-1', S.OUTCOME_UNKNOWN);
    await expect(log.newAttempt('op-1')).rejects.toThrow(RetryRefusedError);
  });

  test('refused for Class E — a user-instructed repeat is a NEW operation, never a re-drive', async () => {
    const { adapter } = makeStorage();
    const log = createOperationLog({ storage: adapter, now: () => 1 });
    await log.begin(beginInput); // Class E
    await log.transition('op-1', S.RUNNING);
    await log.transition('op-1', S.INTERRUPTED);
    await expect(log.newAttempt('op-1')).rejects.toThrow(RetryRefusedError);
  });

  test('refused for Class F - replacement resources require freshly derived grants', async () => {
    const { adapter } = makeStorage();
    const log = createOperationLog({ storage: adapter, now: () => 1 });
    await log.begin({ ...beginInput, retryClass: 'F' });
    await log.transition('op-1', S.RUNNING);
    await log.transition('op-1', S.INTERRUPTED);
    await expect(log.newAttempt('op-1')).rejects.toThrow(RetryRefusedError);
  });
});

describe('poisoned entries', () => {
  test('a null/garbage value in the stored map never crashes the recovery sweep', async () => {
    const { adapter, map } = makeStorage();
    const log = createOperationLog({ storage: adapter, now: () => 1 });
    await log.begin(beginInput);
    // Poison the stored map the way corruption or an in-origin writer would.
    const stored = structuredClone(map.get(OPERATION_LOG_KEY)) as Record<string, unknown>;
    stored.poison = null;
    stored.garbage = 'not-a-record';
    stored.noId = { state: 'running' };
    map.set(OPERATION_LOG_KEY, stored);

    const open = await log.listNonterminal(); // must not throw
    expect(open.map((r) => r.operationId)).toEqual(['op-1']);
    // The next persist self-heals: invalid entries are gone.
    await log.transition('op-1', S.RUNNING);
    const healed = map.get(OPERATION_LOG_KEY) as Record<string, unknown>;
    expect(Object.keys(healed).sort()).toEqual(['op-1']);
  });
});

describe('bounded growth', () => {
  test('oldest terminal records are pruned past the cap; nonterminal ones survive', async () => {
    const { adapter } = makeStorage();
    let t = 0;
    const log = createOperationLog({ storage: adapter, now: () => ++t });
    for (let i = 0; i < OPERATION_LOG_MAX_TERMINAL + 5; i += 1) {
      const id = `op-${i}`;
      await log.begin({ ...beginInput, operationId: id });
      await log.transition(id, S.RUNNING);
      await log.transition(id, S.COMPLETED);
    }
    await log.begin({ ...beginInput, operationId: 'op-live' });
    const stored = await adapter.get(OPERATION_LOG_KEY) as Record<string, { state: string }>;
    const terminal = Object.values(stored).filter((r) => r.state === S.COMPLETED);
    expect(terminal.length).toBe(OPERATION_LOG_MAX_TERMINAL);
    expect(stored['op-0']).toBeUndefined(); // oldest pruned
    expect(stored['op-live']).toBeDefined();
  });

  test('outcome_unknown has its own larger bound — oldest dropped past OPERATION_LOG_MAX_UNKNOWN', async () => {
    const { adapter } = makeStorage();
    let t = 0;
    const log = createOperationLog({ storage: adapter, now: () => ++t });
    for (let i = 0; i < OPERATION_LOG_MAX_UNKNOWN + 3; i += 1) {
      const id = `unk-${i}`;
      await log.begin({ ...beginInput, operationId: id });
      await log.transition(id, S.RUNNING);
      await log.transition(id, S.OUTCOME_UNKNOWN, { dispatched: true });
    }
    const stored = await adapter.get(OPERATION_LOG_KEY) as Record<string, { state: string }>;
    const unknowns = Object.values(stored).filter((r) => r.state === S.OUTCOME_UNKNOWN);
    expect(unknowns.length).toBe(OPERATION_LOG_MAX_UNKNOWN);
    expect(stored['unk-0']).toBeUndefined();
    expect(stored[`unk-${OPERATION_LOG_MAX_UNKNOWN + 2}`]).toBeDefined();
  });

  test('compacted unknowns retain the semantic identity used by replay guards', async () => {
    const { adapter } = makeStorage();
    let t = 0;
    const log = createOperationLog({ storage: adapter, now: () => ++t });
    for (let i = 0; i < OPERATION_LOG_MAX_UNKNOWN + 1; i += 1) {
      const id = `unk-${i}`;
      await log.begin({
        ...beginInput, operationId: id, ownerSessionId: `root-${i}`,
        intentKey: `intent-${i}`, target: `https://example.com/${i}`,
      });
      await log.transition(id, S.RUNNING);
      await log.transition(id, S.OUTCOME_UNKNOWN, { dispatched: true });
    }
    expect(await log.get('unk-0')).toBeUndefined();
    const unknowns = await log.listOutcomeUnknown();
    expect(unknowns).toHaveLength(OPERATION_LOG_MAX_UNKNOWN + 1);
    expect(unknowns.find((record) => record.operationId === 'unk-0')).toMatchObject({
      sessionId: 'sess-1', ownerSessionId: 'root-0', toolName: 'submit_form',
      intentKey: 'intent-0', target: 'https://example.com/0',
      state: S.OUTCOME_UNKNOWN, dispatched: true,
    });
  });

  test('prune evidence is durable before the destructive main-map write', async () => {
    const durable = new Map<string, unknown>();
    let failMainWrite = false;
    const events: string[] = [];
    const storage = {
      get: async (key: string) => structuredClone(durable.get(key)),
      set: async (key: string, value: unknown) => {
        events.push(key);
        if (failMainWrite && key === OPERATION_LOG_KEY) throw new Error('worker died');
        durable.set(key, structuredClone(value));
      },
    };
    let t = 0;
    const log = createOperationLog({ storage, now: () => ++t });
    for (let i = 0; i < OPERATION_LOG_MAX_TERMINAL; i += 1) {
      const id = `old-${i}`;
      await log.begin({ ...beginInput, operationId: id });
      await log.transition(id, S.RUNNING);
      await log.transition(id, S.COMPLETED);
    }
    await log.begin({ ...beginInput, operationId: 'new' });
    await log.transition('new', S.RUNNING);
    events.length = 0;
    failMainWrite = true;
    await expect(log.transition('new', S.COMPLETED)).rejects.toThrow('worker died');
    expect(events.slice(0, 2)).toEqual([TOMBSTONES_KEY, OPERATION_LOG_KEY]);
    const tombstones = durable.get(TOMBSTONES_KEY) as Record<string, unknown>;
    const operations = durable.get(OPERATION_LOG_KEY) as Record<string, unknown>;
    expect(tombstones['old-0']).toBeDefined();
    expect(operations['old-0']).toBeDefined();
  });

  test('outcome_unknown records are not pruned by the terminal cap — the uncertainty outlives ordinary history', async () => {
    const { adapter } = makeStorage();
    let t = 0;
    const log = createOperationLog({ storage: adapter, now: () => ++t });
    await log.begin({ ...beginInput, operationId: 'op-unknown' });
    await log.transition('op-unknown', S.RUNNING);
    await log.transition('op-unknown', S.OUTCOME_UNKNOWN, { dispatched: true });
    for (let i = 0; i < OPERATION_LOG_MAX_TERMINAL + 5; i += 1) {
      const id = `op-${i}`;
      await log.begin({ ...beginInput, operationId: id });
      await log.transition(id, S.RUNNING);
      await log.transition(id, S.COMPLETED);
    }
    const stored = await adapter.get(OPERATION_LOG_KEY) as Record<string, { state: string }>;
    expect(stored['op-unknown']).toBeDefined(); // oldest record of all, still here
    expect(stored['op-unknown'].state).toBe(S.OUTCOME_UNKNOWN);
  });
});
