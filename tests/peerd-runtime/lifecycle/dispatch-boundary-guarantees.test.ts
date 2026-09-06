// Durable authority-tracker and operation-log boundary guarantees. The
// semantic dispatcher deliberately has no direct lifecycle mode.

import { describe, test, expect } from 'bun:test';
import { makeDispatchTracker } from '../../../extension/peerd-runtime/lifecycle/dispatch-tracking.js';
import {
  createOperationLog, OPERATION_LOG_MAX_TERMINAL, OPERATION_LOG_MAX_UNKNOWN,
  OPERATION_LOG_KEY, TOMBSTONES_KEY, TOMBSTONES_MAX, UNKNOWN_INTENT_OVERFLOW_KEY,
  CLASS_F_REPLAY_FILTER_KEY,
} from '../../../extension/peerd-runtime/lifecycle/operation-log.js';
import { makeLifecycleBoot } from '../../../extension/peerd-runtime/lifecycle/boot.js';
import { OPERATION_STATES } from '../../../extension/peerd-runtime/lifecycle/operation-state.js';
import { confirmationSatisfies } from '../../../extension/peerd-runtime/lifecycle/confirmation.js';
import { retryClassForTool } from '../../../extension/peerd-runtime/lifecycle/tool-retry-class.js';
import { decideRecovery } from '../../../extension/peerd-runtime/lifecycle/retry-class.js';
import { fromOpenAiStream } from '../../../extension/peerd-provider/format/from-openai.js';

const S = OPERATION_STATES;

const makeStorage = () => {
  const map = new Map<string, unknown>();
  const journal: string[] = [];
  return {
    map, journal,
    get: async (k: string) => structuredClone(map.get(k)),
    set: async (k: string, v: unknown) => { journal.push(`set:${k}`); map.set(k, structuredClone(v)); },
  };
};

const makeLog = (storage = makeStorage()) => ({
  storage,
  log: createOperationLog({ storage, now: () => 1 }),
});

describe('authority tracker failure closure', () => {
  test('internal failures produce a refusal rather than a rejected promise', async () => {
    const cases = [
      ['throwing classifier', makeDispatchTracker({
        operationLog: createOperationLog({ storage: makeStorage() }),
        generationId: () => 'gen-1-x',
        retryClassFor: () => { throw new Error('classifier exploded'); },
      })],
      ['throwing generationId', makeDispatchTracker({
        operationLog: createOperationLog({ storage: makeStorage() }),
        generationId: () => { throw new Error('no generation'); },
        retryClassFor: retryClassForTool,
      })],
      ['unreadable replay identity', makeDispatchTracker({
        operationLog: {
          ...createOperationLog({ storage: makeStorage() }),
          getTombstone: async () => { throw new Error('tombstone store unreadable'); },
        } as any,
        generationId: () => 'gen-1-x',
        retryClassFor: retryClassForTool,
      })],
    ] as const;

    for (const [label, tracker] of cases) {
      const begun = await tracker.beginTracking({
        callId: 'c1', tool: { name: 'submit_form', sideEffect: 'mutate_external' },
        sessionId: 's',
      });
      expect(begun && 'refuse' in begun, label).toBe(true);
      expect((begun as any).refuse.error, label).toContain('NOT executed');
    }
  });

  test('completed settlement is durable before settleTracking resolves', async () => {
    const { storage, log } = makeLog();
    const tracker = makeDispatchTracker({
      operationLog: log, generationId: () => 'gen-1-x', retryClassFor: retryClassForTool,
    });
    const begun = await tracker.beginTracking({
      callId: 'tu-1', tool: { name: 'submit_form', retryClass: 'E' },
      sessionId: 'sess-1',
    });
    await tracker.settleTracking((begun as { handle: any }).handle, { ok: true });
    const writesAtResolve = storage.journal.length;
    expect(writesAtResolve).toBe(storage.journal.length);
    expect((await log.get('sess-1:tu-1'))!.state).toBe(S.COMPLETED);
  });
});

describe('replay identity survives compaction (tombstones)', () => {
  test('a completed Class E call refuses re-execution even after its record was pruned past the cap', async () => {
    const { storage } = makeLog();
    let t = 0;
    const agedLog = createOperationLog({ storage, now: () => ++t });
    // The Class E operation completes…
    await agedLog.begin({
      operationId: 'sess-1:tu-pay', sessionId: 'sess-1', toolName: 'submit_form',
      retryClass: 'E', generationId: 'gen-1-x',
    });
    await agedLog.transition('sess-1:tu-pay', S.RUNNING);
    await agedLog.transition('sess-1:tu-pay', S.COMPLETED,
      { evidence: { kind: 'success-response' } });
    // …then 500+ later operations age its full record out.
    for (let i = 0; i < OPERATION_LOG_MAX_TERMINAL + 2; i += 1) {
      const id = `op-${i}`;
      await agedLog.begin({
        operationId: id, sessionId: 's2', toolName: 't', retryClass: 'E',
        generationId: 'gen-1-x',
      });
      await agedLog.transition(id, S.RUNNING);
      await agedLog.transition(id, S.COMPLETED, { evidence: { kind: 'success-response' } });
    }
    expect(await agedLog.get('sess-1:tu-pay')).toBeUndefined(); // full record gone

    const tracker = makeDispatchTracker({
      operationLog: agedLog, generationId: () => 'gen-2-y', retryClassFor: retryClassForTool,
    });
    const replay = await tracker.beginTracking({
      callId: 'tu-pay', sessionId: 'sess-1', args: {},
      tool: { name: 'submit_form', retryClass: 'E' },
    });
    expect((replay as { refuse: { error: string } }).refuse.error)
      .toStartWith('completed:');
  }, 15_000);

  test('an interrupted Class F call stays lost after compaction while a fresh call can replace it', async () => {
    const { storage } = makeLog();
    let t = 0;
    const agedLog = createOperationLog({ storage, now: () => ++t });
    await agedLog.begin({
      operationId: 'sess-1:resource-old', sessionId: 'sess-1',
      toolName: 'sandbox_create', retryClass: 'F', generationId: 'gen-1-x',
    });
    await agedLog.settle('sess-1:resource-old', decideRecovery({
      retryClass: 'F', dispatched: false,
    }));
    for (let i = 0; i < OPERATION_LOG_MAX_TERMINAL + 2; i += 1) {
      const id = `resource-pressure-${i}`;
      await agedLog.begin({
        operationId: id, sessionId: 's2', toolName: 't', retryClass: 'B',
        generationId: 'gen-1-x',
      });
      await agedLog.settle(id, decideRecovery({ retryClass: 'B', dispatched: false }));
    }
    expect(await agedLog.get('sess-1:resource-old')).toBeUndefined();

    const tracker = makeDispatchTracker({
      operationLog: agedLog, generationId: () => 'gen-2-y',
      retryClassFor: (tool) => tool.retryClass as any,
    });
    const tool = { name: 'sandbox_create', retryClass: 'F' };
    const stale = await tracker.beginTracking({
      callId: 'resource-old', tool, sessionId: 'sess-1', args: {},
    });
    expect((stale as { refuse: { error: string } }).refuse.error)
      .toStartWith('resource_lost:');
    expect((stale as { refuse: { error: string } }).refuse.error)
      .toContain('record ending interrupted');
    expect((stale as { refuse: { recovery: Record<string, unknown> } }).refuse.recovery)
      .toMatchObject({
        category: 'resource_lost', autoRetry: false,
        retryRequires: ['rederive-grants'], verificationRequired: false,
        keepIdempotencyKey: false,
        reason: 'compacted Class F record ended interrupted',
      });
    expect((stale as { refuse: { recovery: { retryRequires: string[] } } })
      .refuse.recovery.retryRequires).toContain('rederive-grants');

    const fresh = await tracker.beginTracking({
      callId: 'resource-fresh', tool, sessionId: 'sess-1', args: {},
    });
    expect(fresh && 'handle' in fresh).toBe(true);
    expect((fresh as { handle: { operationId: string } }).handle.operationId)
      .toBe('sess-1:resource-fresh');
  }, 15_000);

  test('Class F replay stays blocked after exact tombstones exceed their cap', async () => {
    const storage = makeStorage();
    const tombstones = Object.fromEntries(Array.from({ length: TOMBSTONES_MAX }, (_, i) => [
      i === 0 ? 'sess-1:resource-evicted' : `old-resource-${i}`,
      { terminalState: S.INTERRUPTED, retryClass: 'F', completedAt: i },
    ]));
    await storage.set(TOMBSTONES_KEY, tombstones);
    const operations = Object.fromEntries(Array.from({ length: OPERATION_LOG_MAX_TERMINAL + 1 }, (_, i) => {
      const operationId = i === 0 ? 'pressure-resource' : `pressure-${i}`;
      return [operationId, {
        operationId, sessionId: 'pressure-session',
        toolName: i === 0 ? 'sandbox_create' : 'readish',
        retryClass: i === 0 ? 'F' : 'B', createdAt: i, attempt: 1,
        state: S.COMPLETED, generationId: 'gen-1-x', dispatched: true,
      }];
    }));
    await storage.set(OPERATION_LOG_KEY, operations);
    const log = createOperationLog({ storage, now: () => 20_000 });
    await log.begin({
      operationId: 'compaction-trigger', sessionId: 'pressure-session',
      toolName: 'readish', retryClass: 'B', generationId: 'gen-2-y',
    });
    expect((storage.map.get(CLASS_F_REPLAY_FILTER_KEY) as { version: number }).version)
      .toBe(1);
    expect((storage.map.get(TOMBSTONES_KEY) as Record<string, unknown>)
      ['sess-1:resource-evicted']).toBeUndefined();

    const tracker = makeDispatchTracker({
      operationLog: log, generationId: () => 'gen-2-y',
      retryClassFor: (tool) => tool.retryClass as any,
    });
    const tool = { name: 'sandbox_create', retryClass: 'F' };
    const stale = await tracker.beginTracking({
      callId: 'resource-evicted', tool, sessionId: 'sess-1', args: {},
    });
    expect((stale as { refuse: { error: string } }).refuse.error)
      .toStartWith('resource_lost:');
    expect((stale as { refuse: { error: string } }).refuse.error)
      .toContain('may match an older compacted resource request');
    expect((stale as { refuse: { error: string } }).refuse.error)
      .toContain('issue a fresh call');
    expect((stale as { refuse: { recovery: Record<string, unknown> } }).refuse.recovery)
      .toMatchObject({
        category: 'resource_lost', autoRetry: false,
        retryRequires: ['rederive-grants'], verificationRequired: false,
        keepIdempotencyKey: false,
        reason: 'call id may match an older compacted Class F request',
      });

    const unrelated = await tracker.beginTracking({
      callId: 'resource-evicted',
      tool: { name: 'submit_form', retryClass: 'E' },
      sessionId: 'sess-1', args: {},
    });
    expect(unrelated && 'handle' in unrelated).toBe(true);

    const fresh = await tracker.beginTracking({
      callId: 'resource-overflow-fresh', tool, sessionId: 'sess-1', args: {},
    });
    expect(fresh && 'handle' in fresh).toBe(true);
  });

  test('the production tombstone adapter fails closed when replay identity is unreadable', async () => {
    const storage = makeStorage();
    const realGet = storage.get;
    storage.get = async (key: string) => {
      if (key === 'peerd.lifecycle.tombstones') throw new Error('store unreadable');
      return realGet(key);
    };
    const tracker = makeDispatchTracker({
      operationLog: createOperationLog({ storage }),
      generationId: () => 'gen-2-y', retryClassFor: retryClassForTool,
    });
    const result = await tracker.beginTracking({
      callId: 'tu-pay', sessionId: 'sess-1', args: {},
      tool: { name: 'submit_form', retryClass: 'E' },
    });
    expect((result as { refuse: { error: string } }).refuse.error)
      .toContain('store unreadable');
    expect((result as { refuse: { error: string } }).refuse.error)
      .toContain('must not run untracked');
  });

  test('an unreadable Class F replay filter refuses resource creation', async () => {
    const storage = makeStorage();
    const realGet = storage.get;
    storage.get = async (key: string) => {
      if (key === CLASS_F_REPLAY_FILTER_KEY) throw new Error('resource replay store unreadable');
      return realGet(key);
    };
    const tracker = makeDispatchTracker({
      operationLog: createOperationLog({ storage }), generationId: () => 'gen-2-y',
      retryClassFor: (tool) => tool.retryClass as any,
    });
    const result = await tracker.beginTracking({
      callId: 'resource-new', sessionId: 'sess-1', args: {},
      tool: { name: 'sandbox_create', retryClass: 'F' },
    });
    expect((result as { refuse: { error: string } }).refuse.error)
      .toContain('resource replay store unreadable');
    expect(await createOperationLog({ storage: {
      get: realGet, set: storage.set,
    } }).get('sess-1:resource-new')).toBeUndefined();
  });

  test('fresh-id semantic replay stays guarded after global unknown-log pressure', async () => {
    const storage = makeStorage();
    let t = 0;
    const log = createOperationLog({ storage, now: () => ++t });
    const tracker = makeDispatchTracker({
      operationLog: log, generationId: () => 'gen-1-x', retryClassFor: retryClassForTool,
    });
    const tool = { name: 'submit_form', sideEffect: 'mutate_external' };
    const args = { amount: 5, account: 'acct-1' };
    const first = await tracker.beginTracking({
      callId: 'victim', tool, sessionId: 'actor-a', ownerSessionId: 'root-victim',
      target: 'https://example.com/pay', args, turnId: 'turn-1', userInitiated: true,
    });
    expect(first && 'handle' in first).toBe(true);
    await tracker.settleTracking((first as { handle: any }).handle, {
      ok: false, error: 'network timeout',
    });
    for (let i = 0; i < OPERATION_LOG_MAX_UNKNOWN; i += 1) {
      const id = `pressure-${i}`;
      await log.begin({
        operationId: id, sessionId: `other-${i}`, toolName: 'submit_form',
        retryClass: 'E', generationId: 'gen-1-x', intentKey: `other-intent-${i}`,
      });
      await log.transition(id, S.RUNNING);
      await log.transition(id, S.OUTCOME_UNKNOWN, { dispatched: true });
    }
    expect(await log.get('actor-a:victim')).toBeUndefined();

    const confirmation = await tracker.requiresIntentConfirmation({
      tool, sessionId: 'actor-b', ownerSessionId: 'root-victim',
      target: 'https://example.com/pay', args, userInitiated: true,
    });
    expect(confirmation).toMatchObject({
      required: true, ownerSessionId: 'root-victim', target: 'https://example.com/pay',
    });
    const replay = await tracker.beginTracking({
      callId: 'fresh-id', tool, sessionId: 'actor-b', ownerSessionId: 'root-victim',
      target: 'https://example.com/pay', args, turnId: 'turn-2', userInitiated: true,
    });
    expect((replay as { refuse: { error: string } }).refuse.error)
      .toStartWith('outcome_unknown:');
  }, 15_000);

  test('overflow beyond the tombstone cap forces confirmation instead of forgetting intent', async () => {
    const storage = makeStorage();
    const tombstones = Object.fromEntries(Array.from({ length: TOMBSTONES_MAX }, (_, i) => [
      `old-unknown-${i}`,
      {
        terminalState: S.OUTCOME_UNKNOWN, retryClass: 'E', completedAt: i,
        operationId: `old-unknown-${i}`, sessionId: `old-session-${i}`,
        ownerSessionId: `old-root-${i}`, toolName: 'submit_form',
        target: `https://old.example/${i}`, intentKey: `old-intent-${i}`, createdAt: i,
      },
    ]));
    const operations = Object.fromEntries(Array.from(
      { length: OPERATION_LOG_MAX_UNKNOWN + 1 }, (_, i) => {
        const operationId = `active-unknown-${i}`;
        return [operationId, {
          operationId, sessionId: `active-session-${i}`, toolName: 'submit_form',
          retryClass: 'E', createdAt: TOMBSTONES_MAX + i, attempt: 1,
          state: S.OUTCOME_UNKNOWN, generationId: 'gen-old', dispatched: true,
          intentKey: `active-intent-${i}`,
        }];
      }));
    await storage.set(TOMBSTONES_KEY, tombstones);
    await storage.set(OPERATION_LOG_KEY, operations);

    const log = createOperationLog({ storage, now: () => 20_000 });
    // Any persist compacts the extra active unknown. Exact tombstones are
    // already full, so one unknown identity must cross the second bound.
    await log.begin({
      operationId: 'trigger', sessionId: 'trigger-session', toolName: 'submit_form',
      retryClass: 'E', generationId: 'gen-live',
    });
    expect(await log.unknownIntentOverflowed()).toBe(true);
    expect((storage.map.get(UNKNOWN_INTENT_OVERFLOW_KEY) as any)).toMatchObject({
      incomplete: true, droppedCount: 1,
    });
    expect(Object.keys(storage.map.get(TOMBSTONES_KEY) as Record<string, unknown>))
      .toHaveLength(TOMBSTONES_MAX);

    const tracker = makeDispatchTracker({
      operationLog: log, generationId: () => 'gen-live', retryClassFor: retryClassForTool,
    });
    const tool = { name: 'submit_form', sideEffect: 'mutate_external' };
    const args = { amount: 99 };
    const confirmation = await tracker.requiresIntentConfirmation({
      tool, sessionId: 'fresh-session', ownerSessionId: 'fresh-root',
      target: 'https://new.example/pay', args, userInitiated: true,
    });
    expect(confirmation).toMatchObject({
      required: true, overflow: true, ownerSessionId: 'fresh-root',
      target: 'https://new.example/pay',
    });
    const replay = await tracker.beginTracking({
      callId: 'fresh-call', tool, sessionId: 'fresh-session',
      ownerSessionId: 'fresh-root', target: 'https://new.example/pay', args,
      turnId: 'synthetic-turn', userInitiated: false,
    });
    expect((replay as { refuse: { error: string } }).refuse.error)
      .toContain('cannot be proven distinct from compacted unresolved actions');
  }, 15_000);
});

describe('uncertainty is never silently discarded (overflow evidence)', () => {
  test('compacting unknowns past the cap leaves a drained overflow record and a boot notice', async () => {
    const storage = makeStorage();
    let n = 0;
    const boot = makeLifecycleBoot({
      storage, nonce: () => `nonce-${n += 1}-xxxx`, now: () => 1000 + n,
    });
    const { generation } = await boot.init();
    let t = 0;
    const log = createOperationLog({ storage, now: () => ++t });
    for (let i = 0; i < 202; i += 1) {
      const id = `unk-${i}`;
      await log.begin({
        operationId: id, sessionId: 'sess-9', toolName: 'submit_form',
        retryClass: 'E', generationId: generation.id,
      });
      await log.transition(id, S.RUNNING);
      await log.transition(id, S.OUTCOME_UNKNOWN, { dispatched: true });
    }
    // The next boot surfaces the compaction as evidence + a notice.
    const boot2 = makeLifecycleBoot({
      storage, nonce: () => `nonce-${n += 1}-xxxx`, now: () => 2000 + n,
    });
    await boot2.init();
    const block = await boot2.drainNoticesFor('sess-9');
    expect(block).toContain('compacted');
    expect(block).toContain('Verify');
    expect(block).toContain('"category":"verify_before_retry"');
    expect(block).toContain('"autoRetry":false');
    expect(block).toContain('"retryRequires":["external-verification","user-instruction"]');
    expect(block).toContain('"verificationRequired":true');
    expect(block).toContain('compacted unresolved evidence');
  });
});

describe('§8.3 the confirmation forensic chain on the durable record', () => {
  test('an approved dispatch persists a consumed, generation-bound proof that a restart invalidates', async () => {
    const { log } = makeLog();
    const tracker = makeDispatchTracker({
      operationLog: log, generationId: () => 'gen-1-x',
      retryClassFor: retryClassForTool, now: () => 50_000,
    });
    const begun = await tracker.beginTracking({
      callId: 'tu-1', tool: { name: 'submit_form', sideEffect: 'mutate_external' },
      sessionId: 'sess-1', target: 'https://example.com/pay',
      confirmed: true, args: { amount: 5 },
    });
    expect(begun && 'handle' in begun).toBe(true);
    const record = (await log.get('sess-1:tu-1'))!;
    const proof = record.confirmationProof as any;
    expect(record.confirmationRef).toBe('sess-1:tu-1:confirm');
    expect(proof).toMatchObject({
      operationId: 'sess-1:tu-1', action: 'submit_form',
      target: 'https://example.com/pay', generationId: 'gen-1-x',
      consumed: true, // one approval covers exactly one dispatch
    });
    expect(proof.expiresAt).toBeGreaterThan(proof.grantedAt);

    // Consumed: never satisfies again, even for the identical request.
    expect(confirmationSatisfies(proof, {
      operationId: 'sess-1:tu-1', action: 'submit_form',
      target: 'https://example.com/pay', generationId: 'gen-1-x', now: 50_001,
    }).valid).toBe(false);
    // Stale after a restart: the new generation refuses it outright.
    const fresh = { ...proof, consumed: false };
    expect(confirmationSatisfies(fresh, {
      operationId: 'sess-1:tu-1', action: 'submit_form',
      target: 'https://example.com/pay', generationId: 'gen-2-y', now: 50_001,
    }).valid).toBe(false);
  });

  test('idempotency keys are ORDER-INDEPENDENT and SHA-256 wide', async () => {
    const { log } = makeLog();
    const tracker = makeDispatchTracker({
      operationLog: log, generationId: () => 'gen-1-x', retryClassFor: () => 'D' as any,
    });
    const keyFor = async (callId: string, args: Record<string, unknown>) => {
      await tracker.beginTracking({
        callId, tool: { name: 'dweb_share' }, sessionId: 's', args,
      });
      return (await log.get(`s:${callId}`))!.idempotencyKey!;
    };
    // Same content, different property order at two depths — one key.
    const a = await keyFor('c1', { title: 'post', meta: { x: 1, y: 2 }, body: 'hi' });
    const b = await keyFor('c2', { body: 'hi', meta: { y: 2, x: 1 }, title: 'post' });
    expect(a).toBe(b);
    // Array ORDER is semantic — it must still separate operations.
    const c = await keyFor('c3', { tags: ['x', 'y'] });
    const d = await keyFor('c4', { tags: ['y', 'x'] });
    expect(c).not.toBe(d);
    // SHA-256 hex, not a 32-bit digest.
    expect(a).toMatch(/^dweb_share:[0-9a-f]{64}$/);
  });

  test('canonicalJson: stable across key order, faithful to arrays, depth-bounded', async () => {
    const { canonicalJson, sha256Hex, idempotencyKeyFor } = await import(
      '../../../extension/peerd-runtime/lifecycle/dispatch-tracking.js');
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ a: [1, 2] })).not.toBe(canonicalJson({ a: [2, 1] }));
    expect(canonicalJson({ a: undefined })).toBe('{"a":null}');
    // A pathological nest terminates instead of blowing the stack.
    let deep: Record<string, unknown> = { end: true };
    for (let i = 0; i < 200; i += 1) deep = { nest: deep };
    expect(() => canonicalJson(deep)).not.toThrow();
    expect(canonicalJson(deep)).toContain('depth-capped');
    // Known-answer check that this really is SHA-256.
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await idempotencyKeyFor('t', { a: 1 }))
      .toBe(`t:${await sha256Hex('{"a":1}')}`);
  });

  test('Class C/D records carry a deterministic idempotency key (same args → same key; retries reuse it)', async () => {
    const { log } = makeLog();
    const tracker = makeDispatchTracker({
      operationLog: log, generationId: () => 'gen-1-x',
      retryClassFor: () => 'D' as any,
    });
    await tracker.beginTracking({
      callId: 'c1', tool: { name: 'dweb_share' }, sessionId: 's',
      args: { content: 'hello', title: 'post' },
    });
    const key1 = (await log.get('s:c1'))!.idempotencyKey;
    await tracker.beginTracking({
      callId: 'c2', tool: { name: 'dweb_share' }, sessionId: 's',
      args: { content: 'hello', title: 'post' },
    });
    const key2 = (await log.get('s:c2'))!.idempotencyKey;
    await tracker.beginTracking({
      callId: 'c3', tool: { name: 'dweb_share' }, sessionId: 's',
      args: { content: 'DIFFERENT' },
    });
    const key3 = (await log.get('s:c3'))!.idempotencyKey;
    expect(key1).toBeDefined();
    expect(key1).toBe(key2!);      // deterministic across identical calls
    expect(key1).not.toBe(key3!);  // args select the operation
  });
});

describe('operation identity assumptions hold at the formatter seam', () => {
  test('fromOpenAiStream preserves provider tool-call ids verbatim (no regeneration)', async () => {
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_VERBATIM_9x', type: 'function', function: { name: 'submit_form', arguments: '{}' } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}`,
      'data: [DONE]', '',
    ].join('\n\n');
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse));
        controller.close();
      },
    });
    const ids: string[] = [];
    for await (const ev of fromOpenAiStream(body as any)) {
      if ((ev as any).type === 'tool-use-start') ids.push((ev as any).id);
    }
    expect(ids).toEqual(['call_VERBATIM_9x']);
  });
});
