import { describe, expect, mock, test } from 'bun:test';
import { appCallToToolCall, shapeAppResult, APP_API_METHODS } from '../../extension/peerd-runtime/actor/app-api.js';
import { makeAppCallHandler } from '../../extension/peerd-runtime/actor/app-call-handler.js';
import { appCodeTool, APP_CODE_CAPS } from '../../extension/peerd-runtime/tools/defs/app-code.js';
import { appActTool } from '../../extension/peerd-runtime/tools/defs/app-act.js';
import { makeOffscreenJsClient } from '../../extension/background/offscreen-js-client.js';

describe('App code client translation', () => {
  test('maps only the declared high-level runtime operations', () => {
    expect(APP_API_METHODS).toEqual(['observe', 'act']);
    expect(appCallToToolCall({ method: 'observe' })).toEqual({ name: 'app_observe', args: {} });
    expect(appCallToToolCall({ method: 'act', args: { action: 'move', params: { x: 1 } } }))
      .toEqual({ name: 'app_act', args: { action: 'move', params: { x: 1 } } });
    expect(() => appCallToToolCall({ method: 'fetch', args: {} })).toThrow('unknown app method');
    expect(() => appCallToToolCall({ method: 'act', args: { action: '../../eval' } })).toThrow('action must match');
  });

  test('returns only the internal structured runtime value', () => {
    expect(shapeAppResult('observe', { ok: true, structured: { value: { screen: 'lobby' } } }))
      .toEqual({ screen: 'lobby' });
    expect(() => shapeAppResult('act', { ok: false, error: 'refused' })).toThrow('refused');
  });

  test('inner calls use a fresh id and the supplied exact-App context', async () => {
    const dispatched: any[] = [];
    const handler = makeAppCallHandler({
      buildActorContext: async (binding) => ({ binding }),
      dispatchToolCall: async (call, ctx) => {
        dispatched.push({ call, ctx });
        return { ok: true, structured: { value: { accepted: true } } };
      },
    });
    const result = await handler({
      method: 'act', args: { action: 'start-game' }, sessionId: 'actor-1', appId: 'app-charon', rid: 7,
    });
    expect(result).toEqual({ ok: true, value: { accepted: true } });
    expect(dispatched[0].call.name).toBe('app_act');
    expect(dispatched[0].call.id).toStartWith('app-7-');
    expect(dispatched[0].ctx.binding).toEqual({ sessionId: 'actor-1', appId: 'app-charon' });
  });

  test('preserves an inner action outcome-unknown instead of shaping it as a value', async () => {
    const handler = makeAppCallHandler({
      buildActorContext: async () => ({}),
      dispatchToolCall: async () => ({
        ok: false, error: 'ack lost', outcomeKnown: false, outcomeKind: 'transport-lost',
      }),
    });
    expect(await handler({
      method: 'act', args: { action: 'start-game' }, sessionId: 'actor-1', appId: 'app-charon',
    })).toEqual({
      ok: false, error: 'ack lost', outcomeKnown: false, outcomeKind: 'transport-lost',
    });
  });
});

describe('app_code tool', () => {
  test('uses one locked App-only capability profile and owner-bound run lease', async () => {
    const execHeadless = mock(async (_code: string, _options: any) => ({ value: { ok: true }, consoleOutput: [], durationMs: 2, error: null, usedApp: true }));
    const scriptRuns = {
      mintRunId: mock(() => 'run-app-1'), register: mock(() => {}), release: mock(() => {}),
    };
    const result = await appCodeTool.execute({ code: 'return await app.observe()' }, {
      session: { sessionId: 'actor-app-1' }, jsOffscreenClient: { execHeadless }, scriptRuns,
    } as any);
    expect(result.ok).toBe(true);
    expect(APP_CODE_CAPS).toEqual({ app: true, page: false, egress: false, subagent: false, opfs: false });
    const options: any = execHeadless.mock.calls[0][1];
    expect(options.caps).toEqual(APP_CODE_CAPS);
    expect(options.ownerSessionId).toBe('actor-app-1');
    expect(options.runId).toBe('run-app-1');
    expect(scriptRuns.register).toHaveBeenCalledWith('run-app-1', undefined, 'actor-app-1', { app: true });
    expect(result.content).toContain('App runtime state');
  });

  test('fails closed without a live actor session, worker, or run registry', async () => {
    expect(await appCodeTool.execute({ code: 'return 1' }, {} as any)).toEqual({ ok: false, error: 'app_code_unavailable' });
    expect(await appCodeTool.execute({ code: 'return 1' }, { jsOffscreenClient: { execHeadless() {} } } as any))
      .toEqual({ ok: false, error: 'app_code_requires_actor_session' });
    expect(await appCodeTool.execute({ code: 'return 1' }, {
      session: { sessionId: 'actor-1' }, jsOffscreenClient: { execHeadless() {} },
    } as any)).toEqual({ ok: false, error: 'app_code_run_registry_unavailable' });
  });

  test('fails on worker errors and host-custodied unknown outcomes even when code caught the bridge error', async () => {
    const scriptRuns = { mintRunId: () => 'run-1', register() {}, release() {} };
    const base = { session: { sessionId: 'actor-1' }, scriptRuns };
    const failed = await appCodeTool.execute({ code: 'throw new Error("bad")' }, {
      ...base,
      jsOffscreenClient: { execHeadless: async () => ({ error: 'bad', usedApp: false, consoleOutput: [], durationMs: 1 }) },
    } as any);
    expect(failed).toMatchObject({ ok: false, outcomeKnown: true, outcomeKind: 'pre-effect-failure' });

    const unknown = await appCodeTool.execute({ code: 'try { await app.act("go") } catch {}' }, {
      ...base,
      jsOffscreenClient: { execHeadless: async () => ({
        value: 'caught', error: 'app action outcome unknown: ack lost', usedApp: true,
        appOutcomeUnknown: true, appOutcomeError: 'ack lost', consoleOutput: [], durationMs: 1,
      }) },
    } as any);
    expect(unknown).toMatchObject({ ok: false, outcomeKnown: false, outcomeKind: 'transport-lost' });
  });

  test('uses the explicit job/run dispatch boundary when the outer result is lost', async () => {
    const scriptRuns = { mintRunId: () => 'run-1', register() {}, release() {} };
    const afterDispatch = await appCodeTool.execute({ code: 'await app.act("go")' }, {
      session: { sessionId: 'actor-1' }, scriptRuns,
      jsOffscreenClient: {
        execHeadless: async (_code: string, opts: any) => {
          opts.onExecutionDispatch();
          throw new Error('outer result lost');
        },
      },
    } as any);
    expect(afterDispatch).toMatchObject({
      ok: false, outcomeKnown: false, outcomeKind: 'transport-lost',
    });

    const beforeDispatchError = Object.assign(new Error('startup refused'), {
      executionDispatched: false, outcomeKnown: true, outcomeKind: 'pre-effect-failure',
    });
    const beforeDispatch = await appCodeTool.execute({ code: 'await app.act("go")' }, {
      session: { sessionId: 'actor-1' }, scriptRuns,
      jsOffscreenClient: { execHeadless: async () => { throw beforeDispatchError; } },
    } as any);
    expect(beforeDispatch).toMatchObject({
      ok: false, outcomeKnown: true, outcomeKind: 'pre-effect-failure',
    });
  });

  test('an act can land before an outer Stop, and the integrated client still returns unknown', async () => {
    const controller = new AbortController();
    let actLanded = false;
    let released = false;
    const client = makeOffscreenJsClient({
      ensureOffscreen: async () => {},
      sendMessage: (message: any) => {
        if (message.type === 'job/abort') return Promise.resolve({ ok: true });
        actLanded = true;
        controller.abort();
        return new Promise(() => {});
      },
    });
    const result = await appCodeTool.execute({ code: 'await app.act("launch")' }, {
      session: { sessionId: 'actor-1' },
      jsOffscreenClient: client,
      abortSignal: controller.signal,
      scriptRuns: {
        mintRunId: () => 'run-integrated', register() {}, release() { released = true; },
      },
    } as any);
    expect(actLanded).toBe(true);
    expect(released).toBe(true);
    expect(result).toMatchObject({
      ok: false, outcomeKnown: false, outcomeKind: 'transport-lost',
    });
  });

  test('an already-aborted turn is known-safe and never dispatches execution', async () => {
    const controller = new AbortController();
    controller.abort();
    let dispatched = false;
    const result = await appCodeTool.execute({ code: 'await app.act("launch")' }, {
      session: { sessionId: 'actor-1' },
      abortSignal: controller.signal,
      jsOffscreenClient: { execHeadless: async () => { dispatched = true; } },
      scriptRuns: { mintRunId: () => 'unused', register() {}, release() {} },
    } as any);
    expect(dispatched).toBe(false);
    expect(result).toMatchObject({
      ok: false, outcomeKnown: true, outcomeKind: 'pre-effect-failure',
    });
  });
});

describe('app_act custody', () => {
  const execute = (appAgentCall: (...args: any[]) => Promise<any>) => appActTool.execute(
    { action: 'launch', params: {} },
    { actorInstanceId: 'app-1', appAgentCall } as any,
  );

  test('a naked post-dispatch handler rejection is unknown, never known-safe', async () => {
    expect(await execute(async () => ({ ok: false, error: 'mutated then threw' })))
      .toMatchObject({ ok: false, outcomeKnown: false, outcomeKind: 'transport-lost' });
  });

  test('only an explicit trusted pre-effect refusal remains known-safe', async () => {
    expect(await execute(async () => ({
      ok: false, error: 'not ready', outcomeKnown: true, outcomeKind: 'pre-effect-failure',
    }))).toMatchObject({ ok: false, outcomeKnown: true, outcomeKind: 'pre-effect-failure' });
  });
});
