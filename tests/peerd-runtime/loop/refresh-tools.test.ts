// runUserTurn refreshTools — progressive disclosure wiring.
//
// The main turn passes refreshTools so the loop recomputes the advertised
// tool list each STEP (an instance created mid-turn reveals its ops on the
// next step). When absent (subagents / runners), the static ctx.tools is used
// unchanged. These tests pin both: the loop calls refreshTools and feeds ITS
// result to the model, and the fallback path is untouched.

import { describe, test, expect } from 'bun:test';
import { runUserTurn } from '../../../extension/peerd-runtime/loop/agent-loop.js';

const makeStore = () => {
  const sessions = new Map<string, any>();
  return {
    seed(id: string) { sessions.set(id, { sessionId: id, messages: [] }); },
    async get(id: string) { return sessions.get(id) ?? null; },
    async appendMessage(id: string, msg: any) {
      const s = sessions.get(id); s.messages.push({ ...msg }); return s;
    },
    async updateAssistantMessage(id: string, msgId: string, patch: any) {
      const s = sessions.get(id);
      const m = s.messages.find((x: any) => x.id === msgId);
      if (m) Object.assign(m, patch);
      return s;
    },
  };
};

async function* fakeModel() {
  yield { type: 'text-delta', text: 'ok' };
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
  toolDispatch: async () => ({}),
  tools: [],
  ...extra,
});

const drain = async (gen: AsyncGenerator<any>) => { for await (const _ of gen) { /* exhaust */ } };

describe('runUserTurn refreshTools (progressive disclosure)', () => {
  test('the model call uses the REFRESHED tool list, not the static one', async () => {
    const store = makeStore(); store.seed('s1');
    const seenTools: any[] = [];
    let refreshCalls = 0;
    await drain(runUserTurn(baseCtx(store, {
      tools: [{ name: 'initial' }],                 // static fallback — must NOT be what the model sees
      refreshTools: async () => { refreshCalls += 1; return [{ name: 'fresh' }]; },
      callModel: (args: any) => { seenTools.push(args.tools); return fakeModel(); },
    })));
    expect(refreshCalls).toBeGreaterThanOrEqual(1);          // called at the start of the step
    expect(seenTools[0]).toEqual([{ name: 'fresh' }]);       // the recomputed list reached the provider
  });

  test('a refreshTools throw keeps the prior tool set — never breaks the turn', async () => {
    const store = makeStore(); store.seed('s1');
    const seenTools: any[] = [];
    await drain(runUserTurn(baseCtx(store, {
      tools: [{ name: 'prior' }],
      refreshTools: async () => { throw new Error('registry hiccup'); },
      callModel: (args: any) => { seenTools.push(args.tools); return fakeModel(); },
    })));
    expect(seenTools[0]).toEqual([{ name: 'prior' }]);       // fell back to the initial set, turn completed
  });

  test('without refreshTools the static tool list is used unchanged (subagents/runners)', async () => {
    const store = makeStore(); store.seed('s1');
    const seenTools: any[] = [];
    await drain(runUserTurn(baseCtx(store, {
      tools: [{ name: 'static' }],
      callModel: (args: any) => { seenTools.push(args.tools); return fakeModel(); },
    })));
    expect(seenTools[0]).toEqual([{ name: 'static' }]);
  });
});
