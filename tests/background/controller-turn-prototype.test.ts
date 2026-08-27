import { describe, expect, test } from 'bun:test';
import { makeControllerTurnBridge } from '../../extension/background/controller-turn-bridge.js';
import { CONTROLLER_AUTHORITY_MANIFEST } from '../../extension/shared/controller-authority-manifest.js';
import { runControllerTurn } from '../../extension/offscreen/controller-turn-runtime.js';
import { createControllerModelEgress } from '../../extension/offscreen/model-egress-client.js';
import { runUserTurn as runDirectTurn } from '../../extension/peerd-runtime/loop/agent-loop.js';
import {
  buildTemporalBlock, buildTemporalContext,
} from '../../extension/peerd-runtime/controller.js';
import { makeScriptedProviderAuthority } from '../peerd-provider/model-egress-fixture';

const clone = <T>(value: T): T => structuredClone(value);

const makeSessions = () => {
  let record: any = {
    sessionId: 'session-1', provider: 'anthropic', model: 'claude-sonnet-4-6', messages: [],
  };
  return {
    get: async (sessionId: string) => sessionId === record.sessionId ? clone(record) : undefined,
    appendMessage: async (sessionId: string, message: any) => {
      if (sessionId !== record.sessionId) throw new Error('session not found');
      record = { ...record, messages: [...record.messages, clone(message)] };
      return clone(record);
    },
    updateAssistantMessage: async (sessionId: string, messageId: string, patch: any) => {
      if (sessionId !== record.sessionId) throw new Error('session not found');
      const index = record.messages.findIndex((message: any) => message.id === messageId);
      if (index < 0) throw new Error('assistant message not found');
      const messages = [...record.messages];
      messages[index] = { ...messages[index], ...clone(patch) };
      record = { ...record, messages };
      return clone(record);
    },
    setTrimSummary: async (sessionId: string, state: any) => {
      if (sessionId !== record.sessionId) throw new Error('session not found');
      record = { ...record, trimSummary: clone(state) };
      return clone(record);
    },
    snapshot: () => clone(record),
  };
};

const normalize = (value: any): any => {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, any> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'when') out[key] = 0;
    else if ((key === 'id' || key === 'messageId')
        && typeof entry === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(entry)) {
      out[key] = '<generated-id>';
    } else out[key] = normalize(entry);
  }
  return out;
};

const withoutProjectedPrice = (events: any[]) => events.map((event) => {
  if (event?.type !== 'usage') return event;
  const { price: _price, ...rest } = event;
  return rest;
});

const drain = async (iterable: AsyncIterable<any>) => {
  const values: any[] = [];
  for await (const value of iterable) values.push(value);
  return values;
};

type HarnessOptions = {
  ctx: any;
  inspectOuter?: (payload: any) => void;
  inspectModelRequest?: (request: any, grant: any) => void;
  interceptKernel?: (
    operation: string,
    payload: any,
    next: () => Promise<any>,
    invoke: (operation: string, payload: any) => Promise<any>,
  ) => Promise<any>;
};

const runPrototype = async ({
  ctx, inspectOuter, inspectModelRequest, interceptKernel,
}: HarnessOptions) => {
  let bridge: ReturnType<typeof makeControllerTurnBridge>;
  let id = 0;
  const getClient = async () => ({
    call: async (capability: string, payload: any, options: { signal?: AbortSignal }) => {
      inspectOuter?.(payload);
      if (options.signal?.aborted) {
        return {
          ok: false, code: 'controller-call-aborted', outcomeKnown: true, phase: 'startup',
        };
      }
      const authority = bridge.authorize(payload);
      if (!authority) return { ok: false, code: 'authority-invalid', outcomeKnown: true };
      return runControllerTurn(payload, {
        signal: options.signal ?? new AbortController().signal,
        authority,
        kernelCall: (operation, kernelPayload) => {
          const invoke = (candidateOperation: string, candidatePayload: any) =>
            Promise.resolve(bridge.handleKernelCall(
              candidateOperation,
              candidatePayload,
              {
                capability,
                authority,
                signal: new AbortController().signal,
                deadlineAt: Date.now() + 60_000,
              },
            ));
          const next = () => invoke(operation, kernelPayload);
          return interceptKernel
            ? interceptKernel(operation, kernelPayload, next, invoke)
            : next();
        },
      });
    },
  });
  bridge = makeControllerTurnBridge({
    getClient,
    newId: () => `prototype-${++id}`,
    providerEgress: makeScriptedProviderAuthority(
      () => ctx.callModel,
      (request, grant) => inspectModelRequest?.(request, grant),
    ) as any,
  });
  try {
    const events = [];
    for await (const event of bridge.runUserTurn(ctx)) events.push(event);
    return events;
  } finally {
    bridge.close();
  }
};

const makeSimpleCtx = (sessions: ReturnType<typeof makeSessions>, capture: any[]) => ({
  sessionId: 'session-1',
  userText: 'inspect the image',
  attachments: [{
    name: 'pixel.png', mediaType: 'image/png', kind: 'image' as const, size: 3,
    data: 'RAW-IMAGE-BYTES',
  }],
  sessions,
  tools: [],
  refreshTools: async () => [],
  classifyToolCall: () => ({ actionClass: 'read', confirm: false }),
  getSystemPrompt: async () => 'PINNED-SYSTEM',
  appendAudit: async () => {},
  enrichTrimSummary: () => {},
  getSecret: async () => 'RAW-PROVIDER-SECRET',
  safeFetch: async () => new Response('unused'),
  signal: new AbortController().signal,
  now: () => 1_700_000_000_000,
  previousTurnAt: null,
  turnNow: 1_700_000_000_000,
  activeTabContext: null,
  protectedTabContext: null,
  recoveryBlock: '',
  contextMessage: buildTemporalContext({
    temporalBlock: buildTemporalBlock({ lastTurnAt: null, nowMs: 1_700_000_000_000 }),
  }),
  reasoning: { enabled: false },
  callModel: async function* () {
    capture.push({ called: true });
    yield { type: 'text-delta', text: 'done' };
    yield {
      type: 'usage',
      usage: { inputTokens: 3, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
    yield { type: 'message-stop', stopReason: 'end_turn' };
  },
});

describe('orchestrator controller turn boundary', () => {
  test('Stop reaches both exact remote and local model cancellation operations', async () => {
    const operations: string[] = [];
    const modelEgress = createControllerModelEgress({
      call: async (operation: string) => {
        operations.push(operation);
        if (operation === 'turn.model.open-inference') return {
          streamId: 'remote-stream', status: 200, headers: {}, hasBody: true,
        };
        if (operation === 'turn.model.open-local') return { streamId: 'local-stream' };
        if (operation === 'turn.model.read-local') return { done: true };
        return null;
      },
    });
    const remoteStop = new AbortController();
    remoteStop.abort();
    await modelEgress.openInference({
      providerId: 'anthropic', modelId: 'model', nativeBody: {},
      signal: remoteStop.signal,
    });
    const localStop = new AbortController();
    localStop.abort();
    const local = modelEgress.generateLocal({
      providerId: 'local-webgpu', modelId: 'model', messages: [], system: '', tools: [],
      maxTokens: 1, signal: localStop.signal,
    });
    await local.next();
    for (let attempt = 0; attempt < 10
      && !operations.includes('turn.model.cancel-inference'); attempt += 1) {
      await Promise.resolve();
    }
    expect(operations).toContain('turn.model.cancel-inference');
    expect(operations).toContain('turn.model.cancel-local');
  });

  test('emergency bridge close releases active provider owners', async () => {
    const released: object[] = [];
    const bridge = makeControllerTurnBridge({
      getClient: async () => ({
        call: () => new Promise(() => {}),
      }),
      providerEgress: {
        closeOwner: async (owner: object) => { released.push(owner); },
      } as any,
      newId: () => 'emergency-close-run',
    });
    const turn = bridge.runUserTurn({
      sessionId: 'session-emergency-close', tools: [],
      signal: new AbortController().signal,
    });
    void turn.next();
    for (let attempt = 0; attempt < 10 && bridge.activeCount() === 0; attempt += 1) {
      await Promise.resolve();
    }
    expect(bridge.activeCount()).toBe(1);

    await bridge.close();

    expect(bridge.activeCount()).toBe(0);
    expect(released).toHaveLength(1);
  });

  test('emergency close does not let a stuck tool post-hook block provider release', async () => {
    let bridge!: ReturnType<typeof makeControllerTurnBridge>;
    let markPrepared!: () => void;
    let markSettlement!: () => void;
    const prepared = new Promise<void>((resolve) => { markPrepared = resolve; });
    const settlement = new Promise<void>((resolve) => { markSettlement = resolve; });
    const released: object[] = [];
    bridge = makeControllerTurnBridge({
      getClient: async () => ({
        call: async (capability: string, payload: any, options: any) => {
          const authority = bridge.authorize(payload);
          const invoke = (operation: string, value: unknown) => bridge.handleKernelCall(
            operation, { runId: payload.runId, value }, {
              capability, authority, signal: options.signal,
              deadlineAt: Date.now() + 60_000,
            },
          );
          await invoke('turn.model.observe-event', {
            type: 'tool-use-start', id: 'close-tool', name: 'complete_goal',
          });
          await invoke('turn.model.observe-event', {
            type: 'tool-use-delta', id: 'close-tool', partialJson: '{"summary":"done"}',
          });
          await invoke('turn.tool.prepare', {
            authorityClass: 'local',
            callJson: JSON.stringify({
              id: 'close-tool', name: 'complete_goal', args: { summary: 'done' },
            }),
          });
          markPrepared();
          return new Promise(() => {});
        },
      }),
      prepareToolCall: async (call: any) => ({
        mode: 'execute', custody: {}, args: call.args, projection: {},
        manifestDigest: CONTROLLER_AUTHORITY_MANIFEST.digest,
      }),
      settleToolCall: async () => { markSettlement(); return new Promise(() => {}); },
      providerEgress: {
        closeOwner: async (owner: object) => { released.push(owner); },
      } as any,
      newId: () => 'stuck-settlement-run',
    });
    const turn = bridge.runUserTurn({
      sessionId: 'session-stuck-settlement',
      tools: [{ name: 'complete_goal' }],
      classifyToolCall: () => ({ actionClass: 'write', confirm: false }),
      signal: new AbortController().signal,
    });
    void turn.next();
    await prepared;

    await bridge.close();
    await settlement;

    expect(bridge.activeCount()).toBe(0);
    expect(released).toHaveLength(1);
  });

  test('matches direct transcript semantics while opaque media stays kernel-side', async () => {
    const directSessions = makeSessions();
    const controllerSessions = makeSessions();
    const directCalls: any[] = [];
    const controllerCalls: any[] = [];
    const directEvents = await drain(runDirectTurn(
      makeSimpleCtx(directSessions, directCalls) as any,
    ));
    const observedTransport: string[] = [];
    const authorityMedia: string[] = [];
    const controllerEvents = await runPrototype({
      ctx: makeSimpleCtx(controllerSessions, controllerCalls),
      inspectOuter: (payload) => observedTransport.push(JSON.stringify(payload)),
      inspectModelRequest: (request, grant) => {
        const token = request.nativeBody.messages
          .flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
          .find((block: any) => typeof block?.source?.data === 'string')?.source.data;
        expect(token).toStartWith('peerd-controller-opaque:');
        authorityMedia.push(grant.redeemOpaque(token));
      },
      interceptKernel: async (_operation, payload, next) => {
        observedTransport.push(JSON.stringify(payload));
        return next();
      },
    });
    expect(controllerEvents.find((event) => event.type === 'usage')?.price)
      .toEqual({ cost: 0.000024, estimated: true });
    expect(normalize(withoutProjectedPrice(controllerEvents))).toEqual(normalize(directEvents));
    expect(normalize(controllerSessions.snapshot())).toEqual(normalize(directSessions.snapshot()));
    expect(controllerCalls).toEqual(directCalls);
    expect(authorityMedia).toEqual(['RAW-IMAGE-BYTES']);
    expect(observedTransport.join('\n')).not.toContain('RAW-IMAGE-BYTES');
  });

  test('pins provider and model before egress opens', async () => {
    const sessions = makeSessions();
    let modelCalls = 0;
    const events = await runPrototype({
      ctx: {
        ...makeSimpleCtx(sessions, []), attachments: undefined,
        callModel: async function* () { modelCalls += 1; },
      },
      interceptKernel: async (operation, payload, next) => {
        if (operation === 'turn.model.open-inference') {
          payload.value.modelId = 'forged-model';
        }
        return next();
      },
    });
    expect(modelCalls).toBe(0);
    expect(events.some((event) => event.type === 'error'
      && String(event.error).includes('model-egress-request-invalid'))).toBe(true);
  });

  test('a pre-dispatch abort performs no model effect', async () => {
    const sessions = makeSessions();
    const controller = new AbortController();
    controller.abort();
    let modelCalls = 0;
    let failure: any = null;
    try {
      await runPrototype({
        ctx: {
          ...makeSimpleCtx(sessions, []),
          signal: controller.signal,
          callModel: async function* () { modelCalls += 1; },
        },
      });
    } catch (cause) { failure = cause; }
    expect(modelCalls).toBe(0);
    expect(failure).toMatchObject({ code: 'controller-call-aborted', outcomeKnown: true });
  });
});
