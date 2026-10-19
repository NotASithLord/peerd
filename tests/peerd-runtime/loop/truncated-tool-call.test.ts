// runUserTurn: a tool call cut by the output limit (stopReason max_tokens with
// tool_use blocks) never ran, because its arguments are incomplete. The loop
// used to end the turn there with a dangling tool_use (no result, no error, no
// dispatch), which the side panel showed as "running..." forever and the next
// model call could only pair with a generic interruption note. Now each cut
// call gets a not_run result that says why, and the turn continues within the
// same bound as the thinking-only truncation. The bound and a Stop end the
// turn BEFORE the not_run results are appended: a history that ends on tool
// results reads as resumable, and auto-resume would re-drive it.

import { describe, test, expect } from 'bun:test';
import { runUserTurn } from '../../../extension/peerd-runtime/loop/agent-loop.js';
import { detectInterruptedTurn } from '../../../extension/peerd-runtime/loop/resume-detect.js';
import { callLocalWebgpu } from '../../../extension/peerd-provider/adapters/local-webgpu.js';
import { makeModelEgress } from '../../peerd-provider/model-egress-fixture';

type ToolUse = { id: string; name: string; input: Record<string, unknown> };
type ToolResult = { tool_use_id: string; content: string; is_error?: boolean; outcomeKnown?: boolean };
type Msg = {
  id: string;
  role: 'user' | 'assistant';
  content?: string;
  stopReason?: string;
  toolUses?: ToolUse[];
  toolResults?: ToolResult[];
};
type Sess = { sessionId: string; messages: Msg[] };

const makeStore = () => {
  const sessions = new Map<string, Sess>();
  const sessionOf = (id: string) => {
    const s = sessions.get(id);
    if (!s) throw new Error(`no session ${id}`);
    return s;
  };
  return {
    seed(id: string) { sessions.set(id, { sessionId: id, messages: [] }); },
    async get(id: string) { return sessions.get(id) ?? null; },
    async appendMessage(id: string, msg: Msg) {
      const s = sessionOf(id);
      s.messages.push({ ...msg });
      return s;
    },
    async updateAssistantMessage(id: string, msgId: string, patch: Partial<Msg>) {
      const s = sessionOf(id);
      const m = s.messages.find((x) => x.id === msgId);
      if (m) Object.assign(m, patch);
      return s;
    },
  };
};
type Store = ReturnType<typeof makeStore>;

const sessionOf = async (store: Store) => {
  const s = await store.get('s1');
  if (!s) throw new Error('session s1 missing');
  return s;
};

// The output ceiling lands in the middle of the call's JSON arguments.
const cutToolCall = (id: string) => (async function* () {
  yield { type: 'tool-use-start', id, name: 'sandbox_create' };
  yield { type: 'tool-use-delta', id, partialJson: '{"kind":"app","name":"Budget tracker","html":"<!doctype html>' };
  yield { type: 'tool-use-stop', id };
  yield { type: 'message-stop', stopReason: 'max_tokens' };
})();

const textReply = (text: string) => (async function* () {
  yield { type: 'text-delta', text };
  yield { type: 'message-stop', stopReason: 'end_turn' };
})();

// why `as never`: the fake store and model cover only what these turns touch,
// so the ctx is cast once here instead of at every call site.
const baseCtx = (store: Store, extra: Record<string, unknown> = {}) => ({
  sessionId: 's1',
  userText: 'build me a budget tracker app',
  getSecret: async () => 'sk',
  safeFetch: async () => new Response('ok'),
  sessions: store,
  getSystemPrompt: async () => 'sys',
  appendAudit: async () => {},
  tools: [{ name: 'sandbox_create', description: '', schema: { type: 'object' } }],
  ...extra,
}) as never;

const drain = async <T>(gen: AsyncIterable<T>, onEvent?: (ev: T) => void) => {
  const evs: T[] = [];
  for await (const ev of gen) {
    evs.push(ev);
    onEvent?.(ev);
  }
  return evs;
};

const resultsOf = (s: Sess) =>
  s.messages.find((m) => m.role === 'user' && Array.isArray(m.toolResults))?.toolResults;

describe('runUserTurn: a tool call cut by the output limit', () => {
  test('gets a not_run result, is never dispatched, and the turn continues', async () => {
    const store = makeStore();
    store.seed('s1');
    const dispatched: unknown[] = [];
    let calls = 0;
    const events = await drain(runUserTurn(baseCtx(store, {
      callModel: () => {
        calls += 1;
        return calls === 1 ? cutToolCall('t1') : textReply('I will write the app in smaller files.');
      },
      toolDispatch: async (call: unknown) => { dispatched.push(call); return { ok: true, content: 'created' }; },
    })));

    expect(calls).toBe(2);
    expect(dispatched).toEqual([]);
    expect(events.some((e) => e.type === 'error')).toBe(false);

    const s = await sessionOf(store);
    const cut = s.messages.find((m) => m.role === 'assistant' && m.stopReason === 'max_tokens');
    expect(cut?.toolUses).toEqual([{ id: 't1', name: 'sandbox_create', input: {} }]);
    const results = resultsOf(s);
    expect(results).toHaveLength(1);
    expect(results?.[0]).toMatchObject({ tool_use_id: 't1', is_error: true, outcomeKnown: true });
    expect(results?.[0]?.content).toMatch(/^not_run: /);
    expect(results?.[0]?.content).toContain('Split the work into smaller calls');
    expect(s.messages.at(-1)).toMatchObject({
      role: 'assistant', content: 'I will write the app in smaller files.', stopReason: 'end_turn',
    });
    expect(detectInterruptedTurn(s as never).resumable).toBe(false);
  });

  test('every call in a cut batch gets its own not_run result', async () => {
    const store = makeStore();
    store.seed('s1');
    let calls = 0;
    const events = await drain(runUserTurn(baseCtx(store, {
      callModel: () => {
        calls += 1;
        if (calls > 1) return textReply('done');
        return (async function* () {
          yield { type: 'tool-use-start', id: 'a', name: 'sandbox_create' };
          yield { type: 'tool-use-delta', id: 'a', partialJson: '{"kind":"app","name":"one"}' };
          yield { type: 'tool-use-stop', id: 'a' };
          yield { type: 'tool-use-start', id: 'b', name: 'sandbox_create' };
          yield { type: 'tool-use-delta', id: 'b', partialJson: '{"kind":"app","na' };
          yield { type: 'tool-use-stop', id: 'b' };
          yield { type: 'message-stop', stopReason: 'max_tokens' };
        })();
      },
      toolDispatch: async () => { throw new Error('nothing may run'); },
    })));

    expect(calls).toBe(2);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    const results = resultsOf(await sessionOf(store));
    expect(results?.map((r) => r.tool_use_id)).toEqual(['a', 'b']);
    expect(results?.every((r) => r.is_error === true && r.outcomeKnown === true)).toBe(true);
  });

  test('the continue is bounded like the thinking-only truncation', async () => {
    const store = makeStore();
    store.seed('s1');
    let calls = 0;
    const events = await drain(runUserTurn(baseCtx(store, {
      callModel: () => { calls += 1; return cutToolCall(`t${calls}`); },
      toolDispatch: async () => { throw new Error('nothing may run'); },
    })));

    // the first call plus MAX_TRUNCATION_CONTINUES (2) continues, then the turn ends
    expect(calls).toBe(3);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    const s = await sessionOf(store);
    const toolUses = s.messages.filter((m) => m.role === 'assistant').flatMap((m) => m.toolUses ?? []);
    const answered = s.messages.filter((m) => m.role === 'user')
      .flatMap((m) => (m.toolResults ?? []).map((r) => r.tool_use_id));
    expect(toolUses.map((tu) => tu.id)).toEqual(['t1', 't2', 't3']);
    // the last cut call gets no not_run result: the turn ends at the bound
    // BEFORE the append, on the max_tokens assistant message
    expect(answered).toEqual(['t1', 't2']);
    expect(s.messages.at(-1)).toMatchObject({ role: 'assistant', stopReason: 'max_tokens' });
    // a history that ends on tool results reads as resumable, and auto-resume
    // would re-drive the turn past the bound on every chat open
    expect(detectInterruptedTurn(s as never)).toEqual({ resumable: false });
  });

  test('Stop before or after cut results prevents automatic resume', async () => {
    for (const stopAt of ['stream', 'results']) {
      const store = makeStore();
      store.seed('s1');
      const ac = new AbortController();
      let calls = 0;
      const events = await drain(runUserTurn(baseCtx(store, {
        signal: ac.signal,
        callModel: () => { calls += 1; return cutToolCall(`t${calls}`); },
        toolDispatch: async () => { throw new Error('nothing may run'); },
      })), (ev) => {
        const last = ev.type === 'state' ? ev.session.messages.at(-1) : null;
        if ((stopAt === 'stream' && ev.type === 'stop' && ev.stopReason === 'max_tokens')
          || (stopAt === 'results' && last?.role === 'user' && last.toolResults?.length)) ac.abort();
      });

      expect(calls).toBe(1);
      expect(events.at(-1)).toMatchObject({ type: 'stop', stopReason: 'aborted' });
      const s = await sessionOf(store);
      if (stopAt === 'stream') expect(resultsOf(s)).toBeUndefined();
      else expect(resultsOf(s)).toHaveLength(1);
      expect(s.messages.find((message) => message.role === 'assistant')).toMatchObject({
        stopReason: 'aborted', toolUses: [{ id: 't1', name: 'sandbox_create', input: {} }],
      });
      expect(detectInterruptedTurn(s as never)).toEqual({ resumable: false });
    }
  });
});

test('runUserTurn dispatches a parsed Local WebGPU call and completes the turn', async () => {
  const store = makeStore();
  store.seed('s1');
  const dispatched: unknown[] = [];
  let calls = 0;
  const modelEgress = makeModelEgress({ generateLocal: () => (async function* () {
    calls += 1;
    yield calls === 1
      ? '<tool_call>{"name":"sandbox_create","arguments":{"kind":"app","name":"Budget tracker"}}</tool_call>'
      : 'The app is ready.';
  })() });
  const events = await drain(runUserTurn(baseCtx(store, {
    callModel: (args: Parameters<typeof callLocalWebgpu>[0]) => callLocalWebgpu({ ...args, modelEgress }),
    toolDispatch: async (call: unknown) => { dispatched.push(call); return { ok: true, content: 'created' }; },
  })));
  expect(dispatched).toEqual([{ id: 'local-1', name: 'sandbox_create', args: { kind: 'app', name: 'Budget tracker' } }]);
  expect(calls).toBe(2);
  expect(events.some((event) => event.type === 'error')).toBe(false);
  expect((await sessionOf(store)).messages.at(-1)).toMatchObject({
    role: 'assistant', content: 'The app is ready.', stopReason: 'end_turn',
  });
});
