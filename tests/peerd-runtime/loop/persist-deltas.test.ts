// runUserTurn persistDeltas — the ephemeral-runner persistence diet.
// persistDeltas:false must skip the per-streamed-delta full-record
// rewrite while leaving finalization intact (the runner's result is read
// from the COMPLETED session).

import { describe, test, expect } from 'bun:test';
import { runUserTurn } from '../../../extension/peerd-runtime/loop/agent-loop.js';

const makeStore = () => {
  const sessions = new Map<string, any>();
  const updateCalls: any[] = [];
  return {
    updateCalls,
    seed(id: string) {
      sessions.set(id, { sessionId: id, messages: [] });
    },
    async get(id: string) { return sessions.get(id) ?? null; },
    async appendMessage(id: string, msg: any) {
      const s = sessions.get(id);
      s.messages.push({ ...msg });
      return s;
    },
    async updateAssistantMessage(id: string, msgId: string, patch: any) {
      updateCalls.push({ msgId, patch });
      const s = sessions.get(id);
      const m = s.messages.find((x: any) => x.id === msgId);
      if (m) Object.assign(m, patch);
      return s;
    },
  };
};

// Stream three text deltas then stop.
async function* fakeModel() {
  yield { type: 'text-delta', text: 'a' };
  yield { type: 'text-delta', text: 'b' };
  yield { type: 'text-delta', text: 'c' };
  yield { type: 'message-stop', stopReason: 'end_turn' };
}

const baseCtx = (store: any, extra: any = {}) => ({
  sessionId: 's1',
  userText: 'hi',
  callModel: () => fakeModel(),
  getSecret: async () => 'sk',
  safeFetch: async () => new Response('ok'),
  sessions: store,
  getSystemPrompt: async () => 'sys',
  appendAudit: async () => {},
  tools: [],
  ...extra,
});

const drain = async (gen: AsyncGenerator<any>) => {
  const evs = [];
  for await (const ev of gen) evs.push(ev);
  return evs;
};

describe('runUserTurn persistDeltas', () => {
  test('default: every text delta persists (crash recovery for the main chat)', async () => {
    const store = makeStore();
    store.seed('s1');
    await drain(runUserTurn(baseCtx(store)));
    const contentWrites = store.updateCalls.filter((c) => 'content' in c.patch);
    // 3 per-delta writes + the finalize write
    expect(contentWrites.length).toBe(4);
    expect(contentWrites.at(-1)!.patch.content).toBe('abc');
  });

  test('persistDeltas:false: zero per-delta writes, finalize still lands the full text', async () => {
    const store = makeStore();
    store.seed('s1');
    const evs = await drain(runUserTurn(baseCtx(store, { persistDeltas: false })));
    const contentWrites = store.updateCalls.filter((c) => 'content' in c.patch);
    expect(contentWrites.length).toBe(1);                 // finalize only
    expect(contentWrites[0].patch.content).toBe('abc');
    expect(contentWrites[0].patch.streaming).toBe(false);
    // The live event stream is unaffected — callers still see every delta.
    expect(evs.filter((e) => e.type === 'delta').length).toBe(3);
  });
});
