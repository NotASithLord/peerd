import { describe, expect, test } from 'bun:test';
import {
  TOOL_EXECUTION_PROTOCOL,
  compileToolEffectManifest,
} from '../../extension/shared/tool-execution-protocol.js';
import { createToolExecutionHost } from '../../extension/offscreen/tool-execution-host.js';

const digest = 'a'.repeat(64);
const argsDigest = 'b'.repeat(64);
const manifest = compileToolEffectManifest({
  protocol: TOOL_EXECUTION_PROTOCOL,
  digest,
  tools: {
    remember: {
      projectionKeys: ['sessionId'],
      effects: [{
        method: 'writeMemory', operation: 'memory.write', maxCalls: 1,
        requestBytes: 1_024, resultBytes: 1_024,
      }],
      argumentBytes: 1_024, projectionBytes: 1_024, resultBytes: 4_096, pendingEffects: 1,
    },
  },
});
const payload = {
  protocol: TOOL_EXECUTION_PROTOCOL,
  executionId: 'execution-1',
  runId: 'run-1',
  callId: 'tool-use-1',
  sessionId: 'session-1',
  turnGeneration: 3,
  attempt: 0,
  toolName: 'remember',
  argsDigest,
  manifestDigest: digest,
  args: { fact: 'one' },
  projection: { sessionId: 'session-1' },
};
const options = (over: Record<string, unknown> = {}) => ({
  signal: new AbortController().signal,
  authority: {
    ownerId: 'run-1', sessionId: 'session-1', target: 'tool:remember', replayClass: 'E',
  },
  deadlineAt: Date.now() + 10_000,
  kernelCall: async () => ({ ok: true, outcomeKnown: true, value: { stored: true } }),
  ...over,
});

describe('controller tool execution host', () => {
  test('gives implementation only declared exact effect methods', async () => {
    const calls: Array<[string, unknown]> = [];
    const host = createToolExecutionHost({
      manifest,
      implementations: {
        remember: async (args, context) => {
          expect(args).toEqual({ fact: 'one' });
          expect(Object.keys(context.effects)).toEqual(['writeMemory']);
          expect((context.effects as any).call).toBeUndefined();
          const stored = await context.effects.writeMemory(args);
          return { ok: stored.ok, content: 'saved' };
        },
      },
    });
    const result: any = await host.dispatch(payload, options({
      kernelCall: async (operation: string, input: unknown) => {
        calls.push([operation, input]);
        return { ok: true, outcomeKnown: true, value: { stored: true } };
      },
    }) as any);
    expect(calls).toEqual([['memory.write', { fact: 'one' }]]);
    expect(result).toMatchObject({
      ok: true, outcomeKnown: true, effectEntered: true,
      executionId: 'execution-1', argsDigest,
      value: { ok: true, content: 'saved' },
    });
  });

  test('refuses authority retargeting before implementation or effect', async () => {
    let executions = 0;
    const host = createToolExecutionHost({
      manifest,
      implementations: { remember: async () => { executions += 1; return { ok: true }; } },
    });
    const result: any = await host.dispatch(payload, options({
      authority: {
        ownerId: 'run-1', sessionId: 'session-1',
        target: 'tool:inspect', replayClass: 'E',
      },
    }) as any);
    expect(result).toMatchObject({
      ok: false, code: 'tool-execution-authority-invalid', outcomeKnown: true,
      effectEntered: false,
    });
    expect(executions).toBe(0);
  });

  test('closes late effect methods after settlement', async () => {
    const calls: string[] = [];
    let lateEffect!: (payload: unknown) => Promise<any>;
    const host = createToolExecutionHost({
      manifest,
      implementations: {
        remember: async (_args, context) => {
          lateEffect = context.effects.writeMemory;
          return { ok: true };
        },
      },
    });
    const result: any = await host.dispatch(payload, options({
      kernelCall: async (operation: string) => {
        calls.push(operation);
        return { ok: true, outcomeKnown: true };
      },
    }) as any);
    expect(result).toMatchObject({ ok: true, effectEntered: false });
    expect(await lateEffect({ fact: 'late' })).toMatchObject({
      ok: false, code: 'tool-effect-grant-settled', outcomeKnown: true,
    });
    expect(calls).toEqual([]);
  });

  test('a deadline during an entered effect settles unknown and denies its late reply', async () => {
    let now = 100;
    let fireDeadline!: () => void;
    let resolveEffect!: (value: unknown) => void;
    const effect = new Promise((resolve) => { resolveEffect = resolve; });
    const host = createToolExecutionHost({
      manifest,
      implementations: {
        remember: async (args, context) => context.effects.writeMemory(args),
      },
      now: () => now,
      setTimeoutFn: ((callback: () => void) => { fireDeadline = callback; return 1; }) as any,
      clearTimeoutFn: (() => {}) as any,
    });
    const running = host.dispatch(payload, options({
      deadlineAt: 200,
      kernelCall: async () => effect,
    }) as any);
    await Promise.resolve();
    await Promise.resolve();
    now = 200;
    fireDeadline();
    const result: any = await running;
    expect(result).toMatchObject({
      ok: false, code: 'tool-execution-deadline-expired', outcomeKnown: false,
      effectEntered: true, retryable: false,
    });
    resolveEffect({ ok: true, outcomeKnown: true });
    await Promise.resolve();
  });

  test('a replacement generation starts clean while the retired grant stays closed', async () => {
    let oldEffect!: (payload: unknown) => Promise<any>;
    const oldHost = createToolExecutionHost({
      manifest,
      implementations: {
        remember: async (_args, context) => {
          oldEffect = context.effects.writeMemory;
          return { ok: true };
        },
      },
    });
    await oldHost.dispatch(payload, options() as any);
    const calls: string[] = [];
    const replacement = createToolExecutionHost({
      manifest,
      implementations: {
        remember: async (args, context) => context.effects.writeMemory(args),
      },
    });
    const fresh: any = await replacement.dispatch(
      { ...payload, executionId: 'execution-2', attempt: 1 },
      options({
        kernelCall: async (operation: string) => {
          calls.push(operation);
          return { ok: true, outcomeKnown: true };
        },
      }) as any,
    );
    expect(fresh).toMatchObject({ ok: true, executionId: 'execution-2', effectEntered: true });
    expect(await oldEffect({ fact: 'late' })).toMatchObject({
      ok: false, code: 'tool-effect-grant-settled', outcomeKnown: true,
    });
    expect(calls).toEqual(['memory.write']);
  });
});
