// An OpenAI-compatible mid-stream error chunk through the real parser and
// runUserTurn: the saved turn keeps the provider's own error text and is not
// auto-resumed (a resume would re-run a paid call on every reopen).

import { describe, test, expect } from 'bun:test';
import { runUserTurn } from '../../../extension/peerd-runtime/loop/agent-loop.js';
import { detectInterruptedTurn } from '../../../extension/peerd-runtime/loop/resume-detect.js';
import { fromOpenAiStream } from '../../../extension/peerd-provider/format/from-openai.js';

const makeStore = () => {
  const sessions = new Map<string, any>([['s1', { sessionId: 's1', messages: [] }]]);
  return {
    sessions,
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

const streamOf = (chunks: string[]): ReadableStream<Uint8Array> => {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
      controller.close();
    },
  });
};

const drain = async (gen: AsyncGenerator<any>) => {
  const evs = [];
  for await (const ev of gen) evs.push(ev);
  return evs;
};

describe('mid-stream provider error', () => {
  test('the saved turn keeps the provider error and is not resumable', async () => {
    const store = makeStore();
    const evs = await drain(runUserTurn({
      sessionId: 's1',
      userText: 'hi',
      callModel: () => fromOpenAiStream(streamOf([
        'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
        'data: {"error":{"code":502,"message":"Provider disconnected"},"choices":[{"delta":{"content":""},"finish_reason":"error"}]}\n\n',
      ]), { provider: 'openrouter' }),
      getSecret: async () => 'sk',
      safeFetch: async () => new Response('ok'),
      sessions: store,
      getSystemPrompt: async () => 'sys',
      appendAudit: async () => {},
      tools: [],
    } as any));
    const errors = evs.filter((ev) => ev.type === 'error').map((ev) => ev.error);
    expect(errors).toEqual(['openrouter: Provider disconnected']);
    const session = store.sessions.get('s1');
    const last = session.messages.at(-1);
    expect(last.role).toBe('assistant');
    expect(last.error).toBe('openrouter: Provider disconnected');
    expect(last.stopReason).not.toBe('incomplete');
    expect(detectInterruptedTurn(session).resumable).toBe(false);
  });
});
