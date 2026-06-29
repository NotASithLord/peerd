// runUserTurn one-shot mode (message_actor oneShot) — after the FIRST clean
// tool round the loop synthesizes the reply from the tool result and stops,
// skipping the second "summarize" model call. An errored round falls through to
// a normal turn so the model can recover. Off (default) behaves as before.

import { describe, test, expect } from 'bun:test';
import { runUserTurn } from '../../../extension/peerd-runtime/loop/agent-loop.js';

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

// Step 1 → one tool call; step 2+ → plain text 'summary'. `calls` counts how
// many times the model was invoked, so a one-shot turn proves it stopped at 1.
const makeCountingModel = (toolName = 'vm_boot') => {
  const state = { calls: 0 };
  const model = () => {
    state.calls += 1;
    if (state.calls === 1) {
      return (async function* () {
        yield { type: 'tool-use-start', id: 't1', name: toolName };
        yield { type: 'tool-use-delta', id: 't1', partialJson: '{}' };
        yield { type: 'tool-use-stop', id: 't1' };
        yield { type: 'message-stop', stopReason: 'tool_use' };
      })();
    }
    return (async function* () {
      yield { type: 'text-delta', text: 'summary' };
      yield { type: 'message-stop', stopReason: 'end_turn' };
    })();
  };
  return { model, state };
};

const baseCtx = (store: any, extra: any = {}) => ({
  sessionId: 's1',
  userText: 'compute the thing',
  getSecret: async () => 'sk',
  safeFetch: async () => new Response('ok'),
  sessions: store,
  getSystemPrompt: async () => 'sys',
  appendAudit: async () => {},
  tools: [{ name: 'vm_boot', description: '', schema: {} }],
  ...extra,
});

const drain = async (gen: AsyncGenerator<any>) => {
  const evs: any[] = [];
  for await (const ev of gen) evs.push(ev);
  return evs;
};

describe('runUserTurn — one-shot', () => {
  test('stops after the first clean tool round; reply IS the tool result; no 2nd model call', async () => {
    const store = makeStore();
    store.seed('s1');
    const { model, state } = makeCountingModel();
    const ctx = baseCtx(store, {
      callModel: model,
      oneShot: true,
      toolDispatch: async () => ({ ok: true, content: '5050', meta: {} }),
    });

    const events = await drain(runUserTurn(ctx));

    // The summarize inference NEVER ran.
    expect(state.calls).toBe(1);

    const s = await store.get('s1');
    const last = s.messages[s.messages.length - 1];
    expect(last.role).toBe('assistant');
    expect(last.content).toBe('5050');          // synthesized from the tool result
    expect(last.stopReason).toBe('one_shot');
    // and the model's step-2 text ('summary') never made it into the transcript.
    expect(s.messages.some((m: any) => m.content === 'summary')).toBe(false);
    // a terminal stop event was emitted for the synthetic reply.
    expect(events.filter((e) => e.type === 'stop').at(-1)?.stopReason).toBe('one_shot');
  });

  test('joins multiple tool results into the one-shot reply', async () => {
    const store = makeStore();
    store.seed('s1');
    // two tool calls in the single round
    let calls = 0;
    const model = () => {
      calls += 1;
      if (calls === 1) {
        return (async function* () {
          for (const id of ['a', 'b']) {
            yield { type: 'tool-use-start', id, name: 'vm_boot' };
            yield { type: 'tool-use-delta', id, partialJson: '{}' };
            yield { type: 'tool-use-stop', id };
          }
          yield { type: 'message-stop', stopReason: 'tool_use' };
        })();
      }
      return (async function* () { yield { type: 'message-stop', stopReason: 'end_turn' }; })();
    };
    const ctx = baseCtx(store, {
      callModel: model,
      oneShot: true,
      toolDispatch: async (call: any) => ({ ok: true, content: `out-${call.id}`, meta: {} }),
    });
    await drain(runUserTurn(ctx));
    const s = await store.get('s1');
    const last = s.messages[s.messages.length - 1];
    expect(last.content).toBe('out-a\nout-b');
    expect(calls).toBe(1);
  });

  test('an errored first tool FALLS THROUGH to a normal turn (recovery)', async () => {
    const store = makeStore();
    store.seed('s1');
    const { model, state } = makeCountingModel();
    const ctx = baseCtx(store, {
      callModel: model,
      oneShot: true,
      toolDispatch: async () => { throw new Error('boom'); },
    });
    await drain(runUserTurn(ctx));

    // one round did NOT suffice → the model got its normal second turn.
    expect(state.calls).toBe(2);
    const s = await store.get('s1');
    const last = s.messages[s.messages.length - 1];
    expect(last.role).toBe('assistant');
    expect(last.content).toBe('summary');               // the recovery turn's text
    expect(s.messages.some((m: any) => m.stopReason === 'one_shot')).toBe(false);
  });

  test('without oneShot (default) the loop runs the full turn — summarize inference happens', async () => {
    const store = makeStore();
    store.seed('s1');
    const { model, state } = makeCountingModel();
    const ctx = baseCtx(store, {
      callModel: model,
      toolDispatch: async () => ({ ok: true, content: '5050', meta: {} }),
    });
    await drain(runUserTurn(ctx));
    expect(state.calls).toBe(2);
    const s = await store.get('s1');
    expect(s.messages[s.messages.length - 1].content).toBe('summary');
    expect(s.messages.some((m: any) => m.stopReason === 'one_shot')).toBe(false);
  });
});
