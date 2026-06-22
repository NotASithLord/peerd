// Auto-resume — the loop's resume branch (runUserTurn with ctx.resume).
//
// The pure detector (resume-detect.test.ts) decides WHETHER to resume; this
// covers what the LOOP does when told to: continue the persisted history
// without a new user turn, appending a synthetic nudge only when the turn
// was cut off mid-ANSWER (so the trailing turn is a USER message, never an
// illegal assistant prefill), and NOT when a dangling tool_use / pending
// tool-results already make the history continuable.

import { describe, test, expect } from 'bun:test';
// Import the leaf modules directly — the peerd-runtime barrel pulls in
// browser-coupled modules that don't load outside an extension context.
import { runUserTurn } from '../../../extension/peerd-runtime/loop/agent-loop.js';
import { createSessionStore } from '../../../extension/peerd-runtime/sessions/store.js';

const makeIdb = () => {
  const stores = new Map<string, Map<string, any>>();
  const tbl = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name)!;
  };
  return {
    get: async (store: string, key: string) => tbl(store).get(key),
    getMany: async (store: string, keys: string[]) => (keys ?? []).map((k) => tbl(store).get(k)),
    put: async (store: string, val: any) => { tbl(store).set(val.id ?? val.sessionId, val); },
    getAll: async (store: string) => [...tbl(store).values()],
  };
};

async function* textStream(text: string, stopReason = 'end_turn') {
  yield { type: 'text-delta', text } as any;
  yield { type: 'message-stop', stopReason } as any;
}

const drain = async (gen: AsyncIterable<any>) => {
  const out: any[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
};

const buildCtx = (sessions: any, sessionId: string, calls: any[]) => ({
  sessions,
  sessionId,
  resume: true,
  callModel: (args: any) => { calls.push(args.messages); return textStream('continued'); },
  getSecret: async () => 'sk-test',
  safeFetch: async () => new Response('ok'),
  getSystemPrompt: async () => 'sys',
  appendAudit: async () => {},
  now: () => 2000,
});

describe('runUserTurn resume mode', () => {
  test('answer cut off mid-stream → appends a synthetic nudge, then continues', async () => {
    let i = 0;
    const sessions = createSessionStore({ idb: makeIdb(), now: () => 1000, makeId: () => `g-${++i}` });
    const s = await sessions.create();
    await sessions.appendMessage(s.sessionId, { role: 'user', content: 'do it', id: 'u1', when: 1 } as any);
    await sessions.appendMessage(s.sessionId, { role: 'assistant', content: 'half', id: 'a1', when: 2, streaming: true } as any);

    const calls: any[] = [];
    await drain(runUserTurn(buildCtx(sessions, s.sessionId, calls) as any));

    const after = await sessions.get(s.sessionId);
    // The interrupted assistant was finalized (no longer streaming)...
    const a1 = after!.messages.find((m: any) => m.id === 'a1') as any;
    expect(a1.streaming).toBe(false);
    // ...a synthetic user nudge was appended (hidden from the UI)...
    const nudge = after!.messages.find((m: any) => m.role === 'user' && (m as any).synthetic) as any;
    expect(nudge).toBeTruthy();
    // ...and the model saw a history ENDING on a user turn (no illegal prefill).
    const sent = calls[0];
    expect(sent[sent.length - 1].role).toBe('user');
    // The continuation produced a new assistant message.
    expect(after!.messages.some((m: any) => m.content === 'continued')).toBe(true);
  });

  test('dangling tool_use → appends NO nudge, continues from the tool_use turn', async () => {
    let i = 0;
    const sessions = createSessionStore({ idb: makeIdb(), now: () => 1000, makeId: () => `g-${++i}` });
    const s = await sessions.create();
    await sessions.appendMessage(s.sessionId, { role: 'user', content: 'do it', id: 'u1', when: 1 } as any);
    await sessions.appendMessage(s.sessionId, {
      role: 'assistant', content: '', id: 'a1', when: 2,
      stopReason: 'tool_use', toolUses: [{ id: 't1', name: 'x', input: {} }],
    } as any);

    const calls: any[] = [];
    await drain(runUserTurn(buildCtx(sessions, s.sessionId, calls) as any));

    const after = await sessions.get(s.sessionId);
    // No synthetic user nudge — the format layer's orphan-repair makes the
    // dangling tool_use continuable on its own.
    expect(after!.messages.some((m: any) => m.role === 'user' && (m as any).synthetic)).toBe(false);
    // The model saw history ending on the assistant tool_use turn.
    const sent = calls[0];
    const lastSent = sent[sent.length - 1];
    expect(lastSent.role).toBe('assistant');
    expect(lastSent.toolUses?.[0]?.id).toBe('t1');
  });

  test('empty session → no-op (nothing to resume)', async () => {
    let i = 0;
    const sessions = createSessionStore({ idb: makeIdb(), now: () => 1000, makeId: () => `g-${++i}` });
    const s = await sessions.create();
    const calls: any[] = [];
    const events = await drain(runUserTurn(buildCtx(sessions, s.sessionId, calls) as any));
    expect(calls.length).toBe(0);
    expect(events.length).toBe(0);
    expect((await sessions.get(s.sessionId))!.messages).toEqual([]);
  });
});
