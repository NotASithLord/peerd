import { afterEach, describe, expect, test } from 'bun:test';
import { makeControllerTurnBridge } from '../../extension/background/controller-turn-bridge.js';
import {
  createControllerTurnRuntime,
} from '../../extension/offscreen/controller-turn-runtime.js';
import {
  controllerOperationAllowedAfterCancel,
  createControllerKernelQuota,
} from '../../extension/shared/controller-kernel-quota.js';
import { executeControllerToolCall } from '../../extension/offscreen/controller-tool-runtime.js';
import { CONTROLLER_TOOL_MANIFEST } from '../../extension/shared/controller-tool-manifest.js';
import {
  prepareToolCall as prepareRuntimeToolCall,
  settleToolCall as settleRuntimeToolCall,
} from '../../extension/peerd-runtime/tools/dispatcher.js';
import {
  clearTools,
  registerMetadataInventory,
  registerTool,
} from '../../extension/peerd-runtime/tools/registry.js';
import { toToolDescriptor, projectToolAuthority } from '../../extension/peerd-runtime/tools/metadata/descriptor.js';
import { getToolPolicy } from '../../extension/peerd-runtime/tools/metadata/policy.js';
import {
  TOOL_EXECUTION_PROTOCOL,
  compileToolEffectManifest,
} from '../../extension/shared/tool-execution-protocol.js';
import { makeScriptedProviderAuthority } from '../peerd-provider/model-egress-fixture';

const MANIFEST_DIGEST = 'a'.repeat(64);
const manifestFor = (riskClass: 'read' | 'control' | 'commit' | 'resource') =>
  compileToolEffectManifest({
    protocol: TOOL_EXECUTION_PROTOCOL,
    digest: MANIFEST_DIGEST,
    tools: {
      remember: {
        projectionKeys: ['sessionId'],
        effects: [{
          method: 'writeMemory', operation: 'memory.write', riskClass,
          requestSchema: {
            type: 'object', properties: { fact: { type: 'string', maxLength: 64 } },
            required: ['fact'],
          },
          resultSchema: {
            type: 'object', properties: { stored: { type: 'boolean' } }, required: ['stored'],
          },
          maxCalls: 1, requestBytes: 256, resultBytes: 256,
        }],
        argumentBytes: 256, projectionBytes: 256, resultBytes: 4_096, pendingEffects: 1,
      },
    },
  });
const TOOL_MANIFEST = manifestFor('commit');
const authorityDescriptor = (name: string) => projectToolAuthority(
  toToolDescriptor(getToolPolicy(name)),
);
const descriptor = authorityDescriptor('remember');

const makeSessions = () => {
  let session: any = {
    sessionId: 'session-tool-protocol', provider: 'anthropic',
    model: 'claude-sonnet-4-6', messages: [],
  };
  return {
    get: async () => structuredClone(session),
    appendMessage: async (_sessionId: string, message: any) => {
      session = { ...session, messages: [...session.messages, structuredClone(message)] };
      return structuredClone(session);
    },
    updateAssistantMessage: async (_sessionId: string, messageId: string, patch: any) => {
      session = {
        ...session,
        messages: session.messages.map((message: any) => message.id === messageId
          ? { ...message, ...structuredClone(patch) } : message),
      };
      return structuredClone(session);
    },
    setTrimSummary: async () => structuredClone(session),
    snapshot: () => structuredClone(session),
  };
};

const context = (over: Record<string, unknown> = {}) => {
  const sessions = makeSessions();
  let round = 0;
  return {
    sessionId: 'session-tool-protocol', userText: 'remember one', sessions,
    tools: [descriptor], refreshTools: async () => [descriptor],
    classifyToolCall: () => ({ actionClass: 'write', confirm: false }),
    toolDispatch: async () => ({ ok: true, content: 'legacy' }),
    getSystemPrompt: async () => 'PINNED', appendAudit: async () => {},
    enrichTrimSummary: () => {}, signal: new AbortController().signal,
    reasoning: { enabled: false }, oneShot: true,
    callModel: async function* () {
      round += 1;
      if (round > 1) {
        yield { type: 'message-stop', stopReason: 'end_turn' };
        return;
      }
      yield { type: 'tool-use-start', id: 'tool-use-1', name: 'remember' };
      yield { type: 'tool-use-delta', id: 'tool-use-1', partialJson: '{"fact":"one"}' };
      yield { type: 'tool-use-stop', id: 'tool-use-1' };
      yield { type: 'message-stop', stopReason: 'tool_use' };
    },
    ...over,
  } as any;
};

const runHarness = async ({
  bridgeHooks = {}, executeToolCall, ctx = context(), leaveOpen = false,
  interceptKernel,
}: {
  bridgeHooks?: Record<string, unknown>;
  executeToolCall: (request: any, options: any) => Promise<any>;
  ctx?: any;
  leaveOpen?: boolean;
  interceptKernel?: (
    operation: string, payload: unknown, next: () => Promise<any>,
    invoke: (operation: string, payload: unknown) => Promise<any>,
  ) => Promise<any>;
}) => {
  let bridge!: ReturnType<typeof makeControllerTurnBridge>;
  let sequence = 0;
  const runtime = createControllerTurnRuntime({ executeToolCall });
  const getClient = async () => ({
    call: async (capability: string, payload: any, options: any) => {
      const authority = bridge.authorize(payload);
      return runtime.runControllerTurn(payload, {
        signal: options.signal,
        authority,
        kernelCall: (operation: string, kernelPayload: unknown) => {
          const invoke = (candidate: string, candidatePayload: unknown) =>
            bridge.handleKernelCall(candidate, candidatePayload, {
            capability, authority, signal: options.signal,
            deadlineAt: Date.now() + 60_000,
            });
          const next = () => invoke(operation, kernelPayload);
          return interceptKernel
            ? interceptKernel(operation, kernelPayload, next, invoke) : next();
        },
      });
    },
  });
  bridge = makeControllerTurnBridge({
    getClient, newId: () => `tool-protocol-${++sequence}`,
    toolManifest: TOOL_MANIFEST,
    providerEgress: makeScriptedProviderAuthority(() => ctx.callModel) as any,
    ...bridgeHooks,
  });
  const events = [];
  let error: any = null;
  try {
    for await (const event of bridge.runUserTurn(ctx)) events.push(event);
  } catch (cause) { error = cause; }
  if (!leaveOpen) bridge.close();
  return { bridge, events, error };
};

afterEach(() => {
  clearTools();
  registerMetadataInventory([]);
});

describe('controller turn finite tool protocol', () => {
  test('executes now through real prepare, controller, and settle phases', async () => {
    registerMetadataInventory();
    let legacy = 0;
    const toolContext = {
      audit: async () => {}, hooks: [], session: { sessionId: 'session-tool-protocol' },
      permission: { mode: 'act', confirmActions: false },
    } as any;
    const nowDescriptor = authorityDescriptor('now');
    const result = await runHarness({
      ctx: context({
        tools: [nowDescriptor], refreshTools: async () => [nowDescriptor],
        toolDispatch: async () => { legacy += 1; return { ok: true, content: 'legacy' }; },
        callModel: async function* () {
          yield { type: 'tool-use-start', id: 'tool-now-1', name: 'now' };
          yield { type: 'tool-use-delta', id: 'tool-now-1', partialJson: '{}' };
          yield { type: 'tool-use-stop', id: 'tool-now-1' };
          yield { type: 'message-stop', stopReason: 'tool_use' };
        },
      }),
      bridgeHooks: {
        toolManifest: CONTROLLER_TOOL_MANIFEST,
        prepareToolCall: async (call: any) => {
          const prepared: any = await prepareRuntimeToolCall(call, toolContext);
          return prepared?.prepared === true ? {
            mode: 'execute', custody: prepared, args: prepared.args,
            projection: {}, manifestDigest: CONTROLLER_TOOL_MANIFEST.digest,
          } : { mode: 'result', result: prepared };
        },
        handleToolEffect: async () => ({
          ok: false, code: 'tool-effect-denied', outcomeKnown: true,
        }),
        settleToolCall: async ({ custody, result }: any) => settleRuntimeToolCall(custody, {
          result: result.value,
        }),
      },
      executeToolCall: executeControllerToolCall,
    });
    expect(result.error).toBeNull();
    expect(legacy).toBe(0);
    const toolResult: any = result.events.find((event: any) => event.type === 'tool-result');
    expect(toolResult.result.ok).toBe(true);
    expect(typeof toolResult.result.content).toBe('string');
    expect(JSON.parse(toolResult.result.content)).toMatchObject({
      iso: expect.any(String), unixMs: expect.any(Number),
      timezone: expect.any(String), dayOfWeek: expect.any(String),
    });
  });

  test('executes actor_cancel through the exact actor authority operation', async () => {
    const actorCancelDescriptor = authorityDescriptor('actor_cancel');
    let legacy = 0;
    let genericExecutor = 0;
    let cancelled = '';
    let round = 0;
    const result = await runHarness({
      ctx: context({
        tools: [actorCancelDescriptor], refreshTools: async () => [actorCancelDescriptor],
        toolDispatch: async () => { legacy += 1; return { ok: true, content: 'legacy' }; },
        callModel: async function* () {
          round += 1;
          if (round > 1) {
            yield { type: 'message-stop', stopReason: 'end_turn' };
            return;
          }
          yield { type: 'tool-use-start', id: 'tool-actor-cancel-1', name: 'actor_cancel' };
          yield {
            type: 'tool-use-delta', id: 'tool-actor-cancel-1',
            partialJson: '{"taskId":"task-9"}',
          };
          yield { type: 'tool-use-stop', id: 'tool-actor-cancel-1' };
          yield { type: 'message-stop', stopReason: 'tool_use' };
        },
      }),
      bridgeHooks: {
        toolManifest: CONTROLLER_TOOL_MANIFEST,
        prepareToolCall: async (call: any) => ({
          mode: 'execute',
          custody: {
            ctx: {
              actorAuthority: {
                cancelTask: async (taskId: string) => {
                  cancelled = taskId;
                  return { ok: true, content: `cancelled ${taskId}` };
                },
              },
            },
          },
          args: call.args, projection: {}, manifestDigest: CONTROLLER_TOOL_MANIFEST.digest,
        }),
        handleToolEffect: async () => ({
          ok: false, code: 'tool-effect-denied', outcomeKnown: true,
        }),
        settleToolCall: async ({ result: execution }: any) => execution.value,
      },
      executeToolCall: async () => { genericExecutor += 1; return {}; },
    });
    expect(result.error).toBeNull();
    expect(cancelled).toBe('task-9');
    expect(legacy).toBe(0);
    expect(genericExecutor).toBe(0);
    expect(result.events).toContainEqual(expect.objectContaining({
      type: 'tool-result',
      result: expect.objectContaining({ ok: true, content: 'cancelled task-9' }),
    }));
  });

  test('retains preparation in the kernel and exposes only exact effect calls', async () => {
    const custody = Object.freeze({ private: true });
    const observed: any[] = [];
    let legacy = 0;
    const ctx = context({
      toolDispatch: async () => { legacy += 1; return { ok: true, content: 'legacy' }; },
    });
    const result = await runHarness({
      ctx,
      bridgeHooks: {
        prepareToolCall: async (call: any, _ctx: any, binding: any) => {
          observed.push(['prepare', call, binding]);
          return {
            mode: 'execute', custody, args: call.args,
            projection: { sessionId: binding.sessionId }, manifestDigest: MANIFEST_DIGEST,
          };
        },
        handleToolEffect: async (input: any) => {
          observed.push(['effect', input]);
          expect(input.custody).toBe(custody);
          return { ok: true, outcomeKnown: true, value: { stored: true } };
        },
        settleToolCall: async (input: any) => {
          observed.push(['settle', input]);
          expect(input.custody).toBe(custody);
          return input.result.value;
        },
      },
      executeToolCall: async (request, options) => {
        expect(request.argsDigest).toMatch(/^[a-f0-9]{64}$/);
        expect(request.turnGeneration).toBe(1);
        expect(options.authority).toEqual({
          ownerId: request.runId, sessionId: request.sessionId,
          target: 'tool:remember', replayClass: 'E',
        });
        const effect = await options.kernelCall('memory.write', request.args);
        expect(effect).toEqual({ ok: true, outcomeKnown: true, value: { stored: true } });
        return {
          protocol: request.protocol, executionId: request.executionId,
          argsDigest: request.argsDigest, ok: true, outcomeKnown: true,
          effectEntered: true, value: { ok: true, content: 'remembered' },
        };
      },
    });
    expect(result.error).toBeNull();
    expect(legacy).toBe(0);
    expect(observed.map(([phase]) => phase)).toEqual(['prepare', 'effect', 'settle']);
    expect(result.events).toContainEqual(expect.objectContaining({
      type: 'tool-result', result: expect.objectContaining({ content: 'remembered' }),
    }));
  });

  test('rejects malformed nested effect payloads before handler entry', async () => {
    let effects = 0;
    const settlements: any[] = [];
    const result = await runHarness({
      bridgeHooks: {
        prepareToolCall: async (call: any, _ctx: any, binding: any) => ({
          mode: 'execute', custody: binding.executionId, args: call.args,
          projection: {}, manifestDigest: MANIFEST_DIGEST,
        }),
        handleToolEffect: async () => {
          effects += 1;
          return { ok: true, outcomeKnown: true, value: { stored: true } };
        },
        settleToolCall: async (input: any) => {
          settlements.push(input.result);
          return input.result.value;
        },
      },
      executeToolCall: async (request, options) => {
        const refused = await options.kernelCall('memory.write', {
          fact: 'one', nested: { hidden: true },
        });
        expect(refused).toMatchObject({
          ok: false, code: 'tool-effect-request-invalid', outcomeKnown: true,
        });
        return {
          protocol: request.protocol, executionId: request.executionId,
          argsDigest: request.argsDigest, ok: true, outcomeKnown: true,
          effectEntered: false, value: { ok: true },
        };
      },
    });
    expect(result.error).toBeNull();
    expect(effects).toBe(0);
    expect(settlements).toContainEqual(expect.objectContaining({
      ok: true, outcomeKnown: true, effectEntered: false,
    }));
  });

  test('settles a malformed pre-effect executor result as known and retryable', async () => {
    const settlements: any[] = [];
    const result = await runHarness({
      bridgeHooks: {
        prepareToolCall: async (call: any, _ctx: any, binding: any) => ({
          mode: 'execute', custody: binding.executionId, args: call.args,
          projection: {}, manifestDigest: MANIFEST_DIGEST,
        }),
        handleToolEffect: async () => ({
          ok: true, outcomeKnown: true, value: { stored: true },
        }),
        settleToolCall: async (input: any) => {
          settlements.push(input.result);
          return input.result;
        },
      },
      executeToolCall: async (request) => ({
        protocol: request.protocol, executionId: request.executionId,
        argsDigest: request.argsDigest, ok: true, outcomeKnown: true,
        effectEntered: false, value: { ok: true }, hidden: true,
      }),
    });
    expect(result.error).toBeNull();
    expect(settlements).toContainEqual(expect.objectContaining({
      code: 'tool-execution-result-invalid', outcomeKnown: true,
      effectEntered: false, retryable: true,
    }));
  });

  test('does not trust a malformed nested commit result from the handler', async () => {
    const settlements: any[] = [];
    const result = await runHarness({
      bridgeHooks: {
        prepareToolCall: async (call: any, _ctx: any, binding: any) => ({
          mode: 'execute', custody: binding.executionId, args: call.args,
          projection: {}, manifestDigest: MANIFEST_DIGEST,
        }),
        handleToolEffect: async () => ({
          ok: true, outcomeKnown: true, value: { stored: true, hidden: true },
        }),
        settleToolCall: async (input: any) => {
          settlements.push(input.result);
          return input.result;
        },
      },
      executeToolCall: async (request, options) => {
        const effect = await options.kernelCall('memory.write', request.args);
        expect(effect).toMatchObject({
          ok: false, code: 'tool-effect-result-invalid', outcomeKnown: false,
        });
        return {
          protocol: request.protocol, executionId: request.executionId,
          argsDigest: request.argsDigest, ok: false,
          code: 'tool-effect-outcome-unknown', error: 'Malformed effect result.',
          outcomeKnown: false, effectEntered: true, retryable: false, phase: 'run',
        };
      },
    });
    expect(result.error).toMatchObject({ outcomeKnown: false, retryable: false });
    expect(settlements).toContainEqual(expect.objectContaining({
      outcomeKnown: false, effectEntered: true, retryable: false,
    }));
  });

  test('uses legacy dispatch only when kernel preparation declines hosting', async () => {
    let legacy = 0;
    let executed = 0;
    const result = await runHarness({
      ctx: context({
        toolDispatch: async () => { legacy += 1; return { ok: true, content: 'legacy' }; },
      }),
      bridgeHooks: {
        prepareToolCall: async () => null,
        handleToolEffect: async () => ({ ok: true, outcomeKnown: true }),
        settleToolCall: async () => ({ ok: true }),
      },
      executeToolCall: async () => { executed += 1; return {}; },
    });
    expect(result.error).toBeNull();
    expect(legacy).toBe(1);
    expect(executed).toBe(0);
  });

  test('keeps wait_until in the durable legacy lane', async () => {
    let legacy = 0;
    let executed = 0;
    const waitDescriptor = authorityDescriptor('wait_until');
    const result = await runHarness({
      ctx: context({
        tools: [waitDescriptor], refreshTools: async () => [waitDescriptor],
        toolDispatch: async () => { legacy += 1; return { ok: true, content: 'waited' }; },
        callModel: async function* () {
          yield { type: 'tool-use-start', id: 'tool-wait-1', name: 'wait_until' };
          yield { type: 'tool-use-delta', id: 'tool-wait-1', partialJson: '{"when":"1s"}' };
          yield { type: 'tool-use-stop', id: 'tool-wait-1' };
          yield { type: 'message-stop', stopReason: 'tool_use' };
        },
      }),
      bridgeHooks: { prepareToolCall: async () => null },
      executeToolCall: async () => { executed += 1; return {}; },
    });
    expect(result.error).toBeNull();
    expect(legacy).toBe(1);
    expect(executed).toBe(0);
  });

  test('never falls back to legacy dispatch for a controller-hosted tool', async () => {
    let legacy = 0;
    let executed = 0;
    const nowDescriptor = authorityDescriptor('now');
    const result = await runHarness({
      ctx: context({
        tools: [nowDescriptor], refreshTools: async () => [nowDescriptor],
        toolDispatch: async () => { legacy += 1; return { ok: true, content: 'legacy' }; },
        callModel: async function* () {
          yield { type: 'tool-use-start', id: 'tool-now-1', name: 'now' };
          yield { type: 'tool-use-delta', id: 'tool-now-1', partialJson: '{}' };
          yield { type: 'tool-use-stop', id: 'tool-now-1' };
          yield { type: 'message-stop', stopReason: 'tool_use' };
        },
      }),
      bridgeHooks: {
        prepareToolCall: async () => null,
        handleToolEffect: async () => ({ ok: true, outcomeKnown: true }),
        settleToolCall: async () => ({ ok: true }),
      },
      executeToolCall: async () => { executed += 1; return {}; },
    });
    expect(result.error).toBeNull();
    const toolResult: any = result.events.find((event: any) => event.type === 'tool-result');
    expect(toolResult.result).toMatchObject({
      ok: false,
      code: 'controller-tool-preparation-unavailable',
    });
    expect(legacy).toBe(0);
    expect(executed).toBe(0);
  });

  test('the kernel rejects direct legacy dispatch of a controller-hosted tool', async () => {
    let bypass: any = null;
    let legacy = 0;
    const nowDescriptor = authorityDescriptor('now');
    const result = await runHarness({
      ctx: context({
        tools: [nowDescriptor], refreshTools: async () => [nowDescriptor],
        toolDispatch: async () => { legacy += 1; return { ok: true, content: 'legacy' }; },
        callModel: async function* () {
          yield { type: 'tool-use-start', id: 'tool-now-bypass', name: 'now' };
          yield { type: 'tool-use-delta', id: 'tool-now-bypass', partialJson: '{}' };
          yield { type: 'tool-use-stop', id: 'tool-now-bypass' };
          yield { type: 'message-stop', stopReason: 'tool_use' };
        },
      }),
      bridgeHooks: { prepareToolCall: async () => null },
      executeToolCall: async () => ({}),
      interceptKernel: async (operation, payload, next, invoke) => {
        if (operation === 'turn.tool.prepare') {
          bypass = await invoke('turn.tool.dispatch', payload);
        }
        return next();
      },
    });
    expect(bypass).toMatchObject({
      ok: false, code: 'turn-controller-tool-legacy-dispatch-refused',
      outcomeKnown: true,
    });
    expect(result.error).toBeNull();
    expect(legacy).toBe(0);
  });

  test('settles a pre-effect executor loss as known and rejects its stale generation', async () => {
    const settlements: any[] = [];
    let staleEffect!: (operation: string, payload: unknown) => Promise<any>;
    const result = await runHarness({
      leaveOpen: true,
      bridgeHooks: {
        prepareToolCall: async (call: any, _ctx: any, binding: any) => ({
          mode: 'execute', custody: { id: binding.executionId }, args: call.args,
          projection: {}, manifestDigest: MANIFEST_DIGEST,
        }),
        handleToolEffect: async () => ({ ok: true, outcomeKnown: true }),
        settleToolCall: async (input: any) => {
          settlements.push(input.result);
          return {
            ok: false, error: input.result.error,
            outcomeKnown: input.result.outcomeKnown, retryable: false,
          };
        },
      },
      executeToolCall: async (_request, options) => {
        staleEffect = options.kernelCall;
        throw new Error('worker generation disappeared');
      },
    });
    expect(result.error).toBeNull();
    expect(settlements).toContainEqual(expect.objectContaining({
      code: 'tool-execution-host-lost', outcomeKnown: true,
      effectEntered: false, retryable: true,
    }));
    await expect(staleEffect('memory.write', { fact: 'late' })).rejects.toThrow();
    result.bridge.close();
  });

  test('ignores an executor effect claim when the kernel observed no effect', async () => {
    const settlements: any[] = [];
    const result = await runHarness({
      bridgeHooks: {
        prepareToolCall: async (call: any, _ctx: any, binding: any) => ({
          mode: 'execute', custody: binding.executionId, args: call.args,
          projection: {}, manifestDigest: MANIFEST_DIGEST,
        }),
        handleToolEffect: async () => ({ ok: true, outcomeKnown: true }),
        settleToolCall: async (input: any) => {
          settlements.push(input.result);
          return {
            ok: false, error: input.result.error,
            outcomeKnown: input.result.outcomeKnown,
            retryable: input.result.retryable,
          };
        },
      },
      executeToolCall: async (request) => ({
        protocol: request.protocol, executionId: request.executionId,
        argsDigest: request.argsDigest, ok: false,
        code: 'tool-execution-host-lost', error: 'Worker disappeared.',
        outcomeKnown: false, effectEntered: true, retryable: false, phase: 'run',
      }),
    });
    expect(result.error).toBeNull();
    expect(settlements).toContainEqual(expect.objectContaining({
      code: 'tool-execution-host-lost', outcomeKnown: true,
      effectEntered: false, retryable: true,
    }));
  });

  test('settles executor loss after an observed commit as known and not retryable', async () => {
    const settlements: any[] = [];
    const result = await runHarness({
      bridgeHooks: {
        prepareToolCall: async (call: any, _ctx: any, binding: any) => ({
          mode: 'execute', custody: binding.executionId, args: call.args,
          projection: {}, manifestDigest: MANIFEST_DIGEST,
        }),
        handleToolEffect: async () => ({
          ok: true, outcomeKnown: true, value: { stored: true },
        }),
        settleToolCall: async (input: any) => {
          settlements.push(input.result);
          return input.result;
        },
      },
      executeToolCall: async (request, options) => {
        await options.kernelCall('memory.write', request.args);
        return {
          protocol: request.protocol, executionId: request.executionId,
          argsDigest: request.argsDigest, ok: false,
          code: 'tool-execution-host-lost', error: 'Worker disappeared.',
          outcomeKnown: false, effectEntered: true, retryable: false, phase: 'run',
        };
      },
    });
    expect(result.error).toBeNull();
    expect(settlements).toContainEqual(expect.objectContaining({
      code: 'tool-execution-host-lost', outcomeKnown: true,
      effectEntered: true, retryable: false,
    }));
  });

  test('does not let the executor make an observed commit retryable', async () => {
    const settlements: any[] = [];
    const result = await runHarness({
      bridgeHooks: {
        prepareToolCall: async (call: any, _ctx: any, binding: any) => ({
          mode: 'execute', custody: binding.executionId, args: call.args,
          projection: {}, manifestDigest: MANIFEST_DIGEST,
        }),
        handleToolEffect: async () => ({
          ok: true, outcomeKnown: true, value: { stored: true },
        }),
        settleToolCall: async (input: any) => {
          settlements.push(input.result);
          return input.result;
        },
      },
      executeToolCall: async (request, options) => {
        await options.kernelCall('memory.write', request.args);
        return {
          protocol: request.protocol, executionId: request.executionId,
          argsDigest: request.argsDigest, ok: false,
          code: 'tool-execution-failed', error: 'Retry me.',
          outcomeKnown: true, effectEntered: true, retryable: true, phase: 'run',
        };
      },
    });
    expect(result.error).toBeNull();
    expect(settlements).toContainEqual(expect.objectContaining({
      code: 'tool-execution-failed', outcomeKnown: true,
      effectEntered: true, retryable: false,
    }));
  });

  test('settles loss during a read effect as known and retryable', async () => {
    const settlements: any[] = [];
    const result = await runHarness({
      bridgeHooks: {
        toolManifest: manifestFor('read'),
        prepareToolCall: async (call: any, _ctx: any, binding: any) => ({
          mode: 'execute', custody: binding.executionId, args: call.args,
          projection: {}, manifestDigest: MANIFEST_DIGEST,
        }),
        handleToolEffect: async () => ({
          ok: false, code: 'tool-effect-kernel-lost',
          outcomeKnown: false, retryable: false,
        }),
        settleToolCall: async (input: any) => {
          settlements.push(input.result);
          return input.result;
        },
      },
      executeToolCall: async (request, options) => {
        await options.kernelCall('memory.write', request.args);
        return {
          protocol: request.protocol, executionId: request.executionId,
          argsDigest: request.argsDigest, ok: false,
          code: 'tool-execution-host-lost', error: 'Worker disappeared.',
          outcomeKnown: false, effectEntered: true, retryable: false, phase: 'run',
        };
      },
    });
    expect(result.error).toBeNull();
    expect(settlements).toContainEqual(expect.objectContaining({
      outcomeKnown: true, effectEntered: true, retryable: true,
    }));
  });

  test('settles an expired pre-effect grant as known and retryable', async () => {
    const settlements: any[] = [];
    let effects = 0;
    const result = await runHarness({
      bridgeHooks: {
        prepareToolCall: async (call: any, _ctx: any, binding: any) => ({
          mode: 'execute', custody: binding.executionId, args: call.args,
          projection: {}, manifestDigest: MANIFEST_DIGEST,
        }),
        handleToolEffect: async () => {
          effects += 1;
          return { ok: true, outcomeKnown: true };
        },
        settleToolCall: async (input: any) => {
          settlements.push(input.result);
          return {
            ok: false, error: input.result.error,
            outcomeKnown: input.result.outcomeKnown,
            retryable: input.result.retryable,
          };
        },
      },
      executeToolCall: async (request) => ({
        protocol: request.protocol, executionId: request.executionId,
        argsDigest: request.argsDigest, ok: false,
        code: 'tool-execution-deadline-expired',
        error: 'Tool execution deadline expired.', outcomeKnown: true,
        effectEntered: false, retryable: true, phase: 'run',
      }),
    });
    expect(result.error).toBeNull();
    expect(effects).toBe(0);
    expect(settlements).toContainEqual(expect.objectContaining({
      code: 'tool-execution-deadline-expired', outcomeKnown: true,
      effectEntered: false, retryable: true,
    }));
  });

  test('Stop after effect entry settles unknown and never enters another effect', async () => {
    const abort = new AbortController();
    let admit = () => {};
    let release = () => {};
    const admitted = new Promise<void>((resolve) => { admit = resolve; });
    const effect = new Promise((resolve) => { release = () => resolve(undefined); });
    const settlements: any[] = [];
    let effects = 0;
    const running = runHarness({
      ctx: context({ signal: abort.signal }),
      bridgeHooks: {
        prepareToolCall: async (call: any, _ctx: any, binding: any) => ({
          mode: 'execute', custody: binding.executionId, args: call.args,
          projection: {}, manifestDigest: MANIFEST_DIGEST,
        }),
        handleToolEffect: async () => {
          effects += 1;
          admit();
          await effect;
          return { ok: true, outcomeKnown: true };
        },
        settleToolCall: async (input: any) => {
          settlements.push(input.result);
          return {
            ok: false, error: input.result.error,
            outcomeKnown: input.result.outcomeKnown, retryable: false,
          };
        },
      },
      executeToolCall: async (request, options) => {
        await options.kernelCall('memory.write', request.args);
        return {
          protocol: request.protocol, executionId: request.executionId,
          argsDigest: request.argsDigest, ok: true, outcomeKnown: true,
          effectEntered: true, value: { ok: true },
        };
      },
    });
    await admitted;
    abort.abort();
    release();
    const result = await running;
    expect(result.error).toMatchObject({ outcomeKnown: false });
    expect(effects).toBe(1);
    expect(settlements).toContainEqual(expect.objectContaining({
      outcomeKnown: false, effectEntered: true, retryable: false,
    }));
  });

  test('quota admits the three bounded phases and only settle survives cancellation', () => {
    const quota = createControllerKernelQuota('turn.run', { maxSteps: 1 });
    const prepare = { runId: 'run-1', value: { callJson: '{}' } };
    const effect = {
      runId: 'run-1', value: {
        executionId: 'execution-1', argsDigest: 'b'.repeat(64), turnGeneration: 1,
        operation: 'memory.write', effectPayload: { fact: 'one' },
      },
    };
    const settle = {
      runId: 'run-1', value: {
        executionId: 'execution-1', argsDigest: 'b'.repeat(64), turnGeneration: 1,
        resultJson: '{}',
      },
    };
    expect(quota.admit('turn.tool.prepare', prepare).ok).toBe(true);
    expect(quota.admit('turn.tool.effect', effect).ok).toBe(true);
    expect(quota.admit('turn.tool.settle', settle).ok).toBe(true);
    expect(controllerOperationAllowedAfterCancel('turn.run', 'turn.tool.prepare')).toBe(false);
    expect(controllerOperationAllowedAfterCancel('turn.run', 'turn.tool.effect')).toBe(false);
    expect(controllerOperationAllowedAfterCancel('turn.run', 'turn.tool.settle')).toBe(true);
  });

  test.each([
    ['read', true, true],
    ['commit', false, false],
  ] as const)('outer quota preserves pending %s effect custody', (
    riskClass, outcomeKnown, retryable,
  ) => {
    const manifest = manifestFor(riskClass);
    const quota = createControllerKernelQuota('turn.run', { maxSteps: 1 }, manifest);
    const request = {
      protocol: TOOL_EXECUTION_PROTOCOL,
      executionId: 'execution-1', runId: 'run-12345678', callId: 'call-1',
      sessionId: 'session:test', turnGeneration: 1, attempt: 0,
      toolName: 'remember', argsDigest: 'b'.repeat(64),
      manifestDigest: MANIFEST_DIGEST, args: { fact: 'one' }, projection: {},
    };
    const prepare = { runId: request.runId, value: { callJson: '{}' } };
    expect(quota.admit('turn.tool.prepare', prepare).ok).toBe(true);
    expect(quota.observe('turn.tool.prepare', prepare, {
      ok: true, outcomeKnown: true,
      value: { mode: 'execute', requestJson: JSON.stringify(request), deadlineAt: 1_000 },
    }).ok).toBe(true);
    const effect = {
      runId: request.runId, value: {
        executionId: request.executionId, argsDigest: request.argsDigest,
        turnGeneration: request.turnGeneration, operation: 'memory.write',
        effectPayload: request.args,
      },
    };
    expect(quota.pendingLoss?.('turn.tool.effect', effect)).toEqual({
      outcomeKnown, retryable,
    });
    const settle = {
      runId: request.runId, value: {
        executionId: request.executionId, argsDigest: request.argsDigest,
        turnGeneration: request.turnGeneration, resultJson: '{}',
      },
    };
    expect(quota.admit('turn.tool.settle', settle).ok).toBe(true);
    expect(quota.observe('turn.tool.settle', settle, {
      ok: true, outcomeKnown: true, value: {},
    }).ok).toBe(true);
    expect(quota.pendingLoss?.('turn.tool.effect', effect)).toEqual({
      outcomeKnown, retryable,
    });
    expect(quota.custody()).toEqual({ outcomeKnown: true, retryable: false });
  });
});
