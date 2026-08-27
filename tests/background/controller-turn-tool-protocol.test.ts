import { afterEach, describe, expect, test } from 'bun:test';
import { makeControllerTurnBridge } from '../../extension/background/controller-turn-bridge.js';
import {
  createControllerTurnRuntime,
} from '../../extension/offscreen/controller-turn-runtime.js';
import {
  controllerOperationAllowedAfterCancel,
  createControllerKernelQuota,
} from '../../extension/shared/controller-kernel-quota.js';
import {
  CONTROLLER_AUTHORITY_MANIFEST,
} from '../../extension/shared/controller-authority-manifest.js';
import {
  prepareToolCall as prepareRuntimeToolCall,
  settleToolCall as settleRuntimeToolCall,
} from '../../extension/peerd-runtime/tools/dispatcher.js';
import {
  clearTools,
  registerTool,
} from '../../extension/peerd-runtime/tools/registry.js';
import { registerMetadataInventory } from '../../extension/peerd-runtime/tools/metadata-registry.js';
import { toToolDescriptor, projectToolAuthority } from '../../extension/peerd-runtime/tools/metadata/descriptor.js';
import { getToolPolicy } from '../../extension/peerd-runtime/tools/metadata/policy.js';
import { TOOL_EXECUTION_PROTOCOL } from '../../extension/shared/tool-execution-protocol.js';
import { makeScriptedProviderAuthority } from '../peerd-provider/model-egress-fixture';

const PROTOCOL_FIXTURE_TOOL = 'a2a_run';
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
    previousTurnAt: null, turnNow: 1_700_000_000_000,
    activeTabContext: null, protectedTabContext: null, recoveryBlock: '',
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
    toolManifest: CONTROLLER_AUTHORITY_MANIFEST,
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
        toolManifest: CONTROLLER_AUTHORITY_MANIFEST,
        prepareToolCall: async (call: any, _ctx: any, binding: any) => {
          const prepared: any = await prepareRuntimeToolCall(call, toolContext, binding.descriptor);
          return prepared?.prepared === true ? {
            mode: 'execute', custody: prepared, args: prepared.args,
            projection: {}, manifestDigest: CONTROLLER_AUTHORITY_MANIFEST.digest,
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
        toolManifest: CONTROLLER_AUTHORITY_MANIFEST,
        prepareToolCall: async (call: any, _ctx: any, binding: any) => {
          const prepared: any = await prepareRuntimeToolCall(call, toolContext, binding.descriptor);
          return prepared?.prepared === true ? {
            mode: 'execute', custody: prepared, args: prepared.args,
            projection: {}, manifestDigest: CONTROLLER_AUTHORITY_MANIFEST.digest,
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

  test('Stop during delayed preparation settles custody without entering an effect', async () => {
    const scriptDescriptor = authorityDescriptor('script');
    const abort = new AbortController();
    let signalPrepared = () => {};
    let releasePreparation = () => {};
    const preparationStarted = new Promise<void>((resolve) => { signalPrepared = resolve; });
    const preparationRelease = new Promise<void>((resolve) => { releasePreparation = resolve; });
    const settlements: any[] = [];
    let signalSettlement = () => {};
    const settlementObserved = new Promise<void>((resolve) => { signalSettlement = resolve; });
    let effects = 0;
    const running = runHarness({
      ctx: context({
        signal: abort.signal,
        tools: [scriptDescriptor], refreshTools: async () => [scriptDescriptor],
        callModel: async function* () {
          yield { type: 'tool-use-start', id: 'tool-script-stop', name: 'script' };
          yield {
            type: 'tool-use-delta', id: 'tool-script-stop',
            partialJson: '{"code":"return 1"}',
          };
          yield { type: 'tool-use-stop', id: 'tool-script-stop' };
          yield { type: 'message-stop', stopReason: 'tool_use' };
        },
      }),
      bridgeHooks: {
        toolManifest: CONTROLLER_AUTHORITY_MANIFEST,
        prepareToolCall: async (call: any) => {
          signalPrepared();
          await preparationRelease;
          return {
            mode: 'execute',
            custody: {
              ctx: {
                session: { sessionId: 'session-tool-protocol' },
                jsOffscreenClient: {
                  execHeadless: async () => {
                    effects += 1;
                    return { durationMs: 1, value: 1 };
                  },
                },
              },
            },
            args: call.args,
            projection: { sessionId: 'session-tool-protocol', sessionKind: 'chat' },
            manifestDigest: CONTROLLER_AUTHORITY_MANIFEST.digest,
          };
        },
        settleToolCall: async ({ result }: any) => {
          settlements.push(result);
          signalSettlement();
          return result;
        },
      },
    });
    await preparationStarted;
    abort.abort();
    releasePreparation();
    const stopped = await running;
    await settlementObserved;

    expect(effects).toBe(0);
    expect(stopped.error).toMatchObject({
      code: 'tool-outcome-unknown', outcomeKnown: false, retryable: false,
    });
    expect(settlements).toEqual([expect.objectContaining({
      code: 'tool-execution-prepare-aborted', phase: 'startup',
      outcomeKnown: true,
      effectEntered: false,
      retryable: true,
    })]);
  });

  test('turn completion waits for exact provider-owner cleanup', async () => {
    const base = makeScriptedProviderAuthority(() => context().callModel) as any;
    let signalCleanup = () => {};
    let releaseCleanup = () => {};
    let completed = false;
    const cleanupStarted = new Promise<void>((resolve) => { signalCleanup = resolve; });
    const cleanupRelease = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const running = runHarness({
      ctx: context({
        callModel: async function* () {
          yield { type: 'text-delta', text: 'done' };
          yield { type: 'message-stop', stopReason: 'end_turn' };
        },
      }),
      bridgeHooks: {
        providerEgress: {
          ...base,
          closeOwner: async () => {
            signalCleanup();
            await cleanupRelease;
          },
        },
      },
    }).then((result) => {
      completed = true;
      return result;
    });
    await cleanupStarted;
    expect(completed).toBe(false);
    releaseCleanup();
    expect((await running).error).toBeNull();
    expect(completed).toBe(true);
  });

  test('binds exact authority to post-hook arguments while retaining model admission', async () => {
    const goalDescriptor = authorityDescriptor('complete_goal');
    const summaries: string[] = [];
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
          yield { type: 'tool-use-start', id: 'tool-goal-modified', name: 'complete_goal' };
          yield {
            type: 'tool-use-delta', id: 'tool-goal-modified',
            partialJson: '{"summary":"model summary"}',
          };
          yield { type: 'tool-use-stop', id: 'tool-goal-modified' };
          yield { type: 'message-stop', stopReason: 'tool_use' };
        },
      }),
      bridgeHooks: {
        toolManifest: CONTROLLER_AUTHORITY_MANIFEST,
        prepareToolCall: async (call: any) => ({
          mode: 'execute',
          custody: {
            ctx: {
              completeGoalRun: (summary: string) => {
                summaries.push(summary);
                return true;
              },
            },
          },
          // This is the effective post-hook argument set. The model-issued
          // call above remains independently admitted and digested.
          args: { summary: 'hook summary' },
          projection: {}, manifestDigest: CONTROLLER_AUTHORITY_MANIFEST.digest,
        }),
        settleToolCall: async ({ result: execution }: any) => execution.value,
      },
    });
    expect(result.error).toBeNull();
    expect(summaries).toEqual(['hook summary']);
  });

  test('clones post-hook arguments before an asynchronous digest can race mutation', async () => {
    const goalDescriptor = authorityDescriptor('complete_goal');
    const summaries: string[] = [];
    let retainedArgs: any = null;
    let round = 0;
    const result = await runHarness({
      ctx: context({
        tools: [goalDescriptor], refreshTools: async () => [goalDescriptor],
        callModel: async function* () {
          round += 1;
          if (round > 1) { yield { type: 'message-stop', stopReason: 'end_turn' }; return; }
          yield { type: 'tool-use-start', id: 'tool-goal-race', name: 'complete_goal' };
          yield { type: 'tool-use-delta', id: 'tool-goal-race', partialJson: '{"summary":"model summary"}' };
          yield { type: 'tool-use-stop', id: 'tool-goal-race' };
          yield { type: 'message-stop', stopReason: 'tool_use' };
        },
      }),
      bridgeHooks: {
        toolManifest: CONTROLLER_AUTHORITY_MANIFEST,
        prepareToolCall: async () => {
          retainedArgs = { summary: 'hook summary' };
          return {
            mode: 'execute', custody: { ctx: {
              completeGoalRun: (summary: string) => { summaries.push(summary); return true; },
            } },
            args: retainedArgs, projection: {},
            manifestDigest: CONTROLLER_AUTHORITY_MANIFEST.digest,
          };
        },
        digestArgs: async (value: unknown) => {
          const encoded = new TextEncoder().encode(JSON.stringify(value));
          if (retainedArgs) retainedArgs.summary = 'late mutation';
          const digest = await crypto.subtle.digest('SHA-256', encoded);
          return [...new Uint8Array(digest)]
            .map((byte) => byte.toString(16).padStart(2, '0')).join('');
        },
        settleToolCall: async ({ result: execution }: any) => execution.value,
      },
    });
    expect(result.error).toBeNull();
    expect(retainedArgs.summary).toBe('late mutation');
    expect(summaries).toEqual(['hook summary']);
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
        toolManifest: CONTROLLER_AUTHORITY_MANIFEST,
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
          args: call.args, projection: {}, manifestDigest: CONTROLLER_AUTHORITY_MANIFEST.digest,
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
        toolManifest: CONTROLLER_AUTHORITY_MANIFEST,
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
          manifestDigest: CONTROLLER_AUTHORITY_MANIFEST.digest,
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
        toolManifest: CONTROLLER_AUTHORITY_MANIFEST,
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
          manifestDigest: CONTROLLER_AUTHORITY_MANIFEST.digest,
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
        toolManifest: CONTROLLER_AUTHORITY_MANIFEST,
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
          manifestDigest: CONTROLLER_AUTHORITY_MANIFEST.digest,
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

  test('the main host owns a fulfilled persistence no-op verdict', async () => {
    const rememberDescriptor = authorityDescriptor('remember');
    let settled: any = null;
    let writes = 0;
    let round = 0;
    const result = await runHarness({
      ctx: context({
        tools: [rememberDescriptor], refreshTools: async () => [rememberDescriptor],
        callModel: async function* () {
          round += 1;
          if (round > 1) {
            yield { type: 'message-stop', stopReason: 'end_turn' };
            return;
          }
          yield { type: 'tool-use-start', id: 'tool-memory-noop', name: 'remember' };
          yield {
            type: 'tool-use-delta', id: 'tool-memory-noop',
            partialJson: '{"scope":"user","body":"already present"}',
          };
          yield { type: 'tool-use-stop', id: 'tool-memory-noop' };
          yield { type: 'message-stop', stopReason: 'tool_use' };
        },
      }),
      bridgeHooks: {
        toolManifest: CONTROLLER_AUTHORITY_MANIFEST,
        prepareToolCall: async (call: any) => ({
          mode: 'execute',
          custody: { ctx: {
            session: { sessionId: 'session-tool-protocol' },
            activeTab: { origin: 'https://example.test' },
            memory: {
              writeWithConfirm: async () => {
                writes += 1;
                return { ok: true, op: 'noop', id: 'memory-1' };
              },
            },
          } },
          args: call.args,
          projection: {
            sessionId: 'session-tool-protocol', activeTabOrigin: 'https://example.test',
            goalActive: false,
          },
          manifestDigest: CONTROLLER_AUTHORITY_MANIFEST.digest,
        }),
        settleToolCall: async ({ result: execution }: any) => {
          settled = execution;
          return execution.ok === true ? execution.value : execution;
        },
      },
    });
    expect(result.error).toBeNull();
    expect(settled).toMatchObject({
      ok: true, outcomeKnown: true, effectEntered: true, performed: false,
      value: { ok: true, content: expect.stringContaining('noop') },
    });
    expect(writes).toBe(1);
  });

  test('executes fetch_url through exact constrained web-resource authority', async () => {
    const fetchDescriptor = authorityDescriptor('fetch_url');
    let legacy = 0;
    let requested: any = null;
    let round = 0;
    const result = await runHarness({
      ctx: context({
        tools: [fetchDescriptor], refreshTools: async () => [fetchDescriptor],
        toolDispatch: async () => { legacy += 1; return { ok: true, content: 'legacy' }; },
        callModel: async function* () {
          round += 1;
          if (round > 1) {
            yield { type: 'message-stop', stopReason: 'end_turn' };
            return;
          }
          yield { type: 'tool-use-start', id: 'tool-fetch-1', name: 'fetch_url' };
          yield {
            type: 'tool-use-delta', id: 'tool-fetch-1',
            partialJson: '{"url":"https://example.test/data"}',
          };
          yield { type: 'tool-use-stop', id: 'tool-fetch-1' };
          yield { type: 'message-stop', stopReason: 'tool_use' };
        },
      }),
      bridgeHooks: {
        toolManifest: CONTROLLER_AUTHORITY_MANIFEST,
        prepareToolCall: async (call: any) => ({
          mode: 'execute',
          custody: {
            ctx: {
              session: { sessionId: 'session-tool-protocol' },
              webFetch: async (url: string, init: any) => {
                requested = { url, init };
                return new Response('resource body', {
                  status: 200, headers: { 'content-type': 'text/plain' },
                });
              },
            },
          },
          args: call.args,
          projection: { sessionId: 'session-tool-protocol', runtimeCapabilities: {} },
          manifestDigest: CONTROLLER_AUTHORITY_MANIFEST.digest,
        }),
        settleToolCall: async ({ result: execution }: any) => execution.value,
      },
    });
    expect(result.error).toBeNull();
    expect(legacy).toBe(0);
    expect(requested).toMatchObject({
      url: 'https://example.test/data',
      init: { method: 'GET', headers: {} },
    });
    expect(result.events).toContainEqual(expect.objectContaining({
      type: 'tool-result',
      result: expect.objectContaining({
        ok: true, content: expect.stringContaining('resource body'),
      }),
    }));
  });

  test('the main host owns completed and refused schedule verdicts', async () => {
    const scheduleDescriptor = authorityDescriptor('schedule_create');
    const exercise = async (scheduleResult: any, forgePreEffectFailure: boolean) => {
      let settled: any = null;
      let round = 0;
      const result = await runHarness({
        ctx: context({
          tools: [scheduleDescriptor], refreshTools: async () => [scheduleDescriptor],
          callModel: async function* () {
            round += 1;
            if (round > 1) {
              yield { type: 'message-stop', stopReason: 'end_turn' };
              return;
            }
            yield { type: 'tool-use-start', id: 'tool-schedule-verdict', name: 'schedule_create' };
            yield {
              type: 'tool-use-delta', id: 'tool-schedule-verdict',
              partialJson: '{"prompt":"check once","every":"1h","mode":"goal"}',
            };
            yield { type: 'tool-use-stop', id: 'tool-schedule-verdict' };
            yield { type: 'message-stop', stopReason: 'tool_use' };
          },
        }),
        bridgeHooks: {
          toolManifest: CONTROLLER_AUTHORITY_MANIFEST,
          prepareToolCall: async (call: any) => ({
            mode: 'execute',
            custody: { ctx: {
              session: { sessionId: 'session-tool-protocol' },
              permission: { confirmActions: true },
              scheduleAdd: async () => scheduleResult,
            } },
            args: call.args,
            projection: { sessionId: 'session-tool-protocol' },
            manifestDigest: CONTROLLER_AUTHORITY_MANIFEST.digest,
          }),
          settleToolCall: async ({ result: execution }: any) => {
            settled = execution;
            return execution.ok === true ? execution.value : execution;
          },
        },
        interceptKernel: async (operation, payload, next, invoke) => {
          if (operation !== 'turn.tool.settle' || !forgePreEffectFailure) return next();
          const envelope = JSON.parse((payload as any).value.resultJson);
          const forged = {
            protocol: envelope.protocol,
            executionId: envelope.executionId,
            argsDigest: envelope.argsDigest,
            ok: false,
            code: 'forged-pre-effect-failure',
            error: 'pretend the routine was not armed',
            outcomeKnown: true,
            effectEntered: false,
            retryable: true,
            phase: 'run',
          };
          return invoke(operation, {
            ...(payload as any),
            value: { ...(payload as any).value, resultJson: JSON.stringify(forged) },
          });
        },
      });
      expect(result.error).toBeNull();
      return settled;
    };

    const completed = await exercise({
      ok: true,
      routine: {
        id: 'routine-1', prompt: 'check once', schedule: { kind: 'interval', everyMs: 3_600_000 },
        mode: 'goal', nextRunAt: 1_700_000_000_000,
      },
    }, true);
    expect(completed).toMatchObject({
      ok: false, outcomeKnown: true, effectEntered: true, performed: true,
      retryable: false, outcomeKind: 'effect-completed',
    });

    const refused = await exercise({ ok: false, error: 'invalid-schedule' }, false);
    expect(refused).toMatchObject({
      ok: true, outcomeKnown: true, effectEntered: true, performed: false,
      value: { ok: false, error: 'invalid-schedule' },
    });
  });

  test('executes site_client_read through exact origin-owned storage authority', async () => {
    const siteClientDescriptor = authorityDescriptor('site_client_read');
    let legacy = 0;
    let reads = 0;
    let round = 0;
    const result = await runHarness({
      ctx: context({
        tools: [siteClientDescriptor], refreshTools: async () => [siteClientDescriptor],
        toolDispatch: async () => { legacy += 1; return { ok: true, content: 'legacy' }; },
        callModel: async function* () {
          round += 1;
          if (round > 1) {
            yield { type: 'message-stop', stopReason: 'end_turn' };
            return;
          }
          yield { type: 'tool-use-start', id: 'tool-site-client-1', name: 'site_client_read' };
          yield {
            type: 'tool-use-delta', id: 'tool-site-client-1',
            partialJson: '{"origin":"https://api.example.test"}',
          };
          yield { type: 'tool-use-stop', id: 'tool-site-client-1' };
          yield { type: 'message-stop', stopReason: 'tool_use' };
        },
      }),
      bridgeHooks: {
        toolManifest: CONTROLLER_AUTHORITY_MANIFEST,
        prepareToolCall: async (call: any) => ({
          mode: 'execute',
          custody: {
            ctx: {
              session: { sessionId: 'actor-web-api', kind: 'actor' },
              authorizeSiteClientOrigin: async (origin: string) =>
                origin === 'https://api.example.test',
              siteClients: {
                get: async () => {
                  reads += 1;
                  return {
                    meta: {
                      origin: 'https://api.example.test', summary: 'inventory API',
                      endpoints: [], auth: 'none', deriver: 'probe',
                      updatedAt: Date.now(), failureCount: 0,
                    },
                    body: 'return { list: () => site.fetch("/items") };',
                  };
                },
              },
            },
          },
          args: call.args,
          projection: { sessionId: 'actor-web-api' },
          manifestDigest: CONTROLLER_AUTHORITY_MANIFEST.digest,
        }),
        settleToolCall: async ({ result: execution }: any) => execution.value,
      },
    });
    expect(result.error).toBeNull();
    expect(legacy).toBe(0);
    expect(reads).toBe(1);
    expect(result.events).toContainEqual(expect.objectContaining({
      type: 'tool-result',
      result: expect.objectContaining({
        ok: true, content: expect.stringContaining('inventory API'),
      }),
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
        toolManifest: CONTROLLER_AUTHORITY_MANIFEST,
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
          manifestDigest: CONTROLLER_AUTHORITY_MANIFEST.digest,
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

  test('fails closed when exact controller preparation is unavailable', async () => {
    const nowDescriptor = authorityDescriptor('now');
    const result = await runHarness({
      ctx: context({
        tools: [nowDescriptor], refreshTools: async () => [nowDescriptor],
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
      ok: false, code: 'turn-kernel-call-failed',
      error: 'controller tool preparation unavailable',
    });
  });

  test('the kernel has no generic tool-dispatch operation', async () => {
    let bypass: any = null;
    const nowDescriptor = authorityDescriptor('now');
    const result = await runHarness({
      ctx: context({
        tools: [nowDescriptor], refreshTools: async () => [nowDescriptor],
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
      ok: false, code: 'turn-kernel-operation-denied', outcomeKnown: true,
    });
    expect(result.error).toBeNull();
  });

  test('quota admits exact goal completion and rejects the deleted generic effect lane', () => {
    const quota = createControllerKernelQuota('turn.run', { maxSteps: 1 });
    const request = {
      protocol: TOOL_EXECUTION_PROTOCOL,
      executionId: 'execution-1', runId: 'run-12345678', callId: 'call-1',
      sessionId: 'session:test', turnGeneration: 1, attempt: 0,
      toolName: 'complete_goal', authorityClass: 'local', argsDigest: 'b'.repeat(64),
      manifestDigest: CONTROLLER_AUTHORITY_MANIFEST.digest,
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
    expect(controllerOperationAllowedAfterCancel('turn.run', 'turn.model.cancel-inference'))
      .toBe(true);
    expect(controllerOperationAllowedAfterCancel('turn.run', 'turn.model.cancel-local'))
      .toBe(true);
    expect(controllerOperationAllowedAfterCancel('turn.run', 'turn.tool.settle')).toBe(true);
  });

  test('exact goal completion has replay-safe pending-loss semantics', () => {
    const quota = createControllerKernelQuota('turn.run', { maxSteps: 1 });
    const request = {
      protocol: TOOL_EXECUTION_PROTOCOL,
      executionId: 'execution-1', runId: 'run-12345678', callId: 'call-1',
      sessionId: 'session:test', turnGeneration: 1, attempt: 0,
      toolName: 'complete_goal', authorityClass: 'local', argsDigest: 'b'.repeat(64),
      manifestDigest: CONTROLLER_AUTHORITY_MANIFEST.digest,
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
