import { afterEach, describe, expect, test } from 'bun:test';
import {
  dispatchToolCall,
  executePreparedToolCall,
  prepareToolCall,
  settleToolCall,
} from '../../../extension/peerd-runtime/tools/dispatcher.js';
import {
  clearTools,
  getTool,
  registerTool,
} from '../../../extension/peerd-runtime/tools/registry.js';
import {
  getToolDescriptor as getMetadataToolDescriptor,
  registerMetadataInventory,
} from '../../../extension/peerd-runtime/tools/metadata-registry.js';

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

afterEach(() => {
  clearTools();
  registerMetadataInventory([]);
});

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
    expect(prepared.tool).not.toHaveProperty('execute');
    expect(prepared).not.toHaveProperty('execCtx');
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

  test('inert metadata can authorize, confirm, track, and settle remote execution', async () => {
    const events: string[] = [];
    registerMetadataInventory([{
      name: 'remote_tool', primitive: 'web', sideEffect: 'write',
      originRule: { kind: 'none' },
    }]);
    const prepared: any = await prepareToolCall(
      { id: 'call-remote', name: 'remote_tool', args: { value: 1 } } as any,
      context({
        permission: { mode: 'act', confirmActions: true },
        confirm: async () => {
          events.push('confirm');
          return 'yes_once';
        },
        lifecycleUserInitiated: true,
        lifecycle: {
          requiresIntentConfirmation: async () => false,
          beginTracking: async ({ tool: descriptor }: any) => {
            events.push(`prepare:${descriptor.name}:${'execute' in descriptor}`);
            return { handle: { operationId: 'remote-operation' } };
          },
          settleTracking: async (_handle: any, outcome: any) => {
            events.push(`settle:${outcome.ok}`);
            return null;
          },
        },
      }) as any,
      getMetadataToolDescriptor('remote_tool'),
    );

    expect(prepared).toMatchObject({ prepared: true, args: { value: 1 } });
    expect(prepared.tool).not.toHaveProperty('execute');
    expect(prepared).not.toHaveProperty('execCtx');
    const execution = await executePreparedToolCall(prepared, async (request) => {
      events.push(`execute:${request.execCtx.toolUseId}`);
      expect(request.tool).not.toHaveProperty('execute');
      return { ok: true, content: 'remote' };
    });
    const result: any = await settleToolCall(prepared, execution);

    expect(result).toMatchObject({
      ok: true,
      content: 'remote',
      meta: { toolName: 'remote_tool', primitive: 'web', sideEffect: 'write' },
    });
    expect(events).toEqual([
      'confirm', 'prepare:remote_tool:false', 'execute:call-remote', 'settle:true',
    ]);
  });

  test('metadata without a local implementation fails before an effect', async () => {
    registerMetadataInventory([{
      name: 'remote_only', primitive: 'web', sideEffect: 'read',
      originRule: { kind: 'none' },
    }]);
    const prepared: any = await prepareToolCall(
      { id: 'call-missing', name: 'remote_only', args: {} } as any,
      context() as any,
      getMetadataToolDescriptor('remote_only'),
    );
    const result: any = prepared.prepared === true
      ? await settleToolCall(prepared, await executePreparedToolCall(prepared))
      : prepared;
    expect(result).toMatchObject({
      ok: false,
      error: 'tool_implementation_unavailable:remote_only',
      code: 'tool-implementation-unavailable',
      outcomeKnown: true,
      outcomeKind: 'pre-effect-failure',
      retryable: true,
    });
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
      {
        execute: (request) => {
          const implementation = getTool(request.tool.name);
          if (!implementation) throw new Error('tool implementation missing');
          return implementation.execute(request.args, request.execCtx);
        },
      },
    );
    inline.meta.durationMs = 0;
    injected.meta.durationMs = 0;
    expect(injected).toEqual(inline);
  });
});
