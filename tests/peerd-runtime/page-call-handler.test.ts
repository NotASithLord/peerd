// Host-side page-call handler — the SW-route logic that runs a page.<method> RPC
// through the gated dispatcher on the actor's owned tab. IO is injected, so these
// pin the security-relevant wiring without a browser: the action is pinned to the
// actor's tab, every call goes through dispatchToolCall (gates inherited), a bad
// method never dispatches, and a gated block / dispatch error surfaces the way
// the worker's awaited page.* call would see it.

import { describe, test, expect, mock } from 'bun:test';
import { makePageCallHandler } from '../../extension/peerd-runtime/subagent/page-call-handler.js';

const ACTOR_CTX = { sessionId: 's1', exposure: 'runner' as const };

/** A handler whose dispatcher echoes a fixed tool result and records the call. */
const harness = (toolResult: any = { ok: true, content: '{}' }) => {
  const dispatched: Array<{ call: any; ctx: any }> = [];
  const dispatchToolCall = mock(async (call: any, ctx: any) => {
    dispatched.push({ call, ctx });
    return toolResult;
  });
  const buildActorContext = mock(async (_binding: any) => ACTOR_CTX);
  const handle = makePageCallHandler({ dispatchToolCall, buildActorContext });
  return { handle, dispatched, dispatchToolCall, buildActorContext };
};

describe('page-call handler — gated dispatch on the owned tab', () => {
  test('page.click dispatches a strict click through the gated dispatcher, on the actor tab', async () => {
    const { handle, dispatched } = harness({ ok: true, content: JSON.stringify({ clicked: true, matchedCount: 1 }) });
    const out = await handle({ method: 'click', args: { selector: 'button.send' }, sessionId: 's1', tabId: 42, rid: 7 });

    expect(out).toEqual({ ok: true, value: { ok: true, clicked: true, matchedCount: 1 } });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].call.name).toBe('click');
    // locator strictness preserved + the tab PINNED to the actor's tab
    expect(dispatched[0].call.args).toEqual({ selector: 'button.send', expectedCount: 1, tabId: 42 });
    // dispatched with the actor's gated context, not some ambient one
    expect(dispatched[0].ctx).toBe(ACTOR_CTX);
  });

  test('the tab is taken from the binding, never from the call args (no aiming elsewhere)', async () => {
    const { handle, dispatched } = harness();
    // a malicious/confused worker tries to pass its own tabId
    await handle({ method: 'goto', args: { url: 'https://example.com', tabId: 999 }, sessionId: 's1', tabId: 42 });
    expect(dispatched[0].call.args.tabId).toBe(42);
  });
});

describe('page-call handler — failures surface as the worker sees them', () => {
  test('an unknown method never dispatches', async () => {
    const { handle, dispatchToolCall } = harness();
    const out = await handle({ method: 'evaluate', args: {}, sessionId: 's1', tabId: 42 });
    expect(out.ok).toBe(false);
    expect((out as any).error).toMatch(/unknown page method: evaluate/);
    expect(dispatchToolCall).not.toHaveBeenCalled();
  });

  test('a gated BLOCK (denylist/confirm/mismatch) becomes a rejection error', async () => {
    const { handle } = harness({ ok: false, error: 'gate_blocked:origin:denylisted host evil.test' });
    const out = await handle({ method: 'goto', args: { url: 'https://evil.test' }, sessionId: 's1', tabId: 42 });
    expect(out).toEqual({ ok: false, error: 'gate_blocked:origin:denylisted host evil.test' });
  });

  test('a thrown dispatcher is contained, not leaked', async () => {
    const dispatchToolCall = mock(async () => { throw new Error('boom'); });
    const buildActorContext = mock(async () => ACTOR_CTX);
    const handle = makePageCallHandler({ dispatchToolCall, buildActorContext });
    const out = await handle({ method: 'click', args: { selector: '#x' }, sessionId: 's1', tabId: 1 });
    expect(out).toEqual({ ok: false, error: 'page_dispatch_failed: boom' });
  });

  test('an unavailable actor context fails closed', async () => {
    const dispatchToolCall = mock(async () => ({ ok: true, content: '{}' }));
    const buildActorContext = mock(async () => { throw new Error('no such actor'); });
    const handle = makePageCallHandler({ dispatchToolCall, buildActorContext });
    const out = await handle({ method: 'click', args: { selector: '#x' }, sessionId: 'gone', tabId: 1 });
    expect(out.ok).toBe(false);
    expect((out as any).error).toMatch(/page_context_unavailable: no such actor/);
    expect(dispatchToolCall).not.toHaveBeenCalled();
  });
});
