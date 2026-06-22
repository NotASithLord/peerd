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

  test('a throwing origins() fails closed at the origin gate (never reaches meta)', async () => {
    registerTool(baseTool({ origins: () => { throw new Error('origins blew up'); } }) as any);
    const r: any = await dispatchToolCall({ id: 't3', name: 'lt', args: {} } as any, ctx);
    // The origin gate runs origins() and fails CLOSED on throw — so the call
    // is blocked before execute(); the spine-field path is never reached.
    expect(r.ok).toBe(false);
    expect(r.error).toContain('gate_blocked:origin');
  });
});
