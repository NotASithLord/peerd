// The heap split — the pure, worker-portable PRIMITIVES shared by every offscreen
// agent loop (spawned reasoners + bound actors): the in-memory session shim, the
// in-memory session shim and finalAssistantText. The loop-driver itself is covered in
// actor-worker-core.test.ts.
import { describe, test, expect } from 'bun:test';
import {
  finalAssistantText, makeInMemorySessions,
} from '../../extension/peerd-runtime/actor/actor-worker-core.js';

describe('makeInMemorySessions', () => {
  test('seeds the child record and supports the loop surface', async () => {
    const s = makeInMemorySessions({ sessionId: 'c1', provider: 'anthropic', model: 'm', depth: 1 });
    expect((await s.get('c1')).sessionId).toBe('c1');
    await s.appendMessage('c1', { role: 'user', content: 'hi' });
    await s.appendMessage('c1', { role: 'assistant', content: 'yo', id: 'a1' });
    // 3-arg (sessionId, messageId, patch) — the real store contract. A 2-arg shim
    // silently dropped the patch, so the child's final content vanished.
    await s.updateAssistantMessage('c1', 'a1', { content: 'yo!' });
    expect((await s.get('c1')).messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo!', id: 'a1' },
    ]);
  });
});

describe('finalAssistantText', () => {
  test('returns the last non-empty assistant message', () => {
    expect(finalAssistantText({ messages: [
      { role: 'assistant', content: 'first' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'final answer' },
    ] })).toBe('final answer');
    expect(finalAssistantText({ messages: [] })).toBe('');
  });
});
