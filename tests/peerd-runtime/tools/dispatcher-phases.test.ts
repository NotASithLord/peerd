import { afterEach, describe, expect, test } from 'bun:test';
import {
  dispatchToolCall,
  executePreparedToolCall,
  prepareToolCall,
  settleToolCall,
} from '../../../extension/peerd-runtime/tools/dispatcher.js';
import { clearTools, registerTool } from '../../../extension/peerd-runtime/tools/registry.js';

const tool = (over: Record<string, unknown> = {}) => ({
  name: 'phase_tool', description: 'phase tool', primitive: 'web', sideEffect: 'read',
  schema: { type: 'object', properties: {} }, origins: () => [],
  execute: async () => ({ ok: true, content: 'inline' }),
  ...over,
});

const context = (over: Record<string, unknown> = {}) => ({
  audit: async () => {}, hooks: [], session: { sessionId: 'session-1' },
  permission: { mode: 'act', confirmActions: false },
  ...over,
});

afterEach(() => clearTools());

describe('dispatcher phases', () => {
  test('prepare stops before execution and settle owns the durable outcome', async () => {
    const events: string[] = [];
    let inlineExecutions = 0;
    registerTool(tool({
      execute: async () => {
        inlineExecutions += 1;
        return { ok: true, content: 'inline' };
      },
    }) as any);
    const ctx = context({
      audit: async (entry: any) => { events.push(`audit:${entry.type}`); },
      lifecycle: {
        beginTracking: async () => {
          events.push('prepare:lifecycle');
          return { handle: { operationId: 'operation-1' } };
        },
        settleTracking: async () => {
          events.push('settle:lifecycle');
          return null;
        },
      },
    }) as any;

    const prepared: any = await prepareToolCall(
      { id: 'call-1', name: 'phase_tool', args: {} } as any,
      ctx,
    );
    expect(prepared.prepared).toBe(true);
    expect(inlineExecutions).toBe(0);
    expect(events).toEqual(['prepare:lifecycle']);

    const execution = await executePreparedToolCall(prepared, async (request) => {
      events.push('execute');
      expect(request.args).toEqual({});
      expect(request.execCtx.toolUseId).toBe('call-1');
      return { ok: true, content: 'injected' };
    });
    expect(inlineExecutions).toBe(0);

    const result: any = await settleToolCall(prepared, execution);
    expect(result).toMatchObject({ ok: true, content: 'injected' });
    expect(result.meta).toMatchObject({ toolName: 'phase_tool', primitive: 'web' });
    expect(events).toEqual([
      'prepare:lifecycle', 'execute', 'audit:tool_executed', 'settle:lifecycle',
    ]);
  });

  test('prepare arms quarantine before the injected executor', async () => {
    const events: string[] = [];
    registerTool(tool({ name: 'page_eval', primitive: 'tab', sideEffect: 'write' }) as any);
    const prepared: any = await prepareToolCall(
      { id: 'call-2', name: 'page_eval', args: {} } as any,
      context({
        activeTab: { id: 7, url: 'https://example.com', origin: 'https://example.com' },
        browserChildQuarantineRequired: true,
        armBrowserChildQuarantine: async () => {
          events.push('prepare:quarantine');
          return { ok: true };
        },
      }) as any,
    );
    const execution = await executePreparedToolCall(prepared, async (request) => {
      events.push('execute');
      expect(request.execCtx.browserChildQuarantineArmedTabId).toBe(7);
      return { ok: true, content: 'done' };
    });
    await settleToolCall(prepared, execution);
    expect(events).toEqual(['prepare:quarantine', 'execute']);
  });

  test('the default dispatcher and injected inline seam settle identically', async () => {
    registerTool(tool() as any);
    const inline: any = await dispatchToolCall(
      { id: 'call-3', name: 'phase_tool', args: { value: 1 } } as any,
      context() as any,
    );
    const injected: any = await dispatchToolCall(
      { id: 'call-4', name: 'phase_tool', args: { value: 1 } } as any,
      context() as any,
      { execute: (request) => request.tool.execute(request.args, request.execCtx) },
    );
    inline.meta.durationMs = 0;
    injected.meta.durationMs = 0;
    expect(injected).toEqual(inline);
  });
});
