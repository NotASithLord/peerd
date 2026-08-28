// runUserTurn concurrent tool dispatch — the loop-level half of the
// scheduler (partitionToolBatch has its own unit tests).
//
// What must hold:
//   - with an injected classifyToolCall, consecutive READ-class calls run
//     CONCURRENTLY (both dispatches in flight at once);
//   - persisted tool_result blocks keep the model's emitted order even
//     when completion order differs;
//   - any call whose verdict says confirm:true is NEVER raced (serialized
//     confirms — stacked modals are a UX failure);
//   - writes are barriers: a read emitted after a write waits for it;
//   - without a classifier, dispatch fails closed to serial execution.

import { describe, test, expect } from 'bun:test';
import { runUserTurn } from '../../../extension/peerd-runtime/loop/agent-loop.js';
import { dispatchToolCall } from '../../../extension/peerd-runtime/tools/local-tool-dispatcher.js';
import { registerTool, clearTools } from '../../../extension/peerd-runtime/tools/registry.js';
import { detectInterruptedTurn } from '../../../extension/peerd-runtime/loop/resume-detect.js';
import { INITIAL_STATE, reduceChat } from '../../../extension/sidepanel/chat-reducer.js';

// ---- harness ----------------------------------------------------------------

const makeStore = () => {
  const sessions = new Map<string, any>();
  return {
    seed(id: string) { sessions.set(id, { sessionId: id, messages: [] }); },
    async get(id: string) { return sessions.get(id) ?? null; },
    async appendMessage(id: string, msg: any) {
      const s = sessions.get(id);
      s.messages.push({ ...msg });
      return s;
    },
    async updateAssistantMessage(id: string, msgId: string, patch: any) {
      const s = sessions.get(id);
      const m = s.messages.find((x: any) => x.id === msgId);
      if (m) Object.assign(m, patch);
      return s;
    },
  };
};

// A model that emits the given tool_use calls on step 1 and plain text on
// step 2 (so the loop terminates).
const makeToolModel = (calls: Array<{ id: string; name: string; args?: Record<string, unknown> }>) => {
  let step = 0;
  return () => {
    step += 1;
    if (step === 1) {
      return (async function* () {
        for (const c of calls) {
          yield { type: 'tool-use-start', id: c.id, name: c.name };
          yield { type: 'tool-use-delta', id: c.id, partialJson: JSON.stringify(c.args ?? {}) };
          yield { type: 'tool-use-stop', id: c.id };
        }
        yield { type: 'message-stop', stopReason: 'tool_use' };
      })();
    }
    return (async function* () {
      yield { type: 'text-delta', text: 'done' };
      yield { type: 'message-stop', stopReason: 'end_turn' };
    })();
  };
};

const baseCtx = (store: any, extra: any = {}) => ({
  sessionId: 's1',
  userText: 'go',
  getSecret: async () => 'sk',
  safeFetch: async () => new Response('ok'),
  sessions: store,
  getSystemPrompt: async () => 'sys',
  appendAudit: async () => {},
  ...extra,
});

const drain = async (gen: AsyncGenerator<any>) => {
  const evs: any[] = [];
  for await (const ev of gen) evs.push(ev);
  return evs;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Verdict factories mirroring decideAction's shape.
const READ_VERDICT = { allowed: true, confirm: false, actionClass: 'read', reason: 'read-only action' };
const WRITE_VERDICT = { allowed: true, confirm: false, actionClass: 'external', reason: 'confirmations off: runs without asking' };
const CONFIRM_VERDICT = { allowed: true, confirm: true, actionClass: 'external', reason: 'confirmations on: confirms external' };

describe('runUserTurn — concurrent tool dispatch', () => {
  test('consecutive READ-class calls run concurrently; persisted order stays emitted order', async () => {
    const store = makeStore();
    store.seed('s1');
    const calls = [{ id: 't_a', name: 'read_a' }, { id: 't_b', name: 'read_b' }];

    const started: string[] = [];
    const ctx = baseCtx(store, {
      callModel: makeToolModel(calls),
      tools: [{ name: 'read_a', description: '', schema: {} }, { name: 'read_b', description: '', schema: {} }],
      classifyToolCall: () => READ_VERDICT,
      toolDispatch: async (call: any) => {
        started.push(call.name);
        if (call.name === 'read_a') {
          // a finishes only after BOTH dispatches started — if scheduling
          // were serial, b would never start and this would deadlock, so
          // guard with a deadline that fails the assertions cleanly (the
          // thrown error becomes a's error block, and `started` stays
          // length 1, failing the expectation below).
          await Promise.race([
            (async () => { while (started.length < 2) await sleep(5); })(),
            sleep(1500).then(() => { throw new Error('serialized: b never started'); }),
          ]);
        }
        return { ok: true, content: `${call.name}-result`, meta: {} };
      },
    });

    const events = await drain(runUserTurn(ctx));

    // Both dispatches were in flight together.
    expect(started).toEqual(['read_a', 'read_b']);

    // tool-result events land in COMPLETION order (b first — a was gated).
    const resultEvents = events.filter((e) => e.type === 'tool-result').map((e) => e.toolUseId);
    expect(resultEvents).toEqual(['t_b', 't_a']);

    // Persisted blocks keep the model's EMITTED order regardless.
    const s = await store.get('s1');
    const resultMsg = s.messages.find((m: any) => Array.isArray(m.toolResults));
    expect(resultMsg.toolResults.map((b: any) => b.tool_use_id)).toEqual(['t_a', 't_b']);
    expect(resultMsg.toolResults.map((b: any) => b.is_error)).toEqual([false, false]);
  });

  test('tool-use events for a concurrent wave are all announced BEFORE any result', async () => {
    const store = makeStore();
    store.seed('s1');
    const calls = [{ id: 't_a', name: 'read_a' }, { id: 't_b', name: 'read_b' }];
    const ctx = baseCtx(store, {
      callModel: makeToolModel(calls),
      tools: [{ name: 'read_a', description: '', schema: {} }, { name: 'read_b', description: '', schema: {} }],
      classifyToolCall: () => READ_VERDICT,
      toolDispatch: async (call: any) => ({ ok: true, content: call.name, meta: {} }),
    });
    const events = await drain(runUserTurn(ctx));
    const seq = events
      .filter((e) => e.type === 'tool-use' || e.type === 'tool-result')
      .map((e) => `${e.type}:${e.toolUseId}`);
    expect(seq.slice(0, 2)).toEqual(['tool-use:t_a', 'tool-use:t_b']);
    expect(seq.length).toBe(4);
  });

  test('persists singular and batched actor delivery custody on tool results', async () => {
    const store = makeStore();
    store.seed('s1');
    const ctx = baseCtx(store, {
      callModel: makeToolModel([{ id: 't_script', name: 'script' }]),
      tools: [{ name: 'script', description: '', schema: {} }],
      classifyToolCall: () => WRITE_VERDICT,
      toolDispatch: async () => ({
        ok: true,
        content: 'done',
        meta: {},
        actorDeliveryId: 'delivery-one',
        actorDeliveryIds: ['delivery-two', 'delivery-two', ''],
        actorCorrelationId: 'correlation-one',
        actorTerminal: true,
        actorOutcomeKnown: false,
        actorPerformed: true,
        actorAborted: true,
      }),
    });

    await drain(runUserTurn(ctx));
    const session = await store.get('s1');
    const block = session.messages.find((m: any) => Array.isArray(m.toolResults))
      .toolResults[0];
    expect(block.actorDeliveryId).toBe('delivery-one');
    expect(block.actorDeliveryIds).toEqual(['delivery-two']);
    expect(block.actorCorrelationId).toBe('correlation-one');
    expect(block.actorTerminal).toBe(true);
    expect(block.actorOutcomeKnown).toBe(false);
    expect(block.actorPerformed).toBe(true);
    expect(block.actorAborted).toBe(true);
  });

  test('outer actor uncertainty survives dispatcher, persistence, and reducer replay', async () => {
    clearTools();
    registerTool({
      name: 'message_actor', description: '', primitive: 'spawned', sideEffect: 'write',
      schema: { type: 'object', properties: {} },
      origins: () => [],
      execute: async () => ({
        ok: false,
        error: 'inner policy stop',
        actorCorrelationId: 'correlation-outer-unknown',
        actorTerminal: true,
        actorOutcomeKnown: true,
        actorPerformed: true,
        actorAborted: true,
      }),
    } as any);
    try {
      const lifecycle = {
        beginTracking: async () => ({ handle: { operationId: 'op-outer-unknown' } }),
        settleTracking: async () => ({
          error: 'outcome_unknown: This action may have completed, but peerd did not receive confirmation.',
          recovery: { state: 'outcome_unknown', category: 'verify_before_retry' },
        }),
      };
      const dispatchCtx: any = {
        audit: async () => {},
        confirm: async () => 'yes_once',
        session: { sessionId: 's1', kind: 'chat' },
        permission: { mode: 'act', confirmActions: false },
        lifecycle,
      };
      const store = makeStore();
      store.seed('s1');
      const loopCtx = baseCtx(store, {
        callModel: makeToolModel([{
          id: 'actor-unknown', name: 'message_actor', args: { to: 'web', await: true },
        }]),
        tools: [{ name: 'message_actor', description: '', schema: {} }],
        classifyToolCall: () => WRITE_VERDICT,
        toolDispatch: (call: any) => dispatchToolCall(call, dispatchCtx),
      });

      await expect(drain(runUserTurn(loopCtx))).rejects.toMatchObject({
        code: 'tool-outcome-unknown', outcomeKnown: false, retryable: false,
      });
      const session = await store.get('s1');
      const block = session.messages.find((m: any) => Array.isArray(m.toolResults)).toolResults[0];
      expect(block.content).toStartWith('outcome_unknown:');
      expect(block).toMatchObject({
        is_error: true,
        actorCorrelationId: 'correlation-outer-unknown',
        actorTerminal: true,
        actorOutcomeKnown: false,
        actorPerformed: true,
      });
      expect(block.actorAborted).toBeUndefined();

      const viewing: any = {
        ...INITIAL_STATE,
        session: { sessionId: 's1', messages: [], cost: null },
      };
      const started: any = reduceChat(viewing, {
        type: 'turn/actor-start', rootSessionId: 's1', parentToolUseId: 'actor-unknown',
        sessionId: 'actor-web', fromIndex: 0, kind: 'web', instanceId: 'web',
      });
      const replayed: any = reduceChat(started, { type: 'turn/state', session });
      expect(replayed.actors['actor-unknown']).toMatchObject({
        streaming: false,
        aborted: false,
        outcomeKnown: false,
        performed: true,
        error: 'the actor turn ended with an unknown outcome',
      });
    } finally {
      clearTools();
    }
  });

  test('a write is a barrier: [read, write, read] runs strictly in order', async () => {
    const store = makeStore();
    store.seed('s1');
    const calls = [
      { id: 't_r1', name: 'read_a' },
      { id: 't_w', name: 'click' },
      { id: 't_r2', name: 'read_b' },
    ];
    const log: string[] = [];
    const ctx = baseCtx(store, {
      callModel: makeToolModel(calls),
      tools: calls.map((c) => ({ name: c.name, description: '', schema: {} })),
      classifyToolCall: (name: string) => (name.startsWith('read') ? READ_VERDICT : WRITE_VERDICT),
      toolDispatch: async (call: any) => {
        log.push(`start:${call.name}`);
        await sleep(10);
        log.push(`end:${call.name}`);
        return { ok: true, content: 'r', meta: {} };
      },
    });
    await drain(runUserTurn(ctx));
    expect(log).toEqual([
      'start:read_a', 'end:read_a',
      'start:click', 'end:click',
      'start:read_b', 'end:read_b',
    ]);
  });

  test('confirm-gated calls are NEVER raced', async () => {
    const store = makeStore();
    store.seed('s1');
    const calls = [{ id: 't_1', name: 'actor_create' }, { id: 't_2', name: 'actor_create' }];
    const log: string[] = [];
    const ctx = baseCtx(store, {
      callModel: makeToolModel(calls),
      tools: [{ name: 'actor_create', description: '', schema: {} }],
      // confirmations on: the spawn would confirm → must not race another.
      classifyToolCall: () => CONFIRM_VERDICT,
      toolDispatch: async (call: any) => {
        log.push(`start:${call.id}`);
        await sleep(10);
        log.push(`end:${call.id}`);
        return { ok: true, content: 'r', meta: {} };
      },
    });
    await drain(runUserTurn(ctx));
    expect(log).toEqual(['start:t_1', 'end:t_1', 'start:t_2', 'end:t_2']);
  });

  test('no classifier injected: every tool stays serial', async () => {
    const store = makeStore();
    store.seed('s1');
    // A tool name cannot grant itself concurrency without semantic policy.
    const spawnCalls = [{ id: 't_1', name: 'actor_create' }, { id: 't_2', name: 'actor_create' }];
    const log: string[] = [];
    const ctx = baseCtx(store, {
      callModel: makeToolModel(spawnCalls),
      tools: [{ name: 'actor_create', description: '', schema: {} }],
      toolDispatch: async (call: any) => {
        log.push(`start:${call.id}`);
        await sleep(5);
        log.push(`end:${call.id}`);
        return { ok: true, content: 'r', meta: {} };
      },
    });
    await drain(runUserTurn(ctx));
    expect(log).toEqual(['start:t_1', 'end:t_1', 'start:t_2', 'end:t_2']);

    // Unknown names are equally serial.
    const store2 = makeStore();
    store2.seed('s1');
    const unknownLog: string[] = [];
    const ctx2 = baseCtx(store2, {
      callModel: makeToolModel([{ id: 'u_1', name: 'a' }, { id: 'u_2', name: 'b' }]),
      tools: [{ name: 'a', description: '', schema: {} }, { name: 'b', description: '', schema: {} }],
      toolDispatch: async (call: any) => {
        unknownLog.push(`start:${call.name}`);
        await sleep(5);
        unknownLog.push(`end:${call.name}`);
        return { ok: true, content: 'r', meta: {} };
      },
    });
    await drain(runUserTurn(ctx2));
    expect(unknownLog).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
  });

  test('Stop after a known ToolResult halts later waves and conservatively persists custody', async () => {
    const store = makeStore();
    store.seed('s1');
    // Three writes → three sequential waves (writes are barriers).
    const calls = [
      { id: 't_w1', name: 'click' },
      { id: 't_w2', name: 'click' },
      { id: 't_w3', name: 'click' },
    ];
    const dispatched: string[] = [];
    const ac = new AbortController();
    const ctx = baseCtx(store, {
      callModel: makeToolModel(calls),
      tools: calls.map((c) => ({ name: c.name, description: '', schema: {} })),
      classifyToolCall: () => WRITE_VERDICT, // confirmations off → each write just runs
      signal: ac.signal,
      toolDispatch: async (call: any) => {
        dispatched.push(call.id);
        return { ok: true, content: 'r', meta: {} };
      },
    });

    const events: any[] = [];
    let failure: any = null;
    try {
      for await (const event of runUserTurn(ctx)) {
        events.push(event);
        if (event.type === 'tool-result' && event.toolUseId === 't_w1') ac.abort();
      }
    } catch (cause) { failure = cause; }

    // waves 2 + 3 must NOT have dispatched their side effects after Stop.
    expect(dispatched).toEqual(['t_w1']);
    expect(failure).toMatchObject({
      code: 'tool-outcome-unknown', outcomeKnown: false, retryable: false,
    });
    const s = await store.get('s1');
    expect(s.messages.some((m: any) => Array.isArray(m.toolResults))).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error', code: 'tool-outcome-unknown',
      outcomeKnown: false, retryable: false,
    }));
    expect(s.messages.at(-1)).toMatchObject({
      errorCode: 'tool-outcome-unknown', outcomeKnown: false, retryable: false,
    });
    expect(detectInterruptedTurn(s).resumable).toBe(false);
  });

  test('Stop before the first tool dispatch remains an ordinary abort', async () => {
    const store = makeStore();
    store.seed('s1');
    const ac = new AbortController();
    let dispatches = 0;
    const events: any[] = [];
    for await (const event of runUserTurn(baseCtx(store, {
      callModel: makeToolModel([{ id: 't_w1', name: 'click' }]),
      tools: [{ name: 'click', description: '', schema: {} }],
      classifyToolCall: () => WRITE_VERDICT,
      signal: ac.signal,
      toolDispatch: async () => { dispatches += 1; return { ok: true, content: 'r' }; },
    }))) {
      events.push(event);
      if (event.type === 'stop' && event.stopReason === 'tool_use') ac.abort();
    }
    const session = await store.get('s1');
    expect(dispatches).toBe(0);
    expect(events.at(-1)).toMatchObject({ type: 'stop', stopReason: 'aborted' });
    expect(session.messages.at(-1)).toMatchObject({ streaming: false, stopReason: 'aborted' });
    expect(session.messages.at(-1).outcomeKnown).toBeUndefined();
  });

  test('Stop during an admitted tool persists non-retryable unknown custody', async () => {
    const store = makeStore();
    store.seed('s1');
    const ac = new AbortController();
    let started = () => {};
    let release = () => {};
    const admitted = new Promise<void>((resolve) => { started = resolve; });
    const ctx = baseCtx(store, {
      callModel: makeToolModel([{ id: 't_w1', name: 'click' }]),
      tools: [{ name: 'click', description: '', schema: {} }],
      classifyToolCall: () => WRITE_VERDICT,
      signal: ac.signal,
      toolDispatch: () => new Promise((resolve) => {
        release = () => resolve({ ok: true, content: 'RAW LATE EFFECT', meta: {} });
        started();
      }),
    });

    const events: any[] = [];
    const running = (async () => {
      try {
        for await (const event of runUserTurn(ctx)) events.push(event);
        return { ok: true as const, error: null };
      } catch (error) {
        return { ok: false as const, error };
      }
    })();
    await admitted;
    ac.abort();
    const settlement = await running;
    release();

    const s = await store.get('s1');
    expect(s.messages.some((m: any) => Array.isArray(m.toolResults))).toBe(false);
    expect(settlement).toMatchObject({
      ok: false,
      error: { code: 'tool-outcome-unknown', outcomeKnown: false, retryable: false },
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error', code: 'tool-outcome-unknown',
      outcomeKnown: false, retryable: false,
      error: expect.stringContaining('outcome unknown'),
    }));
    expect(JSON.stringify(events)).not.toContain('RAW LATE EFFECT');
    expect(s.messages.at(-1)).toMatchObject({
      role: 'assistant', streaming: false,
      errorCode: 'tool-outcome-unknown', outcomeKnown: false, retryable: false,
      error: expect.stringContaining('outcome unknown'),
    });
    expect(s.messages.at(-1).stopReason).not.toBe('aborted');
    expect(detectInterruptedTurn(s).resumable).toBe(false);
  });

  test('a failure with authored content renders `code: content`; without content, the code alone', async () => {
    const store = makeStore();
    store.seed('s1');
    const calls = [{ id: 't_a', name: 'a' }, { id: 't_b', name: 'b' }];
    const ctx = baseCtx(store, {
      callModel: makeToolModel(calls),
      tools: [{ name: 'a', description: '', schema: {} }, { name: 'b', description: '', schema: {} }],
      classifyToolCall: () => WRITE_VERDICT,
      toolDispatch: async (call: any) => (call.name === 'a'
        // authored human explanation alongside the machine code
        ? { ok: false, error: 'declined', content: 'User declined the outbound write.', meta: {} }
        // failure carrying only a code
        : { ok: false, error: 'not_found', meta: {} }),
    });
    await drain(runUserTurn(ctx));
    const s = await store.get('s1');
    const resultMsg = s.messages.find((m: any) => Array.isArray(m.toolResults));
    expect(resultMsg.toolResults[0].content).toBe('declined: User declined the outbound write.');
    expect(resultMsg.toolResults[0].is_error).toBe(true);
    expect(resultMsg.toolResults[1].content).toBe('not_found');
    expect(resultMsg.toolResults[1].is_error).toBe(true);
  });

  test('a hung dispatch synthesizes an aborted tool_failed audit on Stop', async () => {
    const store = makeStore();
    store.seed('s1');
    const audited: any[] = [];
    const ac = new AbortController();
    const ctx = baseCtx(store, {
      callModel: makeToolModel([{ id: 't_w1', name: 'click' }]),
      tools: [{ name: 'click', description: '', schema: {} }],
      classifyToolCall: () => WRITE_VERDICT,
      signal: ac.signal,
      appendAudit: async (e: any) => { audited.push(e); },
      // never settles — the abort is the only thing that ends the dispatch
      toolDispatch: () => { ac.abort(); return new Promise(() => {}); },
    });
    await expect(drain(runUserTurn(ctx))).rejects.toMatchObject({
      code: 'tool-outcome-unknown', outcomeKnown: false, retryable: false,
    });
    const failed = audited.find((e) => e.type === 'tool_failed');
    expect(failed).toBeTruthy();
    expect(failed.details.tool).toBe('click');
    expect(failed.details.kind).toBe('aborted');
  });

  test('one failing sibling in a concurrent wave becomes its own error block, not a batch failure', async () => {
    const store = makeStore();
    store.seed('s1');
    const calls = [{ id: 't_a', name: 'read_a' }, { id: 't_b', name: 'read_b' }];
    const ctx = baseCtx(store, {
      callModel: makeToolModel(calls),
      tools: [{ name: 'read_a', description: '', schema: {} }, { name: 'read_b', description: '', schema: {} }],
      classifyToolCall: () => READ_VERDICT,
      toolDispatch: async (call: any) => {
        if (call.name === 'read_a') throw new Error('boom');
        return { ok: true, content: 'fine', meta: {} };
      },
    });
    await drain(runUserTurn(ctx));
    const s = await store.get('s1');
    const resultMsg = s.messages.find((m: any) => Array.isArray(m.toolResults));
    expect(resultMsg.toolResults.map((b: any) => b.tool_use_id)).toEqual(['t_a', 't_b']);
    expect(resultMsg.toolResults[0].is_error).toBe(true);
    expect(resultMsg.toolResults[0].content).toContain('boom');
    expect(resultMsg.toolResults[1].is_error).toBe(false);
  });
});
