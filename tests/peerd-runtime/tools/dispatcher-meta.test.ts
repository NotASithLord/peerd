// The dispatcher stamps the lineage spine fields (sideEffect + origins) onto
// EXECUTED results — both success and failure — so lineage compaction can
// classify and render them. They ride in meta (off the wire).

import { describe, test, expect, afterEach } from 'bun:test';
import { createExplicitToolFixture } from './explicit-tool-fixture';
import { messageActorTool } from '../../../extension/peerd-runtime/tools/defs/message-actor.js';
import {
  BROWSER_TARGET_STAGES,
  BrowserAutomationPolicyError,
  browserTargetRefusalResult,
  classifyBrowserAutomationTarget,
  sensitiveSiteBrowserTargetVerdict,
} from '../../../extension/peerd-runtime/tools/browser-automation-policy.js';

const ctx: any = {
  audit: async () => {},
  confirm: async () => 'yes_once',
  session: { sessionId: 's' },
  permission: { mode: 'act', confirmActions: false },
};

// A ctx that records every audit entry synchronously (the dispatcher fires
// audit as fire-and-forget; the recorder pushes before its first await).
const recorderCtx = () => {
  const audited: any[] = [];
  return {
    audited,
    ctx: { ...ctx, audit: async (e: any) => { audited.push(e); } },
  };
};

const baseTool = (over: any = {}) => ({
  name: 'lt', description: 'd', primitive: 'web', sideEffect: 'read',
  schema: { type: 'object', properties: {} },
  origins: () => ['https://example.com'],
  execute: async () => ({ ok: true, content: 'body' }),
  ...over,
});

const fixture = createExplicitToolFixture();
const dispatchToolCall = fixture.dispatch;
const setFixtureTool = fixture.set;

afterEach(fixture.clear);

describe('dispatcher lineage spine fields', () => {
  test('success: sideEffect + origins on meta', async () => {
    setFixtureTool(baseTool() as any);
    const r: any = await dispatchToolCall({ id: 't1', name: 'lt', args: {} } as any, ctx);
    expect(r.ok).toBe(true);
    expect(r.meta.sideEffect).toBe('read');
    expect(r.meta.origins).toEqual(['https://example.com']);
    expect(typeof r.meta.durationMs).toBe('number');
  });

  test('failure (execute throws): spine fields still present', async () => {
    setFixtureTool(baseTool({
      sideEffect: 'mutate_external',
      origins: () => ['https://api.bank.com'],
      execute: async () => { throw new Error('boom'); },
    }) as any);
    const r: any = await dispatchToolCall(
      { id: 't2', name: 'lt', args: {} } as any,
      { ...ctx, allowlist: ['https://api.bank.com'] },
    );
    expect(r.ok).toBe(false);
    expect(r.meta.sideEffect).toBe('mutate_external');
    expect(r.meta.origins).toEqual(['https://api.bank.com']);
  });

  test('a normalized semantic throw keeps its bounded custody fields', async () => {
    setFixtureTool(baseTool({
      execute: async () => { throw Object.assign(new Error('semantic execution failed'), {
        code: 'controller-tool-execution-failed', outcomeKnown: false, retryable: true,
      }); },
    }) as any);
    const result: any = await dispatchToolCall(
      { id: 'semantic-custody', name: 'lt', args: {} } as any, ctx,
    );
    expect(result).toMatchObject({
      ok: false, error: 'semantic execution failed',
      code: 'controller-tool-execution-failed', outcomeKnown: false, retryable: false,
    });
  });

  test('a thrown browser policy refusal preserves human and structured details', async () => {
    const verdict = classifyBrowserAutomationTarget('http://127.0.0.1/private', {
      stage: BROWSER_TARGET_STAGES.COMMITTED_ORIGIN,
    });
    if (verdict.allowed) throw new Error('expected browser target to be refused');
    setFixtureTool(baseTool({
      execute: async () => { throw new BrowserAutomationPolicyError(verdict, { effectCompleted: false }); },
    }) as any);
    const r: any = await dispatchToolCall({ id: 'policy', name: 'lt', args: {} } as any, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('browser_private_network_blocked');
    expect(r.content).toContain('peerd did not run this tool');
    expect(r.content).toContain('"reason":"private_network"');
    expect(r.structured).toMatchObject({ reason: 'private_network', stage: 'committed_origin' });
    expect(r.outcomeKind).toBe('pre-effect-failure');
    expect(r.meta.origins).toEqual([]);
  });

  test('a serialized exposed error is projected without a concrete error class', async () => {
    setFixtureTool(baseTool({
      execute: async () => { throw {
        exposeToModel: true,
        code: 'typed_policy_stop',
        content: 'The action was refused. Policy: {"retryable":false}',
        structured: { retryable: false },
        outcomeKind: 'pre-effect-failure',
        message: 'realm-specific wrapper text',
      }; },
    }) as any);
    const result: any = await dispatchToolCall({ id: 'serialized', name: 'lt', args: {} } as any, ctx);
    expect(result).toMatchObject({
      ok: false,
      error: 'typed_policy_stop',
      content: 'The action was refused. Policy: {"retryable":false}',
      structured: { retryable: false },
      outcomeKind: 'pre-effect-failure',
    });
  });

  test('an unvalidated thrown marker cannot expose arbitrary fields', async () => {
    setFixtureTool(baseTool({
      execute: async () => { throw {
        exposeToModel: true,
        code: 'Bad Code',
        content: 'private body',
        structured: { secret: 'do not project' },
        outcomeKind: 'pre-effect-failure',
        message: 'ordinary failure',
      }; },
    }) as any);
    const result: any = await dispatchToolCall({ id: 'invalid', name: 'lt', args: {} } as any, ctx);
    expect(result.error).toBe('ordinary failure');
    expect(result.content).toBeUndefined();
    expect(result.structured).toBeUndefined();
  });

  test('return-value failure ({ok:false}) audits tool_failed, not tool_executed', async () => {
    setFixtureTool(baseTool({
      primitive: 'web',
      execute: async () => ({ ok: false, error: 'declined' }),
    }) as any);
    const { ctx: rctx, audited } = recorderCtx();
    const r: any = await dispatchToolCall({ id: 't4', name: 'lt', args: {} } as any, rctx);
    expect(r.ok).toBe(false);
    await Promise.resolve();
    const failed = audited.find((e) => e.type === 'tool_failed');
    expect(failed).toBeTruthy();
    expect(audited.some((e) => e.type === 'tool_executed')).toBe(false);
    expect(failed.details.primitive).toBe('web');
    expect(failed.details.error).toBe('declined');
    expect(typeof failed.details.durationMs).toBe('number');
  });

  test('a browser policy failure audits only its fixed recovery fields', async () => {
    const verdict = classifyBrowserAutomationTarget('http://127.0.0.1/private', {
      stage: BROWSER_TARGET_STAGES.COMMITTED_ORIGIN,
    });
    if (verdict.allowed) throw new Error('expected browser target to be refused');
    setFixtureTool(baseTool({
      execute: async () => browserTargetRefusalResult(verdict, {
        effectCompleted: false,
        neutralized: true,
      }),
    }) as any);
    const { ctx: rctx, audited } = recorderCtx();
    const result: any = await dispatchToolCall(
      { id: 'policy-audit', name: 'lt', args: {} } as any,
      rctx,
    );
    await Promise.resolve();
    expect(audited.find((entry) => entry.type === 'tool_failed')?.details.browserPolicy).toEqual({
      reason: 'private_network',
      stage: 'committed_origin',
      outcome: 'page_loaded_not_automated',
      retryable: false,
      neutralized: true,
    });
    expect(JSON.stringify(audited)).not.toContain('127.0.0.1');
    expect(result.meta.origins).toEqual([]);
  });

  test('a sensitive-site landing audits its URL-free recovery fields', async () => {
    setFixtureTool(baseTool({
      execute: async () => browserTargetRefusalResult(sensitiveSiteBrowserTargetVerdict(), {
        neutralized: false,
      }),
    }) as any);
    const { ctx: rctx, audited } = recorderCtx();
    await dispatchToolCall({ id: 'sensitive-audit', name: 'lt', args: {} } as any, rctx);
    await Promise.resolve();
    expect(audited.find((entry) => entry.type === 'tool_failed')?.details.browserPolicy).toEqual({
      reason: 'sensitive_site',
      stage: 'committed_origin',
      outcome: 'page_loaded_not_automated',
      retryable: false,
      neutralized: false,
    });
  });

  test('success audits tool_executed', async () => {
    setFixtureTool(baseTool() as any);
    const { ctx: rctx, audited } = recorderCtx();
    await dispatchToolCall({ id: 't5', name: 'lt', args: {} } as any, rctx);
    await Promise.resolve();
    expect(audited.some((e) => e.type === 'tool_executed')).toBe(true);
    expect(audited.some((e) => e.type === 'tool_failed')).toBe(false);
  });

  test('a throwing tool audits tool_failed enriched with primitive + durationMs', async () => {
    setFixtureTool(baseTool({
      primitive: 'web',
      execute: async () => { throw new Error('boom'); },
    }) as any);
    const { ctx: rctx, audited } = recorderCtx();
    await dispatchToolCall({ id: 't6', name: 'lt', args: {} } as any, rctx);
    await Promise.resolve();
    const failed = audited.find((e) => e.type === 'tool_failed');
    expect(failed).toBeTruthy();
    expect(failed.details.primitive).toBe('web');
    expect(failed.details.error).toBe('boom');
    expect(typeof failed.details.durationMs).toBe('number');
  });

  test('paged survives the {...result, meta} enrichment spread (the loop reads it)', async () => {
    // The agent loop redacts at the larger paged ceiling only when the DISPATCH
    // result carries paged:true — but dispatch spreads the tool result to attach
    // meta, so a spread that dropped unknown fields would silently un-page it.
    setFixtureTool(baseTool({ execute: async () => ({ ok: true, content: 'slice', paged: true }) }) as any);
    const r: any = await dispatchToolCall({ id: 't4b', name: 'lt', args: {} } as any, ctx);
    expect(r.ok).toBe(true);
    expect(r.paged).toBe(true);
    expect(r.meta.sideEffect).toBe('read');   // enrichment still attached
  });

  test('a lifecycle recovery rewrite preserves actor delivery custody', async () => {
    setFixtureTool(baseTool({
      sideEffect: 'write',
      execute: async () => ({
        ok: false,
        error: 'transport lost',
        actorDeliveryId: 'delivery-one',
        actorDeliveryIds: ['delivery-two', 'delivery-two'],
      }),
    }) as any);
    const lifecycle = {
      beginTracking: async () => ({ handle: { operationId: 'op-1' } }),
      settleTracking: async () => ({
        error: 'outcome_unknown: verify before retry',
        recovery: { category: 'verify_before_retry' },
      }),
    };

    const r: any = await dispatchToolCall(
      { id: 't-custody', name: 'lt', args: {} } as any,
      { ...ctx, lifecycle },
    );

    expect(r).toMatchObject({
      ok: false,
      error: 'outcome_unknown: verify before retry',
      actorDeliveryId: 'delivery-one',
      actorDeliveryIds: ['delivery-two'],
    });
  });

  test('outer outcome_unknown overrides stale inner actor certainty and cancellation', async () => {
    setFixtureTool(baseTool({
      name: 'message_actor',
      primitive: 'spawned',
      sideEffect: 'write',
      execute: async () => ({
        ok: false,
        error: 'clean inner policy stop',
        actorCorrelationId: 'actor-delivery',
        actorTerminal: true,
        actorOutcomeKnown: true,
        actorPerformed: false,
        actorAborted: true,
      }),
    }) as any);
    let settledOutcome: any = null;
    const lifecycle = {
      beginTracking: async () => ({ handle: { operationId: 'op-actor' } }),
      settleTracking: async (_handle: any, outcome: any) => {
        settledOutcome = outcome;
        return {
          error: 'outcome_unknown: This action may have completed, but peerd did not receive confirmation.',
          recovery: { state: 'outcome_unknown', category: 'verify_before_retry' },
        };
      },
    };

    const result: any = await dispatchToolCall(
      { id: 'actor-call', name: 'message_actor', args: { await: true } } as any,
      { ...ctx, lifecycle },
    );

    expect(settledOutcome.aborted).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      actorCorrelationId: 'actor-delivery',
      actorTerminal: true,
      actorOutcomeKnown: false,
      actorPerformed: true,
      actorAborted: false,
    });
    expect(result.error).toStartWith('outcome_unknown:');
  });

  test('message_actor Not run evidence reaches lifecycle as a typed pre-effect failure', async () => {
    setFixtureTool(messageActorTool as any);
    let settledOutcome: any = null;
    const lifecycle = {
      beginTracking: async () => ({ handle: { operationId: 'op-not-run' } }),
      settleTracking: async (_handle: any, outcome: any) => {
        settledOutcome = outcome;
        return null;
      },
    };

    const result: any = await dispatchToolCall(
      { id: 'actor-not-run', name: 'message_actor', args: { to: 'web', message: 'read it', await: true } } as any,
      {
        ...ctx,
        lifecycle,
        messageActor: async () => ({
          ok: false,
          error: 'the actor request was not run because that helper was retired.',
          actorTerminal: true,
          actorOutcomeKnown: true,
          actorPerformed: false,
        }),
      } as any,
    );

    expect(settledOutcome).toMatchObject({
      ok: false, outcomeKind: 'pre-effect-failure', aborted: false,
    });
    expect(result).toMatchObject({
      ok: false,
      error: 'the actor request was not run because that helper was retired.',
      outcomeKind: 'pre-effect-failure',
      actorOutcomeKnown: true,
      actorPerformed: false,
    });
  });

  test('a throwing origins() fails closed at the origin gate (never reaches meta)', async () => {
    setFixtureTool(baseTool({ origins: () => { throw new Error('origins blew up'); } }) as any);
    const r: any = await dispatchToolCall({ id: 't3', name: 'lt', args: {} } as any, ctx);
    // The origin gate runs origins() and fails CLOSED on throw — so the call
    // is blocked before execute(); the spine-field path is never reached.
    expect(r.ok).toBe(false);
    expect(r.error).toContain('gate_blocked:origin');
  });

  test('a child policy receipt reaches the model without destination details', async () => {
    const queuedNotices: any[] = [];
    setFixtureTool(baseTool({
      primitive: 'tab',
      sideEffect: 'write',
      execute: async () => {
        queuedNotices.push(notice);
        return { ok: true, content: JSON.stringify({ clicked: true }) };
      },
    }) as any);
    const notice = {
      reason: 'protected_child_navigation',
      outcome: 'not_run',
      child: 'left_blank',
      retryable: false,
    };
    const result: any = await dispatchToolCall(
      { id: 'child-policy', name: 'lt', args: {} } as any,
      {
        ...ctx,
        activeTab: { id: 7, url: 'https://example.com', origin: 'https://example.com' },
        consumeBrowserChildPolicyNotice: (tabId: number) => tabId === 7 ? queuedNotices.splice(0) : [],
      },
    );
    expect(JSON.parse(result.content)).toEqual({ clicked: true, browserPolicy: notice });
    expect(result.structured.browserPolicy).toEqual(notice);
    expect(JSON.stringify(result)).not.toContain('127.0.0.1');
  });

  test('a blocked child subrequest has an honest guarded receipt', async () => {
    const queuedNotices: any[] = [];
    setFixtureTool(baseTool({
      primitive: 'tab',
      sideEffect: 'write',
      execute: async () => {
        queuedNotices.push(notice);
        return { ok: true, content: 'clicked' };
      },
    }) as any);
    const notice = {
      reason: 'protected_child_request',
      outcome: 'not_run',
      child: 'guarded',
      retryable: false,
    };
    const result: any = await dispatchToolCall(
      { id: 'child-request-policy', name: 'lt', args: {} } as any,
      {
        ...ctx,
        activeTab: { id: 7, url: 'https://example.com', origin: 'https://example.com' },
        consumeBrowserChildPolicyNotice: () => queuedNotices.splice(0),
      },
    );
    expect(result.content).toContain('A protected child request did not run.');
    expect(result.content).toContain('The child tab remained guarded.');
    expect(result.structured.browserPolicy).toEqual(notice);
  });

  test('ordered child policy receipts survive one tool result', async () => {
    const queuedNotices: any[] = [];
    setFixtureTool(baseTool({
      primitive: 'tab',
      sideEffect: 'write',
      execute: async () => {
        queuedNotices.push(...notices);
        return { ok: true, content: JSON.stringify({ clicked: true }) };
      },
    }) as any);
    const notices = [
      { reason: 'protected_child_navigation', outcome: 'not_run', child: 'closed', retryable: false },
      { reason: 'child_navigation_failed', outcome: 'unverified', child: 'uncontained', retryable: false },
    ];
    const result: any = await dispatchToolCall(
      { id: 'child-policies', name: 'lt', args: {} } as any,
      {
        ...ctx,
        activeTab: { id: 7, url: 'https://example.com', origin: 'https://example.com' },
        consumeBrowserChildPolicyNotice: () => queuedNotices.splice(0),
      },
    );
    expect(JSON.parse(result.content)).toEqual({
      clicked: true,
      browserPolicy: notices[0],
      browserPolicies: notices,
    });
    expect(result.structured.browserPolicies).toEqual(notices);
    expect(result.meta.browserPolicies).toEqual(notices);
  });

  test('a delayed child receipt returns with the action that created it', async () => {
    setFixtureTool(baseTool({
      name: 'click',
      primitive: 'tab',
      sideEffect: 'write',
      execute: async () => ({ ok: true, content: JSON.stringify({ clicked: true }) }),
    }) as any);
    const notice = {
      reason: 'protected_child_navigation', outcome: 'not_run', child: 'closed', retryable: false,
    };
    let queued: any[] = [];
    const result: any = await dispatchToolCall(
      { id: 'delayed-child-policy', name: 'click', args: {} } as any,
      {
        ...ctx,
        activeTab: { id: 7, url: 'https://example.com', origin: 'https://example.com' },
        consumeBrowserChildPolicyNotice: () => queued.splice(0),
        waitForBrowserChildPolicyNotice: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          queued.push(notice);
          return true;
        },
      },
    );
    expect(JSON.parse(result.content).browserPolicy).toEqual(notice);
  });

  test('Chrome arms navigation and direct page-action tools before their effect', async () => {
    for (const name of ['navigate', 'click', 'type']) {
      fixture.clear();
      const calls: string[] = [];
      setFixtureTool(baseTool({
        name, primitive: 'tab', sideEffect: 'write',
        execute: async (_args: any, executionContext: any) => {
          if (name === 'navigate'
              && executionContext.browserChildQuarantineArmedTabId !== 7) {
            await executionContext.armBrowserChildQuarantine(7);
          }
          calls.push('effect');
          return { ok: true, content: 'done' };
        },
      }) as any);
      const result: any = await dispatchToolCall(
        { id: `quarantine-${name}`, name, args: {} } as any,
        {
          ...ctx,
          activeTab: { id: 7, url: 'https://example.com', origin: 'https://example.com' },
          browserChildQuarantineRequired: true,
          armBrowserChildQuarantine: async (tabId: number) => {
            calls.push(`arm:${tabId}`);
            return { ok: true };
          },
        },
      );
      expect(result.ok).toBe(true);
      expect(calls).toEqual(['arm:7', 'effect']);
    }
  });

  test('a failed Chrome quarantine never reaches the page effect', async () => {
    let effects = 0;
    setFixtureTool(baseTool({
      name: 'click', primitive: 'tab', sideEffect: 'write',
      execute: async () => { effects += 1; return { ok: true }; },
    }) as any);
    const result: any = await dispatchToolCall(
      { id: 'quarantine-failed', name: 'click', args: {} } as any,
      {
        ...ctx,
        activeTab: { id: 7, url: 'https://example.com', origin: 'https://example.com' },
        browserChildQuarantineRequired: true,
        armBrowserChildQuarantine: async () => ({
          ok: false, code: 'browser-child-quarantine-unavailable',
          error: 'browser_child_quarantine_unavailable',
        }),
      },
    );
    expect(effects).toBe(0);
    expect(result).toMatchObject({
      ok: false, code: 'browser-child-quarantine-unavailable',
      outcomeKind: 'pre-effect-failure', retryable: true,
    });
  });

  test('a delayed prior action receipt is detached before the next click', async () => {
    setFixtureTool(baseTool({
      name: 'click', primitive: 'tab', sideEffect: 'write',
      execute: async () => ({ ok: true, content: JSON.stringify({ clicked: true }) }),
    }) as any);
    const recorded = recorderCtx();
    const notice = {
      reason: 'protected_child_navigation', outcome: 'not_run',
      child: 'closed', retryable: false,
    };
    let queued: any[] = [];
    const dispatchCtx = {
      ...recorded.ctx,
      activeTab: { id: 7, url: 'https://example.com', origin: 'https://example.com' },
      consumeBrowserChildPolicyNotice: () => queued.splice(0),
      waitForBrowserChildPolicyNotice: async () => false,
    };
    const actionA: any = await dispatchToolCall(
      { id: 'action-a', name: 'click', args: {} } as any, dispatchCtx,
    );
    expect(actionA.structured?.browserPolicy).toBeUndefined();
    queued.push(notice);
    const actionB: any = await dispatchToolCall(
      { id: 'action-b', name: 'click', args: {} } as any, dispatchCtx,
    );
    expect(actionB.structured?.browserPolicy).toBeUndefined();
    expect(actionB.structured?.browserAsyncPolicies).toEqual([notice]);
    expect(actionB.structured?.browserAsyncPolicyAttribution).toBe('prior_action');
    expect(JSON.parse(actionB.content).browserAsyncPolicyAttribution).toBe('prior_action');
    expect(recorded.audited).toContainEqual({
      type: 'browser_child_policy_detached', details: { count: 1 },
    });
  });

  test('a guarded authority failure is retryable without exposing its destination', async () => {
    setFixtureTool(baseTool({
      name: 'click', primitive: 'tab', sideEffect: 'write',
      execute: async () => ({ ok: true, content: 'evaluated' }),
    }) as any);
    const notice = {
      reason: 'child_authority_unavailable', outcome: 'unverified',
      child: 'guarded', retryable: true,
    };
    let queued: any[] = [];
    const result: any = await dispatchToolCall(
      { id: 'authority-unavailable', name: 'click', args: {} } as any,
      {
        ...ctx,
        activeTab: { id: 7, url: 'https://example.com', origin: 'https://example.com' },
        consumeBrowserChildPolicyNotice: () => queued.splice(0),
        waitForBrowserChildPolicyNotice: async () => { queued.push(notice); return true; },
      },
    );
    expect(result.structured.browserPolicy).toEqual(notice);
    expect(result.content).toContain('retry');
    expect(JSON.stringify(result)).not.toContain('127.0.0.1');
  });

  test('a pending cold child outcome cannot move to the next action', async () => {
    setFixtureTool(baseTool({
      name: 'click', primitive: 'tab', sideEffect: 'write',
      execute: async () => ({ ok: true, content: JSON.stringify({ clicked: true }) }),
    }) as any);
    const notice = {
      reason: 'child_navigation_unverified', outcome: 'unverified',
      child: 'uncontained', retryable: false,
    };
    let pending = true;
    let queued: any[] = [];
    const waits: any[] = [];
    const dispatchCtx = {
      ...ctx,
      activeTab: { id: 7, url: 'https://example.com', origin: 'https://example.com' },
      consumeBrowserChildPolicyNotice: () => queued.splice(0),
      hasPendingBrowserChildPolicy: () => pending,
      waitForBrowserChildPolicyNotice: async (_tabId: number, timeoutMs: number,
        terminal = false) => {
        waits.push([timeoutMs, terminal]);
        if (terminal) {
          pending = false;
          queued.push(notice);
          return true;
        }
        return false;
      },
    };
    const first: any = await dispatchToolCall(
      { id: 'cold-child-first', name: 'click', args: {} } as any, dispatchCtx,
    );
    expect(first.structured.browserPolicy).toEqual(notice);
    expect(waits).toEqual([[175, false], [5_000, true]]);
    const second: any = await dispatchToolCall(
      { id: 'cold-child-second', name: 'click', args: {} } as any, dispatchCtx,
    );
    expect(second.structured?.browserPolicy).toBeUndefined();
  });

  test('page_code keeps an inner page receipt even when user code discards the call result', async () => {
    const notice = {
      reason: 'protected_child_navigation', outcome: 'not_run', child: 'closed', retryable: false,
    };
    setFixtureTool(baseTool({
      name: 'page_code',
      primitive: 'web',
      sideEffect: 'write',
      execute: async () => ({
        ok: true,
        content: '> await page.click("#open")\n[CODE OPS]\n#1 page.click → ok',
        browserChildPolicyNotices: [notice],
      }),
    }) as any);
    const result: any = await dispatchToolCall(
      { id: 'page-code-child-policy', name: 'page_code', args: { code: 'await page.click("#open")' } } as any,
      {
        ...ctx,
        activeTab: { id: 7, url: 'https://example.com', origin: 'https://example.com' },
        consumeBrowserChildPolicyNotice: () => [],
      },
    );
    expect(result.content).toContain('[HOST POLICY]');
    expect(result.content).toContain('The child tab was closed.');
    expect(result.browserChildPolicyNotices).toBeUndefined();
    expect(result.structured.browserPolicy).toEqual(notice);
    expect(result.meta.browserPolicies).toEqual([notice]);
  });

  test('a throwing tab tool never claims an older child receipt', async () => {
    const notice = {
      reason: 'child_navigation_failed', outcome: 'unverified', child: 'uncontained', retryable: false,
    };
    const queued = [notice];
    setFixtureTool(baseTool({
      name: 'click',
      primitive: 'tab',
      sideEffect: 'write',
      execute: async () => { throw new Error('click exploded'); },
    }) as any);
    const recorded = recorderCtx();
    const result: any = await dispatchToolCall(
      { id: 'throwing-child-policy', name: 'click', args: {} } as any,
      {
        ...recorded.ctx,
        activeTab: { id: 7, url: 'https://example.com', origin: 'https://example.com' },
        consumeBrowserChildPolicyNotice: () => queued.splice(0),
        waitForBrowserChildPolicyNotice: async () => false,
      },
    );
    expect(result.ok).toBe(false);
    expect(result.structured?.browserPolicy).toBeUndefined();
    expect(result.meta?.browserPolicies).toEqual([]);
    expect(result.structured?.browserAsyncPolicies).toEqual([notice]);
    expect(result.meta?.browserAsyncPolicies).toEqual([notice]);
    expect(recorded.audited).toContainEqual({
      type: 'browser_child_policy_detached', details: { count: 1 },
    });
  });
});
