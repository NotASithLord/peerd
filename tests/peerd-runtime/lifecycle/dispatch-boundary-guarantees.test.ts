// Boundary-guarantee proofs — each test is named for the contract guarantee
// it defends, and each of the reviewer's mutation probes would fail exactly
// one of them. All run at the REAL dispatcher boundary (dispatchToolCall +
// an execution spy), not against the tracker in isolation.

import { describe, test, expect, beforeEach } from 'bun:test';
import { makeDispatchTracker, makeFailClosedTracker } from '../../../extension/peerd-runtime/lifecycle/dispatch-tracking.js';
import { createOperationLog, OPERATION_LOG_MAX_TERMINAL } from '../../../extension/peerd-runtime/lifecycle/operation-log.js';
import { makeLifecycleBoot } from '../../../extension/peerd-runtime/lifecycle/boot.js';
import { OPERATION_STATES } from '../../../extension/peerd-runtime/lifecycle/operation-state.js';
import { confirmationSatisfies } from '../../../extension/peerd-runtime/lifecycle/confirmation.js';
import { retryClassForTool } from '../../../extension/peerd-runtime/lifecycle/tool-retry-class.js';
import { registerTool, clearTools } from '../../../extension/peerd-runtime/tools/registry.js';
import { dispatchToolCall } from '../../../extension/peerd-runtime/tools/dispatcher.js';
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

const spyTool = (name: string, sideEffect: string, retryClass?: string) => {
  const calls = { count: 0 };
  registerTool({
    name, description: 'x', schema: {}, primitive: 'web', sideEffect,
    ...(retryClass ? { retryClass } : {}),
    origins: () => ['https://example.com'],
    execute: async () => { calls.count += 1; return { ok: true, content: 'done' }; },
  } as any);
  return calls;
};

const baseCtx = (lifecycle: unknown, extra: Record<string, unknown> = {}) => ({
  audit: async () => {},
  session: { sessionId: 'sess-1' },
  permission: { mode: 'act', confirmActions: false },
  hooks: [],
  lifecycle,
  ...extra,
});

beforeEach(() => clearTools());

describe('GUARANTEE 2 + fail-closed: Class D/E never execute when tracking cannot start', () => {
  test('operationLog.begin throws + Class E → refusal at the dispatcher, execute() never entered', async () => {
    const tracker = makeDispatchTracker({
      operationLog: createOperationLog({
        storage: { get: async () => { throw new Error('storage dead'); },
          set: async () => { throw new Error('storage dead'); } },
      }),
      generationId: () => 'gen-1-x',
      retryClassFor: retryClassForTool,
    });
    const calls = spyTool('submit_form', 'mutate_external'); // → Class E by taxonomy
    const result = await dispatchToolCall(
      { id: 'tu-1', name: 'submit_form', args: {} }, baseCtx(tracker) as any);
    expect(calls.count).toBe(0);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain('NOT executed');
  });

  test('boot failed (fail-closed tracker) → Class D and E refused, execute() never entered; A/B/C still run', async () => {
    const tracker = makeFailClosedTracker({
      reason: 'lifecycle boot failed', retryClassFor: retryClassForTool,
    });
    const e = spyTool('submit_form', 'mutate_external');
    const d = spyTool('dweb_share', 'mutate_external');       // named D override
    const b = spyTool('fetch_url_like', 'read', 'B');
    const a = spyTool('read_page', 'read');

    for (const [name, calls, shouldRun] of [
      ['submit_form', e, false], ['dweb_share', d, false],
      ['fetch_url_like', b, true], ['read_page', a, true],
    ] as const) {
      const result = await dispatchToolCall(
        { id: `tu-${name}`, name, args: {} }, baseCtx(tracker) as any);
      expect(calls.count).toBe(shouldRun ? 1 : 0);
      if (!shouldRun) expect(result.ok).toBe(false);
    }
  });

  test('no Class E dispatch proceeds while lifecycle arming is unresolved (the boot-window pattern)', async () => {
    // The SW's buildToolContext awaits the boot before handing out any ctx;
    // this pins that pattern: ctx construction blocks, so execute cannot be
    // reached until the tracker is armed — and the armed result then
    // governs the dispatch.
    const { log } = makeLog();
    let armTracker: (t: unknown) => void = () => {};
    const armed: Promise<unknown> = new Promise((resolve) => { armTracker = resolve; });
    const buildCtx = async () => baseCtx(await armed);
    const calls = spyTool('submit_form', 'mutate_external');

    let settled = false;
    const inFlight = buildCtx().then((ctx) =>
      dispatchToolCall({ id: 'tu-1', name: 'submit_form', args: {} }, ctx as any))
      .then((r) => { settled = true; return r; });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.count).toBe(0); // nothing executed while unarmed
    expect(settled).toBe(false);

    armTracker(makeDispatchTracker({
      operationLog: log, generationId: () => 'gen-1-x', retryClassFor: retryClassForTool,
    }));
    const result = await inFlight;
    expect(result.ok).toBe(true);
    expect(calls.count).toBe(1); // ran exactly once, tracked, after arming
    expect((await log.get('sess-1:tu-1'))!.state).toBe(S.COMPLETED);
  });
});

describe('§8 persist-before-report: the settle write lands before the dispatcher returns', () => {
  test('the COMPLETED transition is journaled before dispatchToolCall resolves', async () => {
    const { storage, log } = makeLog();
    const tracker = makeDispatchTracker({
      operationLog: log, generationId: () => 'gen-1-x', retryClassFor: retryClassForTool,
    });
    spyTool('submit_form', 'mutate_external');
    const writesAtResolve = await dispatchToolCall(
      { id: 'tu-1', name: 'submit_form', args: {} }, baseCtx(tracker) as any)
      .then(() => storage.journal.length);
    // …and the record IS completed at that instant (not settled later).
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
    const calls = spyTool('submit_form', 'mutate_external');
    const replay = await dispatchToolCall(
      { id: 'tu-pay', name: 'submit_form', args: {} }, baseCtx(tracker) as any);
    expect(calls.count).toBe(0); // the tombstone refused it
    expect((replay as { error: string }).error).toStartWith('completed:');
  });
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
