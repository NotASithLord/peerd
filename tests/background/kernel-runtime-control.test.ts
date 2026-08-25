import { describe, expect, test } from 'bun:test';
import { createKernelRuntimeControl } from '../../extension/background/kernel-runtime-control.js';

describe('kernel runtime control', () => {
  test('binds one fixed probe grant to the exact dispatched object', async () => {
    let payload: any;
    const control = createKernelRuntimeControl({
      call: async (value) => { payload = value; return { ok: true }; },
    });
    await expect(control.probe()).resolves.toEqual({ ok: true });
    expect(payload).toEqual({ operation: 'runtime.probe', input: {} });
    expect(control.authorize({ ...payload })).toBeNull();
    expect(control.authorize(payload)).toEqual({
      ownerId: 'peerd-authority-kernel', sessionId: null, instanceId: null,
      origin: null, target: 'kernel-runtime', replayClass: 'A',
    });
    expect(control.authorize(payload)).toBeNull();
  });

  test('issues the fixed bootstrap envelope', async () => {
    let payload: any;
    const control = createKernelRuntimeControl({
      call: async (value) => { payload = value; return { ok: true }; },
    });
    await expect(control.bootstrap()).resolves.toEqual({ ok: true });
    expect(payload).toEqual({ operation: 'runtime.bootstrap', input: {} });
    expect(control.authorize(payload)).toMatchObject({ target: 'kernel-runtime' });
  });

  test('binds rich relay mutation authority and routes only its exact reverse family', async () => {
    let payload: any;
    const calls: any[] = [];
    const control = createKernelRuntimeControl({
      call: async (value) => { payload = value; return { ok: true }; },
      handleRichKernelCall: async (...args) => {
        calls.push(args);
        return { ok: true, outcomeKnown: true };
      },
    });
    await expect(control.relay('script-run/abort', {
      ownerSessionId: 'session:1', runId: 'run:1',
    })).resolves.toEqual({ ok: true });
    expect(payload).toEqual({
      operation: 'runtime.rich.abort',
      input: {
        route: 'script-run/abort',
        message: { ownerSessionId: 'session:1', runId: 'run:1' },
      },
    });
    const authority = control.authorize(payload);
    expect(authority).toMatchObject({ target: 'kernel-runtime-rich-abort', replayClass: 'E' });
    const context = { capability: 'runtime.dispatch', authority };
    await expect(control.handleKernelCall('rich.script.abort', {
      ownerSessionId: 'session:1', runId: 'run:1',
    }, context)).resolves.toEqual({ ok: true, outcomeKnown: true });
    expect(calls).toHaveLength(1);
    await expect(control.handleKernelCall('rich.script.abort', {}, {
      ...context, authority: { ...(authority as any), target: 'kernel-runtime-rich-relay' },
    })).resolves.toEqual({
      ok: false, code: 'kernel-operation-denied', outcomeKnown: true,
    });
  });

  test('uses the run remainder for provider relay and the fixed policy cap for Stop', async () => {
    const calls: Array<{payload:any,options:any}> = [];
    const control = createKernelRuntimeControl({
      now: () => 10_000,
      call: async (payload, options) => {
        calls.push({ payload, options });
        return { ok: true };
      },
    });
    await control.relay('script/model-call', {
      ownerSessionId: 'session:1', runId: 'run:1', args: { prompt: 'hello' },
      deadlineAt: 100_000,
    });
    await control.relay('script/model-call', {
      ownerSessionId: 'session:1', runId: 'run:2', args: { prompt: 'hello' },
    });
    await control.relay('script-run/abort', {
      ownerSessionId: 'session:1', runId: 'run:1',
    });
    expect(calls.map(({ payload, options }) => [payload.operation, options.timeoutMs]))
      .toEqual([
        ['runtime.rich.relay', 90_000],
        ['runtime.rich.relay', 300_000],
        ['runtime.rich.abort', 5_000],
      ]);
  });

  test('refuses an already-expired provider relay before granting authority', async () => {
    let calls = 0;
    const control = createKernelRuntimeControl({
      now: () => 10_000,
      call: async () => { calls += 1; return { ok: true }; },
    });
    await expect(control.relay('script/model-call', {
      ownerSessionId: 'session:1', runId: 'run:1', args: { prompt: 'hello' },
      deadlineAt: 10_000,
    })).resolves.toEqual({
      ok: true, outcomeKnown: true,
      value: { ok: false, error: 'provider: run deadline expired' },
    });
    expect(calls).toBe(0);
  });

  test('admits only the exact runtime bootstrap read effect', async () => {
    const control = createKernelRuntimeControl({
      call: async () => ({ ok: true }),
      readBootstrap: async () => ({ schema: 1, target: 'chrome', dwebEnabled: false }),
    });
    const context = {
      capability: 'runtime.dispatch',
      authority: { target: 'kernel-runtime', replayClass: 'A' },
    };
    await expect(control.handleKernelCall('runtime.bootstrap.read', {}, context))
      .resolves.toEqual({
        ok: true, outcomeKnown: true,
        value: { schema: 1, target: 'chrome', dwebEnabled: false },
      });
    for (const [operation, payload, callContext] of [
      ['turn.session.get', {}, context],
      ['runtime.bootstrap.read', { extra: true }, context],
      ['runtime.bootstrap.read', {}, { ...context, capability: 'turn.run' }],
      ['runtime.bootstrap.read', {}, {
        ...context, authority: { target: 'semantic:contacts/set' },
      }],
    ] as const) {
      await expect(control.handleKernelCall(operation, payload, callContext)).resolves.toEqual({
        ok: false, code: 'kernel-operation-denied', outcomeKnown: true,
      });
    }
  });
});
