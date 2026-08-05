// The durable operation log — persist-before-report, legality-enforced
// transitions, sanitized result metadata, attempt numbering for Class B.

import { describe, test, expect } from 'bun:test';
import {
  createOperationLog, OperationNotFoundError, OPERATION_LOG_KEY,
  OPERATION_LOG_MAX_TERMINAL,
} from '../../../extension/peerd-runtime/lifecycle/operation-log.js';
import {
  OPERATION_STATES, IllegalTransitionError,
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
        writes.push(structuredClone(value));
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
    await log.begin(beginInput);
    await log.transition('op-1', S.RUNNING);
    await log.transition('op-1', S.OUTCOME_UNKNOWN);
    await expect(log.newAttempt('op-1')).rejects.toThrow('interrupted');
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
});
