// Heap-split phase 2 — the pure core of an offscreen BOUND-actor loop: the
// relayed tool dispatch (the new piece vs phase 1) and the actor loop-driver.
import { describe, test, expect } from 'bun:test';
import { makeRelayedToolDispatch, runActorLoop, makeInMemorySessions } from '../../extension/peerd-runtime/subagent/actor-worker-core.js';

describe('makeRelayedToolDispatch', () => {
  test('delegates the call across the boundary and returns the SW ToolResult', async () => {
    let sent: any = null;
    const requestTool = async (call: any) => { sent = call; return { ok: true, result: { ok: true, content: 'ran in VM' } }; };
    const dispatch = makeRelayedToolDispatch(requestTool);
    const out = await dispatch({ name: 'vm_boot', args: { cmd: 'ls' }, id: 't1' });
    expect(sent).toEqual({ name: 'vm_boot', args: { cmd: 'ls' }, id: 't1' });
    expect(out).toEqual({ ok: true, content: 'ran in VM' });
  });

  test('a relay failure becomes a ToolResult error (never throws the loop)', async () => {
    const dispatch = makeRelayedToolDispatch(async () => ({ ok: false, error: 'gate refused' }));
    const out = await dispatch({ name: 'vm_delete', args: {} });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('gate refused');
  });

  test('a thrown relay becomes a ToolResult error', async () => {
    const dispatch = makeRelayedToolDispatch(async () => { throw new Error('port died'); });
    const out = await dispatch({ name: 'vm_boot', args: {} });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('port died');
  });

  test('the call args crossing the boundary carry no functions (cloneable)', async () => {
    let sent: any = null;
    const dispatch = makeRelayedToolDispatch(async (c: any) => { sent = c; return { ok: true, result: {} }; });
    await dispatch({ name: 'js_notebook', args: { code: 'x' }, id: 'n1' });
    expect(() => structuredClone(sent)).not.toThrow();
  });
});

describe('runActorLoop', () => {
  // A fake actor loop: dispatch ONE tool via the relay, then answer.
  const fakeActorLoop = (finalText: string) => async function* (ctx: any) {
    const r = await ctx.toolDispatch({ name: 'vm_boot', args: { cmd: 'echo hi' }, id: 't1' });
    ctx._toolResult = r;
    await ctx.appendAudit({ type: 'x' }).catch(() => {});   // phase-1 crash shape
    yield { type: 'tool-use', name: 'vm_boot' };
    await ctx.sessions.updateAssistantMessage(ctx.sessionId, 'a1', { content: finalText });
    yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    yield { type: 'stop', stopReason: 'end_turn' };
  };

  test('runs the actor loop, relays tool dispatch, returns finalText + usage + toolCalls', async () => {
    const sessions = makeInMemorySessions({ sessionId: 'act-1', provider: 'anthropic', model: 'm' });
    await sessions.appendMessage('act-1', { role: 'assistant', content: '', id: 'a1' });
    const forwarded: any[] = [];
    const toolDispatch = makeRelayedToolDispatch(async () => ({ ok: true, result: { ok: true, content: 'hi' } }));
    const out = await runActorLoop(
      { runUserTurn: fakeActorLoop('the VM did the thing') as any, sessions, callModel: (async function* () {})() as any, toolDispatch, getSystemPrompt: () => 'ACTOR SYS', appendAudit: () => {} /* sync stub — must be tolerated */, onEvent: (e) => forwarded.push(e), tools: [{ name: 'vm_boot', description: 'boot', schema: {} }] },
      { sessionId: 'act-1', userText: 'run echo', maxSteps: 20 },
    );
    expect(out.finalText).toBe('the VM did the thing');
    expect(out.toolCalls).toBe(1);
    expect(out.usage.outputTokens).toBe(3);
    expect(forwarded.map((e) => e.type)).toEqual(['tool-use', 'usage', 'stop']);
  });

  test('surfaces a text-less error (not a silent blank)', async () => {
    const sessions = makeInMemorySessions({ sessionId: 'act-1' });
    const erroringLoop = async function* () { yield { type: 'error', error: 'vm-wedged' }; yield { type: 'stop', stopReason: 'error' }; };
    const out = await runActorLoop(
      { runUserTurn: erroringLoop as any, sessions, callModel: (async function* () {})() as any, toolDispatch: async () => ({}), getSystemPrompt: () => 'S', tools: [] },
      { sessionId: 'act-1', userText: 't', maxSteps: 5 },
    );
    expect(out.finalText).toBe('');
    expect(out.error).toBe('vm-wedged');
  });
});
