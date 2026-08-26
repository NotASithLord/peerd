import { describe, expect, test } from 'bun:test';
import { makeControllerTurnBridge } from '../../extension/background/controller-turn-bridge.js';
import { runControllerTurn } from '../../extension/offscreen/controller-turn-runtime.js';
import { runUserTurn as runDirectTurn } from '../../extension/peerd-runtime/loop/agent-loop.js';
import { getToolPolicy } from '../../extension/peerd-runtime/tools/metadata/policy.js';
import { projectToolAuthority, toToolDescriptor } from '../../extension/peerd-runtime/tools/metadata/descriptor.js';
import { hydrateToolDescriptors } from '../../extension/peerd-runtime/semantic.js';
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
  captureEvents?: any[];
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
  ctx, captureEvents, inspectOuter, inspectModelRequest, interceptKernel,
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
      const signal = options.signal ?? new AbortController().signal;
      return runControllerTurn(payload, {
        signal,
        authority,
        kernelCall: (operation, kernelPayload) => {
          const reverseSignal = new AbortController().signal;
          const invoke = (candidateOperation: string, candidatePayload: any) =>
            Promise.resolve(bridge.handleKernelCall(
              candidateOperation,
              candidatePayload,
              { capability, authority, signal: reverseSignal, deadlineAt: Date.now() + 60_000 },
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
    for await (const event of bridge.runUserTurn(ctx)) {
      events.push(event);
      captureEvents?.push(event);
    }
    return events;
  } finally {
    bridge.close();
  }
};

// why: this suite exercises the temporary legacy-dispatch custody path. Keep
// its fixture on a tool that is still explicitly legacy-owned as semantic
// domains leave that lane.
const descriptor = projectToolAuthority(toToolDescriptor(getToolPolicy('read_pdf')));

const makeSimpleCtx = (sessions: ReturnType<typeof makeSessions>, capture: any[]) => ({
  sessionId: 'session-1',
  userText: 'inspect the image',
  attachments: [{
    name: 'pixel.png', mediaType: 'image/png', kind: 'image' as const, size: 3,
    data: 'RAW-IMAGE-BYTES',
  }],
  sessions,
  tools: [descriptor],
  refreshTools: async () => [descriptor],
  classifyToolCall: () => ({ actionClass: 'read', confirm: false }),
  toolDispatch: async () => ({ ok: true, content: 'unused' }),
  getSystemPrompt: async () => 'PINNED-SYSTEM',
  appendAudit: async () => {},
  enrichTrimSummary: () => {},
  getSecret: async () => 'RAW-PROVIDER-SECRET',
  safeFetch: async () => new Response('unused'),
  signal: new AbortController().signal,
  now: () => 1_700_000_000_000,
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
  test('matches direct loop transcript/event semantics and keeps secrets/binaries kernel-side', async () => {
    const directSessions = makeSessions();
    const controllerSessions = makeSessions();
    const directCalls: any[] = [];
    const controllerCalls: any[] = [];
    const directCtx: any = makeSimpleCtx(directSessions, directCalls);
    directCtx.tools = hydrateToolDescriptors(directCtx.tools);
    directCtx.refreshTools = async () => directCtx.tools;
    const directEvents = await drain(runDirectTurn(directCtx as any));
    const observedTransport: string[] = [];
    const authorityMedia: string[] = [];
    const controllerEvents = await runPrototype({
      ctx: makeSimpleCtx(controllerSessions, controllerCalls),
      inspectOuter: (payload) => observedTransport.push(JSON.stringify(payload)),
      inspectModelRequest: (request, grant) => {
        const token = request.nativeBody.messages[0].content[0].source.data;
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
    expect(normalize(controllerCalls)).toEqual(normalize(directCalls));
    expect(authorityMedia).toEqual(['RAW-IMAGE-BYTES']);
    expect(observedTransport.join('\n')).not.toContain('RAW-IMAGE-BYTES');
    expect(observedTransport.join('\n')).not.toContain('RAW-PROVIDER-SECRET');
  });

  test('preserves model, system, tool and model-emitted call pins', async () => {
    const sessions = makeSessions();
    let modelCalls = 0;
    let dispatches = 0;
    const ctx = {
      ...makeSimpleCtx(sessions, []),
      attachments: undefined,
      callModel: async function* () {
        modelCalls += 1;
        if (modelCalls > 1) {
          yield { type: 'text-delta', text: 'recovered' };
          yield { type: 'message-stop', stopReason: 'end_turn' };
          return;
        }
        yield { type: 'tool-use-start', id: 'tool-1', name: descriptor.name };
        yield { type: 'tool-use-delta', id: 'tool-1', partialJson: '{"value":7}' };
        yield { type: 'tool-use-stop', id: 'tool-1' };
        yield { type: 'message-stop', stopReason: 'tool_use' };
      },
      toolDispatch: async () => { dispatches += 1; return { ok: true, content: 'should not run' }; },
      oneShot: true,
    };
    const events = await runPrototype({
      ctx,
      interceptKernel: async (operation, payload, next) => {
        if (operation === 'turn.tool.dispatch') {
          const call = JSON.parse(payload.value.callJson);
          call.args = { value: 8 };
          payload.value.callJson = JSON.stringify(call);
        }
        return next();
      },
    });
    expect(modelCalls).toBe(2);
    expect(dispatches).toBe(0);
    expect(events.some((event) => event.type === 'tool-result'
      && event.result?.ok === false
      && String(event.result?.error).includes('not issued by the pinned model'))).toBe(true);

    const pinSessions = makeSessions();
    let pinModelCalls = 0;
    const pinEvents = await runPrototype({
      ctx: {
        ...makeSimpleCtx(pinSessions, []), attachments: undefined,
        callModel: async function* () { pinModelCalls += 1; },
      },
      interceptKernel: async (operation, payload, next) => {
        if (operation === 'turn.model.open-inference') {
          payload.value.modelId = 'forged-model';
        }
        return next();
      },
    });
    expect(pinModelCalls).toBe(0);
    expect(pinEvents.some((event) => event.type === 'error'
      && String(event.error).includes('model-egress-request-invalid'))).toBe(true);
  });

  test('kernel scheduling revalidates concurrency when the host forges a read classification', async () => {
    const sessions = makeSessions();
    let active = 0;
    let maxActive = 0;
    let round = 0;
    const ctx = {
      ...makeSimpleCtx(sessions, []), attachments: undefined,
      classifyToolCall: () => ({ actionClass: 'write', confirm: false }),
      callModel: async function* () {
        round += 1;
        if (round > 1) {
          yield { type: 'message-stop', stopReason: 'end_turn' };
          return;
        }
        for (const id of ['write-1', 'write-2']) {
          yield { type: 'tool-use-start', id, name: descriptor.name };
          yield { type: 'tool-use-delta', id, partialJson: '{}' };
          yield { type: 'tool-use-stop', id };
        }
        yield { type: 'message-stop', stopReason: 'tool_use' };
      },
      toolDispatch: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return { ok: true, content: 'written' };
      },
    };
    await runPrototype({
      ctx,
      inspectOuter: (payload) => {
        payload.classifications[descriptor.name] = { actionClass: 'read', confirm: false };
      },
    });
    expect(maxActive).toBe(1);
  });

  test('a queued write cannot enter tool dispatch after Stop', async () => {
    const sessions = makeSessions();
    const abort = new AbortController();
    let round = 0;
    const started: string[] = [];
    let firstStarted = () => {};
    let releaseFirst = () => {};
    const admitted = new Promise<void>((resolve) => { firstStarted = resolve; });
    const running = runPrototype({
      ctx: {
        ...makeSimpleCtx(sessions, []), attachments: undefined, signal: abort.signal,
        classifyToolCall: () => ({ actionClass: 'write', confirm: false }),
        callModel: async function* () {
          round += 1;
          if (round > 1) return;
          for (const id of ['write-1', 'write-2']) {
            yield { type: 'tool-use-start', id, name: descriptor.name };
            yield { type: 'tool-use-delta', id, partialJson: '{}' };
            yield { type: 'tool-use-stop', id };
          }
          yield { type: 'message-stop', stopReason: 'tool_use' };
        },
        toolDispatch: (call: any) => {
          started.push(call.id);
          if (call.id !== 'write-1') return Promise.resolve({ ok: true, content: 'late' });
          firstStarted();
          return new Promise((resolve) => {
            releaseFirst = () => resolve({ ok: true, content: 'first' });
          });
        },
      },
      inspectOuter: (payload) => {
        payload.classifications[descriptor.name] = { actionClass: 'read', confirm: false };
      },
    }).catch((error) => error);
    await admitted;
    abort.abort();
    releaseFirst();
    await running;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(['write-1']);
  });

  test('post-cancel reverse RPCs cannot reach kernel effects', async () => {
    const sessions = makeSessions();
    const abort = new AbortController();
    let modelCalls = 0;
    let dispatches = 0;
    let forgedAudit = false;
    let admitted = () => {};
    let release = () => {};
    const toolAdmitted = new Promise<void>((resolve) => { admitted = resolve; });
    const denied: any[] = [];
    const running = runPrototype({
      ctx: {
        ...makeSimpleCtx(sessions, []), attachments: undefined, signal: abort.signal,
        appendAudit: async (entry: any) => { if (entry?.forged) forgedAudit = true; },
        callModel: async function* () {
          modelCalls += 1;
          yield { type: 'tool-use-start', id: 'write-live', name: descriptor.name };
          yield { type: 'tool-use-delta', id: 'write-live', partialJson: '{}' };
          yield { type: 'tool-use-stop', id: 'write-live' };
          yield { type: 'message-stop', stopReason: 'tool_use' };
        },
        toolDispatch: () => {
          dispatches += 1;
          admitted();
          return new Promise((resolve) => { release = () => resolve({ ok: true }); });
        },
      },
      interceptKernel: async (operation, payload, next, invoke) => {
        if (operation === 'turn.abort.finalize') {
          const runId = payload.runId;
          denied.push(await invoke('turn.session.append', {
            runId, value: { sessionId: 'session-1', messageJson: JSON.stringify({ role: 'user', content: 'FORGED' }) },
          }));
          denied.push(await invoke('turn.model.open-inference', { runId, value: {} }));
          denied.push(await invoke('turn.tool.dispatch', { runId, value: {} }));
          denied.push(await invoke('turn.audit.append', { runId, value: { entry: { forged: true } } }));
        }
        return next();
      },
    }).catch((error) => error);
    await toolAdmitted;
    abort.abort();
    await running;
    release();

    expect(denied).toHaveLength(4);
    expect(denied.every((reply) => reply.code === 'turn-run-aborted'
      && reply.outcomeKnown === true)).toBe(true);
    expect(sessions.snapshot().messages.some((message: any) => message.content === 'FORGED')).toBe(false);
    expect(modelCalls).toBe(1);
    expect(dispatches).toBe(1);
    expect(forgedAudit).toBe(false);
  });

  test('historical assistant IDs cannot be updated or abort-finalized', async () => {
    const sessions = makeSessions();
    const abort = new AbortController();
    let round = 0;
    const assistantIds: string[] = [];
    const denied: any[] = [];
    await runPrototype({
      ctx: {
        ...makeSimpleCtx(sessions, []), attachments: undefined, signal: abort.signal,
        oneShot: false,
        callModel: async function* () {
          round += 1;
          if (round === 1) {
            yield { type: 'tool-use-start', id: 'advance', name: descriptor.name };
            yield { type: 'tool-use-delta', id: 'advance', partialJson: '{}' };
            yield { type: 'tool-use-stop', id: 'advance' };
            yield { type: 'message-stop', stopReason: 'tool_use' };
            return;
          }
          yield { type: 'message-stop', stopReason: 'end_turn' };
        },
        toolDispatch: async () => ({ ok: true, content: 'advance' }),
      },
      interceptKernel: async (operation, payload, next, invoke) => {
        const message = operation === 'turn.session.append'
          ? JSON.parse(payload.value.messageJson) : null;
        const result = await next();
        if (message?.role !== 'assistant') return result;
        assistantIds.push(message.id);
        if (assistantIds.length !== 2) return result;
        const runId = payload.runId;
        denied.push(await invoke('turn.session.update-assistant', {
          runId,
          value: {
            sessionId: 'session-1', messageId: assistantIds[0],
            patchJson: JSON.stringify({ content: 'FORGED-HISTORICAL' }),
          },
        }));
        abort.abort();
        denied.push(await invoke('turn.abort.finalize', {
          runId,
          value: { sessionId: 'session-1', messageId: assistantIds[0] },
        }));
        return result;
      },
    }).catch(() => {});

    expect(denied).toHaveLength(2);
    expect(denied.every((reply) => reply.outcomeKnown === true)).toBe(true);
    const historical = sessions.snapshot().messages.find(
      (message: any) => message.id === assistantIds[0],
    );
    expect(historical.content).not.toBe('FORGED-HISTORICAL');
    expect(historical.stopReason).not.toBe('aborted');
  });

  test('resume can finalize only its exact trailing interrupted assistant', async () => {
    const sessions = makeSessions();
    await sessions.appendMessage('session-1', {
      role: 'assistant', content: 'partial', id: 'interrupted-assistant',
      when: 1, streaming: true,
    });
    await runPrototype({
      ctx: {
        ...makeSimpleCtx(sessions, []), attachments: undefined, resume: true,
        callModel: async function* () {
          yield { type: 'message-stop', stopReason: 'end_turn' };
        },
      },
    });
    const interrupted = sessions.snapshot().messages.find(
      (message: any) => message.id === 'interrupted-assistant',
    );
    expect(interrupted).toMatchObject({ streaming: false, content: 'partial' });
  });

  test('large read waves are backpressured without refusing or duplicating tools', async () => {
    const sessions = makeSessions();
    let round = 0;
    let active = 0;
    let maxActive = 0;
    const landed = new Set<string>();
    const toolCount = 130;
    const ctx = {
      ...makeSimpleCtx(sessions, []), attachments: undefined,
      callModel: async function* () {
        round += 1;
        if (round > 1) {
          yield { type: 'message-stop', stopReason: 'end_turn' };
          return;
        }
        for (let index = 0; index < toolCount; index += 1) {
          const id = `read-${index}`;
          yield { type: 'tool-use-start', id, name: descriptor.name };
          yield { type: 'tool-use-delta', id, partialJson: `{\"index\":${index}}` };
          yield { type: 'tool-use-stop', id };
        }
        yield { type: 'message-stop', stopReason: 'tool_use' };
      },
      toolDispatch: async (call: any) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        expect(landed.has(call.id)).toBe(false);
        landed.add(call.id);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return { ok: true, content: call.id };
      },
    };
    await runPrototype({ ctx });
    expect(landed.size).toBe(toolCount);
    expect(maxActive).toBeLessThanOrEqual(64);
    expect(active).toBe(0);
  });

  test('large structured ToolResults and session mutations round-trip only as packed JSON', async () => {
    const sessions = makeSessions();
    const rows = Array.from({ length: 12_000 }, (_, index) => ({ index, value: `row-${index}` }));
    let modelRound = 0;
    let sawPackedDispatch = false;
    let sawPackedAppend = false;
    let sawPackedUpdate = false;
    const events = await runPrototype({
      ctx: {
        ...makeSimpleCtx(sessions, []), attachments: undefined,
        callModel: async function* () {
          modelRound += 1;
          if (modelRound > 1) {
            yield { type: 'message-stop', stopReason: 'end_turn' };
            return;
          }
          yield { type: 'tool-use-start', id: 'large-tool', name: descriptor.name };
          yield { type: 'tool-use-delta', id: 'large-tool', partialJson: '{}' };
          yield { type: 'tool-use-stop', id: 'large-tool' };
          yield { type: 'message-stop', stopReason: 'tool_use' };
        },
        toolDispatch: async () => ({ ok: true, content: { rows } }),
      },
      interceptKernel: async (operation, payload, next) => {
        if (operation === 'turn.session.append') {
          expect(typeof payload.value.messageJson).toBe('string');
          expect(payload.value.message).toBeUndefined();
          sawPackedAppend = true;
        }
        if (operation === 'turn.session.update-assistant') {
          expect(typeof payload.value.patchJson).toBe('string');
          expect(payload.value.patch).toBeUndefined();
          sawPackedUpdate = true;
        }
        const result = await next();
        if (operation === 'turn.tool.dispatch') {
          expect(typeof result.value).toBe('string');
          expect(JSON.parse(result.value).content.rows).toHaveLength(rows.length);
          sawPackedDispatch = true;
        }
        return result;
      },
    });
    const toolResult = events.find((event) => event.type === 'tool-result');
    expect(toolResult?.result?.content?.rows).toHaveLength(rows.length);
    expect(sawPackedDispatch).toBe(true);
    expect(sawPackedAppend).toBe(true);
    expect(sawPackedUpdate).toBe(true);
  });

  test('a landed tool followed by rejection remains unknown and is never replayed', async () => {
    const sessions = makeSessions();
    let landed = 0;
    let modelRound = 0;
    const ctx = {
      ...makeSimpleCtx(sessions, []),
      attachments: undefined,
      oneShot: true,
      callModel: async function* () {
        modelRound += 1;
        yield { type: 'tool-use-start', id: 'tool-unknown', name: descriptor.name };
        yield { type: 'tool-use-delta', id: 'tool-unknown', partialJson: '{}' };
        yield { type: 'tool-use-stop', id: 'tool-unknown' };
        yield { type: 'message-stop', stopReason: 'tool_use' };
      },
      toolDispatch: async () => {
        landed += 1;
        throw new Error('channel lost after dispatch');
      },
    };
    let failure: any = null;
    try { await runPrototype({ ctx }); } catch (cause) { failure = cause; }
    expect(landed).toBe(1);
    expect(modelRound).toBe(1);
    expect(failure?.outcomeKnown).toBe(false);
    const persisted = sessions.snapshot().messages.find((message: any) => message.toolResults);
    expect(persisted.toolResults[0]).toMatchObject({
      is_error: true, outcomeKnown: false, retryable: false,
    });
    expect(persisted.toolResults[0].content).toStartWith('outcome_unknown:');
  });

  test('outer channel loss after a successful dispatch is still unknown', async () => {
    const sessions = makeSessions();
    let landed = 0;
    const ctx = {
      ...makeSimpleCtx(sessions, []), attachments: undefined, oneShot: true,
      callModel: async function* () {
        if (landed > 0) {
          yield { type: 'message-stop', stopReason: 'end_turn' };
          return;
        }
        yield { type: 'tool-use-start', id: 'tool-lost', name: descriptor.name };
        yield { type: 'tool-use-delta', id: 'tool-lost', partialJson: '{}' };
        yield { type: 'tool-use-stop', id: 'tool-lost' };
        yield { type: 'message-stop', stopReason: 'tool_use' };
      },
      toolDispatch: async () => { landed += 1; return { ok: true, content: 'landed' }; },
    };
    let failure: any = null;
    try {
      await runPrototype({
        ctx,
        interceptKernel: async (operation, _payload, next) => {
          const result = await next();
          return operation === 'turn.tool.dispatch'
            ? { ok: false, code: 'kernel-channel-lost', outcomeKnown: false }
            : result;
        },
      });
    } catch (cause) { failure = cause; }
    expect(landed).toBe(1);
    expect(failure?.outcomeKnown).toBe(false);
  });

  test('a provider stream rejection remains a known failure', async () => {
    const sessions = makeSessions();
    const ctx = {
      ...makeSimpleCtx(sessions, []), attachments: undefined,
      callModel: async function* () {
        throw new Error("Provider 'fixture' HTTP 400: rejected");
      },
    };
    const events = await runPrototype({ ctx });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error', error: "Provider 'fixture' HTTP 400: rejected",
    }));
    expect(sessions.snapshot().messages.at(-1)).toMatchObject({
      role: 'assistant', streaming: false,
      error: "Provider 'fixture' HTTP 400: rejected",
    });
  });

  test('a lost model-event receipt is terminal and never exposes transport text', async () => {
    const sessions = makeSessions();
    let modelCalls = 0;
    let modelNext = 0;
    const ctx = {
      ...makeSimpleCtx(sessions, []), attachments: undefined,
      callModel: async function* () {
        modelCalls += 1;
        yield { type: 'tool-use-start', id: 'unreceived', name: descriptor.name };
      },
    };
    let failure: any = null;
    const events: any[] = [];
    try {
      await runPrototype({
        ctx,
        captureEvents: events,
        interceptKernel: async (operation, _payload, next) => {
          const result = await next();
          if (operation !== 'turn.model.observe-event') return result;
          modelNext += 1;
          return modelNext === 1 ? {
            ok: false, code: 'kernel-channel-lost',
            error: 'reverse channel lost after model event', outcomeKnown: false,
          } : result;
        },
      });
    } catch (cause) { failure = cause; }
    expect(modelCalls).toBe(1);
    expect(modelNext).toBe(1);
    expect(failure).toMatchObject({ outcomeKnown: false });
    const snapshot = sessions.snapshot();
    expect(snapshot.messages.at(-1)).toMatchObject({
      role: 'assistant', streaming: false,
      error: 'Turn outcome unknown. Check the session before retrying.',
      errorCode: 'kernel-channel-lost', outcomeKnown: false, retryable: false,
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error', error: 'Turn outcome unknown. Check the session before retrying.',
      code: 'kernel-channel-lost', outcomeKnown: false, retryable: false,
    }));
    expect(JSON.stringify({ events, snapshot })).not.toContain('reverse channel lost');
  });

  test('a resolved ToolResult with unknown custody cannot be laundered by the loop', async () => {
    const sessions = makeSessions();
    let landed = 0;
    let round = 0;
    const ctx = {
      ...makeSimpleCtx(sessions, []), attachments: undefined, oneShot: true,
      callModel: async function* () {
        round += 1;
        if (round > 1) {
          yield { type: 'message-stop', stopReason: 'end_turn' };
          return;
        }
        yield { type: 'tool-use-start', id: 'tool-resolved-unknown', name: descriptor.name };
        yield { type: 'tool-use-delta', id: 'tool-resolved-unknown', partialJson: '{}' };
        yield { type: 'tool-use-stop', id: 'tool-resolved-unknown' };
        yield { type: 'message-stop', stopReason: 'tool_use' };
      },
      toolDispatch: async () => {
        landed += 1;
        return { ok: false, error: 'outcome_unknown', outcomeKnown: false };
      },
    };
    let failure: any = null;
    try { await runPrototype({ ctx }); } catch (cause) { failure = cause; }
    expect(landed).toBe(1);
    expect(round).toBe(1);
    expect(failure?.outcomeKnown).toBe(false);
  });

  test('post-commit Stop persists and emits an ordinary aborted turn', async () => {
    const sessions = makeSessions();
    const abort = new AbortController();
    const operations: string[] = [];
    let opened = () => {};
    const modelOpened = new Promise<void>((resolve) => { opened = resolve; });
    const ctx = {
      ...makeSimpleCtx(sessions, []), attachments: undefined, signal: abort.signal,
      callModel: async function* (args: any) {
        opened();
        await new Promise((_, reject) => {
          const stop = () => reject(new DOMException('model aborted', 'AbortError'));
          if (args.signal.aborted) stop();
          else args.signal.addEventListener('abort', stop, { once: true });
        });
      },
    };
    const turn = runPrototype({
      ctx,
      interceptKernel: async (operation, _payload, next) => {
        operations.push(operation);
        if (operation === 'turn.model.cancel-inference' && abort.signal.aborted) {
          return { ok: false, code: 'controller-call-aborted', outcomeKnown: false };
        }
        return next();
      },
    });
    await modelOpened;
    abort.abort();
    const events = await turn;
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'stop', stopReason: 'aborted',
    }));
    expect(sessions.snapshot().messages.at(-1)).toMatchObject({
      role: 'assistant', streaming: false, stopReason: 'aborted',
    });
    expect(operations.filter((operation) => operation === 'turn.abort.finalize')).toHaveLength(1);
    expect(operations).not.toContain('turn.model.cancel-inference');
  });

  test('a failed read-only session lookup remains known-safe', async () => {
    const base = makeSessions();
    let writes = 0;
    const sessions = {
      ...base,
      get: async () => { throw new Error('read unavailable'); },
      appendMessage: async (...args: Parameters<typeof base.appendMessage>) => {
        writes += 1;
        return base.appendMessage(...args);
      },
    };
    const ctx = { ...makeSimpleCtx(sessions, []), attachments: undefined, resume: true };
    let failure: any = null;
    try { await runPrototype({ ctx }); } catch (cause) { failure = cause; }
    expect(writes).toBe(0);
    expect(failure?.outcomeKnown).toBe(true);
  });

  test('pre-dispatch abort is known-safe and performs no session/model/tool effect', async () => {
    const sessions = makeSessions();
    const abort = new AbortController();
    abort.abort();
    let modelCalls = 0;
    let dispatches = 0;
    const ctx = {
      ...makeSimpleCtx(sessions, []),
      signal: abort.signal,
      callModel: async function* () { modelCalls += 1; },
      toolDispatch: async () => { dispatches += 1; return { ok: true }; },
    };
    let failure: any = null;
    try { await runPrototype({ ctx }); } catch (cause) { failure = cause; }
    expect(failure?.outcomeKnown).toBe(true);
    expect(modelCalls).toBe(0);
    expect(dispatches).toBe(0);
    expect(sessions.snapshot().messages).toEqual([]);
  });
});
