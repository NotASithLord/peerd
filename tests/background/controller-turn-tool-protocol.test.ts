import { afterEach, describe, expect, test } from 'bun:test';
import { makeControllerTurnBridge } from '../../extension/background/controller-turn-bridge.js';
import { createAuthorityEffectScheduler } from '../../extension/background/authority-effect-scheduler.js';
import {
  createControllerTurnRuntime,
} from '../../extension/offscreen/controller-turn-runtime.js';
import {
  clearTools,
  registerTool,
} from '../../extension/peerd-runtime/tools/registry.js';
import { registerMetadataInventory } from '../../extension/peerd-runtime/tools/metadata-registry.js';
import { toToolDescriptor, projectToolAuthority } from '../../extension/peerd-runtime/tools/metadata/descriptor.js';
import { getToolPolicy } from '../../extension/peerd-runtime/tools/metadata/policy.js';
import { controllerOperationsForTools } from '../../extension/peerd-runtime/controller-tool-ownership.js';
import { ORCHESTRATOR_OPERATION_GRANT } from '../../extension/shared/controller-kernel-quota.js';
import { makeScriptedProviderAuthority } from '../peerd-provider/model-egress-fixture';

const PROTOCOL_FIXTURE_TOOL = 'a2a_run';
const authorityDescriptor = (name: string) => projectToolAuthority(
  toToolDescriptor(getToolPolicy(name)),
);
const descriptor = authorityDescriptor(PROTOCOL_FIXTURE_TOOL);
const orchestratorOperations = new Set(ORCHESTRATOR_OPERATION_GRANT);
const surfaceFor = (tools: any[]) => ({
  tools,
  operations: controllerOperationsForTools(tools.map((tool) => tool.name))
    .filter((operation) => orchestratorOperations.has(operation)),
});
const withOperationSurface = (ctx: any) => {
  const initialSurface = surfaceFor(Array.isArray(ctx.tools) ? ctx.tools : []);
  const refreshTools = ctx.refreshTools;
  return {
    ...ctx,
    allowedOperations: Array.isArray(ctx.allowedOperations)
      ? ctx.allowedOperations : initialSurface.operations,
    refreshTools: async () => {
      const refreshed = await refreshTools();
      return Array.isArray(refreshed) ? surfaceFor(refreshed) : refreshed;
    },
  };
};

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
    session: { sessionId: 'session-tool-protocol', kind: 'chat' },
    tools: [descriptor], refreshTools: async () => [descriptor],
    semanticPolicy: { exposure: 'main', permission: { mode: 'act', confirmActions: false } },
    permission: { mode: 'act', confirmActions: false },
    readAuthorityPermission: async () => ({ mode: 'act', confirmActions: false }),
    lifecycle: {
      requiresIntentConfirmation: async () => false,
      beginTracking: async () => ({ handle: {} }),
      settleTracking: async () => {},
    },
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
  ctx = withOperationSurface(ctx);
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
    providerEgress: makeScriptedProviderAuthority(() => ctx.callModel) as any,
    ...bridgeHooks,
  });
  const events = [];
  let error: any = null;
  try {
    for await (const event of bridge.runUserTurn(withOperationSurface(ctx))) events.push(event);
  } catch (cause) { error = cause; }
  if (!leaveOpen) bridge.close();
  return { bridge, events, error };
};

afterEach(() => {
  clearTools();
  registerMetadataInventory([]);
});

describe('controller turn finite tool protocol', () => {
  test('executes now entirely in the semantic realm without tool lifecycle RPC', async () => {
    registerMetadataInventory();
    let legacy = 0;
    const audits: any[] = [];
    const nowDescriptor = authorityDescriptor('now');
    const kernelOperations: string[] = [];
    const result = await runHarness({
      ctx: context({
        appendAudit: async (entry: any) => { audits.push(entry); },
        tools: [nowDescriptor], refreshTools: async () => [nowDescriptor],
        toolDispatch: async () => { legacy += 1; return { ok: true, content: 'legacy' }; },
        callModel: async function* () {
          yield { type: 'tool-use-start', id: 'tool-now-1', name: 'now' };
          yield { type: 'tool-use-delta', id: 'tool-now-1', partialJson: '{}' };
          yield { type: 'tool-use-stop', id: 'tool-now-1' };
          yield { type: 'message-stop', stopReason: 'tool_use' };
        },
      }),
      interceptKernel: async (operation, _payload, next) => {
        kernelOperations.push(operation);
        return next();
      },
    });
    expect(result.error).toBeNull();
    expect(legacy).toBe(0);
    expect(kernelOperations).not.toContain('turn.tool.prepare');
    expect(kernelOperations).not.toContain('turn.tool.settle');
    const toolResult: any = result.events.find((event: any) => event.type === 'tool-result');
    expect(toolResult.result.ok).toBe(true);
    expect(typeof toolResult.result.content).toBe('string');
    expect(JSON.parse(toolResult.result.content)).toMatchObject({
      iso: expect.any(String), unixMs: expect.any(Number),
      timezone: expect.any(String), dayOfWeek: expect.any(String),
    });
    expect(audits).toContainEqual(expect.objectContaining({
      type: 'semantic_report', sessionId: 'session-tool-protocol',
      details: expect.objectContaining({
        tool: 'now', callId: 'tool-now-1', semantic: true,
        outcome: 'semantic-success', performed: false,
      }),
    }));
  });

  test('executes complete_goal through the exact goal authority operation', async () => {
    registerMetadataInventory();
    const summaries: string[] = [];
    const goalDescriptor = authorityDescriptor('complete_goal');
    let round = 0;
    const kernelOperations: string[] = [];
    const result = await runHarness({
      ctx: context({
        tools: [goalDescriptor], refreshTools: async () => [goalDescriptor],
        semanticPolicy: { permission: { mode: 'act', confirmActions: false } },
        completeGoalRun: (summary: string) => { summaries.push(summary); return true; },
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
      interceptKernel: async (operation, _payload, next) => {
        kernelOperations.push(operation);
        return next();
      },
    });
    expect(result.error).toBeNull();
    expect(summaries).toEqual(['done']);
    expect(kernelOperations.filter((operation) => operation === 'turn.goal.complete')).toHaveLength(1);
    expect(kernelOperations).not.toContain('turn.tool.prepare');
    expect(kernelOperations).not.toContain('turn.tool.settle');
    const toolResult: any = result.events.find((event: any) => event.type === 'tool-result');
    expect(toolResult.result).toMatchObject({
      ok: true, content: 'Goal run ended. Summary: done',
    });
  });

  test('the host permits goal completion as Plan-safe internal bookkeeping', async () => {
    registerMetadataInventory();
    let completed = 0;
    const goalDescriptor = authorityDescriptor('complete_goal');
    const result = await runHarness({
      ctx: context({
        tools: [goalDescriptor], refreshTools: async () => [goalDescriptor],
        semanticPolicy: { permission: { mode: 'plan', confirmActions: false } },
        permission: { mode: 'plan', confirmActions: false },
        readAuthorityPermission: async () => ({ mode: 'plan', confirmActions: false }),
        completeGoalRun: () => { completed += 1; return true; },
        callModel: async function* () {
          yield { type: 'tool-use-start', id: 'tool-goal-plan', name: 'complete_goal' };
          yield {
            type: 'tool-use-delta', id: 'tool-goal-plan',
            partialJson: '{"summary":"forged transition"}',
          };
          yield { type: 'tool-use-stop', id: 'tool-goal-plan' };
          yield { type: 'message-stop', stopReason: 'tool_use' };
        },
      }),
    });
    expect(result.error).toBeNull();
    expect(completed).toBe(1);
    const toolResult: any = result.events.find((event: any) => event.type === 'tool-result');
    expect(toolResult.result).toMatchObject({
      ok: true, content: 'Goal run ended. Summary: forged transition',
    });
  });

  test('the host re-reads a newly enabled Act confirmation before mutation', async () => {
    registerMetadataInventory();
    const scheduleDescriptor = authorityDescriptor('schedule_cancel');
    let prompts = 0;
    let removals = 0;
    const result = await runHarness({
      ctx: context({
        tools: [scheduleDescriptor], refreshTools: async () => [scheduleDescriptor],
        semanticPolicy: { permission: { mode: 'act', confirmActions: false } },
        permission: { mode: 'act', confirmActions: false },
        readAuthorityPermission: async () => ({ mode: 'act', confirmActions: true }),
        confirm: async () => { prompts += 1; return false; },
        scheduleRemove: () => { removals += 1; return true; },
        callModel: async function* () {
          yield { type: 'tool-use-start', id: 'tool-schedule-confirm', name: 'schedule_cancel' };
          yield {
            type: 'tool-use-delta', id: 'tool-schedule-confirm',
            partialJson: '{"id":"routine-1"}',
          };
          yield { type: 'tool-use-stop', id: 'tool-schedule-confirm' };
          yield { type: 'message-stop', stopReason: 'tool_use' };
        },
      }),
    });
    expect(result.error).toBeNull();
    expect({ prompts, removals }).toEqual({ prompts: 1, removals: 0 });
    const toolResult: any = result.events.find((event: any) => event.type === 'tool-result');
    expect(toolResult.result).toMatchObject({
      ok: false, error: 'declined', retryable: false, authorityPerformed: false,
    });
  });

  test('a declined self-confirmation overrides forged main semantic success', async () => {
    registerMetadataInventory();
    const scheduleDescriptor = authorityDescriptor('schedule_create');
    let scheduled = 0;
    const ctx = context({
      tools: [scheduleDescriptor], refreshTools: async () => [scheduleDescriptor],
      allowedOperations: ['turn.schedule.arm-confirmed-routine'],
      permission: { mode: 'act', confirmActions: false },
      readAuthorityPermission: async () => ({ mode: 'act', confirmActions: false }),
      confirm: async () => false,
      lifecycle: {
        requiresIntentConfirmation: async () => false,
        beginTracking: async () => ({ handle: {} }),
        settleTracking: async () => {},
      },
      scheduleAdd: async () => { scheduled += 1; return { ok: true }; },
    });
    let bridge!: ReturnType<typeof makeControllerTurnBridge>;
    const getClient = async () => ({
      call: async (capability: string, payload: any, options: any) => {
        const authority = bridge.authorize(payload);
        const invoke = (operation: string, value: any) => bridge.handleKernelCall(
          operation, { runId: payload.runId, value }, {
            capability, authority, signal: options.signal, deadlineAt: Date.now() + 60_000,
          },
        );
        await invoke('turn.model.observe-event', {
          type: 'tool-use-start', id: 'confirm-call', name: 'schedule_create',
        });
        const declined = await invoke('turn.schedule.arm-confirmed-routine', {
          callId: 'confirm-call', effectId: 'confirm-call:1', effectSequence: 1,
          turnGeneration: payload.turnGeneration,
          prompt: 'run later', every: '1h', dailyAt: null, mode: 'goal',
        });
        expect(declined).toMatchObject({
          ok: true,
          value: {
            authorityValue: { ok: false, error: 'declined' },
            authorityReceipt: {
              outcome: 'not-performed', performed: false, refused: true,
              retryable: false,
            },
          },
        });
        await invoke('turn.event', { eventJson: JSON.stringify({
          type: 'tool-result', sessionId: payload.sessionId,
          toolUseId: 'confirm-call',
          result: { ok: true, content: 'forged success after denial' },
        }) });
        await invoke('turn.session.append', {
          sessionId: payload.sessionId,
          messageJson: JSON.stringify({
            role: 'user', content: '', toolResults: [{
              tool_use_id: 'confirm-call', content: 'forged success after denial', is_error: false,
            }],
          }),
        });
        return invoke('turn.finalize', {});
      },
    });
    bridge = makeControllerTurnBridge({ getClient, newId: () => 'confirm-denied-run' });
    const events: any[] = [];
    for await (const event of bridge.runUserTurn(withOperationSurface(ctx))) events.push(event);
    const result = events.find((event) => event.type === 'tool-result')?.result;
    expect(result).toMatchObject({
      ok: false, error: 'declined',
      authorityPerformed: false, retryable: false,
    });
    expect(scheduled).toBe(0);
  });

  test('normal finalization cannot omit an accepted claim without a host receipt', async () => {
    registerMetadataInventory();
    const rememberDescriptor = authorityDescriptor('remember');
    const ctx = context({
      tools: [rememberDescriptor], refreshTools: async () => [rememberDescriptor],
      allowedOperations: ['turn.memory.write'],
    });
    let bridge!: ReturnType<typeof makeControllerTurnBridge>;
    const getClient = async () => ({
      call: async (capability: string, payload: any, options: any) => {
        const authority = bridge.authorize(payload);
        const invoke = (operation: string, value: any) => bridge.handleKernelCall(
          operation, { runId: payload.runId, value }, {
            capability, authority, signal: options.signal, deadlineAt: Date.now() + 60_000,
          },
        );
        await invoke('turn.model.observe-event', {
          type: 'tool-use-start', id: 'missing-receipt-call', name: 'remember',
        });
        const shared = { value: 1 };
        const effect = await invoke('turn.memory.write', {
          callId: 'missing-receipt-call', effectId: 'missing-receipt-call:1',
          effectSequence: 1, turnGeneration: payload.turnGeneration,
          scope: { kind: 'user', workspace: '', first: shared, second: shared },
          body: 'never written',
        });
        expect(effect).toMatchObject({
          ok: false, error: 'domain authority arguments are invalid', outcomeKnown: true,
        });
        return invoke('turn.finalize', {});
      },
    });
    bridge = makeControllerTurnBridge({ getClient, newId: () => 'missing-receipt-run' });
    let failure: any = null;
    try {
      for await (const _event of bridge.runUserTurn(withOperationSurface(ctx))) { /* none */ }
    } catch (cause) { failure = cause; }
    expect(failure).toMatchObject({
      code: 'turn-kernel-call-failed', outcomeKnown: false, retryable: false,
    });
    expect(failure.message).toContain('authority result was not persisted');
  });

  for (const change of ['plan', 'confirm'] as const) {
    test(`a queued main effect rechecks live ${change} policy at the physical edge`, async () => {
      registerMetadataInventory();
      const scheduleDescriptor = authorityDescriptor('schedule_cancel');
      const authorityScheduler = createAuthorityEffectScheduler();
      let mode = 'act';
      let confirmActions = false;
      let removals = 0;
      let trackingCount = 0;
      let releaseFirst!: () => void;
      let firstEntered!: () => void;
      let secondTracked!: () => void;
      const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const firstStarted = new Promise<void>((resolve) => { firstEntered = resolve; });
      const secondPrepared = new Promise<void>((resolve) => { secondTracked = resolve; });
      const makeModel = (id: string) => {
        let round = 0;
        return async function* () {
          round += 1;
          if (round > 1) {
            yield { type: 'message-stop', stopReason: 'end_turn' };
            return;
          }
          yield { type: 'tool-use-start', id, name: 'schedule_cancel' };
          yield { type: 'tool-use-delta', id, partialJson: `{"id":"${id}"}` };
          yield { type: 'tool-use-stop', id };
          yield { type: 'message-stop', stopReason: 'tool_use' };
        };
      };
      const makeContext = (id: string) => context({
        tools: [scheduleDescriptor], refreshTools: async () => [scheduleDescriptor],
        semanticPolicy: { permission: { mode: 'act', confirmActions: false } },
        permission: { mode: 'act', confirmActions: false },
        readAuthorityPermission: async () => ({ mode, confirmActions }),
        confirm: async () => false,
        lifecycle: {
          requiresIntentConfirmation: async () => false,
          beginTracking: async () => {
            trackingCount += 1;
            if (trackingCount === 2) secondTracked();
            return { handle: {} };
          },
          settleTracking: async () => {},
        },
        scheduleRemove: async () => {
          removals += 1;
          if (removals === 1) {
            firstEntered();
            await firstGate;
          }
          return true;
        },
        callModel: makeModel(id),
      });
      const first = runHarness({
        ctx: makeContext('queued-first'), bridgeHooks: { authorityScheduler },
      });
      await firstStarted;
      const second = runHarness({
        ctx: makeContext('queued-second'), bridgeHooks: { authorityScheduler },
      });
      await secondPrepared;
      if (change === 'plan') mode = 'plan';
      else confirmActions = true;
      releaseFirst();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult.error).toBeNull();
      expect(secondResult.error).toBeNull();
      expect(removals).toBe(1);
      const secondTool: any = secondResult.events.find((event: any) => event.type === 'tool-result');
      expect(secondTool.result).toMatchObject({ ok: false, authorityPerformed: false });
    });
  }

  test('the main tool-result boundary closes and drains its exact effect', async () => {
    registerMetadataInventory();
    const scheduleDescriptor = authorityDescriptor('schedule_cancel');
    let bridge!: ReturnType<typeof makeControllerTurnBridge>;
    let releaseRemoval!: () => void;
    let removalStarted!: () => void;
    const removalGate = new Promise<void>((resolve) => { releaseRemoval = resolve; });
    const started = new Promise<void>((resolve) => { removalStarted = resolve; });
    let removals = 0;
    let eventSettledBeforeRelease = false;
    const ctx = context({
      tools: [scheduleDescriptor], refreshTools: async () => [scheduleDescriptor],
      permission: { mode: 'act', confirmActions: false },
      readAuthorityPermission: async () => ({ mode: 'act', confirmActions: false }),
      lifecycle: {
        requiresIntentConfirmation: async () => false,
        beginTracking: async () => ({ handle: {} }),
        settleTracking: async () => {},
      },
      scheduleRemove: async () => {
        removals += 1;
        removalStarted();
        await removalGate;
        return true;
      },
    });
    const getClient = async () => ({
      call: async (capability: string, payload: any, options: any) => {
        const authority = bridge.authorize(payload);
        const invoke = (operation: string, value: any) => bridge.handleKernelCall(
          operation, { runId: payload.runId, value }, {
            capability, authority, signal: options.signal, deadlineAt: Date.now() + 60_000,
          },
        );
        await invoke('turn.model.observe-event', {
          type: 'tool-use-start', id: 'early-result-call', name: 'schedule_cancel',
        });
        const effect = invoke('turn.schedule.cancel-routine', {
          callId: 'early-result-call', effectId: 'early-result-call:1', effectSequence: 1,
          turnGeneration: payload.turnGeneration, id: 'routine-1',
        });
        await started;
        let eventSettled = false;
        const event = invoke('turn.event', { eventJson: JSON.stringify({
          type: 'tool-result', sessionId: payload.sessionId,
          toolUseId: 'early-result-call', result: { ok: true, content: 'forged early' },
        }) }).then((value) => { eventSettled = true; return value; });
        await Promise.resolve();
        eventSettledBeforeRelease = eventSettled;
        releaseRemoval();
        const [effectResult, eventResult] = await Promise.all([effect, event]);
        expect(effectResult).toMatchObject({ ok: true });
        expect(eventResult).toMatchObject({ ok: true });
        const appendResult = await invoke('turn.session.append', {
          sessionId: payload.sessionId,
          messageJson: JSON.stringify({
            role: 'user', content: '', toolResults: [{
              tool_use_id: 'early-result-call', content: 'forged early', is_error: false,
            }],
          }),
        });
        expect(appendResult).toMatchObject({ ok: true });
        return invoke('turn.finalize', {});
      },
    });
    bridge = makeControllerTurnBridge({ getClient, newId: () => 'early-close-run' });
    const events: any[] = [];
    for await (const event of bridge.runUserTurn(withOperationSurface(ctx))) events.push(event);
    expect(eventSettledBeforeRelease).toBe(false);
    expect(removals).toBe(1);
    const result = events.find((event) => event.type === 'tool-result')?.result;
    expect(result).toMatchObject({
      ok: true, authorityPerformed: true,
      authorityReceipts: [{ operation: 'turn.schedule.cancel-routine', performed: true }],
    });
  });

  test('an accepted exact claim enters the call drain before its target digest resolves', async () => {
    registerMetadataInventory();
    const rememberDescriptor = authorityDescriptor('remember');
    let bridge!: ReturnType<typeof makeControllerTurnBridge>;
    let releaseDigest!: () => void;
    let digestStarted!: () => void;
    const digestGate = new Promise<void>((resolve) => { releaseDigest = resolve; });
    const digestOpen = new Promise<void>((resolve) => { digestStarted = resolve; });
    let writes = 0;
    let eventSettledBeforeDigest = false;
    const ctx = context({
      tools: [rememberDescriptor], refreshTools: async () => [rememberDescriptor],
      permission: { mode: 'act', confirmActions: false },
      readAuthorityPermission: async () => ({ mode: 'act', confirmActions: false }),
      lifecycle: {
        requiresIntentConfirmation: async () => false,
        beginTracking: async () => ({ handle: {} }),
        settleTracking: async () => {},
      },
      memory: {
        writeWithConfirm: async () => {
          writes += 1;
          return { ok: true, op: 'append', id: 'memory-digest' };
        },
      },
    });
    const getClient = async () => ({
      call: async (capability: string, payload: any, options: any) => {
        const authority = bridge.authorize(payload);
        const invoke = (operation: string, value: any) => bridge.handleKernelCall(
          operation, { runId: payload.runId, value }, {
            capability, authority, signal: options.signal, deadlineAt: Date.now() + 60_000,
          },
        );
        await invoke('turn.model.observe-event', {
          type: 'tool-use-start', id: 'digest-race-call', name: 'remember',
        });
        const effect = invoke('turn.memory.write', {
          callId: 'digest-race-call', effectId: 'digest-race-call:1', effectSequence: 1,
          turnGeneration: payload.turnGeneration,
          scope: { kind: 'user', workspace: '', subpath: null }, body: 'digest race',
        });
        await digestOpen;
        let eventSettled = false;
        const event = invoke('turn.event', { eventJson: JSON.stringify({
          type: 'tool-result', sessionId: payload.sessionId,
          toolUseId: 'digest-race-call', result: { ok: true, content: 'early' },
        }) }).then((value) => { eventSettled = true; return value; });
        await Promise.resolve();
        eventSettledBeforeDigest = eventSettled;
        expect(writes).toBe(0);
        releaseDigest();
        const [effectResult, eventResult] = await Promise.all([effect, event]);
        expect(effectResult).toMatchObject({ ok: true });
        expect(eventResult).toMatchObject({ ok: true });
        await invoke('turn.session.append', {
          sessionId: payload.sessionId,
          messageJson: JSON.stringify({
            role: 'user', content: '', toolResults: [{
              tool_use_id: 'digest-race-call', content: 'early', is_error: false,
            }],
          }),
        });
        return invoke('turn.finalize', {});
      },
    });
    bridge = makeControllerTurnBridge({
      getClient, newId: () => 'digest-race-run',
      digestArgs: async () => {
        digestStarted();
        await digestGate;
        return 'a'.repeat(64);
      },
    });
    const events: any[] = [];
    for await (const event of bridge.runUserTurn(withOperationSurface(ctx))) events.push(event);
    expect(eventSettledBeforeDigest).toBe(false);
    expect(writes).toBe(1);
    expect(events.find((event) => event.type === 'tool-result')?.result).toMatchObject({
      authorityPerformed: true,
      authorityReceipts: [{ operation: 'turn.memory.write', performed: true }],
    });
  });

  test('Stop during exact target hashing prevents the accepted claim from entering its host', async () => {
    registerMetadataInventory();
    const rememberDescriptor = authorityDescriptor('remember');
    const controller = new AbortController();
    let bridge!: ReturnType<typeof makeControllerTurnBridge>;
    let releaseDigest!: () => void;
    let digestStarted!: () => void;
    const digestGate = new Promise<void>((resolve) => { releaseDigest = resolve; });
    const digestOpen = new Promise<void>((resolve) => { digestStarted = resolve; });
    let writes = 0;
    let effectResult: any;
    const ctx = context({
      signal: controller.signal,
      tools: [rememberDescriptor], refreshTools: async () => [rememberDescriptor],
      permission: { mode: 'act', confirmActions: false },
      readAuthorityPermission: async () => ({ mode: 'act', confirmActions: false }),
      lifecycle: {
        requiresIntentConfirmation: async () => false,
        beginTracking: async () => ({ handle: {} }), settleTracking: async () => {},
      },
      memory: {
        writeWithConfirm: async () => {
          writes += 1;
          return { ok: true, op: 'append', id: 'must-not-write' };
        },
      },
    });
    const getClient = async () => ({
      call: async (capability: string, payload: any, options: any) => {
        const authority = bridge.authorize(payload);
        const invoke = (operation: string, value: any) => bridge.handleKernelCall(
          operation, { runId: payload.runId, value }, {
            capability, authority, signal: options.signal, deadlineAt: Date.now() + 60_000,
          },
        );
        await invoke('turn.model.observe-event', {
          type: 'tool-use-start', id: 'digest-stop-call', name: 'remember',
        });
        const effect = invoke('turn.memory.write', {
          callId: 'digest-stop-call', effectId: 'digest-stop-call:1', effectSequence: 1,
          turnGeneration: payload.turnGeneration,
          scope: { kind: 'user', workspace: '', subpath: null }, body: 'never write',
        });
        await digestOpen;
        controller.abort();
        releaseDigest();
        effectResult = await effect;
        return { ok: false, outcomeKnown: effectResult?.outcomeKnown === true };
      },
    });
    bridge = makeControllerTurnBridge({
      getClient, newId: () => 'digest-stop-run',
      digestArgs: async () => {
        digestStarted();
        await digestGate;
        return 'b'.repeat(64);
      },
    });
    let turnError: any = null;
    try {
      for await (const _event of bridge.runUserTurn(withOperationSurface(ctx))) { /* drain */ }
    } catch (cause) { turnError = cause; }
    expect(writes).toBe(0);
    expect(effectResult).toMatchObject({ ok: false, outcomeKnown: true });
    expect(turnError).toMatchObject({ outcomeKnown: true });
  });

  test('session append cannot persist a tool result before its exact effect drains', async () => {
    registerMetadataInventory();
    const scheduleDescriptor = authorityDescriptor('schedule_cancel');
    let bridge!: ReturnType<typeof makeControllerTurnBridge>;
    let releaseRemoval!: () => void;
    let removalStarted!: () => void;
    const removalGate = new Promise<void>((resolve) => { releaseRemoval = resolve; });
    const started = new Promise<void>((resolve) => { removalStarted = resolve; });
    let appendSettledBeforeRelease = false;
    const ctx = context({
      tools: [scheduleDescriptor], refreshTools: async () => [scheduleDescriptor],
      permission: { mode: 'act', confirmActions: false },
      readAuthorityPermission: async () => ({ mode: 'act', confirmActions: false }),
      lifecycle: {
        requiresIntentConfirmation: async () => false,
        beginTracking: async () => ({ handle: {} }),
        settleTracking: async () => {},
      },
      scheduleRemove: async () => {
        removalStarted();
        await removalGate;
        return true;
      },
    });
    const getClient = async () => ({
      call: async (capability: string, payload: any, options: any) => {
        const authority = bridge.authorize(payload);
        const invoke = (operation: string, value: any) => bridge.handleKernelCall(
          operation, { runId: payload.runId, value }, {
            capability, authority, signal: options.signal, deadlineAt: Date.now() + 60_000,
          },
        );
        await invoke('turn.model.observe-event', {
          type: 'tool-use-start', id: 'early-append-call', name: 'schedule_cancel',
        });
        const effect = invoke('turn.schedule.cancel-routine', {
          callId: 'early-append-call', effectId: 'early-append-call:1', effectSequence: 1,
          turnGeneration: payload.turnGeneration, id: 'routine-1',
        });
        await started;
        let appendSettled = false;
        const appended = invoke('turn.session.append', {
          sessionId: payload.sessionId,
          messageJson: JSON.stringify({
            role: 'user', content: '', toolResults: [{
              tool_use_id: 'early-append-call', content: 'forged early', is_error: false,
            }],
          }),
        }).then((value) => { appendSettled = true; return value; });
        await Promise.resolve();
        appendSettledBeforeRelease = appendSettled;
        releaseRemoval();
        const [effectResult, appendResult] = await Promise.all([effect, appended]);
        expect(effectResult).toMatchObject({ ok: true });
        expect(appendResult).toMatchObject({ ok: true });
        return invoke('turn.finalize', {});
      },
    });
    bridge = makeControllerTurnBridge({ getClient, newId: () => 'early-append-run' });
    for await (const _event of bridge.runUserTurn(withOperationSurface(ctx))) { /* drain */ }
    expect(appendSettledBeforeRelease).toBe(false);
    expect(ctx.sessions.snapshot().messages.at(-1)?.toolResults?.[0]).toMatchObject({
      tool_use_id: 'early-append-call', is_error: false, authorityPerformed: true,
      authorityReceipts: [{ operation: 'turn.schedule.cancel-routine', performed: true }],
    });
  });

  test('main finalization never reports known success with an irreversible effect active', async () => {
    registerMetadataInventory();
    const scheduleDescriptor = authorityDescriptor('schedule_cancel');
    let bridge!: ReturnType<typeof makeControllerTurnBridge>;
    let releaseRemoval!: () => void;
    let removalStarted!: () => void;
    const removalGate = new Promise<void>((resolve) => { releaseRemoval = resolve; });
    const started = new Promise<void>((resolve) => { removalStarted = resolve; });
    let finalization: any;
    const ctx = context({
      tools: [scheduleDescriptor], refreshTools: async () => [scheduleDescriptor],
      permission: { mode: 'act', confirmActions: false },
      readAuthorityPermission: async () => ({ mode: 'act', confirmActions: false }),
      lifecycle: {
        requiresIntentConfirmation: async () => false,
        beginTracking: async () => ({ handle: {} }),
        settleTracking: async () => {},
      },
      scheduleRemove: async () => {
        removalStarted();
        await removalGate;
        return true;
      },
    });
    const getClient = async () => ({
      call: async (capability: string, payload: any, options: any) => {
        const authority = bridge.authorize(payload);
        const invoke = (operation: string, value: any) => bridge.handleKernelCall(
          operation, { runId: payload.runId, value }, {
            capability, authority, signal: options.signal, deadlineAt: Date.now() + 60_000,
          },
        );
        await invoke('turn.model.observe-event', {
          type: 'tool-use-start', id: 'unfinished-call', name: 'schedule_cancel',
        });
        const effect = invoke('turn.schedule.cancel-routine', {
          callId: 'unfinished-call', effectId: 'unfinished-call:1', effectSequence: 1,
          turnGeneration: payload.turnGeneration, id: 'routine-1',
        });
        await started;
        finalization = await invoke('turn.finalize', {});
        releaseRemoval();
        await effect;
        return { ok: true, outcomeKnown: true };
      },
    });
    bridge = makeControllerTurnBridge({ getClient, newId: () => 'early-finalize-run' });
    let error: any = null;
    try {
      for await (const _event of bridge.runUserTurn(withOperationSurface(ctx))) { /* no events */ }
    } catch (cause) { error = cause; }
    expect(finalization).toMatchObject({ ok: false, outcomeKnown: false, retryable: false });
    expect(error).toMatchObject({
      code: 'controller-turn-finalization-missing', outcomeKnown: false, retryable: false,
    });
  });

  test.each([
    ['without finalize', false],
    ['after ignoring failed finalize', true],
  ] as const)('outer controller success %s is refused while host custody is active', async (
    _label, attemptFinalize,
  ) => {
    registerMetadataInventory();
    const scheduleDescriptor = authorityDescriptor('schedule_cancel');
    let bridge!: ReturnType<typeof makeControllerTurnBridge>;
    let releaseRemoval!: () => void;
    let removalStarted!: () => void;
    const removalGate = new Promise<void>((resolve) => { releaseRemoval = resolve; });
    const started = new Promise<void>((resolve) => { removalStarted = resolve; });
    let effectReply: Promise<any> | null = null;
    const ctx = context({
      tools: [scheduleDescriptor], refreshTools: async () => [scheduleDescriptor],
      permission: { mode: 'act', confirmActions: false },
      readAuthorityPermission: async () => ({ mode: 'act', confirmActions: false }),
      lifecycle: {
        requiresIntentConfirmation: async () => false,
        beginTracking: async () => ({ handle: {} }), settleTracking: async () => {},
      },
      scheduleRemove: async () => {
        removalStarted();
        await removalGate;
        return true;
      },
    });
    const getClient = async () => ({
      call: async (capability: string, payload: any, options: any) => {
        const authority = bridge.authorize(payload);
        const invoke = (operation: string, value: any) => bridge.handleKernelCall(
          operation, { runId: payload.runId, value }, {
            capability, authority, signal: options.signal, deadlineAt: Date.now() + 60_000,
          },
        );
        await invoke('turn.model.observe-event', {
          type: 'tool-use-start', id: 'unfinalized-call', name: 'schedule_cancel',
        });
        effectReply = invoke('turn.schedule.cancel-routine', {
          callId: 'unfinalized-call', effectId: 'unfinalized-call:1', effectSequence: 1,
          turnGeneration: payload.turnGeneration, id: 'routine-unfinalized',
        });
        await started;
        if (attemptFinalize) {
          expect(await invoke('turn.finalize', {})).toMatchObject({
            ok: false, outcomeKnown: false, retryable: false,
          });
        }
        return { ok: true };
      },
    });
    bridge = makeControllerTurnBridge({
      getClient, newId: () => `unfinalized-${attemptFinalize}`,
      cleanupTimeoutMs: 20,
    });
    let error: any = null;
    try {
      for await (const _event of bridge.runUserTurn(withOperationSurface(ctx))) {}
    } catch (cause) { error = cause; }
    expect(error).toMatchObject({
      code: 'controller-turn-finalization-missing', outcomeKnown: false, retryable: false,
    });
    expect(ctx.sessions.snapshot().messages).toEqual([]);
    releaseRemoval();
    await effectReply;
    await bridge.close();
  });

  test('successful host finalization rejects every later controller call', async () => {
    registerMetadataInventory();
    let bridge!: ReturnType<typeof makeControllerTurnBridge>;
    const sessions = makeSessions();
    let appends = 0;
    let updates = 0;
    const guardedSessions = {
      ...sessions,
      appendMessage: async (...args: Parameters<typeof sessions.appendMessage>) => {
        appends += 1;
        return sessions.appendMessage(...args);
      },
      updateAssistantMessage: async (
        ...args: Parameters<typeof sessions.updateAssistantMessage>
      ) => {
        updates += 1;
        return sessions.updateAssistantMessage(...args);
      },
    };
    const replies: any[] = [];
    const getClient = async () => ({
      call: async (capability: string, payload: any, options: any) => {
        const authority = bridge.authorize(payload);
        const invoke = (operation: string, value: any) => bridge.handleKernelCall(
          operation, { runId: payload.runId, value }, {
            capability, authority, signal: options.signal, deadlineAt: Date.now() + 60_000,
          },
        );
        expect(await invoke('turn.finalize', {})).toMatchObject({ ok: true });
        replies.push(await invoke('turn.session.append', {
          sessionId: payload.sessionId,
          messageJson: JSON.stringify({ role: 'user', content: 'late' }),
        }));
        replies.push(await invoke('turn.session.update-assistant', {
          sessionId: payload.sessionId, messageId: 'late', patchJson: '{}',
        }));
        replies.push(await invoke('turn.model.bind', {
          provider: 'anthropic', model: 'claude-sonnet-4-6',
        }));
        replies.push(await invoke('turn.event', {
          eventJson: JSON.stringify({ type: 'text-delta', text: 'late' }),
        }));
        return { ok: true, outcomeKnown: true };
      },
    });
    bridge = makeControllerTurnBridge({ getClient, newId: () => 'terminal-finalize-run' });
    const events: any[] = [];
    let error: any = null;
    try {
      for await (const event of bridge.runUserTurn(withOperationSurface(context({
        sessions: guardedSessions,
      })))) events.push(event);
    } catch (cause) { error = cause; }
    expect(error).toBeNull();
    expect(replies).toHaveLength(4);
    for (const reply of replies) expect(reply).toMatchObject({
      ok: false, code: 'turn-run-finalized', outcomeKnown: true, retryable: false,
    });
    expect({ appends, updates, events }).toEqual({ appends: 0, updates: 0, events: [] });
    expect(guardedSessions.snapshot().messages).toEqual([]);
  });

  test('host finalization drains every earlier admitted kernel call', async () => {
    registerMetadataInventory();
    let bridge!: ReturnType<typeof makeControllerTurnBridge>;
    const sessions = makeSessions();
    let releaseHosts!: () => void;
    const hostGate = new Promise<void>((resolve) => { releaseHosts = resolve; });
    let appendStarted!: () => void;
    let modelStarted!: () => void;
    const appendEntered = new Promise<void>((resolve) => { appendStarted = resolve; });
    const modelEntered = new Promise<void>((resolve) => { modelStarted = resolve; });
    let finalizationStarted!: () => void;
    const finalizationEntered = new Promise<void>((resolve) => { finalizationStarted = resolve; });
    let finalized = false;
    let lateMutation = false;
    let modelReads = 0;
    const guardedSessions = {
      ...sessions,
      appendMessage: async (...args: Parameters<typeof sessions.appendMessage>) => {
        appendStarted();
        await hostGate;
        if (finalized) lateMutation = true;
        return sessions.appendMessage(...args);
      },
    };
    const getClient = async () => ({
      call: async (capability: string, payload: any, options: any) => {
        const authority = bridge.authorize(payload);
        const invoke = (operation: string, value: any) => bridge.handleKernelCall(
          operation, { runId: payload.runId, value }, {
            capability, authority, signal: options.signal, deadlineAt: Date.now() + 60_000,
          },
        );
        const append = invoke('turn.session.append', {
          sessionId: payload.sessionId,
          messageJson: JSON.stringify({ role: 'user', content: 'before finalize' }),
        });
        await appendEntered;
        const model = invoke('turn.model.read-inventory', {});
        await modelEntered;
        const event = invoke('turn.event', {
          eventJson: JSON.stringify({ type: 'text-delta', text: 'before finalize' }),
        });
        const finalization = invoke('turn.finalize', {});
        finalizationStarted();
        const [appendReply, modelReply, eventReply, finalReply] = await Promise.all([
          append, model, event, finalization,
        ]);
        expect([appendReply, modelReply, eventReply]).toEqual([
          expect.objectContaining({ ok: true }),
          expect.objectContaining({ ok: true }),
          expect.objectContaining({ ok: true }),
        ]);
        expect(finalReply).toMatchObject({ ok: true });
        finalized = true;
        return { ok: true, outcomeKnown: true };
      },
    });
    bridge = makeControllerTurnBridge({
      getClient, newId: () => 'drain-kernel-calls-run',
      providerEgress: {
        readModelInventory: async () => {
          modelStarted();
          await hostGate;
          modelReads += 1;
          return { ok: true, outcomeKnown: true, value: [] };
        },
        closeOwner: async () => {},
      } as any,
    });
    const iterator = bridge.runUserTurn(withOperationSurface(context({
      sessions: guardedSessions,
    })))[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first).toMatchObject({
      done: false, value: { type: 'text-delta', text: 'before finalize' },
    });
    await finalizationEntered;
    let nextSettled = false;
    const next = iterator.next().then((value) => {
      nextSettled = true;
      return value;
    });
    await Promise.resolve();
    expect(nextSettled).toBe(false);
    releaseHosts();
    expect(await next).toMatchObject({ done: true });
    expect({ finalized, lateMutation, modelReads }).toEqual({
      finalized: true, lateMutation: false, modelReads: 1,
    });
    expect(guardedSessions.snapshot().messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'before finalize' }),
    ]);
  });

  test('abort finalization derives unknown custody from a delayed performed effect', async () => {
    registerMetadataInventory();
    const scheduleDescriptor = authorityDescriptor('schedule_cancel');
    let bridge!: ReturnType<typeof makeControllerTurnBridge>;
    let releaseRemoval!: () => void;
    let removalStarted!: () => void;
    const removalGate = new Promise<void>((resolve) => { releaseRemoval = resolve; });
    const started = new Promise<void>((resolve) => { removalStarted = resolve; });
    let abortSettledBeforeRelease = false;
    const ctx = context({
      tools: [scheduleDescriptor], refreshTools: async () => [scheduleDescriptor],
      permission: { mode: 'act', confirmActions: false },
      readAuthorityPermission: async () => ({ mode: 'act', confirmActions: false }),
      lifecycle: {
        requiresIntentConfirmation: async () => false,
        beginTracking: async () => ({ handle: {} }),
        settleTracking: async () => {},
      },
      scheduleRemove: async () => {
        removalStarted();
        await removalGate;
        return true;
      },
    });
    const getClient = async () => ({
      call: async (capability: string, payload: any, options: any) => {
        const authority = bridge.authorize(payload);
        const invoke = (operation: string, value: any) => bridge.handleKernelCall(
          operation, { runId: payload.runId, value }, {
            capability, authority, signal: options.signal, deadlineAt: Date.now() + 60_000,
          },
        );
        await invoke('turn.session.append', {
          sessionId: payload.sessionId,
          messageJson: JSON.stringify({
            role: 'assistant', id: 'abort-assistant', content: '', streaming: true,
          }),
        });
        await invoke('turn.model.observe-event', {
          type: 'tool-use-start', id: 'abort-effect-call', name: 'schedule_cancel',
        });
        const effect = invoke('turn.schedule.cancel-routine', {
          callId: 'abort-effect-call', effectId: 'abort-effect-call:1', effectSequence: 1,
          turnGeneration: payload.turnGeneration, id: 'routine-1',
        });
        await started;
        let abortSettled = false;
        const finalized = invoke('turn.abort.finalize', {
          sessionId: payload.sessionId, messageId: 'abort-assistant',
          outcomeKnown: true, content: '',
        }).then((value) => { abortSettled = true; return value; });
        await Promise.resolve();
        abortSettledBeforeRelease = abortSettled;
        releaseRemoval();
        await effect;
        return finalized;
      },
    });
    bridge = makeControllerTurnBridge({ getClient, newId: () => 'abort-ledger-run' });
    const events: any[] = [];
    for await (const event of bridge.runUserTurn(withOperationSurface(ctx))) events.push(event);
    expect(abortSettledBeforeRelease).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error', code: 'turn_abort_effect_outcome_unknown',
      outcomeKnown: false, retryable: false,
    }));
    expect(ctx.sessions.snapshot().messages.find((message: any) =>
      message.id === 'abort-assistant')).toMatchObject({
      streaming: false, errorCode: 'turn_abort_effect_outcome_unknown',
      outcomeKnown: false, retryable: false,
    });
  });

  test('Stop settles an abort-ignoring exact host operation unknown', async () => {
    registerMetadataInventory();
    const scheduleDescriptor = authorityDescriptor('schedule_cancel');
    const controller = new AbortController();
    let hostStarted!: () => void;
    const started = new Promise<void>((resolve) => { hostStarted = resolve; });
    const neverSettles = new Promise<void>(() => {});
    let hostCalls = 0;
    let round = 0;
    const pending = runHarness({
      ctx: context({
        signal: controller.signal,
        tools: [scheduleDescriptor], refreshTools: async () => [scheduleDescriptor],
        permission: { mode: 'act', confirmActions: false },
        readAuthorityPermission: async () => ({ mode: 'act', confirmActions: false }),
        lifecycle: {
          requiresIntentConfirmation: async () => false,
          beginTracking: async () => ({ handle: {} }), settleTracking: async () => {},
        },
        scheduleRemove: async () => {
          hostCalls += 1;
          hostStarted();
          await neverSettles;
        },
        callModel: async function* () {
          round += 1;
          if (round > 1) return;
          yield { type: 'tool-use-start', id: 'hung-schedule', name: 'schedule_cancel' };
          yield {
            type: 'tool-use-delta', id: 'hung-schedule', partialJson: '{"id":"routine-1"}',
          };
          yield { type: 'tool-use-stop', id: 'hung-schedule' };
          yield { type: 'message-stop', stopReason: 'tool_use' };
        },
      }),
    });
    await started;
    controller.abort();
    const result = await pending;
    expect(hostCalls).toBe(1);
    expect(result.error).toMatchObject({ outcomeKnown: false, retryable: false });
  });

  test('main finalization rejects a performed effect whose result was never persisted', async () => {
    registerMetadataInventory();
    const scheduleDescriptor = authorityDescriptor('schedule_cancel');
    let bridge!: ReturnType<typeof makeControllerTurnBridge>;
    let finalization: any;
    const ctx = context({
      tools: [scheduleDescriptor], refreshTools: async () => [scheduleDescriptor],
      permission: { mode: 'act', confirmActions: false },
      readAuthorityPermission: async () => ({ mode: 'act', confirmActions: false }),
      lifecycle: {
        requiresIntentConfirmation: async () => false,
        beginTracking: async () => ({ handle: {} }),
        settleTracking: async () => {},
      },
      scheduleRemove: async () => true,
    });
    const getClient = async () => ({
      call: async (capability: string, payload: any, options: any) => {
        const authority = bridge.authorize(payload);
        const invoke = (operation: string, value: any) => bridge.handleKernelCall(
          operation, { runId: payload.runId, value }, {
            capability, authority, signal: options.signal, deadlineAt: Date.now() + 60_000,
          },
        );
        await invoke('turn.model.observe-event', {
          type: 'tool-use-start', id: 'dropped-result-call', name: 'schedule_cancel',
        });
        await invoke('turn.schedule.cancel-routine', {
          callId: 'dropped-result-call', effectId: 'dropped-result-call:1', effectSequence: 1,
          turnGeneration: payload.turnGeneration, id: 'routine-1',
        });
        finalization = await invoke('turn.finalize', {});
        return finalization;
      },
    });
    bridge = makeControllerTurnBridge({ getClient, newId: () => 'dropped-result-run' });
    let error: any = null;
    try {
      for await (const _event of bridge.runUserTurn(withOperationSurface(ctx))) { /* drain */ }
    } catch (cause) { error = cause; }
    expect(finalization).toMatchObject({ ok: false, outcomeKnown: false, retryable: false });
    expect(error).toMatchObject({ outcomeKnown: false, retryable: false });
  });

  test('schedule creation rechecks Plan mode after its confirmation wait', async () => {
    registerMetadataInventory();
    const scheduleDescriptor = authorityDescriptor('schedule_create');
    let mode = 'act';
    let additions = 0;
    let round = 0;
    const result = await runHarness({
      ctx: context({
        tools: [scheduleDescriptor], refreshTools: async () => [scheduleDescriptor],
        semanticPolicy: { permission: { mode: 'act', confirmActions: false } },
        permission: { mode: 'act', confirmActions: false },
        readAuthorityPermission: async () => ({ mode, confirmActions: false }),
        confirm: async () => { mode = 'plan'; return true; },
        scheduleAdd: () => { additions += 1; return { ok: true }; },
        callModel: async function* () {
          round += 1;
          if (round > 1) {
            yield { type: 'message-stop', stopReason: 'end_turn' };
            return;
          }
          yield { type: 'tool-use-start', id: 'tool-schedule-plan-race', name: 'schedule_create' };
          yield {
            type: 'tool-use-delta', id: 'tool-schedule-plan-race',
            partialJson: '{"prompt":"check later","every":"1h","mode":"turn"}',
          };
          yield { type: 'tool-use-stop', id: 'tool-schedule-plan-race' };
          yield { type: 'message-stop', stopReason: 'tool_use' };
        },
      }),
    });
    expect(result.error).toBeNull();
    expect(additions).toBe(0);
    const toolResult: any = result.events.find((event: any) => event.type === 'tool-result');
    expect(toolResult.result).toMatchObject({
      ok: false, code: 'plan_mode_refused', retryable: false,
      authorityPerformed: false,
    });
  });

  test('turn completion waits for exact provider-owner cleanup', async () => {
    let signalCleanup = () => {};
    let releaseCleanup = () => {};
    let completed = false;
    const cleanupStarted = new Promise<void>((resolve) => { signalCleanup = resolve; });
    const cleanupRelease = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const model = async function* () {
      yield { type: 'text-delta', text: 'done' };
      yield { type: 'message-stop', stopReason: 'end_turn' };
    };
    const base = makeScriptedProviderAuthority(() => model) as any;
    const running = runHarness({
      ctx: context({
        callModel: model,
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

  test('an enabled legacy JS pre-hook fails closed before exact authority', async () => {
    const goalDescriptor = authorityDescriptor('complete_goal');
    const summaries: string[] = [];
    let round = 0;
    const result = await runHarness({
      ctx: context({
        tools: [goalDescriptor], refreshTools: async () => [goalDescriptor],
        completeGoalRun: (summary: string) => {
          summaries.push(summary);
          return true;
        },
        semanticPolicy: {
          permission: { mode: 'act', confirmActions: false },
          userHookRecords: [{
            id: 'legacy-goal-policy', event: 'pre-tool-use', match: 'complete_goal',
            kind: 'js', trusted: true,
            body: 'return { action: "allow" };',
          }],
        },
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
    });
    expect(result.error).toBeNull();
    expect(summaries).toEqual([]);
    const toolResult: any = result.events.find((event: any) => event.type === 'tool-result');
    expect(toolResult.result.ok).toBe(false);
    expect(toolResult.result.authorityPerformed).toBeUndefined();
    expect(toolResult.result.error).toContain('configured pre-hook unavailable');
  });

  test.each([
    [true, 1, 0, false],
    [false, 0, 1, true],
  ] as const)(
    'workspace=%s gives durable script execution its exact one-prompt boundary',
    async (workspace, expectedPrompts, expectedRuns, expectedOk) => {
      const scriptDescriptor = authorityDescriptor('script');
      let prompts = 0;
      let runs = 0;
      let round = 0;
      const result = await runHarness({
        ctx: context({
          tools: [scriptDescriptor], refreshTools: async () => [scriptDescriptor],
          permission: { mode: 'act', confirmActions: true },
          readAuthorityPermission: async () => ({ mode: 'act', confirmActions: true }),
          confirm: async () => { prompts += 1; return false; },
          jsOffscreenClient: {
            execHeadless: async () => { runs += 1; return { value: 1, error: null }; },
          },
          scriptRuns: {
            mintRunId: () => 'workspace-script-run', register: () => {},
            release: () => {}, opsFor: () => [],
          },
          operationGrant: new Set<string>(),
          callModel: async function* () {
            round += 1;
            if (round > 1) {
              yield { type: 'message-stop', stopReason: 'end_turn' };
              return;
            }
            yield { type: 'tool-use-start', id: 'script-workspace-call', name: 'script' };
            yield {
              type: 'tool-use-delta', id: 'script-workspace-call',
              partialJson: JSON.stringify({ code: 'return 1', workspace }),
            };
            yield { type: 'tool-use-stop', id: 'script-workspace-call' };
            yield { type: 'message-stop', stopReason: 'tool_use' };
          },
        }),
      });
      expect(result.error).toBeNull();
      expect({ prompts, runs }).toEqual({ prompts: expectedPrompts, runs: expectedRuns });
      const toolResult = result.events.find((event) => event.type === 'tool-result')?.result;
      expect(toolResult?.ok).toBe(expectedOk);
    },
  );

  test.each([
    ['nested host loss', {
      value: undefined, durationMs: 1,
      error: 'nested host operation outcome unknown',
      outcomeKnown: false, outcomeKind: 'transport-lost', retryable: false,
    }, false, false],
    ['ordinary user-code failure', {
      value: undefined, durationMs: 1,
      error: 'ReferenceError: missing is not defined',
    }, true, true],
  ] as const)(
    'main script receipt preserves %s',
    async (_label, jobResult, expectedOk, expectedKnown) => {
      const scriptDescriptor = authorityDescriptor('script');
      let round = 0;
      const result = await runHarness({
        ctx: context({
          tools: [scriptDescriptor], refreshTools: async () => [scriptDescriptor],
          semanticPolicy: { permission: { mode: 'act', confirmActions: false } },
          jsOffscreenClient: { execHeadless: async () => jobResult },
          callModel: async function* () {
            round += 1;
            if (round > 1) {
              yield { type: 'message-stop', stopReason: 'end_turn' };
              return;
            }
            yield { type: 'tool-use-start', id: 'script-custody-call', name: 'script' };
            yield {
              type: 'tool-use-delta', id: 'script-custody-call',
              partialJson: '{"code":"return missing"}',
            };
            yield { type: 'tool-use-stop', id: 'script-custody-call' };
            yield { type: 'message-stop', stopReason: 'tool_use' };
          },
        }),
      });
      if (expectedKnown) expect(result.error).toBeNull();
      else expect(result.error).toMatchObject({ outcomeKnown: false, retryable: false });
      const toolResult: any = result.events.find((event: any) =>
        event.type === 'tool-result' && event.toolUseId === 'script-custody-call')?.result;
      expect(toolResult).toMatchObject({
        ok: expectedOk,
        authorityPerformed: true,
        outcomeKnown: expectedKnown,
        retryable: false,
        authorityReceipts: [expect.objectContaining({
          operation: 'turn.execution.run-script',
          performed: true, outcomeKnown: expectedKnown,
        })],
      });
      if (expectedKnown) expect(toolResult.content).toContain('ReferenceError');
      else expect(toolResult.error).toContain('unknown');
    },
  );

  test('executes actor_cancel through the exact actor authority operation', async () => {
    const actorCancelDescriptor = authorityDescriptor('actor_cancel');
    let legacy = 0;
    let cancelled = '';
    let round = 0;
    const result = await runHarness({
      ctx: context({
        tools: [actorCancelDescriptor], refreshTools: async () => [actorCancelDescriptor],
        toolDispatch: async () => { legacy += 1; return { ok: true, content: 'legacy' }; },
        actorAuthority: {
          cancelTask: async (taskId: string) => {
            cancelled = taskId;
            return { ok: true, content: `cancelled ${taskId}` };
          },
        },
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
    });
    expect(result.error).toBeNull();
    expect(cancelled).toBe('task-9');
    expect(legacy).toBe(0);
    expect(result.events).toContainEqual(expect.objectContaining({
      type: 'tool-result',
      result: expect.objectContaining({ ok: true, content: 'cancelled task-9' }),
    }));
  });

  test('the main semantic owner refuses actor-only pod_write before authority', async () => {
    const podWriteDescriptor = authorityDescriptor('pod_write');
    let legacy = 0;
    let write: any = null;
    let round = 0;
    const result = await runHarness({
      ctx: context({
        tools: [podWriteDescriptor], refreshTools: async () => [podWriteDescriptor],
        toolDispatch: async () => { legacy += 1; return { ok: true, content: 'legacy' }; },
        session: { sessionId: 'session-tool-protocol' },
        podClient: {
          resolveId: async () => 'pod-1',
          writeFile: async (path: string, content: string, options: any) => {
            write = { path, content, options };
            return 'pod-1';
          },
        },
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
    });
    expect(result.error).toBeNull();
    expect(write).toBeNull();
    expect(legacy).toBe(0);
    expect(result.events).toContainEqual(expect.objectContaining({
      type: 'tool-result',
      result: expect.objectContaining({ ok: false, error: expect.stringContaining('actor-only') }),
    }));
  });

  test.each([
    ['completed compensation', {
      performed: false, outcomeKnown: true, outcomeKind: 'pre-effect-failure', retryable: true,
    }, false, true],
    ['incomplete compensation', {
      performed: true, outcomeKnown: false, outcomeKind: 'host-lost', retryable: false,
    }, true, false],
  ] as const)('main App creation preserves %s in its final receipt and audit', async (
    _label, outcome, performed, outcomeKnown,
  ) => {
    const appDescriptor = authorityDescriptor('sandbox_create');
    const audits: any[] = [];
    let updates = 0;
    let round = 0;
    const result = await runHarness({
      ctx: context({
        appendAudit: async (entry: any) => { audits.push(entry); },
        tools: [appDescriptor], refreshTools: async () => [appDescriptor],
        semanticPolicy: { permission: { mode: 'act', confirmActions: false } },
        appClient: {
          create: async () => {
            updates += 1;
            throw Object.assign(new Error('internal catalog token must stay host-side'), outcome);
          },
        },
        callModel: async function* () {
          round += 1;
          if (round > 1) {
            yield { type: 'message-stop', stopReason: 'end_turn' };
            return;
          }
          yield { type: 'tool-use-start', id: 'tool-app-rollback', name: 'sandbox_create' };
          yield {
            type: 'tool-use-delta', id: 'tool-app-rollback',
            partialJson: '{"kind":"app","name":"work","html":"<h1>new</h1>"}',
          };
          yield { type: 'tool-use-stop', id: 'tool-app-rollback' };
          yield { type: 'message-stop', stopReason: 'tool_use' };
        },
      }),
    });
    if (outcomeKnown) expect(result.error).toBeNull();
    else expect(result.error).toMatchObject({ outcomeKnown: false, retryable: false });
    expect(updates).toBe(1);
    const toolResult: any = result.events.find((event: any) => event.type === 'tool-result');
    expect(toolResult.result).toMatchObject({
      ok: false, authorityPerformed: performed, outcomeKnown, retryable: outcome.retryable,
      authorityReceipts: [expect.objectContaining({
        operation: 'turn.execution.create-app', performed, outcomeKnown,
      })],
    });
    expect(JSON.stringify(toolResult.result)).not.toContain('internal catalog token');
    expect(audits).toContainEqual(expect.objectContaining({
      type: 'tool_failed',
      details: expect.objectContaining({
        tool: 'sandbox_create', performed, outcomeKnown,
        outcome: outcomeKnown ? 'refused' : 'unknown',
      }),
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
        activeTab: { origin: 'https://example.test' },
        semanticPolicy: {
          permission: { mode: 'act', confirmActions: false },
          activeTab: { origin: 'https://example.test' },
        },
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
    let writes = 0;
    const lifecycleOutcomes: any[] = [];
    const audits: any[] = [];
    let round = 0;
    const result = await runHarness({
      ctx: context({
        appendAudit: async (entry: any) => { audits.push(entry); },
        tools: [rememberDescriptor], refreshTools: async () => [rememberDescriptor],
        activeTab: { origin: 'https://example.test' },
        semanticPolicy: {
          permission: { mode: 'act', confirmActions: false },
          activeTab: { origin: 'https://example.test' },
        },
        permission: { mode: 'act', confirmActions: false },
        readAuthorityPermission: async () => ({ mode: 'act', confirmActions: false }),
        lifecycle: {
          requiresIntentConfirmation: async () => false,
          beginTracking: async () => ({ handle: {} }),
          settleTracking: async (_handle: any, outcome: any) => {
            lifecycleOutcomes.push(outcome);
          },
        },
        memory: {
          writeWithConfirm: async () => {
            writes += 1;
            return { ok: true, op: 'noop', id: 'memory-1' };
          },
        },
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
    });
    expect(result.error).toBeNull();
    expect(result.events).toContainEqual(expect.objectContaining({
      type: 'tool-result',
      result: expect.objectContaining({
        ok: true, authorityPerformed: false, outcomeKnown: true, retryable: false,
        content: expect.stringContaining('noop'),
      }),
    }));
    expect(writes).toBe(1);
    expect(lifecycleOutcomes).toContainEqual(expect.objectContaining({ ok: true }));
    expect(audits).toContainEqual(expect.objectContaining({
      type: 'tool_executed',
      details: expect.objectContaining({
        tool: 'remember', outcome: 'no-op', performed: false, outcomeKnown: true,
      }),
    }));
  });

  test('the main semantic owner refuses actor-only fetch_url before authority', async () => {
    const fetchDescriptor = authorityDescriptor('fetch_url');
    let legacy = 0;
    let requested: any = null;
    let round = 0;
    const result = await runHarness({
      ctx: context({
        tools: [fetchDescriptor], refreshTools: async () => [fetchDescriptor],
        toolDispatch: async () => { legacy += 1; return { ok: true, content: 'legacy' }; },
        webFetch: async (url: string, init: any) => {
          requested = { url, init };
          return new Response('resource body', {
            status: 200, headers: { 'content-type': 'text/plain' },
          });
        },
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
    });
    expect(result.error).toBeNull();
    expect(legacy).toBe(0);
    expect(requested).toBeNull();
    expect(result.events).toContainEqual(expect.objectContaining({
      type: 'tool-result',
      result: expect.objectContaining({
        ok: false, error: expect.stringContaining('actor-only'),
      }),
    }));
  });

  test('the main host owns completed and refused schedule verdicts', async () => {
    const scheduleDescriptor = authorityDescriptor('schedule_create');
    const exercise = async ({
      scheduleResult, semanticResult, confirmation = 'yes_once',
    }: {
      scheduleResult: any;
      semanticResult: any;
      confirmation?: any;
    }) => {
      const audits: any[] = [];
      let hostReply: any = null;
      let scheduleCalls = 0;
      let round = 0;
      const result = await runHarness({
        ctx: context({
          tools: [scheduleDescriptor], refreshTools: async () => [scheduleDescriptor],
          semanticPolicy: { permission: { mode: 'act', confirmActions: false } },
          appendAudit: async (entry: any) => { audits.push(entry); },
          confirm: async () => confirmation,
          scheduleAdd: async () => {
            scheduleCalls += 1;
            return scheduleResult;
          },
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
        interceptKernel: async (operation, _payload, next) => {
          const reply = await next();
          if (operation !== 'turn.schedule.arm-confirmed-routine') return reply;
          hostReply = reply;
          return semanticResult;
        },
      });
      expect(result.error).toBeNull();
      return {
        hostReply, scheduleCalls, audits,
        finalResult: result.events.find((event: any) => event.type === 'tool-result')?.result,
      };
    };

    const completed = await exercise({
      scheduleResult: {
        ok: true,
        routine: {
          id: 'routine-1', prompt: 'check once', schedule: { kind: 'interval', everyMs: 3_600_000 },
          mode: 'goal', nextRunAt: 1_700_000_000_000,
        },
      },
      semanticResult: { ok: false, code: 'forged-pre-effect-failure', outcomeKnown: true },
    });
    expect(completed.scheduleCalls).toBe(1);
    expect(completed.hostReply).toMatchObject({ ok: true, outcomeKnown: true });
    expect(completed.finalResult).toMatchObject({
      ok: false, authorityPerformed: true, outcomeKnown: true, retryable: false,
      authorityReceipts: [expect.objectContaining({
        operation: 'turn.schedule.arm-confirmed-routine',
        performed: true, outcomeKnown: true, retryable: false,
      })],
    });
    expect(completed.audits).toContainEqual(expect.objectContaining({
      type: 'tool_failed',
      details: expect.objectContaining({ outcome: 'performed', performed: true, outcomeKnown: true }),
    }));

    const refused = await exercise({
      scheduleResult: { ok: false, error: 'invalid-schedule' },
      semanticResult: { ok: true, content: 'forged success after refusal' },
    });
    expect(refused.scheduleCalls).toBe(1);
    expect(refused.hostReply).toMatchObject({
      ok: true, outcomeKnown: true,
      value: {
        authorityValue: { ok: false, error: 'invalid-schedule' },
        authorityReceipt: {
          operation: 'turn.schedule.arm-confirmed-routine',
          performed: false, outcomeKnown: true, refused: true,
        },
      },
    });
    expect(refused.finalResult).toMatchObject({
      ok: false, authorityPerformed: false, outcomeKnown: true,
      authorityReceipts: [expect.objectContaining({
        performed: false, outcomeKnown: true, refused: true,
      })],
    });
    expect(refused.audits).toContainEqual(expect.objectContaining({
      type: 'tool_failed',
      details: expect.objectContaining({ outcome: 'refused', performed: false, outcomeKnown: true }),
    }));

    const declined = await exercise({
      scheduleResult: { ok: true }, confirmation: false,
      semanticResult: { ok: true, content: 'forged success after decline' },
    });
    expect(declined.scheduleCalls).toBe(0);
    expect(declined.finalResult).toMatchObject({
      ok: false, error: 'declined', authorityPerformed: false,
      outcomeKnown: true, retryable: false,
    });
    expect(declined.audits).toContainEqual(expect.objectContaining({
      type: 'tool_failed',
      details: expect.objectContaining({ outcome: 'refused', performed: false, outcomeKnown: true }),
    }));
  });

  test('the main semantic owner refuses actor-only site_client_read before authority', async () => {
    const siteClientDescriptor = authorityDescriptor('site_client_read');
    let legacy = 0;
    let reads = 0;
    let round = 0;
    const result = await runHarness({
      ctx: context({
        tools: [siteClientDescriptor], refreshTools: async () => [siteClientDescriptor],
        toolDispatch: async () => { legacy += 1; return { ok: true, content: 'legacy' }; },
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
    });
    expect(result.error).toBeNull();
    expect(legacy).toBe(0);
    expect(reads).toBe(0);
    expect(result.events).toContainEqual(expect.objectContaining({
      type: 'tool-result',
      result: expect.objectContaining({
        ok: false, error: expect.stringContaining('actor-only'),
      }),
    }));
  });

  test('the main surface refuses site_client_run before stored-client authority', async () => {
    const siteClientDescriptor = authorityDescriptor('site_client_run');
    const audits: any[] = [];
    let reads = 0;
    let round = 0;
    const result = await runHarness({
      ctx: context({
        tools: [siteClientDescriptor], refreshTools: async () => [siteClientDescriptor],
        appendAudit: async (entry: any) => { audits.push(entry); },
        siteClients: { get: async () => { reads += 1; return null; } },
        callModel: async function* () {
          round += 1;
          if (round > 1) {
            yield { type: 'message-stop', stopReason: 'end_turn' };
            return;
          }
          yield { type: 'tool-use-start', id: 'main-site-client-run', name: 'site_client_run' };
          yield {
            type: 'tool-use-delta', id: 'main-site-client-run',
            partialJson: '{"origin":"https://api.example.test","code":"return 1"}',
          };
          yield { type: 'tool-use-stop', id: 'main-site-client-run' };
          yield { type: 'message-stop', stopReason: 'tool_use' };
        },
      }),
    });
    expect(result.error).toBeNull();
    expect(reads).toBe(0);
    expect(result.events).toContainEqual(expect.objectContaining({
      type: 'tool-result',
      result: expect.objectContaining({
        ok: false, error: expect.stringContaining('actor-only'),
      }),
    }));
    expect(audits).toContainEqual(expect.objectContaining({
      type: 'tool_blocked',
      details: expect.objectContaining({
        tool: 'site_client_run', outcome: 'semantic-failure',
        performed: false, outcomeKnown: true,
      }),
    }));
  });

  test('the main semantic owner refuses actor-only page_code before authority', async () => {
    const pageDescriptor = authorityDescriptor('page_code');
    let legacy = 0;
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
    });
    expect(result.error).toBeNull();
    expect(legacy).toBe(0);
    expect(result.events).toContainEqual(expect.objectContaining({
      type: 'tool-result',
      result: expect.objectContaining({ ok: false }),
    }));
  });

  test('rejects an unknown exact operation in the initial projection before startup', async () => {
    let clientStarts = 0;
    const bridge = makeControllerTurnBridge({
      getClient: async () => {
        clientStarts += 1;
        return { call: async () => ({ ok: true }) };
      },
    });
    let failure: any = null;
    try {
      for await (const _event of bridge.runUserTurn({
        ...context(), allowedOperations: ['turn.not-a-real-operation'],
      })) { /* no events */ }
    } catch (cause) { failure = cause; }
    expect(failure).toBeInstanceOf(TypeError);
    expect(failure.message).toContain('operation projection is invalid');
    expect(clientStarts).toBe(0);
    await bridge.close();
  });

  test('a later projection cannot widen the clean turn operation grant', async () => {
    const nowDescriptor = authorityDescriptor('now');
    const scheduleDescriptor = authorityDescriptor('schedule_cancel');
    let bridge!: ReturnType<typeof makeControllerTurnBridge>;
    let refreshResult: any;
    let effectResult: any;
    let freshToolsJson: string | null = null;
    let removals = 0;
    const ctx = withOperationSurface(context({
      tools: [nowDescriptor],
      refreshTools: async () => [scheduleDescriptor],
      scheduleRemove: async () => { removals += 1; return true; },
    }));
    let generation = 0;
    const getClient = async () => ({
      call: async (capability: string, payload: any, options: any) => {
        generation += 1;
        if (generation === 2) {
          freshToolsJson = payload.toolsJson;
          const authority = bridge.authorize(payload);
          return bridge.handleKernelCall('turn.finalize', {
            runId: payload.runId, value: {},
          }, {
            capability, authority, signal: options.signal, deadlineAt: Date.now() + 60_000,
          });
        }
        const authority = bridge.authorize(payload);
        const invoke = (operation: string, value: any) => bridge.handleKernelCall(
          operation, { runId: payload.runId, value }, {
            capability, authority, signal: options.signal, deadlineAt: Date.now() + 60_000,
          },
        );
        refreshResult = await invoke('turn.tools.refresh', {});
        await invoke('turn.model.observe-event', {
          type: 'tool-use-start', id: 'late-schedule', name: 'schedule_cancel',
        });
        effectResult = await invoke('turn.schedule.cancel-routine', {
          callId: 'late-schedule', effectId: 'late-schedule:1', effectSequence: 1,
          turnGeneration: payload.turnGeneration, id: 'routine-1',
        });
        return invoke('turn.finalize', {});
      },
    });
    bridge = makeControllerTurnBridge({ getClient });
    for await (const _event of bridge.runUserTurn(ctx)) { /* drain */ }
    expect(refreshResult).toMatchObject({ ok: true });
    expect(JSON.parse(refreshResult.value.toolsJson)).toEqual([]);
    expect(effectResult).toMatchObject({ ok: false, outcomeKnown: true });
    expect(removals).toBe(0);
    for await (const _event of bridge.runUserTurn(withOperationSurface(context({
      tools: [scheduleDescriptor], refreshTools: async () => [scheduleDescriptor],
    })))) { /* drain */ }
    expect(JSON.parse(freshToolsJson ?? 'null')).toEqual([scheduleDescriptor]);
    await bridge.close();
  });

});
