// The heap split — the pure, worker-portable PRIMITIVES shared by every offscreen
// agent loop (spawned reasoners + bound actors): the in-memory session shim, the
// relayed callModel (key/egress/signal stripped, maxTokens injected), and
// finalAssistantText. The loop-driver itself (runActorLoop) is covered in
// actor-worker-core.test.ts.
import { describe, test, expect } from 'bun:test';
import {
  finalAssistantText, makeInMemorySessions, makeRelayedCallModel,
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

describe('makeRelayedCallModel', () => {
  test('strips ALL functions (getSecret, safeFetch, signal), injects maxTokens, yields the SW events', async () => {
    let sentArgs: any = null;
    const requestModel = async (args: any) => { sentArgs = args; return { events: [{ type: 'delta', text: 'A' }, { type: 'stop', stopReason: 'end_turn' }] }; };
    const callModel = makeRelayedCallModel(requestModel, 4096);
    const secret = async () => 'sk-KEY';
    const safeFetch = async () => new Response('x');   // the loop ALWAYS passes this — a function
    const ac = new AbortController();
    const got: any[] = [];
    // Mirror the REAL loop's callModel args (agent-loop.js:486-495): getSecret AND
    // safeFetch are functions — a missed strip throws DataCloneError on postMessage.
    for await (const ev of callModel({ provider: 'anthropic', model: 'm', messages: [{ role: 'user' }], getSecret: secret, safeFetch, signal: ac.signal })) got.push(ev);
    // the key, egress, and signal never crossed the boundary
    expect('getSecret' in sentArgs).toBe(false);
    expect('safeFetch' in sentArgs).toBe(false);
    expect('signal' in sentArgs).toBe(false);
    // NO function survives (structured-clone would throw) — the guarantee that keeps the relay working
    expect(Object.values(sentArgs).some((v) => typeof v === 'function')).toBe(false);
    // the payload is structured-cloneable in practice
    expect(() => structuredClone(sentArgs)).not.toThrow();
    // the output cap was injected, the model args survived
    expect(sentArgs.maxTokens).toBe(4096);
    expect(sentArgs.provider).toBe('anthropic');
    expect(got.map((e) => e.type)).toEqual(['delta', 'stop']);
  });

  test('a relayed error becomes a thrown error in the worker loop', async () => {
    const callModel = makeRelayedCallModel(async () => ({ error: 'provider-http-500' }));
    await expect((async () => { for await (const _ of callModel({})) { /* drain */ } })())
      .rejects.toThrow('provider-http-500');
  });
});
