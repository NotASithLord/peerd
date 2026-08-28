import { describe, expect, test } from 'bun:test';
import { makeControllerTurnBridge } from '../../extension/background/controller-turn-bridge.js';
import { semanticCallAuditEntry } from '../../extension/background/semantic-call-audit.js';
import { runControllerTurn } from '../../extension/offscreen/controller-turn-runtime.js';
import { startActorWorker } from '../../extension/offscreen/actor-worker-runtime.js';
import { describeActorExecution } from '../../extension/offscreen/actor-runner.js';
import { projectControllerToolSurface } from '../../extension/peerd-runtime/controller-tool-projection.js';
import { makeScriptedProviderAuthority } from '../peerd-provider/model-egress-fixture';

const projection: any = projectControllerToolSurface({
  surface: 'selection', toolNames: ['now'],
});

const makeModelCall = () => {
  let round = 0;
  return async function* () {
    round += 1;
    if (round > 1) {
      yield { type: 'message-stop', stopReason: 'end_turn' };
      return;
    }
    yield { type: 'tool-use-start', id: 'same-now-call', name: 'now' };
    yield { type: 'tool-use-delta', id: 'same-now-call', partialJson: '{}' };
    yield { type: 'tool-use-stop', id: 'same-now-call' };
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

const runMain = async () => {
  const sessionId = 'main-failure-parity';
  const store = sessions(sessionId);
  const audits: any[] = [];
  const ctx: any = {
    sessionId, session: { sessionId, kind: 'chat' }, userText: 'what time is it?',
    sessions: store, tools: projection.tools, allowedOperations: projection.operations,
    refreshTools: async () => projection,
    semanticPolicy: { exposure: 'main', permission: { mode: 'act', confirmActions: false } },
    permission: { mode: 'act', confirmActions: false },
    classifyToolCall: () => ({ actionClass: 'read', confirm: false }),
    getSystemPrompt: async () => 'PINNED', appendAudit: async (entry: any) => audits.push(entry),
    enrichTrimSummary: () => {}, signal: new AbortController().signal,
    previousTurnAt: null, turnNow: 1_700_000_000_000,
    activeTabContext: null, protectedTabContext: null, recoveryBlock: '',
    reasoning: { enabled: false }, oneShot: true, callModel: makeModelCall(),
  };
  const provider = makeScriptedProviderAuthority(() => ctx.callModel);
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
    getClient, newId: () => `main-failure-${++sequence}`, providerEgress: provider as any,
  });
  const events: any[] = [];
  try {
    for await (const event of bridge.runUserTurn(ctx)) events.push(event);
  } finally { bridge.close(); }
  return {
    result: events.find((event) => event.type === 'tool-result')?.result,
    audit: audits.find((entry) => entry.details?.callId === 'same-now-call'),
  };
};

class WorkerGlobal {
  listener: ((event: MessageEvent) => void | Promise<void>) | null = null;
  events: any[] = [];
  modelCall = makeModelCall();
  provider = makeScriptedProviderAuthority(() => this.modelCall);
  grant = {
    owner: {}, signal: new AbortController().signal,
    permits: (providerId: string, modelId: string) =>
      providerId === 'anthropic' && modelId === 'claude-sonnet-4-6',
  };
  done!: (value: any) => void;
  completion = new Promise((resolve) => { this.done = resolve; });

  addEventListener(type: string, listener: (event: MessageEvent) => void | Promise<void>) {
    if (type === 'message') this.listener = listener;
  }

  dispatch(data: any) {
    queueMicrotask(() => { void this.listener?.({ data } as MessageEvent); });
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
    }
  }
}

const runActor = async () => {
  const worker = new WorkerGlobal();
  const previousSelf = globalThis.self;
  Object.defineProperty(globalThis, 'self', { value: worker, configurable: true });
  try {
    startActorWorker();
    worker.dispatch({
      type: 'run',
      execution: describeActorExecution({
        actorSessionId: 'actor-failure-parity', message: 'what time is it?',
        systemPrompt: 'PINNED', provider: 'anthropic', model: 'claude-sonnet-4-6',
        maxSteps: 1, maxOutputTokens: 256, oneShot: true,
        tools: projection.tools, priorMessages: [], recordKind: 'spawned',
        turnGeneration: 'actor-failure-generation',
      }, 'actor-failure-run'),
      tools: projection.tools, programTools: [], runtimeCapabilities: null,
      semanticPolicy: { permission: { mode: 'act', confirmActions: false } },
    });
    const done: any = await worker.completion;
    if (done.type === 'error') throw new Error(done.error);
    return {
      result: worker.events.find((event) => event.type === 'tool-result')?.result,
      done: done.result,
    };
  } finally {
    if (previousSelf === undefined) delete (globalThis as any).self;
    else Object.defineProperty(globalThis, 'self', { value: previousSelf, configurable: true });
  }
};

describe('main and actor semantic failure integration parity', () => {
  test.serial('preserves the same zero-effect executor failure through both real runtimes', async () => {
    const original = Intl.DateTimeFormat;
    Object.defineProperty(Intl, 'DateTimeFormat', {
      configurable: true,
      value: () => { throw new Error('same semantic fixture failure'); },
    });
    try {
      const main = await runMain();
      const actor = await runActor();
      const expected = {
        ok: false, error: 'same semantic fixture failure',
        code: 'controller-tool-execution-failed', outcomeKnown: true, retryable: true,
      };
      expect(main.result).toMatchObject(expected);
      expect(actor.result).toMatchObject(expected);
      const stableMeta = ({ durationMs: _duration, dispatch: _dispatch, ...meta }: any) => meta;
      expect(stableMeta(actor.result.meta)).toEqual(stableMeta(main.result.meta));
      expect(main.audit).toMatchObject({
        type: 'tool_failed', details: { outcome: 'semantic-failure', outcomeKnown: true },
      });
      expect(semanticCallAuditEntry({
        sessionId: 'actor-failure-parity', callId: 'same-now-call',
        label: 'now', result: actor.result,
      })).toMatchObject({
        type: main.audit.type,
        details: {
          outcome: main.audit.details.outcome,
          outcomeKnown: main.audit.details.outcomeKnown,
          performed: main.audit.details.performed,
        },
      });
    } finally {
      Object.defineProperty(Intl, 'DateTimeFormat', { configurable: true, value: original });
    }
  });
});
