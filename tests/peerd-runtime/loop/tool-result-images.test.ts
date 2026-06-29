// Tool-result images (the `view` screenshot tool) — send-once-then-strip,
// tool-side. A tool that returns `images` has its pixels delivered to the model
// on the ONE step that consumes the tool_result (the step right after capture),
// then never again, and the bytes never persist (the rate-limit cliff redact.js
// guards for text, applied to images).

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

const drain = async (gen: AsyncGenerator<any>) => { for await (const _ of gen) { /* run */ } };

const IMG = { mediaType: 'image/png', data: 'aW1n' };

const trFor = (messages: any[], id: string) =>
  messages
    .flatMap((m: any) => (Array.isArray(m.toolResults) ? m.toolResults : []))
    .find((t: any) => t.tool_use_id === id);

describe('runUserTurn tool-result images — ship once, never persist', () => {
  test('a view screenshot reaches the model on the next step only, and never persists', async () => {
    const store = makeStore();
    store.seed('s1');
    const seen: any[] = [];
    let call = 0;
    const callModel = (args: any) => {
      seen.push(args.messages);
      call++;
      return (async function* () {
        if (call === 1) {
          yield { type: 'tool-use-start', id: 't1', name: 'view' };
          yield { type: 'tool-use-stop', id: 't1' };
          yield { type: 'message-stop', stopReason: 'tool_use' };
        } else if (call === 2) {
          // a second tool call so the turn runs a THIRD step — that step must
          // NOT re-carry the view image (proves send-once).
          yield { type: 'tool-use-start', id: 't2', name: 'now' };
          yield { type: 'tool-use-stop', id: 't2' };
          yield { type: 'message-stop', stopReason: 'tool_use' };
        } else {
          yield { type: 'text-delta', text: 'done' };
          yield { type: 'message-stop', stopReason: 'end_turn' };
        }
      })();
    };
    const toolDispatch = async (c: any) => (c.name === 'view'
      ? { ok: true, content: '{"captured":true}', images: [IMG], meta: { toolName: 'view', primitive: 'tab', gates: [], durationMs: 1 } }
      : { ok: true, content: '"12:00"', meta: { toolName: 'now', primitive: 'time', gates: [], durationMs: 1 } });

    await drain(runUserTurn({
      sessionId: 's1',
      userText: 'see this canvas',
      callModel,
      getSecret: async () => 'sk',
      safeFetch: async () => new Response('ok'),
      sessions: store,
      getSystemPrompt: async () => 'sys',
      appendAudit: async () => {},
      tools: [{ name: 'view', description: 'see', schema: {} }, { name: 'now', description: 't', schema: {} }],
      toolDispatch,
    } as any));

    expect(seen.length).toBe(3);
    // Step 2 (the call right after view dispatched) carries the pixels.
    expect(trFor(seen[1], 't1')?.images).toEqual([IMG]);
    // Step 3 still has the tool_result, but the image was sent once and cleared.
    const tr3 = trFor(seen[2], 't1');
    expect(tr3).toBeTruthy();
    expect(tr3.images).toBeUndefined();
    // The bytes never land in persisted history.
    const session = await store.get('s1');
    expect(JSON.stringify(session)).not.toContain('aW1n');
  });
});
