import { describe, expect, test } from 'bun:test';
import { makeControllerTurnBridge } from '../../extension/background/controller-turn-bridge.js';
import { runControllerTurn } from '../../extension/offscreen/controller-turn-runtime.js';
import { runUserTurn as runDirectTurn } from '../../extension/peerd-runtime/loop/agent-loop.js';

const clone = <T>(value: T): T => structuredClone(value);

const makeSessions = () => {
  let record: any = {
    sessionId: 'session-1', provider: 'provider-1', model: 'model-1', messages: [],
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

const drain = async (iterable: AsyncIterable<any>) => {
  const values: any[] = [];
  for await (const value of iterable) values.push(value);
  return values;
};

type HarnessOptions = {
  ctx: any;
  inspectOuter?: (payload: any) => void;
  interceptKernel?: (
    operation: string,
    payload: any,
    next: () => Promise<any>,
  ) => Promise<any>;
};

const runPrototype = async ({ ctx, inspectOuter, interceptKernel }: HarnessOptions) => {
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
          const next = () => Promise.resolve(bridge.handleKernelCall(
            operation,
            kernelPayload,
            { capability, authority, signal, deadlineAt: Date.now() + 60_000 },
          ));
          return interceptKernel
            ? interceptKernel(operation, kernelPayload, next)
            : next();
        },
      });
    },
  });
  bridge = makeControllerTurnBridge({ getClient, newId: () => `prototype-${++id}` });
  try {
    return await drain(bridge.runUserTurn(ctx));
  } finally {
    bridge.close();
  }
};

const descriptor = {
  name: 'read_fixture', description: 'Read the fixture.', schema: { type: 'object' },
};

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
  callModel: async function* (args: any) {
    const {
      getSecret: _getSecret, safeFetch: _safeFetch, signal: _signal, ...wireArgs
    } = args;
    capture.push(clone(wireArgs));
    expect(args.messages[0].attachments[0].data).toBe('RAW-IMAGE-BYTES');
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
    const directEvents = await drain(runDirectTurn(makeSimpleCtx(directSessions, directCalls) as any));
    const observedTransport: string[] = [];
    const controllerEvents = await runPrototype({
      ctx: makeSimpleCtx(controllerSessions, controllerCalls),
      inspectOuter: (payload) => observedTransport.push(JSON.stringify(payload)),
      interceptKernel: async (_operation, payload, next) => {
        observedTransport.push(JSON.stringify(payload));
        return next();
      },
    });

    expect(normalize(controllerEvents)).toEqual(normalize(directEvents));
    expect(normalize(controllerSessions.snapshot())).toEqual(normalize(directSessions.snapshot()));
    expect(normalize(controllerCalls)).toEqual(normalize(directCalls));
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
        yield { type: 'tool-use-start', id: 'tool-1', name: 'read_fixture' };
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
        if (operation === 'turn.model.open') {
          const request = JSON.parse(payload.value.requestJson);
          request.system = 'FORGED-SYSTEM';
          payload.value.requestJson = JSON.stringify(request);
        }
        return next();
      },
    });
    expect(pinModelCalls).toBe(0);
    expect(pinEvents.some((event) => event.type === 'error'
      && String(event.error).includes('model/tool/system pin mismatch'))).toBe(true);
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
          yield { type: 'tool-use-start', id, name: 'read_fixture' };
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
        payload.classifications.read_fixture = { actionClass: 'read', confirm: false };
      },
    });
    expect(maxActive).toBe(1);
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
          yield { type: 'tool-use-start', id, name: 'read_fixture' };
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
          yield { type: 'tool-use-start', id: 'large-tool', name: 'read_fixture' };
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
        if (modelRound > 1) {
          yield { type: 'message-stop', stopReason: 'end_turn' };
          return;
        }
        yield { type: 'tool-use-start', id: 'tool-unknown', name: 'read_fixture' };
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
    expect(modelRound).toBeGreaterThanOrEqual(1);
    expect(failure?.outcomeKnown).toBe(false);
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
        yield { type: 'tool-use-start', id: 'tool-lost', name: 'read_fixture' };
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
        yield { type: 'tool-use-start', id: 'tool-resolved-unknown', name: 'read_fixture' };
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
    expect(failure?.outcomeKnown).toBe(false);
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
