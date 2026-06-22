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
//   - without a classifier, only spawn_subagent keeps its parallel path.

import { describe, test, expect } from 'bun:test';
import { runUserTurn } from '../../../extension/peerd-runtime/loop/agent-loop.js';

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
const makeToolModel = (calls: Array<{ id: string; name: string }>) => {
  let step = 0;
  return () => {
    step += 1;
    if (step === 1) {
      return (async function* () {
        for (const c of calls) {
          yield { type: 'tool-use-start', id: c.id, name: c.name };
          yield { type: 'tool-use-delta', id: c.id, partialJson: '{}' };
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

  test('confirm-gated calls are NEVER raced — even spawn_subagent serializes its confirms', async () => {
    const store = makeStore();
    store.seed('s1');
    const calls = [{ id: 't_1', name: 'spawn_subagent' }, { id: 't_2', name: 'spawn_subagent' }];
    const log: string[] = [];
    const ctx = baseCtx(store, {
      callModel: makeToolModel(calls),
      tools: [{ name: 'spawn_subagent', description: '', schema: {} }],
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

  test('no classifier injected: spawn_subagent keeps its parallel path, other tools stay serial', async () => {
    const store = makeStore();
    store.seed('s1');
    // Two spawns → concurrent (the pre-existing behavior).
    const spawnCalls = [{ id: 't_1', name: 'spawn_subagent' }, { id: 't_2', name: 'spawn_subagent' }];
    const started: string[] = [];
    const ctx = baseCtx(store, {
      callModel: makeToolModel(spawnCalls),
      tools: [{ name: 'spawn_subagent', description: '', schema: {} }],
      toolDispatch: async (call: any) => {
        started.push(call.id);
        if (call.id === 't_1') {
          await Promise.race([
            (async () => { while (started.length < 2) await sleep(5); })(),
            sleep(1500).then(() => { throw new Error('serialized: second spawn never started'); }),
          ]);
        }
        return { ok: true, content: 'r', meta: {} };
      },
    });
    await drain(runUserTurn(ctx));
    expect(started).toEqual(['t_1', 't_2']);

    // Two unknown tools → serial (no classifier, not in CONCURRENT_TOOLS).
    const store2 = makeStore();
    store2.seed('s1');
    const log: string[] = [];
    const ctx2 = baseCtx(store2, {
      callModel: makeToolModel([{ id: 'u_1', name: 'a' }, { id: 'u_2', name: 'b' }]),
      tools: [{ name: 'a', description: '', schema: {} }, { name: 'b', description: '', schema: {} }],
      toolDispatch: async (call: any) => {
        log.push(`start:${call.name}`);
        await sleep(5);
        log.push(`end:${call.name}`);
        return { ok: true, content: 'r', meta: {} };
      },
    });
    await drain(runUserTurn(ctx2));
    expect(log).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
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
