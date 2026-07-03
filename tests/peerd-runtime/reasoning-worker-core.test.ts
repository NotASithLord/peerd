// Heap-split phase 1 — the pure core of an offscreen reasoning subagent:
// the in-memory session shim, the relayed callModel (key/signal stripped,
// maxTokens injected), and the loop-driver's result/usage accumulation.
import { describe, test, expect } from 'bun:test';
import {
  finalAssistantText, makeInMemorySessions, makeRelayedCallModel, runReasoningLoop,
} from '../../extension/peerd-runtime/subagent/reasoning-worker-core.js';

describe('makeInMemorySessions', () => {
  test('seeds the child record and supports the loop surface', async () => {
    const s = makeInMemorySessions({ sessionId: 'c1', provider: 'anthropic', model: 'm', depth: 1 });
    expect((await s.get('c1')).sessionId).toBe('c1');
    await s.appendMessage('c1', { role: 'user', content: 'hi' });
    await s.appendMessage('c1', { role: 'assistant', content: 'yo', id: 'a1' });
    await s.updateAssistantMessage('c1', { id: 'a1', content: 'yo!' });
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
  test('strips getSecret + signal, injects maxTokens, yields the SW events', async () => {
    let sentArgs: any = null;
    const requestModel = async (args: any) => { sentArgs = args; return { events: [{ type: 'delta', text: 'A' }, { type: 'stop', stopReason: 'end_turn' }] }; };
    const callModel = makeRelayedCallModel(requestModel, 4096);
    const secret = async () => 'sk-KEY';
    const ac = new AbortController();
    const got: any[] = [];
    for await (const ev of callModel({ provider: 'anthropic', model: 'm', messages: [{ role: 'user' }], getSecret: secret, signal: ac.signal })) got.push(ev);
    // the key + signal never crossed the boundary
    expect('getSecret' in sentArgs).toBe(false);
    expect('signal' in sentArgs).toBe(false);
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

describe('runReasoningLoop', () => {
  // A fake loop: drive the injected (relayed) callModel once, append the final
  // assistant message to the shim, and yield usage + stop — exactly the shape
  // runUserTurn produces for a tool-less child.
  const fakeLoop = (finalText: string, stopReason = 'end_turn') =>
    async function* (ctx: any) {
      for await (const _ev of ctx.callModel({ provider: 'anthropic', model: 'm', messages: [], getSecret: ctx.getSecret })) { /* consume the relay */ }
      await ctx.sessions.appendMessage(ctx.sessionId, { role: 'assistant', content: finalText });
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } };
      yield { type: 'stop', stopReason };
    };

  test('returns finalText + accumulated usage + stopReason', async () => {
    const sessions = makeInMemorySessions({ sessionId: 'c1', provider: 'anthropic', model: 'm' });
    const callModel = makeRelayedCallModel(async () => ({ events: [{ type: 'delta', text: 'x' }] }), 4096);
    const out = await runReasoningLoop(
      { runUserTurn: fakeLoop('the researched answer') as any, sessions, callModel, getSystemPrompt: () => 'SYS', appendAudit: () => {} },
      { sessionId: 'c1', task: 'research X', maxSteps: 20 },
    );
    expect(out.finalText).toBe('the researched answer');
    expect(out.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(out.stopReason).toBe('end_turn');
    expect(out.toolCalls).toBe(0);
  });

  test('the loop never receives a real getSecret (worker has no key)', async () => {
    const sessions = makeInMemorySessions({ sessionId: 'c1' });
    let threw = false;
    const probeLoop = async function* (ctx: any) {
      try { await ctx.getSecret('anything'); } catch { threw = true; }
      await ctx.sessions.appendMessage(ctx.sessionId, { role: 'assistant', content: 'done' });
      yield { type: 'stop', stopReason: 'end_turn' };
    };
    await runReasoningLoop(
      { runUserTurn: probeLoop as any, sessions, callModel: (async function* () {})() as any, getSystemPrompt: () => 'S', appendAudit: () => {} },
      { sessionId: 'c1', task: 't', maxSteps: 5 },
    );
    expect(threw).toBe(true); // getSecret in the worker is a throwing stub
  });
});
