// Heap-split phase 2 — the pure core of an offscreen BOUND-actor loop: the
// relayed tool dispatch (the new piece vs phase 1) and the actor loop-driver.
import { describe, test, expect } from 'bun:test';
import { makeRelayedToolDispatch, runActorLoop, makeInMemorySessions, makeActorSummaryFence } from '../../extension/peerd-runtime/actor/actor-worker-core.js';

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
  // A fake actor loop: append the user message + a tool round + a NEW final
  // assistant message (as the real runUserTurn does), so per-turn scoping works.
  const fakeActorLoop = (finalText: string) => async function* (ctx: any) {
    await ctx.sessions.appendMessage(ctx.sessionId, { id: 'u', role: 'user', content: ctx.userText });
    const r = await ctx.toolDispatch({ name: 'vm_boot', args: { cmd: 'echo hi' }, id: 't1' });
    ctx._toolResult = r;
    await ctx.appendAudit({ type: 'x' }).catch(() => {});   // phase-1 crash shape
    await ctx.sessions.appendMessage(ctx.sessionId, { id: 'tr', role: 'tool', content: 'hi' });
    yield { type: 'tool-use', name: 'vm_boot' };
    await ctx.sessions.appendMessage(ctx.sessionId, { id: 'a1', role: 'assistant', content: finalText });
    yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    yield { type: 'stop', stopReason: 'end_turn' };
  };

  test('runs the actor loop, relays tool dispatch, returns finalText + FULL new transcript + usage', async () => {
    const sessions = makeInMemorySessions({ sessionId: 'act-1', provider: 'anthropic', model: 'm' });
    const forwarded: any[] = [];
    const toolDispatch = makeRelayedToolDispatch(async () => ({ ok: true, result: { ok: true, content: 'hi' } }));
    const out = await runActorLoop(
      { runUserTurn: fakeActorLoop('the VM did the thing') as any, sessions, callModel: (async function* () {})() as any, toolDispatch, getSystemPrompt: () => 'ACTOR SYS', appendAudit: () => {} /* sync stub — must be tolerated */, onEvent: (e) => forwarded.push(e), tools: [{ name: 'vm_boot', description: 'boot', schema: {} }] },
      { sessionId: 'act-1', userText: 'run echo', maxSteps: 20 },
    );
    expect(out.finalText).toBe('the VM did the thing');
    expect(out.toolCalls).toBe(1);
    expect(out.usage.outputTokens).toBe(3);
    // the WHOLE turn is returned (user + tool_result + assistant) so the SW can
    // persist it — not a lossy user+finalText pair.
    expect(out.newMessages.map((m: any) => m.role)).toEqual(['user', 'tool', 'assistant']);
    expect(forwarded.map((e) => e.type)).toEqual(['tool-use', 'usage', 'stop']);
  });

  test('per-turn scoping: a SEEDED prior reply is NOT returned as this turn\'s answer (stale-reply guard)', async () => {
    // Seed the actor's prior history (statefulness) — turn 1 answered "PRIOR".
    const sessions = makeInMemorySessions({ sessionId: 'act-1', messages: [{ id: 'p', role: 'assistant', content: 'PRIOR REPLY' }] });
    // Turn 2 emits NO new assistant text (Stop/error).
    const noTextLoop = async function* () { yield { type: 'error', error: 'stopped' }; yield { type: 'stop', stopReason: 'aborted' }; };
    const out = await runActorLoop(
      { runUserTurn: noTextLoop as any, sessions, callModel: (async function* () {})() as any, toolDispatch: async () => ({}), getSystemPrompt: () => 'S', tools: [] },
      { sessionId: 'act-1', userText: 't2', maxSteps: 5 },
    );
    expect(out.finalText).toBe('');            // NOT 'PRIOR REPLY'
    expect(out.error).toBe('stopped');         // the real failure surfaces
    expect(out.newMessages).toEqual([]);       // nothing new this turn
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

  // The unification: a REASONING actor is a tool-less actor. runActorLoop with
  // tools:[] and a loop that never dispatches drives it exactly like the old
  // runReasoningLoop — the relayed toolDispatch is simply never invoked.
  test('drives a tool-less REASONING loop (tools:[], no dispatch)', async () => {
    const sessions = makeInMemorySessions({ sessionId: 'c1', provider: 'anthropic', model: 'm' });
    let dispatched = false;
    const reasoningLoop = async function* (ctx: any) {
      await ctx.sessions.appendMessage(ctx.sessionId, { id: 'a', role: 'assistant', content: 'the researched answer' });
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } };
      yield { type: 'stop', stopReason: 'end_turn' };
    };
    const out = await runActorLoop(
      { runUserTurn: reasoningLoop as any, sessions, callModel: (async function* () {})() as any, toolDispatch: async () => { dispatched = true; return {}; }, getSystemPrompt: () => 'SYS', tools: [] },
      { sessionId: 'c1', userText: 'research X', maxSteps: 20 },
    );
    expect(out.finalText).toBe('the researched answer');
    expect(out.usage.outputTokens).toBe(5);
    expect(out.toolCalls).toBe(0);
    expect(dispatched).toBe(false);   // a tool-less child never dispatches
  });

  test('the loop never receives a real getSecret/safeFetch (the worker holds no key/egress)', async () => {
    const sessions = makeInMemorySessions({ sessionId: 'act-1' });
    let secretThrew = false;
    let fetchThrew = false;
    const probeLoop = async function* (ctx: any) {
      try { await ctx.getSecret('anything'); } catch { secretThrew = true; }
      try { await ctx.safeFetch('https://x'); } catch { fetchThrew = true; }
      await ctx.sessions.appendMessage(ctx.sessionId, { id: 'a', role: 'assistant', content: 'done' });
      yield { type: 'stop', stopReason: 'end_turn' };
    };
    await runActorLoop(
      { runUserTurn: probeLoop as any, sessions, callModel: (async function* () {})() as any, toolDispatch: async () => ({}), getSystemPrompt: () => 'S', tools: [] },
      { sessionId: 'act-1', userText: 't', maxSteps: 5 },
    );
    expect(secretThrew).toBe(true);   // getSecret in the worker is a throwing stub
    expect(fetchThrew).toBe(true);    // safeFetch too — no egress in the heap
  });
});

describe('makeActorSummaryFence', () => {
  test('a tab web actor fences its summary as untrusted, tagged with the tab url', () => {
    const fence = makeActorSummaryFence({ actorType: 'web', tabUrl: 'https://example.com/page' });
    expect(typeof fence).toBe('function');
    const wrapped = fence!('did three steps on the page');
    // the BODY is present and the envelope is an untrusted-data wrap (not a command)
    expect(wrapped).toContain('did three steps on the page');
    expect(wrapped).toContain('example.com');
  });

  test('an API actor fences with its FIXED owned origin', () => {
    const fence = makeActorSummaryFence({ actorType: 'web', backing: 'api', origin: 'https://api.example.com' });
    const wrapped = fence!('learned the /v1/users shape');
    expect(wrapped).toContain('learned the /v1/users shape');
    expect(wrapped).toContain('api.example.com');
  });

  test('a non-web (engine) actor gets NO self-fence — its summary renders verbatim', () => {
    expect(makeActorSummaryFence({ actorType: 'webvm' })).toBeUndefined();
    expect(makeActorSummaryFence({ actorType: 'notebook' })).toBeUndefined();
    expect(makeActorSummaryFence({})).toBeUndefined();
  });
});
