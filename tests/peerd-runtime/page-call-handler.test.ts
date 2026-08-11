// Host-side page-call handler — the SW-route logic that runs a page.<method> RPC
// through the gated dispatcher on the actor's owned tab. IO is injected, so these
// pin the security-relevant wiring without a browser: the action is pinned to the
// actor's tab, every call goes through dispatchToolCall (gates inherited), a bad
// method never dispatches, and a gated block / dispatch error surfaces the way
// the worker's awaited page.* call would see it.

import { describe, test, expect, mock } from 'bun:test';
import { makePageCallHandler, resolvePageTab } from '../../extension/peerd-runtime/actor/page-call-handler.js';
import {
  browserTargetRefusalResult,
  classifyBrowserAutomationTarget,
} from '../../extension/peerd-runtime/tools/browser-automation-policy.js';

describe('resolvePageTab — first-tab adoption for the code actor', () => {
  test('an owned tab dispatches straight to it', () => {
    expect(resolvePageTab(42, 'click')).toEqual({ action: 'dispatch', tabId: 42 });
    expect(resolvePageTab(42, 'goto')).toEqual({ action: 'dispatch', tabId: 42 });
  });

  test('page.goto with NO tab ADOPTS (the fix: the code actor opens its first tab this way)', () => {
    // The bug this fixes: the code actor has no direct `navigate` to trigger the
    // tool-call actor's lazy adoptWebTab, so page.goto must be its adopt path —
    // else a fresh actor can never open a tab and every task thrashes.
    expect(resolvePageTab(null, 'goto')).toEqual({ action: 'adopt' });
    expect(resolvePageTab(undefined, 'goto')).toEqual({ action: 'adopt' });
  });

  test('any OTHER page.* with no tab is refused with an actionable message', () => {
    for (const m of ['click', 'fill', 'snapshot', 'content']) {
      const r = resolvePageTab(null, m);
      expect(r.action).toBe('refuse');
      if (r.action === 'refuse') expect(r.error).toMatch(/page\.goto/);
    }
  });
});

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
  test('a terminal inner policy result survives the page bridge', async () => {
    const { handle } = harness({
      ok: false, error: 'auth_waiting_for_user', content: 'Finish signing in.',
      endTurn: true, outcomeKind: 'pre-effect-failure',
    });
    expect(await handle({ method: 'snapshot', sessionId: 's1', tabId: 42 })).toEqual({
      ok: false,
      error: 'auth_waiting_for_user: Finish signing in.',
      endTurn: true,
      endTurnContent: 'Finish signing in.',
      endTurnOutcomeKind: 'pre-effect-failure',
    });
  });

  test('a pre-aborted run never builds context or dispatches', async () => {
    const controller = new AbortController();
    controller.abort();
    const { handle, buildActorContext, dispatchToolCall } = harness();
    const out = await handle({
      method: 'click', args: { selector: '#x' }, sessionId: 's1', tabId: 1,
      signal: controller.signal,
    });
    expect(out).toEqual({ ok: false, error: 'page_call_aborted' });
    expect(buildActorContext).not.toHaveBeenCalled();
    expect(dispatchToolCall).not.toHaveBeenCalled();
  });

  test('Stop while context is resolving prevents the gated dispatch', async () => {
    let finishContext = (_value: any) => {};
    const context = new Promise((resolve) => { finishContext = resolve; });
    const dispatchToolCall = mock(async () => ({ ok: true, content: '{}' }));
    const handle = makePageCallHandler({
      dispatchToolCall,
      buildActorContext: async () => context,
    });
    const controller = new AbortController();
    const pending = handle({
      method: 'click', args: { selector: '#x' }, sessionId: 's1', tabId: 1,
      signal: controller.signal,
    });
    controller.abort();
    finishContext(ACTOR_CTX);
    expect(await pending).toEqual({ ok: false, error: 'page_call_aborted' });
    expect(dispatchToolCall).not.toHaveBeenCalled();
  });

  test('Stop during dispatch is threaded into the gated context and suppresses its result', async () => {
    let finishDispatch = (_value: any) => {};
    const dispatched = new Promise((resolve) => { finishDispatch = resolve; });
    let seenContext: any = null;
    const handle = makePageCallHandler({
      buildActorContext: async () => ACTOR_CTX,
      dispatchToolCall: async (_call, ctx) => {
        seenContext = ctx;
        return await dispatched as any;
      },
    });
    const controller = new AbortController();
    const pending = handle({
      method: 'click', args: { selector: '#x' }, sessionId: 's1', tabId: 1,
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();
    finishDispatch({ ok: true, content: '{"clicked":true}' });
    expect(await pending).toEqual({ ok: false, error: 'page_call_aborted' });
    expect(seenContext.abortSignal).toBe(controller.signal);
  });

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

  test('a failed page call keeps host child-policy custody outside the worker error', async () => {
    const policy = {
      reason: 'child_navigation_failed', outcome: 'unverified', child: 'uncontained', retryable: false,
    };
    const { handle } = harness({
      ok: false,
      error: 'click failed',
      structured: { browserPolicy: policy },
    });
    const out = await handle({ method: 'click', args: { selector: '#x' }, sessionId: 's1', tabId: 42 });
    expect(out).toEqual({ ok: false, error: 'click failed', browserPolicies: [policy] });
  });

  test('page.goto preserves the safe browser-policy refusal prefix and copy', async () => {
    const verdict = classifyBrowserAutomationTarget(
      'http://user:pass@127.0.0.1/private?q=token');
    if (verdict.allowed) throw new Error('expected browser target to be refused');
    const { handle } = harness(browserTargetRefusalResult(verdict));
    const out = await handle({
      method: 'goto',
      args: { url: 'http://user:pass@127.0.0.1/private?q=token' },
      sessionId: 's1',
      tabId: 42,
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('expected page.goto to reject');
    expect(out.error).toStartWith('browser_private_network_blocked:');
    expect(out.error).toContain('No browser action was run');
    expect(out.error.match(/browser_private_network_blocked/g)).toHaveLength(2);
    expect(out.error).not.toContain('/private');
    expect(out.error).not.toContain('user:pass');
    expect(out.error).not.toContain('q=token');
  });

  test('page.goto preserves committed refusal cleanup truth once', async () => {
    const verdict = classifyBrowserAutomationTarget('http://127.0.0.1/private', {
      stage: 'committed_origin',
    });
    if (verdict.allowed) throw new Error('expected browser target to be refused');
    const result = browserTargetRefusalResult(verdict, { neutralized: false });
    const { handle } = harness(result);
    const out = await handle({
      method: 'goto', args: { url: 'https://public.test/redirect' }, sessionId: 's1', tabId: 42,
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('expected page.goto to reject');
    expect(out.error).toContain('Navigation loaded a localhost');
    expect(out.error).toContain('"stage":"committed_origin"');
    expect(out.error).toContain('browser_private_network_blocked');
    expect(out.error).not.toContain('/private');
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

  test('vision bytes stay separate from the shaped page value and are bounded to one image', async () => {
    const { handle } = harness({
      ok: true,
      content: JSON.stringify({ viewed: true }),
      images: [
        { data: 'old', mediaType: 'image/png' },
        { data: 'latest', mediaType: 'image/png' },
      ],
    });
    const out = await handle({ method: 'view', args: {}, sessionId: 's1', tabId: 1 });
    expect(out).toEqual({
      ok: true,
      value: { viewed: true },
      images: [{ data: 'latest', mediaType: 'image/png' }],
    });
  });
});

describe('dispatch call identity', () => {
  test('every page.* dispatch mints a UNIQUE call id — even with no rid', async () => {
    // The lifecycle tracker keys operations on (sessionId, call id); a
    // constant id made the second page write in a session read as a replay
    // of the first and refuse (wiring-review finding, PR #314).
    const { handle, dispatched } = harness();
    await handle({ method: 'click', args: { selector: 'a' }, sessionId: 's1', tabId: 42 });
    await handle({ method: 'click', args: { selector: 'a' }, sessionId: 's1', tabId: 42 });
    await handle({ method: 'goto', args: { url: 'https://example.com' }, sessionId: 's1', tabId: 42 });
    const ids = dispatched.map((d) => d.call.id);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id.startsWith('page-')).toBe(true);
  });
});
