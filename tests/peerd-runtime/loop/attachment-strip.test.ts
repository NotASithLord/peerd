// runUserTurn send-once-then-strip: the model call carries the live
// attachment bytes on the turn they're sent (every step of it); the
// PERSISTED user message — and therefore every later re-send — carries
// only the stripped metadata shape.

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

const drain = async (gen: AsyncGenerator<any>) => {
  for await (const _ of gen) { /* drive to completion */ }
};

const ATTACHMENTS = [
  { name: 'shot.png', mediaType: 'image/png', kind: 'image', size: 3, data: 'aW1n' },
  { name: 'doc.pdf', mediaType: 'application/pdf', kind: 'pdf', size: 3, data: 'cGRm' },
];

const baseCtx = (store: any, callModel: any, extra: any = {}) => ({
  sessionId: 's1',
  userText: 'look at these',
  attachments: ATTACHMENTS,
  callModel,
  getSecret: async () => 'sk',
  safeFetch: async () => new Response('ok'),
  sessions: store,
  getSystemPrompt: async () => 'sys',
  appendAudit: async () => {},
  tools: [],
  ...extra,
});

describe('runUserTurn attachments — send once, persist stripped', () => {
  test('persisted user message is stripped; the model call carries the bytes', async () => {
    const store = makeStore();
    store.seed('s1');
    const seen: any[] = [];
    const callModel = (args: any) => {
      seen.push(args.messages);
      return (async function* () {
        yield { type: 'text-delta', text: 'ok' };
        yield { type: 'message-stop', stopReason: 'end_turn' };
      })();
    };
    await drain(runUserTurn(baseCtx(store, callModel)));

    // What the MODEL saw: live records, base64 present.
    expect(seen.length).toBe(1);
    const sentUser = seen[0].find((m: any) => m.role === 'user');
    expect(sentUser.attachments.map((a: any) => a.data)).toEqual(['aW1n', 'cGRm']);
    expect(sentUser.attachments.every((a: any) => a.stripped !== true)).toBe(true);

    // What PERSISTED: metadata only, stripped:true, no data anywhere.
    const session = await store.get('s1');
    const persisted = session.messages.find((m: any) => m.role === 'user');
    expect(persisted.attachments).toEqual([
      { name: 'shot.png', mediaType: 'image/png', kind: 'image', size: 3, stripped: true },
      { name: 'doc.pdf', mediaType: 'application/pdf', kind: 'pdf', size: 3, stripped: true },
    ]);
    expect(JSON.stringify(session)).not.toContain('aW1n');
  });

  test('a multi-step (tool_use) turn re-sends the bytes on EVERY step of this turn', async () => {
    const store = makeStore();
    store.seed('s1');
    const seen: any[] = [];
    let call = 0;
    const callModel = (args: any) => {
      seen.push(args.messages);
      call++;
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
    await drain(runUserTurn(baseCtx(store, callModel, {
      tools: [{ name: 'now', description: 'time', schema: {} }],
      toolDispatch: async () => ({ ok: true, content: '"12:00"', meta: { toolName: 'now', primitive: 'time', gates: [], durationMs: 1 } }),
    })));

    // Both model calls of THIS turn carry the live bytes — history is
    // rebuilt from the (stripped) session per step, so the splice must
    // hold beyond step 1.
    expect(seen.length).toBe(2);
    for (const messages of seen) {
      const user = messages.find((m: any) => m.role === 'user' && Array.isArray(m.attachments));
      expect(user.attachments.map((a: any) => a.data)).toEqual(['aW1n', 'cGRm']);
    }
    // Persistence still stripped after the multi-step turn.
    const session = await store.get('s1');
    expect(JSON.stringify(session)).not.toContain('aW1n');
  });

  test('no attachments → user message carries no attachments field (shape unchanged)', async () => {
    const store = makeStore();
    store.seed('s1');
    const callModel = () => (async function* () {
      yield { type: 'text-delta', text: 'ok' };
      yield { type: 'message-stop', stopReason: 'end_turn' };
    })();
    await drain(runUserTurn(baseCtx(store, callModel, { attachments: undefined })));
    const session = await store.get('s1');
    const persisted = session.messages.find((m: any) => m.role === 'user');
    expect('attachments' in persisted).toBe(false);
  });
});
