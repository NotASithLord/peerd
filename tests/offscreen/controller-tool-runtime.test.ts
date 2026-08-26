import { describe, expect, test } from 'bun:test';
import { executeControllerToolCall } from '../../extension/offscreen/controller-tool-runtime.js';
import { CONTROLLER_TOOL_MANIFEST } from '../../extension/shared/controller-tool-manifest.js';
import { TOOL_EXECUTION_PROTOCOL } from '../../extension/shared/tool-execution-protocol.js';

const request = (over: Record<string, unknown> = {}) => ({
  protocol: TOOL_EXECUTION_PROTOCOL,
  executionId: 'execution-now-1',
  runId: 'run-now-1',
  callId: 'call-now-1',
  sessionId: 'session-now-1',
  turnGeneration: 1,
  attempt: 0,
  toolName: 'now',
  argsDigest: 'a'.repeat(64),
  manifestDigest: CONTROLLER_TOOL_MANIFEST.digest,
  args: {},
  projection: {},
  ...over,
});

const options = (toolName = 'now') => ({
  signal: new AbortController().signal,
  authority: {
    ownerId: 'run-now-1',
    sessionId: 'session-now-1',
    target: `tool:${toolName}`,
    replayClass: 'E',
  },
  deadlineAt: Date.now() + 5_000,
});

describe('controller tool runtime', () => {
  test('executes a pure tool without a kernel effect channel', async () => {
    const result = await executeControllerToolCall(request(), options());
    expect(result).toMatchObject({
      ok: true,
      outcomeKnown: true,
      effectEntered: false,
      executionId: 'execution-now-1',
    });
    const value = JSON.parse(result.value.content);
    expect(value.iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(value.unixMs).toBeNumber();
    expect(value.timezone).toBeString();
    expect(value.dayOfWeek).toBeString();
  });

  test('executes goal completion through only goal.end', async () => {
    const operations: Array<[string, unknown]> = [];
    const result = await executeControllerToolCall(request({
      executionId: 'execution-goal-1', callId: 'call-goal-1',
      toolName: 'complete_goal', args: { summary: 'done' },
    }), {
      ...options('complete_goal'),
      kernelCall: async (operation: string, payload: unknown) => {
        operations.push([operation, payload]);
        return { ok: true, value: { ended: true }, outcomeKnown: true };
      },
    });
    expect(operations).toEqual([['goal.end', { summary: 'done' }]]);
    expect(result).toMatchObject({
      ok: true, outcomeKnown: true, effectEntered: true,
      value: { ok: true, content: 'Goal run ended. Summary: done' },
    });
  });

  test('plans sandbox creation through only sandbox-scoped effects', async () => {
    const operations: Array<[string, any]> = [];
    const result = await executeControllerToolCall(request({
      executionId: 'execution-sandbox-1', callId: 'call-sandbox-1',
      toolName: 'sandbox_create', args: { kind: 'webvm', name: 'builder' },
      projection: { sessionId: 'session-now-1', dwebEnabled: false },
    }), {
      ...options('sandbox_create'),
      kernelCall: async (operation: string, payload: any) => {
        const decoded = JSON.parse(payload.json);
        operations.push([operation, decoded]);
        const value = operation === 'sandbox.record.mutate' && decoded.action === 'create'
          ? { id: 'vm-1', name: 'builder' } : null;
        return {
          ok: true, outcomeKnown: true,
          value: { json: JSON.stringify(value) },
        };
      },
    });
    expect(operations).toEqual([
      ['sandbox.record.mutate', {
        kind: 'webvm', action: 'create',
        options: { name: 'builder', ownerSessionId: 'session-now-1' },
      }],
      ['sandbox.tab.ensure', { kind: 'webvm', id: 'vm-1' }],
      ['sandbox.record.mutate', { kind: 'webvm', action: 'default', id: 'vm-1' }],
    ]);
    expect(result).toMatchObject({
      ok: true, outcomeKnown: true, effectEntered: true,
    });
    expect(JSON.parse(result.value.content)).toEqual({
      id: 'vm-1', name: 'builder', kind: 'webvm', isCurrent: true,
    });
  });

  test('rejects tools outside the compiled manifest', async () => {
    const result = await executeControllerToolCall(
      request({ toolName: 'remember' }),
      { ...options(), authority: { ...options().authority, target: 'tool:remember' } },
    );
    expect(result).toMatchObject({
      ok: false,
      code: 'tool-execution-request-invalid',
      outcomeKnown: true,
      effectEntered: false,
    });
  });
});
