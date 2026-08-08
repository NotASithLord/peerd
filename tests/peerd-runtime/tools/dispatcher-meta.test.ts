// The dispatcher stamps the lineage spine fields (sideEffect + origins) onto
// EXECUTED results — both success and failure — so lineage compaction can
// classify and render them. They ride in meta (off the wire).

import { describe, test, expect, afterEach } from 'bun:test';
import { dispatchToolCall } from '../../../extension/peerd-runtime/tools/dispatcher.js';
import { registerTool, clearTools } from '../../../extension/peerd-runtime/tools/registry.js';
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

afterEach(() => clearTools());

describe('dispatcher lineage spine fields', () => {
  test('success: sideEffect + origins on meta', async () => {
    registerTool(baseTool() as any);
    const r: any = await dispatchToolCall({ id: 't1', name: 'lt', args: {} } as any, ctx);
    expect(r.ok).toBe(true);
    expect(r.meta.sideEffect).toBe('read');
    expect(r.meta.origins).toEqual(['https://example.com']);
    expect(typeof r.meta.durationMs).toBe('number');
  });

  test('failure (execute throws): spine fields still present', async () => {
    registerTool(baseTool({
      sideEffect: 'mutate_external',
      origins: () => ['https://api.bank.com'],
      execute: async () => { throw new Error('boom'); },
    }) as any);
    const r: any = await dispatchToolCall({ id: 't2', name: 'lt', args: {} } as any, ctx);
    expect(r.ok).toBe(false);
    expect(r.meta.sideEffect).toBe('mutate_external');
    expect(r.meta.origins).toEqual(['https://api.bank.com']);
  });

  test('a thrown browser policy refusal preserves human and structured details', async () => {
    const verdict = classifyBrowserAutomationTarget('http://127.0.0.1/private', {
      stage: BROWSER_TARGET_STAGES.COMMITTED_ORIGIN,
    });
    if (verdict.allowed) throw new Error('expected browser target to be refused');
    registerTool(baseTool({
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
    registerTool(baseTool({
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
    registerTool(baseTool({
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
    registerTool(baseTool({
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
    registerTool(baseTool({
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
    registerTool(baseTool({
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
    registerTool(baseTool() as any);
    const { ctx: rctx, audited } = recorderCtx();
    await dispatchToolCall({ id: 't5', name: 'lt', args: {} } as any, rctx);
    await Promise.resolve();
    expect(audited.some((e) => e.type === 'tool_executed')).toBe(true);
    expect(audited.some((e) => e.type === 'tool_failed')).toBe(false);
  });

  test('a throwing tool audits tool_failed enriched with primitive + durationMs', async () => {
    registerTool(baseTool({
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
    registerTool(baseTool({ execute: async () => ({ ok: true, content: 'slice', paged: true }) }) as any);
    const r: any = await dispatchToolCall({ id: 't4b', name: 'lt', args: {} } as any, ctx);
    expect(r.ok).toBe(true);
    expect(r.paged).toBe(true);
    expect(r.meta.sideEffect).toBe('read');   // enrichment still attached
  });

  test('a lifecycle recovery rewrite preserves actor delivery custody', async () => {
    registerTool(baseTool({
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

  test('a throwing origins() fails closed at the origin gate (never reaches meta)', async () => {
    registerTool(baseTool({ origins: () => { throw new Error('origins blew up'); } }) as any);
    const r: any = await dispatchToolCall({ id: 't3', name: 'lt', args: {} } as any, ctx);
    // The origin gate runs origins() and fails CLOSED on throw — so the call
    // is blocked before execute(); the spine-field path is never reached.
    expect(r.ok).toBe(false);
    expect(r.error).toContain('gate_blocked:origin');
  });

  test('a child policy receipt reaches the model without destination details', async () => {
    registerTool(baseTool({
      primitive: 'tab',
      sideEffect: 'write',
      execute: async () => ({ ok: true, content: JSON.stringify({ clicked: true }) }),
    }) as any);
    const notice = {
      reason: 'protected_child_navigation',
      outcome: 'not_run',
      child: 'left_blank',
      retryable: false,
    };
    const queuedNotices = [notice];
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

  test('ordered child policy receipts survive one tool result', async () => {
    registerTool(baseTool({
      primitive: 'tab',
      sideEffect: 'write',
      execute: async () => ({ ok: true, content: JSON.stringify({ clicked: true }) }),
    }) as any);
    const notices = [
      { reason: 'protected_child_navigation', outcome: 'not_run', child: 'closed', retryable: false },
      { reason: 'child_navigation_failed', outcome: 'unverified', child: 'uncontained', retryable: false },
    ];
    const queuedNotices = [...notices];
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
    registerTool(baseTool({
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

  test('page_code keeps an inner page receipt even when user code discards the call result', async () => {
    const notice = {
      reason: 'protected_child_navigation', outcome: 'not_run', child: 'closed', retryable: false,
    };
    registerTool(baseTool({
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

  test('a throwing tab tool does not lose an older child receipt', async () => {
    const notice = {
      reason: 'child_navigation_failed', outcome: 'unverified', child: 'uncontained', retryable: false,
    };
    const queued = [notice];
    registerTool(baseTool({
      name: 'click',
      primitive: 'tab',
      sideEffect: 'write',
      execute: async () => { throw new Error('click exploded'); },
    }) as any);
    const result: any = await dispatchToolCall(
      { id: 'throwing-child-policy', name: 'click', args: {} } as any,
      {
        ...ctx,
        activeTab: { id: 7, url: 'https://example.com', origin: 'https://example.com' },
        consumeBrowserChildPolicyNotice: () => queued.splice(0),
        waitForBrowserChildPolicyNotice: async () => false,
      },
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain('The browser did not confirm');
    expect(result.structured.browserPolicy).toEqual(notice);
    expect(result.meta.browserPolicies).toEqual([notice]);
  });
});
