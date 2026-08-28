import { expect } from 'bun:test';
import { makeControllerTurnBridge } from '../../extension/background/controller-turn-bridge.js';
import { runControllerTurn } from '../../extension/offscreen/controller-turn-runtime.js';
import { startActorWorker } from '../../extension/offscreen/actor-worker-runtime.js';
import { describeActorExecution } from '../../extension/offscreen/actor-runner.js';
import { projectControllerToolSurface } from '../../extension/peerd-runtime/controller-tool-projection.js';
import { makeScriptedProviderAuthority } from '../peerd-provider/model-egress-fixture';

type ToolCall = { id: string; name: string; args?: Record<string, unknown> };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const makeLaneProbe = () => {
  let readStarted = 0;
  let readActive = 0;
  let writeActive = 0;
  let confirmActive = 0;
  let releaseReads = () => {};
  const bothReadsStarted = new Promise<void>((resolve) => { releaseReads = resolve; });
  const state = {
    maxReadActive: 0,
    maxWriteActive: 0,
    maxConfirmActive: 0,
    readTimedOut: false,
    writeOrder: [] as string[],
    confirmOrder: [] as string[],
  };
  return {
    state,
    read: async () => {
      readStarted += 1;
      readActive += 1;
      state.maxReadActive = Math.max(state.maxReadActive, readActive);
      if (readStarted === 2) releaseReads();
      await Promise.race([
        bothReadsStarted,
        sleep(300).then(() => { state.readTimedOut = true; }),
      ]);
      await sleep(5);
      readActive -= 1;
      return [];
    },
    write: async (label: string, value: unknown) => {
      state.writeOrder.push(`start:${label}`);
      writeActive += 1;
      state.maxWriteActive = Math.max(state.maxWriteActive, writeActive);
      await sleep(8);
      writeActive -= 1;
      state.writeOrder.push(`end:${label}`);
      return value;
    },
    confirm: async (label: string) => {
      state.confirmOrder.push(`start:${label}`);
      confirmActive += 1;
      state.maxConfirmActive = Math.max(state.maxConfirmActive, confirmActive);
      await sleep(5);
      confirmActive -= 1;
      state.confirmOrder.push(`end:${label}`);
      return 'yes_once';
    },
  };
};

const makeModelCall = (batches: ToolCall[][]) => {
  let round = 0;
  return async function* () {
    const calls = batches[round++] ?? [];
    if (calls.length === 0) {
      yield { type: 'text-delta', text: 'done' };
      yield { type: 'message-stop', stopReason: 'end_turn' };
      return;
    }
    for (const call of calls) {
      yield { type: 'tool-use-start', id: call.id, name: call.name };
      yield {
        type: 'tool-use-delta', id: call.id,
        partialJson: JSON.stringify(call.args ?? {}),
      };
      yield { type: 'tool-use-stop', id: call.id };
    }
    yield { type: 'message-stop', stopReason: 'tool_use' };
  };
};

const sessions = (sessionId: string) => {
  let record: any = {
    sessionId, provider: 'anthropic', model: 'claude-sonnet-4-6', messages: [],
  };
  return {
    get: async () => structuredClone(record),
    appendMessage: async (_id: string, message: any) => {
      record = { ...record, messages: [...record.messages, structuredClone(message)] };
      return structuredClone(record);
    },
    updateAssistantMessage: async (_id: string, messageId: string, patch: any) => {
      record = {
        ...record,
        messages: record.messages.map((message: any) => message.id === messageId
          ? { ...message, ...structuredClone(patch) } : message),
      };
      return structuredClone(record);
    },
    setTrimSummary: async () => structuredClone(record),
  };
};

const projectionFor = (batches: ToolCall[][]) => projectControllerToolSurface({
  surface: 'selection',
  toolNames: [...new Set(batches.flat().map((call) => call.name))],
});

export const runMainSchedulingScenario = async (
  batches: ToolCall[][],
  confirmActions: boolean,
  probe: ReturnType<typeof makeLaneProbe>,
) => {
  const projection: any = projectionFor(batches);
  const sessionId = 'main-scheduling-parity';
  const store = sessions(sessionId);
  const modelCall = makeModelCall(batches);
  const provider = makeScriptedProviderAuthority(() => modelCall);
  let bridge!: ReturnType<typeof makeControllerTurnBridge>;
  let sequence = 0;
  const getClient = async () => ({
    call: async (capability: string, payload: any, options: any) => {
      const authority = bridge.authorize(payload);
      return runControllerTurn(payload, {
        signal: options.signal, authority,
        kernelCall: (operation, value) => bridge.handleKernelCall(operation, value, {
          capability, authority, signal: options.signal, deadlineAt: Date.now() + 60_000,
        }),
      });
    },
  });
  bridge = makeControllerTurnBridge({
    getClient, newId: () => `main-scheduling-${++sequence}`,
    providerEgress: provider as any,
  });
  const events: any[] = [];
  const permission = { mode: 'act', confirmActions };
  const ctx: any = {
    sessionId, session: { sessionId, kind: 'chat', depth: 0 }, userText: 'run batches',
    sessions: store, tools: projection.tools, allowedOperations: projection.operations,
    refreshTools: async () => projection,
    semanticPolicy: { exposure: 'main', permission }, permission,
    readAuthorityPermission: async () => permission,
    getSystemPrompt: async () => 'PINNED', appendAudit: async () => {},
    enrichTrimSummary: () => {}, signal: new AbortController().signal,
    previousTurnAt: null, turnNow: 1_700_000_000_000,
    activeTabContext: null, protectedTabContext: null, recoveryBlock: '',
    reasoning: { enabled: false }, maxSteps: batches.length + 1,
    callModel: modelCall,
    scheduleList: probe.read,
    scheduleRemove: (id: string) => probe.write(`schedule:${id}`, true),
    actorAuthority: {
      spawnAsync: (request: any) => probe.write(`spawn:${request.task}`, {
        ok: true, taskId: `task-${request.task}`, content: `started ${request.task}`,
      }),
    },
    confirm: ({ tool }: any) => probe.confirm(tool),
    lifecycle: {
      requiresIntentConfirmation: async () => false,
      beginTracking: async () => ({ handle: {} }),
      settleTracking: async () => {},
    },
  };
  try {
    for await (const event of bridge.runUserTurn(ctx)) events.push(event);
  } finally { bridge.close(); }
  expect(events.filter((event) => event.type === 'error')).toEqual([]);
  expect(events.filter((event) => event.type === 'tool-result')).toHaveLength(
    batches.reduce((sum, batch) => sum + batch.length, 0),
  );
};

class ActorWorkerGlobal {
  listener: ((event: MessageEvent) => void | Promise<void>) | null = null;
  events: any[] = [];
  modelCall: ReturnType<typeof makeModelCall>;
  provider: ReturnType<typeof makeScriptedProviderAuthority>;
  probe: ReturnType<typeof makeLaneProbe>;
  grant = {
    owner: {}, signal: new AbortController().signal,
    permits: (providerId: string, modelId: string) =>
      providerId === 'anthropic' && modelId === 'claude-sonnet-4-6',
  };
  done!: (value: any) => void;
  completion = new Promise((resolve) => { this.done = resolve; });

  constructor(modelCall: ReturnType<typeof makeModelCall>, probe: ReturnType<typeof makeLaneProbe>) {
    this.modelCall = modelCall;
    this.provider = makeScriptedProviderAuthority(() => this.modelCall);
    this.probe = probe;
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void | Promise<void>) {
    if (type === 'message') this.listener = listener;
  }

  dispatch(data: any) {
    queueMicrotask(() => { void this.listener?.({ data } as MessageEvent); });
  }

  authorityResponse(message: any, type: string, operation: string, pending: Promise<unknown>) {
    void pending.then((authorityValue) => this.dispatch({
      type, rid: message.rid,
      reply: {
        ok: true, outcomeKnown: true,
        value: {
          authorityValue,
          authorityReceipt: {
            operation, outcome: operation.includes('read') ? 'observed' : 'performed',
            outcomeKnown: true, performed: !operation.includes('read'),
          },
        },
      },
    }));
  }

  postMessage(message: any) {
    if (message.type === 'loop-event') this.events.push(message.event);
    if (message.type === 'done' || message.type === 'error') this.done(message);
    const reply = (type: string, pending: Promise<any>) => {
      void pending.then((value) => this.dispatch({ type, rid: message.rid, reply: value }));
    };
    if (message.type === 'model-read-context-request') {
      this.dispatch({
        type: 'model-read-context-response', rid: message.rid,
        reply: { ok: true, outcomeKnown: true, value: null },
      });
    } else if (message.type === 'model-open-inference-request') {
      reply('model-open-inference-response', this.provider.openInference(message, this.grant));
    } else if (message.type === 'model-read-inference-chunk-request') {
      reply('model-read-inference-chunk-response',
        this.provider.readInferenceChunk(message, this.grant));
    } else if (message.type === 'model-cancel-inference-request') {
      reply('model-cancel-inference-response', this.provider.cancelInference(message, this.grant));
    } else if (message.type === 'schedule-read-routines-request') {
      this.authorityResponse(
        message, 'schedule-read-routines-response',
        'turn.schedule.read-routines', this.probe.read(),
      );
    } else if (message.type === 'schedule-cancel-routine-request') {
      this.authorityResponse(
        message, 'schedule-cancel-routine-response',
        'turn.schedule.cancel-routine',
        this.probe.write(`schedule:${message.id}`, true),
      );
    } else if (message.type === 'actor-spawn-async-request') {
      this.authorityResponse(
        message, 'actor-spawn-async-response',
        'turn.actor.spawn-async',
        this.probe.write(`spawn:${message.task}`, {
          ok: true, taskId: `task-${message.task}`, content: `started ${message.task}`,
        }),
      );
    } else if (message.type === 'actor-call-complete-request') {
      this.dispatch({
        type: 'actor-call-complete-response', rid: message.rid,
        reply: { ok: true, result: message.result },
      });
    }
  }
}

export const runActorSchedulingScenario = async (
  batches: ToolCall[][],
  confirmActions: boolean,
  probe: ReturnType<typeof makeLaneProbe>,
) => {
  const projection: any = projectionFor(batches);
  const worker = new ActorWorkerGlobal(makeModelCall(batches), probe);
  const previousSelf = globalThis.self;
  Object.defineProperty(globalThis, 'self', { value: worker, configurable: true });
  try {
    startActorWorker();
    worker.dispatch({
      type: 'run',
      execution: describeActorExecution({
        actorSessionId: 'actor-scheduling-parity', message: 'run batches',
        systemPrompt: 'PINNED', provider: 'anthropic', model: 'claude-sonnet-4-6',
        maxSteps: batches.length + 1, maxOutputTokens: 256,
        tools: projection.tools, priorMessages: [], recordKind: 'spawned', depth: 1,
        turnGeneration: 'actor-scheduling-generation',
      }, 'actor-scheduling-run'),
      tools: projection.tools, programTools: [], runtimeCapabilities: null,
      semanticPolicy: { permission: { mode: 'act', confirmActions } },
    });
    const done: any = await Promise.race([
      worker.completion,
      sleep(5_000).then(() => ({ type: 'error', error: 'actor runtime timed out' })),
    ]);
    expect(done).toMatchObject({ type: 'done' });
    expect(worker.events.filter((event) => event.type === 'error')).toEqual([]);
    expect(worker.events.filter((event) => event.type === 'tool-result')).toHaveLength(
      batches.reduce((sum, batch) => sum + batch.length, 0),
    );
  } finally {
    if (previousSelf === undefined) delete (globalThis as any).self;
    else Object.defineProperty(globalThis, 'self', { value: previousSelf, configurable: true });
  }
};
