// Two loop-seam wire-shape guards the tool-ergonomics batch introduced, each
// a single junction a future refactor could silently break:
//   1. design 01 (prompt-cache stability): ctx.contextMessage is injected as
//      the FIRST wire message every step (so the volatile clock/active-tab
//      lands AFTER the cached system+tools prefix), and NEVER persists.
//   2. design 04 (universal spill): a dispatch result flagged paged:true keeps
//      the larger redact ceiling in its PERSISTED block, while an unflagged
//      result of the same size is cut to the 8k backstop.

import { describe, test, expect } from 'bun:test';
import { runUserTurn } from '../../../extension/peerd-runtime/loop/agent-loop.js';

const makeStore = () => {
  const sessions = new Map<string, any>();
  return {
    seed(id: string) { sessions.set(id, { sessionId: id, messages: [] }); },
    async get(id: string) { return sessions.get(id) ?? null; },
    async appendMessage(id: string, msg: any) { sessions.get(id).messages.push({ ...msg }); return sessions.get(id); },
    async updateAssistantMessage(id: string, msgId: string, patch: any) {
      const s = sessions.get(id); const m = s.messages.find((x: any) => x.id === msgId);
      if (m) Object.assign(m, patch); return s;
    },
  };
};
const drain = async (gen: AsyncGenerator<any>) => { for await (const _ of gen) { /* run */ } };
const trFor = (messages: any[], id: string) => messages
  .flatMap((m: any) => (Array.isArray(m.toolResults) ? m.toolResults : []))
  .find((t: any) => t.tool_use_id === id);

describe('runUserTurn — the leading ephemeral context message (design 01)', () => {
  test('contextMessage is wire message[0] every step and never persists', async () => {
    const store = makeStore(); store.seed('s1');
    const seen: any[][] = [];
    let call = 0;
    const callModel = (args: any) => {
      seen.push(args.messages); call++;
      return (async function* () {
        if (call === 1) {
          yield { type: 'tool-use-start', id: 't1', name: 'now' };
          yield { type: 'tool-use-stop', id: 't1' };
          yield { type: 'message-stop', stopReason: 'tool_use' };
        } else {
          yield { type: 'text-delta', text: 'done' };
          yield { type: 'message-stop', stopReason: 'end_turn' };
        }
      })();
    };
    const CTX = '<context>\n<time>now 2026-08-03T12:00:00Z</time>\n</context>';
    await drain(runUserTurn({
      sessionId: 's1', userText: 'hi', callModel, contextMessage: CTX,
      getSecret: async () => 'sk', safeFetch: async () => new Response('ok'),
      sessions: store, getSystemPrompt: async () => 'sys', appendAudit: async () => {},
      tools: [{ name: 'now', description: 't', schema: {} }],
      toolDispatch: async () => ({ ok: true, content: '"12:00"', meta: { toolName: 'now', primitive: 'time', gates: [], durationMs: 1 } }),
    } as any));

    // Both steps lead with the injected context message.
    expect(seen.length).toBe(2);
    for (const step of seen) {
      expect(step[0].role).toBe('user');
      expect(step[0].content).toBe(CTX);
      expect(step[0].id).toBe('ephemeral-context');
    }
    // It is never written to the session (wire-only).
    const session = await store.get('s1');
    expect(JSON.stringify(session)).not.toContain('<time>now');
    expect(session.messages.some((m: any) => m.id === 'ephemeral-context')).toBe(false);
  });
});

describe('runUserTurn — the paged redact ceiling (design 04)', () => {
  test('a paged result persists whole; an unflagged result of the same size is cut', async () => {
    const store = makeStore(); store.seed('s2');
    let call = 0;
    const callModel = () => {
      call++;
      return (async function* () {
        if (call === 1) {
          yield { type: 'tool-use-start', id: 'p1', name: 'read_run_cache' };
          yield { type: 'tool-use-stop', id: 'p1' };
          yield { type: 'tool-use-start', id: 'p2', name: 'inspect' };
          yield { type: 'tool-use-stop', id: 'p2' };
          yield { type: 'message-stop', stopReason: 'tool_use' };
        } else {
          yield { type: 'text-delta', text: 'ok' };
          yield { type: 'message-stop', stopReason: 'end_turn' };
        }
      })();
    };
    // 17k of body — above the 8k backstop, below the paged ceiling.
    const BIG = 'x'.repeat(17_000);
    const toolDispatch = async (c: any) => (c.name === 'read_run_cache'
      ? { ok: true, content: BIG, paged: true, meta: { toolName: 'read_run_cache', primitive: 'notebook', gates: [], durationMs: 1 } }
      : { ok: true, content: BIG, meta: { toolName: 'inspect', primitive: 'inspect', gates: [], durationMs: 1 } });

    await drain(runUserTurn({
      sessionId: 's2', userText: 'read', callModel,
      getSecret: async () => 'sk', safeFetch: async () => new Response('ok'),
      sessions: store, getSystemPrompt: async () => 'sys', appendAudit: async () => {},
      tools: [{ name: 'read_run_cache', description: 'r', schema: {} }, { name: 'inspect', description: 'i', schema: {} }],
      toolDispatch,
    } as any));

    const session = await store.get('s2');
    const paged = trFor(session.messages, 'p1');
    const unpaged = trFor(session.messages, 'p2');
    // The paged read survives whole; the unflagged one is cut to the backstop.
    expect(paged.content.length).toBeGreaterThan(16_000);
    expect(unpaged.content.length).toBeLessThan(9_000);
  });
});
