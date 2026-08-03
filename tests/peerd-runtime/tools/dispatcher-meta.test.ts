// The dispatcher stamps the lineage spine fields (sideEffect + origins) onto
// EXECUTED results — both success and failure — so lineage compaction can
// classify and render them. They ride in meta (off the wire).

import { describe, test, expect, afterEach } from 'bun:test';
import { dispatchToolCall } from '../../../extension/peerd-runtime/tools/dispatcher.js';
import { registerTool, clearTools } from '../../../extension/peerd-runtime/tools/registry.js';

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

  test('a throwing origins() fails closed at the origin gate (never reaches meta)', async () => {
    registerTool(baseTool({ origins: () => { throw new Error('origins blew up'); } }) as any);
    const r: any = await dispatchToolCall({ id: 't3', name: 'lt', args: {} } as any, ctx);
    // The origin gate runs origins() and fails CLOSED on throw — so the call
    // is blocked before execute(); the spine-field path is never reached.
    expect(r.ok).toBe(false);
    expect(r.error).toContain('gate_blocked:origin');
  });
});
