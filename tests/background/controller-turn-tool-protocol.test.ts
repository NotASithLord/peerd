import { afterEach, describe, expect, test } from 'bun:test';
import { makeControllerTurnBridge } from '../../extension/background/controller-turn-bridge.js';
import {
  createControllerTurnRuntime,
} from '../../extension/offscreen/controller-turn-runtime.js';
import {
  controllerOperationAllowedAfterCancel,
  createControllerKernelQuota,
} from '../../extension/shared/controller-kernel-quota.js';
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
const PROTOCOL_FIXTURE_TOOL = 'request_review';
const manifestFor = (riskClass: 'read' | 'control' | 'commit' | 'resource') =>
  compileToolEffectManifest({
    protocol: TOOL_EXECUTION_PROTOCOL,
    digest: MANIFEST_DIGEST,
    tools: {
      request_review: {
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
const descriptor = authorityDescriptor(PROTOCOL_FIXTURE_TOOL);

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
    sessionId: 'session-tool-protocol', userText: 'run protocol fixture', sessions,
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
      yield { type: 'tool-use-start', id: 'tool-use-1', name: PROTOCOL_FIXTURE_TOOL };
      yield { type: 'tool-use-delta', id: 'tool-use-1', partialJson: '{"fact":"one"}' };
      yield { type: 'tool-use-stop', id: 'tool-use-1' };
      yield { type: 'message-stop', stopReason: 'tool_use' };
    },
    ...over,
  } as any;
};

const runHarness = async ({
  bridgeHooks = {}, ctx = context(), leaveOpen = false,
  interceptKernel,
}: {
  bridgeHooks?: Record<string, unknown>;
  ctx?: any;
  leaveOpen?: boolean;
  interceptKernel?: (
    operation: string, payload: unknown, next: () => Promise<any>,
    invoke: (operation: string, payload: unknown) => Promise<any>,
  ) => Promise<any>;
}) => {
  let bridge!: ReturnType<typeof makeControllerTurnBridge>;
  let sequence = 0;
  const runtime = createControllerTurnRuntime();
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
        settleToolCall: async ({ custody, result }: any) => settleRuntimeToolCall(custody, {
          result: result.value,
        }),
      },
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

  test('executes complete_goal through the exact goal authority operation', async () => {
    registerMetadataInventory();
    const summaries: string[] = [];
    const toolContext = {
      audit: async () => {}, hooks: [], session: { sessionId: 'session-tool-protocol' },
      permission: { mode: 'act', confirmActions: false },
      completeGoalRun: (summary: string) => { summaries.push(summary); return true; },
    } as any;
    const goalDescriptor = authorityDescriptor('complete_goal');
    let round = 0;
    const result = await runHarness({
      ctx: context({
        tools: [goalDescriptor], refreshTools: async () => [goalDescriptor],
        callModel: async function* () {
          round += 1;
          if (round > 1) {
            yield { type: 'message-stop', stopReason: 'end_turn' };
            return;
          }
          yield { type: 'tool-use-start', id: 'tool-goal-1', name: 'complete_goal' };
          yield {
            type: 'tool-use-delta', id: 'tool-goal-1',
            partialJson: '{"summary":"done"}',
          };
          yield { type: 'tool-use-stop', id: 'tool-goal-1' };
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
        settleToolCall: async ({ custody, result }: any) => settleRuntimeToolCall(custody, {
          result: result.value,
        }),
      },
    });
    expect(result.error).toBeNull();
    expect(summaries).toEqual(['done']);
    const toolResult: any = result.events.find((event: any) => event.type === 'tool-result');
    expect(toolResult.result).toMatchObject({
      ok: true, content: 'Goal run ended. Summary: done',
    });
  });

  test('executes actor_cancel through the exact actor authority operation', async () => {
    const actorCancelDescriptor = authorityDescriptor('actor_cancel');
    let legacy = 0;
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
        settleToolCall: async ({ result: execution }: any) => execution.value,
      },
    });
    expect(result.error).toBeNull();
    expect(cancelled).toBe('task-9');
    expect(legacy).toBe(0);
    expect(result.events).toContainEqual(expect.objectContaining({
      type: 'tool-result',
      result: expect.objectContaining({ ok: true, content: 'cancelled task-9' }),
    }));
  });

  test('executes pod_write through exact file authority', async () => {
    const podWriteDescriptor = authorityDescriptor('pod_write');
    let legacy = 0;
    let write: any = null;
    let round = 0;
    const result = await runHarness({
      ctx: context({
        tools: [podWriteDescriptor], refreshTools: async () => [podWriteDescriptor],
        toolDispatch: async () => { legacy += 1; return { ok: true, content: 'legacy' }; },
        callModel: async function* () {
          round += 1;
          if (round > 1) {
            yield { type: 'message-stop', stopReason: 'end_turn' };
            return;
          }
          yield { type: 'tool-use-start', id: 'tool-pod-write-1', name: 'pod_write' };
          yield {
            type: 'tool-use-delta', id: 'tool-pod-write-1',
            partialJson: '{"podId":"pod-1","path":"main.js","content":"ok"}',
          };
          yield { type: 'tool-use-stop', id: 'tool-pod-write-1' };
          yield { type: 'message-stop', stopReason: 'tool_use' };
        },
      }),
      bridgeHooks: {
        toolManifest: CONTROLLER_TOOL_MANIFEST,
        prepareToolCall: async (call: any) => ({
          mode: 'execute',
          custody: {
            ctx: {
              session: { sessionId: 'session-tool-protocol' },
              podClient: {
                writeFile: async (path: string, content: string, options: any) => {
                  write = { path, content, options };
                  return 'pod-1';
                },
              },
            },
          },
          args: call.args,
          projection: { sessionId: 'session-tool-protocol' },
          manifestDigest: CONTROLLER_TOOL_MANIFEST.digest,
        }),
        settleToolCall: async ({ result: execution }: any) => execution.value,
      },
    });
    expect(result.error).toBeNull();
    expect(write).toEqual({
      path: 'main.js', content: 'ok',
      options: { sessionId: 'session-tool-protocol', podId: 'pod-1' },
    });
    expect(legacy).toBe(0);
    expect(result.events).toContainEqual(expect.objectContaining({
      type: 'tool-result',
      result: expect.objectContaining({ ok: true, content: expect.stringContaining('main.js') }),
    }));
  });

  test('executes repo_version through exact repository authority', async () => {
    const repositoryDescriptor = authorityDescriptor('repo_version');
    let legacy = 0;
    const order: string[] = [];
    let round = 0;
    const result = await runHarness({
      ctx: context({
        tools: [repositoryDescriptor], refreshTools: async () => [repositoryDescriptor],
        toolDispatch: async () => { legacy += 1; return { ok: true, content: 'legacy' }; },
        callModel: async function* () {
          round += 1;
          if (round > 1) {
            yield { type: 'message-stop', stopReason: 'end_turn' };
            return;
          }
          yield { type: 'tool-use-start', id: 'tool-repository-1', name: 'repo_version' };
          yield {
            type: 'tool-use-delta', id: 'tool-repository-1',
            partialJson: '{"op":"checkpoint","message":"approved"}',
          };
          yield { type: 'tool-use-stop', id: 'tool-repository-1' };
          yield { type: 'message-stop', stopReason: 'tool_use' };
        },
      }),
      bridgeHooks: {
        toolManifest: CONTROLLER_TOOL_MANIFEST,
        prepareToolCall: async (call: any) => ({
          mode: 'execute',
          custody: {
            ctx: {
              actorType: 'app', actorInstanceId: 'app-1',
              repositories: {
                coordinate: async (_ref: any, operation: () => Promise<any>) => {
                  order.push('lock');
                  try { return await operation(); }
                  finally { order.push('unlock'); }
                },
                commit: async (_ref: any, options: any) => {
                  order.push(`checkpoint:${options.message}`);
                  return { oid: 'new' };
                },
              },
              appQuiescence: {
                run: async (_id: string, operation: () => Promise<any>) => {
                  order.push('quiesce');
                  const value = await operation();
                  order.push('resume');
                  return value;
                },
              },
            },
          },
          args: call.args,
          projection: { actorType: 'app', actorInstanceId: 'app-1' },
          manifestDigest: CONTROLLER_TOOL_MANIFEST.digest,
        }),
        settleToolCall: async ({ result: execution }: any) => execution.value,
      },
    });
    expect(result.error).toBeNull();
    expect(order).toEqual(['quiesce', 'lock', 'checkpoint:approved', 'unlock', 'resume']);
    expect(legacy).toBe(0);
    expect(result.events).toContainEqual(expect.objectContaining({
      type: 'tool-result',
      result: expect.objectContaining({ ok: true, content: expect.stringContaining('checkpoint') }),
    }));
  });

  test('executes remember through exact confirmed persistence authority', async () => {
    const rememberDescriptor = authorityDescriptor('remember');
    let legacy = 0;
    let write: any = null;
    let confirmed = 0;
    let round = 0;
    const result = await runHarness({
      ctx: context({
        tools: [rememberDescriptor], refreshTools: async () => [rememberDescriptor],
        toolDispatch: async () => { legacy += 1; return { ok: true, content: 'legacy' }; },
        callModel: async function* () {
          round += 1;
          if (round > 1) {
            yield { type: 'message-stop', stopReason: 'end_turn' };
            return;
          }
          yield { type: 'tool-use-start', id: 'tool-remember-1', name: 'remember' };
          yield {
            type: 'tool-use-delta', id: 'tool-remember-1',
            partialJson: '{"scope":"user","body":"approved fact"}',
          };
          yield { type: 'tool-use-stop', id: 'tool-remember-1' };
          yield { type: 'message-stop', stopReason: 'tool_use' };
        },
      }),
      bridgeHooks: {
        toolManifest: CONTROLLER_TOOL_MANIFEST,
        prepareToolCall: async (call: any) => ({
          mode: 'execute',
          custody: {
            ctx: {
              session: { sessionId: 'session-tool-protocol' },
              activeTab: { origin: 'https://example.test' },
              abortSignal: new AbortController().signal,
              confirm: async () => { confirmed += 1; return 'yes_once'; },
              memory: {
                writeWithConfirm: async (request: any) => {
                  await request.confirm({
                    op: 'create', header: 'User memory', addedLines: 1, removedLines: 0,
                  });
                  write = { scope: request.scope, body: request.body };
                  return { rejected: false, op: 'create', id: 'user' };
                },
              },
            },
          },
          args: call.args,
          projection: {
            sessionId: 'session-tool-protocol',
            activeTabOrigin: 'https://example.test', goalActive: false,
          },
          manifestDigest: CONTROLLER_TOOL_MANIFEST.digest,
        }),
        settleToolCall: async ({ result: execution }: any) => execution.value,
      },
    });
    expect(result.error).toBeNull();
    expect(write).toEqual({
      scope: {
        kind: 'user', workspace: 'https://example.test', subpath: undefined,
      },
      body: 'approved fact',
    });
    expect(confirmed).toBe(1);
    expect(legacy).toBe(0);
    expect(result.events).toContainEqual(expect.objectContaining({
      type: 'tool-result',
      result: expect.objectContaining({ ok: true, content: expect.stringContaining('user') }),
    }));
  });

  test('executes page_code through exact page-run authority', async () => {
    const pageDescriptor = authorityDescriptor('page_code');
    let legacy = 0;
    const registrations: any[] = [];
    let round = 0;
    const result = await runHarness({
      ctx: context({
        tools: [pageDescriptor], refreshTools: async () => [pageDescriptor],
        toolDispatch: async () => { legacy += 1; return { ok: true, content: 'legacy' }; },
        callModel: async function* () {
          round += 1;
          if (round > 1) {
            yield { type: 'message-stop', stopReason: 'end_turn' };
            return;
          }
          yield { type: 'tool-use-start', id: 'tool-page-code-1', name: 'page_code' };
          yield {
            type: 'tool-use-delta', id: 'tool-page-code-1',
            partialJson: '{"code":"return await page.snapshot()"}',
          };
          yield { type: 'tool-use-stop', id: 'tool-page-code-1' };
          yield { type: 'message-stop', stopReason: 'tool_use' };
        },
      }),
      bridgeHooks: {
        toolManifest: CONTROLLER_TOOL_MANIFEST,
        prepareToolCall: async (call: any) => ({
          mode: 'execute',
          custody: {
            ctx: {
              session: { sessionId: 'actor-web-1', kind: 'actor' },
              jsOffscreenClient: {
                execHeadless: async () => ({
                  value: { title: 'Example' }, consoleOutput: [], durationMs: 4, error: null,
                }),
              },
              scriptRuns: {
                mintRunId: () => 'page-run-1',
                register: (...args: any[]) => registrations.push(['register', ...args]),
                release: (...args: any[]) => registrations.push(['release', ...args]),
              },
            },
          },
          args: call.args,
          projection: {},
          manifestDigest: CONTROLLER_TOOL_MANIFEST.digest,
        }),
        settleToolCall: async ({ result: execution }: any) => execution.value,
      },
    });
    expect(result.error).toBeNull();
    expect(registrations).toEqual([
      ['register', 'page-run-1', expect.anything(), 'actor-web-1', { page: true }],
      ['release', 'page-run-1'],
    ]);
    expect(legacy).toBe(0);
    expect(result.events).toContainEqual(expect.objectContaining({
      type: 'tool-result',
      result: expect.objectContaining({ ok: true, content: expect.stringContaining('Example') }),
    }));
  });

  test('uses legacy dispatch only when kernel preparation declines hosting', async () => {
    let legacy = 0;
    const result = await runHarness({
      ctx: context({
        toolDispatch: async () => { legacy += 1; return { ok: true, content: 'legacy' }; },
      }),
      bridgeHooks: {
        prepareToolCall: async () => null,
        settleToolCall: async () => ({ ok: true }),
      },
    });
    expect(result.error).toBeNull();
    expect(legacy).toBe(1);
  });

  test('never falls back to legacy dispatch for a controller-hosted tool', async () => {
    let legacy = 0;
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
        settleToolCall: async () => ({ ok: true }),
      },
    });
    expect(result.error).toBeNull();
    const toolResult: any = result.events.find((event: any) => event.type === 'tool-result');
    expect(toolResult.result).toMatchObject({
      ok: false,
      code: 'controller-tool-preparation-unavailable',
    });
    expect(legacy).toBe(0);
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

  test('quota admits exact goal completion and rejects the deleted generic effect lane', () => {
    const quota = createControllerKernelQuota('turn.run', { maxSteps: 1 });
    const request = {
      protocol: TOOL_EXECUTION_PROTOCOL,
      executionId: 'execution-1', runId: 'run-12345678', callId: 'call-1',
      sessionId: 'session:test', turnGeneration: 1, attempt: 0,
      toolName: 'complete_goal', argsDigest: 'b'.repeat(64),
      manifestDigest: CONTROLLER_TOOL_MANIFEST.digest,
      args: { summary: 'done' }, projection: {},
    };
    const prepare = { runId: request.runId, value: { callJson: '{}' } };
    const settle = {
      runId: request.runId, value: {
        executionId: request.executionId, argsDigest: request.argsDigest, turnGeneration: 1,
        resultJson: '{}',
      },
    };
    expect(quota.admit('turn.tool.prepare', prepare).ok).toBe(true);
    expect(quota.observe('turn.tool.prepare', prepare, {
      ok: true, outcomeKnown: true,
      value: { mode: 'execute', requestJson: JSON.stringify(request), deadlineAt: 1_000 },
    }).ok).toBe(true);
    expect(quota.admit('turn.goal.complete', {
      runId: request.runId,
      value: {
        executionId: request.executionId, argsDigest: request.argsDigest,
        turnGeneration: 1, summary: 'done',
      },
    }).ok).toBe(true);
    expect(quota.admit('turn.tool.effect', { runId: request.runId, value: {} }))
      .toEqual({ ok: false, code: 'kernel-operation-denied', outcomeKnown: true });
    expect(quota.admit('turn.tool.settle', settle).ok).toBe(true);
    expect(controllerOperationAllowedAfterCancel('turn.run', 'turn.tool.prepare')).toBe(false);
    expect(controllerOperationAllowedAfterCancel('turn.run', 'turn.goal.complete')).toBe(false);
    expect(controllerOperationAllowedAfterCancel('turn.run', 'turn.tool.settle')).toBe(true);
  });

  test('exact goal completion has replay-safe pending-loss semantics', () => {
    const quota = createControllerKernelQuota('turn.run', { maxSteps: 1 });
    const request = {
      protocol: TOOL_EXECUTION_PROTOCOL,
      executionId: 'execution-1', runId: 'run-12345678', callId: 'call-1',
      sessionId: 'session:test', turnGeneration: 1, attempt: 0,
      toolName: 'complete_goal', argsDigest: 'b'.repeat(64),
      manifestDigest: CONTROLLER_TOOL_MANIFEST.digest,
      args: { summary: 'done' }, projection: {},
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
        turnGeneration: request.turnGeneration, summary: 'done',
      },
    };
    expect(quota.pendingLoss?.('turn.goal.complete', effect)).toEqual({
      outcomeKnown: true, retryable: true,
    });
  });
});
