// runUserTurn × planTrim integration: when the history trim fires, the
// loop (a) persists the rolling state via sessions.setTrimSummary
// BEFORE streaming, (b) fires the enrichTrimSummary seam exactly once
// per fold (fire-and-forget), and (c) sends the model the trimmed
// history opening on the synthesised summary. A store without
// setTrimSummary — and a throwing enrichment seam — must not break the
// turn.

import { describe, test, expect } from 'bun:test';
import { runUserTurn } from '../../../extension/peerd-runtime/loop/agent-loop.js';

const makeStore = (opts: { withSetTrimSummary?: boolean } = {}) => {
  const sessions = new Map<string, any>();
  const trimWrites: any[] = [];
  const store: any = {
    trimWrites,
    seed(id: string, messages: any[] = [], extra: any = {}) {
      sessions.set(id, { sessionId: id, messages, ...extra });
    },
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
  if (opts.withSetTrimSummary !== false) {
    store.setTrimSummary = async (id: string, state: any) => {
      trimWrites.push({ id, state });
      const s = sessions.get(id);
      s.trimSummary = state;
      return s;
    };
  }
  return store;
};

// A long pre-existing history so the very first model call trims.
const longHistory = (n: number) => Array.from({ length: n }, (_, i) => (
  i % 2 === 0
    ? { role: 'user', content: `u${i}`, id: `u${i}`, when: i }
    : { role: 'assistant', content: `a${i}`, id: `a${i}`, when: i }
));

async function* fakeModel() {
  yield { type: 'text-delta', text: 'ok' };
  yield { type: 'message-stop', stopReason: 'end_turn' };
}

const drain = async (gen: AsyncGenerator<any>) => {
  const evs = [];
  for await (const ev of gen) evs.push(ev);
  return evs;
};

const baseCtx = (store: any, extra: any = {}) => ({
  sessionId: 's1',
  userText: 'next question',
  getSecret: async () => 'sk',
  safeFetch: async () => new Response('ok'),
  sessions: store,
  getSystemPrompt: async () => 'sys',
  appendAudit: async () => {},
  ...extra,
});

describe('runUserTurn trim integration', () => {
  test('over-cap history: state persists before streaming, seam fires once, model sees the summary', async () => {
    const store = makeStore();
    store.seed('s1', longHistory(80));
    const enrichCalls: any[] = [];
    let sentMessages: any[] | null = null;
    await drain(runUserTurn(baseCtx(store, {
      callModel: ({ messages }: any) => { sentMessages = messages; return fakeModel(); },
      enrichTrimSummary: (req: any) => enrichCalls.push(req),
    })));

    // State persisted with the fold of the dropped prefix.
    expect(store.trimWrites.length).toBe(1);
    expect(store.trimWrites[0].state.covered).toBeGreaterThan(0);
    // Enrichment seam fired once, with the newly dropped slice.
    expect(enrichCalls.length).toBe(1);
    expect(enrichCalls[0].sessionId).toBe('s1');
    expect(enrichCalls[0].newlyDropped.length).toBe(store.trimWrites[0].state.covered);
    // The model got the trimmed view, opening on the synthetic summary.
    expect(sentMessages![0].synthetic).toBe(true);
    expect(sentMessages![0].content).toContain('<conversation_trim_summary>');
    // The PERSISTED history is untouched (trim affects only what's sent).
    const s = await store.get('s1');
    expect(s.messages.filter((m: any) => m.synthetic).length).toBe(0);
  });

  test('persisted prior state rolls forward instead of refolding blind', async () => {
    const store = makeStore();
    // First turn established a state covering 60; session has grown.
    const history = longHistory(90);
    store.seed('s1', history);
    let sent: any[] | null = null;
    await drain(runUserTurn(baseCtx(store, {
      callModel: ({ messages }: any) => { sent = messages; return fakeModel(); },
    })));
    const firstState = store.trimWrites[0].state;

    // Next turn: more messages appended; prior state on the record.
    const s = await store.get('s1');
    for (const m of longHistory(10)) s.messages.push({ ...m, id: `x${m.id}`, when: 100 + m.when });
    await drain(runUserTurn(baseCtx(store, {
      callModel: ({ messages }: any) => { sent = messages; return fakeModel(); },
    })));
    const secondState = store.trimWrites[1].state;
    expect(secondState.covered).toBeGreaterThan(firstState.covered);
    // Counts rolled, not restarted.
    expect(secondState.users).toBeGreaterThan(firstState.users);
    expect(sent![0].content).toContain(`${secondState.covered} earlier messages elided`);
  });

  test('store without setTrimSummary and a throwing seam still complete the turn', async () => {
    const store = makeStore({ withSetTrimSummary: false });
    store.seed('s1', longHistory(80));
    const evs = await drain(runUserTurn(baseCtx(store, {
      callModel: () => fakeModel(),
      enrichTrimSummary: () => { throw new Error('seam exploded'); },
    })));
    const stop = evs.find((e) => e.type === 'stop');
    expect(stop?.stopReason).toBe('end_turn');
    expect(evs.some((e) => e.type === 'error')).toBe(false);
  });

  test('under the cap: no trim writes, no seam calls', async () => {
    const store = makeStore();
    store.seed('s1', longHistory(10));
    const enrichCalls: any[] = [];
    await drain(runUserTurn(baseCtx(store, {
      callModel: () => fakeModel(),
      enrichTrimSummary: (req: any) => enrichCalls.push(req),
    })));
    expect(store.trimWrites.length).toBe(0);
    expect(enrichCalls.length).toBe(0);
  });

  // History with big tool-result bodies in the prefix, for the lineage-
  // compaction wiring. Each "round" = assistant tool_use + user tool_result.
  const bigToolHistory = (rounds: number, bytes = 4000) => {
    const out: any[] = [];
    for (let i = 0; i < rounds; i++) {
      out.push({ role: 'assistant', content: '', id: `a${i}`, when: i, toolUses: [{ id: `tu_${i}`, name: 'read_page', input: {} }] });
      out.push({
        role: 'user', content: '', id: `r${i}`, when: i,
        toolResults: [{
          tool_use_id: `tu_${i}`, content: 'x'.repeat(bytes), is_error: false,
          meta: { toolName: 'read_page', primitive: 'tab', sideEffect: 'read', origins: ['https://example.com'], durationMs: 10, gates: [], hooks: [] },
        }],
      });
    }
    return out;
  };

  test('with a context window, old tool-result bodies reach the model compacted', async () => {
    const store = makeStore();
    store.seed('s1', bigToolHistory(8)); // 16 msgs, ~8k est tokens of bodies
    let sent: any[] | null = null;
    await drain(runUserTurn(baseCtx(store, {
      callModel: ({ messages }: any) => { sent = messages; return fakeModel(); },
      contextWindow: 8000, // fires compaction (trigger 6k); trim stays a no-op once compacted
    })));
    const spine = (m: any) =>
      Array.isArray(m.toolResults) && m.toolResults.some((b: any) => typeof b.content === 'string' && b.content.startsWith('‹elided›'));
    expect(sent!.some(spine)).toBe(true);
    // The persisted record keeps the FULL bodies — only what's sent shrank.
    const s = await store.get('s1');
    expect(s.messages.some(spine)).toBe(false);
  });

  test('without a context window, bodies are sent verbatim (compaction off)', async () => {
    const store = makeStore();
    store.seed('s1', bigToolHistory(8));
    let sent: any[] | null = null;
    await drain(runUserTurn(baseCtx(store, {
      callModel: ({ messages }: any) => { sent = messages; return fakeModel(); },
      // no contextWindow → compaction is skipped
    })));
    const spine = (m: any) =>
      Array.isArray(m.toolResults) && m.toolResults.some((b: any) => typeof b.content === 'string' && b.content.startsWith('‹elided›'));
    expect(sent!.some(spine)).toBe(false);
  });
});
