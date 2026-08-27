import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  connectOffscreenController,
  makeSemanticControllerClient as makeSemanticControllerClientBase,
} from '../../extension/background/offscreen-controller-client.js';
import { connectDirectController } from '../../extension/background/direct-controller-client.js';
import {
  bindControllerChannel,
  makeControllerOfferHandler,
} from '../../extension/offscreen/controller-shell.js';
import { createController } from '../../extension/offscreen/controller-runtime.js';
import { createKernelRuntimeHost } from '../../extension/offscreen/kernel-runtime-host.js';
import {
  createRuntimeEffectQuota,
  parseRuntimeDispatch,
  RUNTIME_DISPATCH_MANIFEST,
  runtimeDispatchAuthorityAllowed,
  runtimeDispatchPayloadAllowed,
  runtimeDispatchResultAllowed,
} from '../../extension/shared/kernel-runtime-policy.js';
import { makeBoundedModuleLoader } from '../../extension/shared/bounded-module-load.js';
import { createKernelRuntimeControl } from '../../extension/background/kernel-runtime-control.js';
import { CONTROLLER_BUILD_DIGEST } from '../../extension/shared/controller-build.js';
import {
  TEST_CONTROLLER_KERNEL_IDENTITY,
  testControllerLease,
  withTestControllerLease,
} from './controller-test-identity.ts';

const makeSemanticControllerClient = (
  deps: Omit<Parameters<typeof makeSemanticControllerClientBase>[0], 'kernelIdentity'> & {
    kernelIdentity?: Parameters<typeof makeSemanticControllerClientBase>[0]['kernelIdentity'],
  },
) => makeSemanticControllerClientBase({
  ...deps,
  kernelIdentity: deps.kernelIdentity ?? TEST_CONTROLLER_KERNEL_IDENTITY,
  ...(!deps.firefoxDirect && typeof deps.withControllerLease !== 'function'
    ? { withControllerLease: withTestControllerLease } : {}),
});

const BUILD_DIGEST = 'a'.repeat(64);
const AUTHORITY = Object.freeze({
  ownerId: 'peerd-authority-kernel', sessionId: null, instanceId: null,
  origin: null, target: 'kernel-runtime', replayClass: 'A' as const,
});
const REQUEST = Object.freeze({ operation: 'runtime.probe', input: Object.freeze({}) });
const BOOTSTRAP = Object.freeze({ operation: 'runtime.bootstrap', input: Object.freeze({}) });
const options = (overrides: Record<string, unknown> = {}) => ({
  signal: new AbortController().signal,
  authority: AUTHORITY,
  deadlineAt: Date.now() + 10_000,
  ...overrides,
});
const richSse = (text: string) => new TextEncoder().encode([
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(text)}}}\n\n`,
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join(''));
const richKernelHandler = (seen: string[], text: string) => {
  let read = false;
  return async (operation: string) => {
    seen.push(operation);
    if (operation === 'rich.script.admit') return {
      ok: true, outcomeKnown: true,
      value: {
        token: 'reservation-token-1234',
        providerId: 'anthropic', modelId: 'claude-test',
      },
    };
    if (operation === 'rich.model.open-inference') return {
      ok: true, outcomeKnown: true,
      value: { streamId: 'stream:1', status: 200, statusText: 'OK', headers: {}, hasBody: true },
    };
    if (operation === 'rich.model.read-inference') return {
      ok: true, outcomeKnown: true,
      value: read ? { done: true } : (read = true, { done: false, chunk: richSse(text) }),
    };
    return { ok: true, outcomeKnown: true };
  };
};

const connectRuntime = async ({
  authorizeCall = () => AUTHORITY,
  loadRuntimeHost = async () => ({ createKernelRuntimeHost }),
  handleKernelCall,
}: {
  authorizeCall?: (capability: string, payload: unknown) => unknown;
  loadRuntimeHost?: () => Promise<any>;
  handleKernelCall?: (operation: string, payload: unknown, context?: unknown) => unknown;
} = {}) => {
  let host: ReturnType<typeof bindControllerChannel> | null = null;
  const controller = await connectOffscreenController({
    ensureOffscreen: async () => {},
    capabilities: ['runtime.dispatch'],
    buildDigest: BUILD_DIGEST,
    authorizeCall,
    handleKernelCall,
    findHost: async () => ({
      postMessage: (offer: any, transfer: Transferable[]) => {
        host = bindControllerChannel({
          port: transfer[0] as MessagePort,
          channelId: offer.channelId,
          buildDigest: offer.buildDigest,
          kernelEpoch: offer.kernelEpoch,
          hostEpoch: 'runtime-host-epoch',
          offeredCaps: offer.capabilities,
          supportedCaps: ['runtime.dispatch'],
          loadController: async () => createController({ loadRuntimeHost }),
        });
      },
    }),
  });
  return Object.freeze({
    ...controller,
    close: () => { controller.close(); host?.close(); },
  });
};

describe('sealed kernel runtime dispatch policy', () => {
  test('loads the fixed host only under the already-sealed controller runtime', () => {
    const source = (path: string) => readFileSync(join(process.cwd(), 'extension', path), 'utf8');
    expect(source('offscreen/controller-runtime.js'))
      .toContain("import('./kernel-runtime-host.js')");
    for (const path of [
      'background/offscreen-controller-client.js',
      'offscreen/controller-bootstrap.js',
      'offscreen/controller-shell.js',
      'offscreen/controller-worker.js',
    ]) expect(source(path)).not.toContain('kernel-runtime-host.js');
  });

  test('accepts only the exact fixed operation, input, authority, and result envelopes', () => {
    expect(parseRuntimeDispatch(REQUEST)).toMatchObject({ operation: 'runtime.probe' });
    expect(runtimeDispatchPayloadAllowed({ operation: 'runtime.unknown', input: {} })).toBe(false);
    expect(runtimeDispatchPayloadAllowed({ ...REQUEST, extra: true })).toBe(false);
    expect(runtimeDispatchPayloadAllowed({
      operation: 'runtime.probe', input: { bytes: 'x'.repeat(2_000) },
    })).toBe(false);
    expect(runtimeDispatchAuthorityAllowed(REQUEST, AUTHORITY)).toBe(true);
    expect(runtimeDispatchAuthorityAllowed(REQUEST, { ...AUTHORITY, generation: 2 })).toBe(false);
    expect(runtimeDispatchAuthorityAllowed(REQUEST, { ...AUTHORITY, replayClass: 'E' })).toBe(false);
    expect(runtimeDispatchResultAllowed(REQUEST, {
      ok: true, outcomeKnown: true, value: { ready: true },
    })).toBe(true);
    expect(runtimeDispatchResultAllowed(REQUEST, {
      ok: true, outcomeKnown: true, value: 'x'.repeat(5_000),
    })).toBe(false);
    const quota = createRuntimeEffectQuota(REQUEST);
    expect(quota.pendingCap).toBe(0);
    expect(quota.admit('runtime.unknown', {})).toEqual({
      ok: false, code: 'runtime-effect-denied', outcomeKnown: true,
    });
  });

  test('dispatches the fixed rich relay with independently shaped reverse effects', async () => {
    const request = {
      operation: 'runtime.rich.relay',
      input: {
        route: 'script/model-call',
        message: {
          ownerSessionId: 'session:1', runId: 'run:1', args: { prompt: 'hello' },
        },
      },
    };
    const authority = {
      ...AUTHORITY, target: 'kernel-runtime-rich-relay', replayClass: 'E' as const,
    };
    const effects: string[] = [];
    const result = await createKernelRuntimeHost().dispatch(request, {
      signal: new AbortController().signal,
      authority,
      deadlineAt: Date.now() + 30_000,
      kernelCall: richKernelHandler(effects, 'world'),
    });
    expect(result).toEqual({
      ok: true, outcomeKnown: true,
      value: { ok: true, value: {
        text: 'world', model: 'claude-test', stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
      } },
    });
    expect(effects).toEqual([
      'rich.script.admit', 'rich.model.open-inference',
      'rich.model.read-inference', 'rich.model.read-inference', 'rich.model.observe-usage',
    ]);
  });

  test('keeps Stop dispatch independent from saturated model turns', async () => {
    const relayRequest = {
      operation: 'runtime.rich.relay',
      input: { route: 'script/model-call', message: {} },
    };
    const abortRequest = {
      operation: 'runtime.rich.abort',
      input: { route: 'script-run/abort', message: {} },
    };
    const relayAuthority = {
      ...AUTHORITY, target: 'kernel-runtime-rich-relay', replayClass: 'E' as const,
    };
    const abortAuthority = {
      ...AUTHORITY, target: 'kernel-runtime-rich-abort', replayClass: 'E' as const,
    };
    let release!: () => void;
    let entered = 0;
    let saturated!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const allEntered = new Promise<void>((resolve) => { saturated = resolve; });
    const host = createKernelRuntimeHost({ handlers: {
      'runtime.rich.relay': async () => {
        entered += 1;
        if (entered === RUNTIME_DISPATCH_MANIFEST['runtime.rich.relay'].concurrent) saturated();
        await blocked;
        return { ok: true, outcomeKnown: true };
      },
      'runtime.rich.abort': async () => ({ ok: true, outcomeKnown: true }),
    } });
    const relays = Array.from(
      { length: RUNTIME_DISPATCH_MANIFEST['runtime.rich.relay'].concurrent },
      () => host.dispatch(relayRequest, options({ authority: relayAuthority })),
    );
    await allEntered;
    const abortOptions = () => options({
      authority: abortAuthority, deadlineAt: Date.now() + 4_000,
    });
    await expect(host.dispatch(abortRequest, abortOptions()))
      .resolves.toEqual({ ok: true, outcomeKnown: true });
    await expect(host.dispatch(abortRequest, {
      ...abortOptions(), authority: relayAuthority,
    }))
      .resolves.toMatchObject({ code: 'runtime-authority-invalid', outcomeKnown: true });
    await expect(host.dispatch(relayRequest, options({ authority: abortAuthority })))
      .resolves.toMatchObject({ code: 'runtime-authority-invalid', outcomeKnown: true });
    release();
    await Promise.all(relays);
  });

  test('bounds concurrency before dispatch and treats invalid results or throws as unknown', async () => {
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const host = createKernelRuntimeHost({
      handlers: {
        'runtime.probe': async () => {
          started();
          await blocked;
          return { ok: true, outcomeKnown: true, value: { ready: true } };
        },
      },
    });
    const first = host.dispatch(REQUEST, options());
    await entered;
    await expect(host.dispatch(REQUEST, options())).resolves.toEqual({
      ok: false, code: 'runtime-concurrency-exhausted',
      outcomeKnown: true, phase: 'startup',
    });
    release();
    await expect(first).resolves.toMatchObject({ ok: true, outcomeKnown: true });

    const oversized = createKernelRuntimeHost({
      handlers: {
        'runtime.probe': async () => ({
          ok: true, outcomeKnown: true, value: 'x'.repeat(5_000),
        }),
      },
    });
    await expect(oversized.dispatch(REQUEST, options())).resolves.toEqual({
      ok: false, code: 'runtime-result-invalid', outcomeKnown: false, phase: 'run',
    });
    const throwing = createKernelRuntimeHost({
      handlers: { 'runtime.probe': async () => { throw new Error('after dispatch'); } },
    });
    await expect(throwing.dispatch(REQUEST, options())).resolves.toEqual({
      ok: false, code: 'runtime-dispatch-failed', outcomeKnown: false, phase: 'run',
    });
  });

  test('retires the reverse-call closure when its exact dispatch settles', async () => {
    let retained!: (operation: string, payload: unknown) => Promise<any>;
    let kernelCalls = 0;
    const host = createKernelRuntimeHost({
      handlers: {
        'runtime.probe': async (_input, context) => {
          retained = context.effects.call;
          return { ok: true, outcomeKnown: true };
        },
      },
    });
    await expect(host.dispatch(REQUEST, options({
      kernelCall: async () => { kernelCalls += 1; return { ok: true }; },
    }))).resolves.toMatchObject({ ok: true });
    await expect(retained('runtime.late', {})).resolves.toEqual({
      ok: false, code: 'runtime-grant-settled', outcomeKnown: true,
    });
    expect(kernelCalls).toBe(0);
  });

  test('owns the fixed deadline and refuses effects after a hung dispatch expires', async () => {
    let expire!: () => void;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let lateEffect: any;
    let kernelCalls = 0;
    const setTimer = ((callback: () => void) => {
      expire = callback;
      return 1 as any;
    }) as unknown as typeof setTimeout;
    const host = createKernelRuntimeHost({
      now: () => 1,
      setTimeoutFn: setTimer,
      clearTimeoutFn: (() => {}) as typeof clearTimeout,
      handlers: {
        'runtime.probe': async (_input, context) => {
          await blocked;
          lateEffect = await context.effects.call('runtime.unknown', {});
          return { ok: true, outcomeKnown: true };
        },
      },
    });
    const signal = new AbortController();
    const pending = host.dispatch(REQUEST, options({
      signal: signal.signal,
      deadlineAt: 2,
      kernelCall: async () => { kernelCalls += 1; return { ok: true }; },
    }));
    await Promise.resolve();
    expire();
    await expect(pending).resolves.toEqual({
      ok: false, code: 'runtime-deadline-expired', outcomeKnown: false, phase: 'run',
    });
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lateEffect).toEqual({
      ok: false, code: 'runtime-grant-settled', outcomeKnown: true,
    });
    expect(kernelCalls).toBe(0);
  });

  test('holds a provider past 121s, preserves Stop, and retires late effects', async () => {
    let nowMs = 0;
    let timerId = 0;
    const timers = new Map<number, {at:number,callback:()=>void}>();
    const setTimeoutFn = ((callback: () => void, delay = 0) => {
      const id = ++timerId;
      timers.set(id, { at: nowMs + Number(delay), callback });
      return id as any;
    }) as typeof setTimeout;
    const clearTimeoutFn = ((id: number) => { timers.delete(Number(id)); }) as any;
    const advanceTo = async (target: number) => {
      nowMs = target;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= nowMs)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        due[1].callback();
        await Promise.resolve();
      }
    };
    let retainedEffect!: (operation: string, payload: unknown) => Promise<any>;
    let providerEntered!: () => void;
    const providerStarted = new Promise<void>((resolve) => { providerEntered = resolve; });
    let releaseProvider!: () => void;
    const heldProvider = new Promise<void>((resolve) => { releaseProvider = resolve; });
    let providerCalls = 0;
    let abortCalls = 0;
    const host = createKernelRuntimeHost({
      now: () => nowMs, setTimeoutFn, clearTimeoutFn,
      handlers: {
        'runtime.rich.relay': async (_input, context) => {
          retainedEffect = context.effects.call;
          const admitted = await context.effects.call('rich.script.admit', {
            ownerSessionId: 'session:1', runId: 'run:1', maxTokens: 32,
            requestedModel: null,
          });
          if (admitted?.ok !== true) return admitted;
          return context.effects.call('rich.model.open-inference', {
            token: 'reservation-token-1234',
            ownerSessionId: 'session:1', runId: 'run:1',
            providerId: 'anthropic', modelId: 'claude-test',
            nativeBody: { model: 'claude-test', stream: true, messages: [], max_tokens: 32, system: '' },
          });
        },
        'runtime.rich.abort': async (_input, context) => context.effects.call(
          'rich.script.abort', { ownerSessionId: 'session:1', runId: 'run:1' },
        ),
      },
    });
    const relayAuthority = {
      ...AUTHORITY, target: 'kernel-runtime-rich-relay', replayClass: 'E' as const,
    };
    const relay = host.dispatch({
      operation: 'runtime.rich.relay',
      input: { route: 'script/model-call', message: {} },
    }, options({
      authority: relayAuthority, deadlineAt: 300_000,
      kernelCall: async (operation: string, _payload: unknown) => {
        if (operation === 'rich.script.admit') return {
          ok: true, outcomeKnown: true,
          value: {
            token: 'reservation-token-1234',
            providerId: 'anthropic', modelId: 'claude-test',
          },
        };
        providerCalls += 1;
        providerEntered();
        await heldProvider;
        return {
          ok: true, outcomeKnown: true,
          value: { streamId: 'stream:1', status: 200, statusText: 'OK', headers: {}, hasBody: true },
        };
      },
    }));
    await providerStarted;
    let settled = false;
    void relay.then(() => { settled = true; });
    await advanceTo(61_000);
    expect(settled).toBe(false);

    const abortAuthority = {
      ...AUTHORITY, target: 'kernel-runtime-rich-abort', replayClass: 'E' as const,
    };
    await expect(host.dispatch({
      operation: 'runtime.rich.abort',
      input: { route: 'script-run/abort', message: {} },
    }, options({
      authority: abortAuthority, deadlineAt: 66_000,
      kernelCall: async () => {
        abortCalls += 1;
        return { ok: true, outcomeKnown: true };
      },
    }))).resolves.toMatchObject({ ok: true, outcomeKnown: true });
    expect(abortCalls).toBe(1);

    await advanceTo(121_000);
    expect(settled).toBe(false);
    releaseProvider();
    await expect(relay).resolves.toEqual({
      ok: true, outcomeKnown: true,
      value: { streamId: 'stream:1', status: 200, statusText: 'OK', headers: {}, hasBody: true },
    });
    expect(providerCalls).toBe(1);
    await expect(retainedEffect('rich.model.open-inference', {})).resolves.toEqual({
      ok: false, code: 'runtime-grant-settled', outcomeKnown: true,
    });
  });

  test('independently refuses a runtime deadline beyond its operation cap', async () => {
    const maxDurationMs = RUNTIME_DISPATCH_MANIFEST['runtime.probe'].maxDurationMs;
    const host = createKernelRuntimeHost({ now: () => 100 });
    await expect(host.dispatch(REQUEST, options({ deadlineAt: 101 + maxDurationMs })))
      .resolves.toEqual({
        ok: false, code: 'runtime-duration-invalid', outcomeKnown: true, phase: 'startup',
      });
  });

  test('loads the fixed host only on demand and classifies load failure as safe startup', async () => {
    let loads = 0;
    const controller = await createController({
      loadRuntimeHost: async () => {
        loads += 1;
        throw Object.assign(new Error('missing'), { code: 'runtime-host-load-failed' });
      },
    });
    expect(loads).toBe(0);
    await expect(controller.call('runtime.dispatch', REQUEST, options())).resolves.toEqual({
      ok: false, code: 'runtime-host-load-failed', error: 'Feature unavailable. Try again.',
      outcomeKnown: true, retryable: true, phase: 'startup',
    });
    expect(loads).toBe(1);
  });

  test('turns a frozen fixed-host evaluation into a bounded startup refusal', async () => {
    const loadRuntimeHost = makeBoundedModuleLoader(
      () => new Promise<any>(() => {}),
      { timeoutMs: 5, timeoutCode: 'runtime-host-load-timeout' },
    );
    const controller = await createController({ loadRuntimeHost });
    await expect(controller.call('runtime.dispatch', REQUEST, options())).resolves.toEqual({
      ok: false, code: 'runtime-host-load-timeout', error: 'Feature unavailable. Try again.',
      outcomeKnown: true, retryable: true, phase: 'startup',
    });
  });
});

describe('private runtime controller channel', () => {
  test('rejects unknown or oversized operations and forged authority before commit', async () => {
    const controller = await connectRuntime();
    await expect(controller.call('runtime.dispatch', {
      operation: 'runtime.unknown', input: {},
    })).resolves.toMatchObject({
      ok: false, code: 'controller-payload-invalid', outcomeKnown: true, phase: 'startup',
    });
    await expect(controller.call('runtime.dispatch', {
      operation: 'runtime.probe', input: { bytes: 'x'.repeat(3_000) },
    })).resolves.toMatchObject({
      ok: false, code: 'controller-payload-invalid', outcomeKnown: true, phase: 'startup',
    });
    controller.close();

    const forged = await connectRuntime({
      authorizeCall: () => ({ ...AUTHORITY, generation: 9 }),
    });
    await expect(forged.call('runtime.dispatch', REQUEST)).resolves.toMatchObject({
      ok: false, code: 'controller-authority-invalid', outcomeKnown: true, phase: 'startup',
    });
    forged.close();
  });

  test('clamps finite runtime deadlines and rejects non-finite timeouts', async () => {
    let remainingMs = Number.POSITIVE_INFINITY;
    const controller = await connectRuntime({
      loadRuntimeHost: async () => ({
        createKernelRuntimeHost: () => createKernelRuntimeHost({
          handlers: {
            'runtime.probe': async (_input, context) => {
              remainingMs = context.effects.deadlineAt - Date.now();
              return { ok: true, outcomeKnown: true };
            },
          },
        }),
      }),
    });
    const pending = controller.call('runtime.dispatch', REQUEST, { timeoutMs: 1e100 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(pending)
      .resolves.toMatchObject({ ok: true, outcomeKnown: true });
    expect(remainingMs)
      .toBeLessThanOrEqual(RUNTIME_DISPATCH_MANIFEST['runtime.probe'].maxDurationMs);
    for (const timeoutMs of [Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(controller.call('runtime.dispatch', REQUEST, { timeoutMs }))
        .resolves.toMatchObject({
          ok: false, code: 'controller-timeout-invalid', outcomeKnown: true, phase: 'startup',
        });
    }
    controller.close();
  });

  test('the shell independently refuses an oversized runtime deadline', async () => {
    const channel = new MessageChannel();
    const binding = bindControllerChannel({
      port: channel.port2,
      channelId: 'runtime-duration-channel',
      buildDigest: BUILD_DIGEST,
      kernelEpoch: 'runtime-duration-kernel',
      hostEpoch: 'runtime-duration-host',
      offeredCaps: ['runtime.dispatch'],
      supportedCaps: ['runtime.dispatch'],
      loadController: async () => createController(),
    });
    const common = {
      protocol: 2, channelId: 'runtime-duration-channel', buildDigest: BUILD_DIGEST,
      kernelEpoch: 'runtime-duration-kernel', hostEpoch: 'runtime-duration-host',
    };
    const result = new Promise<any>((resolve) => {
      let sequence = 0;
      channel.port1.onmessage = (event) => {
        if (event.data.type === 'controller/ready') {
          channel.port1.postMessage({
            ...common, sequence: ++sequence, type: 'kernel/open',
            requestId: 'runtime-duration-request', grantId: 'runtime-duration-grant',
            deadlineAt: Date.now()
              + RUNTIME_DISPATCH_MANIFEST['runtime.probe'].maxDurationMs + 1_000,
            capability: 'runtime.dispatch', authority: AUTHORITY, payload: REQUEST,
          });
        } else if (event.data.type === 'controller/rejected') resolve(event.data.result);
      };
      channel.port1.start();
    });
    await expect(result).resolves.toEqual({
      ok: false, code: 'duration-invalid', outcomeKnown: true, phase: 'startup',
    });
    binding.close();
    channel.port1.close();
  });

  test('keeps startup and no-effect dispatch failures known', async () => {
    let unavailableLoads = 0;
    const unavailable = await connectRuntime({
      loadRuntimeHost: async () => {
        unavailableLoads += 1;
        throw Object.assign(new Error('unavailable'), { code: 'runtime-host-load-failed' });
      },
    });
    const unavailableResult = await unavailable.call(
      'runtime.dispatch', REQUEST, { timeoutMs: 1_000 },
    );
    expect({ unavailableResult, unavailableLoads }).toMatchObject({
      unavailableLoads: 1,
      unavailableResult: {
      ok: false, code: 'runtime-host-load-failed', outcomeKnown: true, phase: 'startup',
      },
    });
    unavailable.close();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const failed = await connectRuntime({
      loadRuntimeHost: async () => ({
        createKernelRuntimeHost: () => createKernelRuntimeHost({
          handlers: { 'runtime.probe': async () => { throw new Error('after commit'); } },
        }),
      }),
    });
    const failedResult = await failed.call(
      'runtime.dispatch', REQUEST, { timeoutMs: 1_000 },
    );
    expect(failedResult).toMatchObject({
      ok: false, code: 'runtime-dispatch-failed', outcomeKnown: true,
      retryable: true, phase: 'run',
    });
    failed.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  test('denies reverse operations and never calls kernel authority', async () => {
    let kernelCalls = 0;
    let loads = 0;
    let dispatches = 0;
    const controller = await connectRuntime({
      handleKernelCall: () => { kernelCalls += 1; return { ok: true }; },
      loadRuntimeHost: async () => {
        loads += 1;
        return {
          createKernelRuntimeHost: () => createKernelRuntimeHost({
            handlers: {
              'runtime.probe': async (_input, context) => {
                dispatches += 1;
                return ({
              ok: true, outcomeKnown: true,
              value: await context.effects.call('runtime.unknown', {}),
                });
              },
            },
          }),
        };
      },
    });
    const result = await controller.call('runtime.dispatch', REQUEST, { timeoutMs: 1_000 });
    expect({ result, loads, dispatches }).toMatchObject({
      loads: 1,
      dispatches: 1,
      result: {
        ok: true,
        value: { ok: false, code: 'runtime-effect-denied', outcomeKnown: true },
      },
    });
    expect(kernelCalls).toBe(0);
    controller.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  test('runtime success cannot strand an unawaited reverse effect', async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const observed = { signal: null as AbortSignal | null };
    const controller = await connectRuntime({
      handleKernelCall: (_operation, _payload) => {
        entered();
        return new Promise((resolve) => setTimeout(
          () => resolve({ ok: true, outcomeKnown: true }), 100,
        ));
      },
      loadRuntimeHost: async () => ({
        createKernelRuntimeHost: () => createKernelRuntimeHost({
          handlers: {
            'runtime.bootstrap': (_input, context) => {
              void context.effects.call('runtime.bootstrap.read', {});
              observed.signal = context.effects.signal;
              return { ok: true, outcomeKnown: true };
            },
          },
        }),
      }),
    });
    const result = controller.call('runtime.dispatch', BOOTSTRAP, { timeoutMs: 1_000 });
    await started;
    await expect(result).resolves.toMatchObject({
      ok: false, code: 'controller-pending-kernel-effect',
      outcomeKnown: true, retryable: true,
    });
    expect(observed.signal?.aborted).toBe(true);
    controller.close();
  });

  test('dispatch cancellation retires a settled reverse-effect lifetime', async () => {
    let admitted!: () => void;
    const admission = new Promise<void>((resolve) => { admitted = resolve; });
    const observed = { effectSignal: null as AbortSignal | null };
    const authority = {
      ...AUTHORITY, target: 'kernel-runtime-rich-relay', replayClass: 'E' as const,
    };
    const controller = await connectRuntime({
      authorizeCall: () => authority,
      handleKernelCall: (_operation, _payload, rawContext) => {
        const context = rawContext as any;
        observed.effectSignal = context.signal;
        admitted();
        return {
          ok: true, outcomeKnown: true,
          value: {
            token: 'reservation-token-1234',
            providerId: 'anthropic', modelId: 'claude-test',
          },
        };
      },
      loadRuntimeHost: async () => ({
        createKernelRuntimeHost: () => createKernelRuntimeHost({ handlers: {
          'runtime.rich.relay': async (_input, context) => {
            await context.effects.call('rich.script.admit', {
              ownerSessionId: 'session:1', runId: 'run:1', maxTokens: 32,
              requestedModel: null,
            });
            await new Promise((resolve) => context.effects.signal
              .addEventListener('abort', resolve, { once: true }));
            return { ok: false, code: 'aborted', outcomeKnown: false };
          },
        } }),
      }),
    });
    const cancel = new AbortController();
    const pending = controller.call('runtime.dispatch', {
      operation: 'runtime.rich.relay',
      input: { route: 'script/model-call', message: {} },
    }, { signal: cancel.signal, timeoutMs: 10_000 });
    await admission;
    expect(observed.effectSignal?.aborted).toBe(false);
    cancel.abort();
    await expect(pending).resolves.toMatchObject({
      ok: false, outcomeKnown: true, retryable: true,
    });
    expect(observed.effectSignal?.aborted).toBe(true);
    controller.close();
  });

  test('keeps a settled model-call commit through channel timeout', async () => {
    let committed!: () => void;
    const settled = new Promise<void>((resolve) => { committed = resolve; });
    const authority = {
      ...AUTHORITY, target: 'kernel-runtime-rich-relay', replayClass: 'E' as const,
    };
    const controller = await connectRuntime({
      authorizeCall: () => authority,
      handleKernelCall: async (operation: string) => operation === 'rich.script.admit'
        ? {
          ok: true, outcomeKnown: true,
          value: {
            token: 'reservation-token-1234',
            providerId: 'anthropic', modelId: 'claude-test',
          },
        }
        : { ok: true, outcomeKnown: true, value: {
          streamId: 'stream:1', status: 200, statusText: 'OK', headers: {}, hasBody: true,
        } },
      loadRuntimeHost: async () => ({
        createKernelRuntimeHost: () => createKernelRuntimeHost({ handlers: {
          'runtime.rich.relay': async (_input, context) => {
            await context.effects.call('rich.script.admit', {
              ownerSessionId: 'session:1', runId: 'run:1', maxTokens: 32,
              requestedModel: null,
            });
            await context.effects.call('rich.model.open-inference', {
              token: 'reservation-token-1234',
              ownerSessionId: 'session:1', runId: 'run:1',
              providerId: 'anthropic', modelId: 'claude-test',
              nativeBody: { model: 'claude-test', stream: true, messages: [], max_tokens: 32, system: '' },
            });
            committed();
            return new Promise(() => {});
          },
        } }),
      }),
    });
    const pending = controller.call('runtime.dispatch', {
      operation: 'runtime.rich.relay',
      input: { route: 'script/model-call', message: {} },
    }, { timeoutMs: 20 });
    await settled;
    await expect(pending).resolves.toMatchObject({
      ok: false, code: 'controller-call-timeout', outcomeKnown: true, retryable: false,
    });
    controller.close();
  });

  test('Firefox runtime lifetime loss aborts its exact pending effect', async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const observed = { signal: null as AbortSignal | null };
    const controller = await connectDirectController({
      capabilities: ['runtime.dispatch'],
      supportedCapabilities: ['runtime.dispatch'],
      buildDigest: BUILD_DIGEST,
      authorizeCall: () => AUTHORITY,
      handleKernelCall: () => { entered(); return new Promise(() => {}); },
      loadController: async () => createController({
        loadRuntimeHost: async () => ({
          createKernelRuntimeHost: () => createKernelRuntimeHost({
            handlers: {
              'runtime.bootstrap': async (_input, context) => {
                observed.signal = context.effects.signal;
                return context.effects.call('runtime.bootstrap.read', {});
              },
            },
          }),
        }),
      }),
    });
    const pending = controller.call('runtime.dispatch', BOOTSTRAP);
    await started;
    controller.close();
    await expect(pending).resolves.toMatchObject({
      outcomeKnown: true, retryable: true,
    });
    expect(observed.signal?.aborted).toBe(true);
  });

  test('Chrome and Firefox reserve channel capacity for Stop', async () => {
    for (const firefoxDirect of [false, true]) {
      let release!: () => void;
      let entered = 0;
      let saturated!: () => void;
      let abortEffects = 0;
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      const allEntered = new Promise<void>((resolve) => { saturated = resolve; });
      const loadController = async () => createController({
        loadRuntimeHost: async () => ({
          createKernelRuntimeHost: () => createKernelRuntimeHost({ handlers: {
            'runtime.rich.relay': async () => {
              entered += 1;
              if (entered === 4) saturated();
              await blocked;
              return { ok: true, outcomeKnown: true };
            },
            'runtime.rich.abort': async (_input, context) =>
              context.effects.call('rich.script.abort', {
                ownerSessionId: 'session:1', runId: 'run:1',
              }),
          } }),
        }),
      });
      const authorizeCall = (_capability: string, payload: any) => ({
        ...AUTHORITY,
        target: payload.operation === 'runtime.rich.abort'
          ? 'kernel-runtime-rich-abort' : 'kernel-runtime-rich-relay',
        replayClass: 'E' as const,
      });
      const handleKernelCall = (operation: string) => {
        if (operation === 'rich.script.abort') abortEffects += 1;
        return { ok: true, outcomeKnown: true };
      };
      const controller = firefoxDirect
        ? await connectDirectController({
          capabilities: ['runtime.dispatch'],
          supportedCapabilities: ['runtime.dispatch'],
          buildDigest: BUILD_DIGEST, authorizeCall, handleKernelCall, loadController,
        })
        : await connectRuntime({
          authorizeCall, handleKernelCall,
          loadRuntimeHost: async () => ({
            createKernelRuntimeHost: () => createKernelRuntimeHost({ handlers: {
              'runtime.rich.relay': async () => {
                entered += 1;
                if (entered === 4) saturated();
                await blocked;
                return { ok: true, outcomeKnown: true };
              },
              'runtime.rich.abort': async (_input, context) =>
                context.effects.call('rich.script.abort', {
                  ownerSessionId: 'session:1', runId: 'run:1',
                }),
            } }),
          }),
        });
      const relayRequest = {
        operation: 'runtime.rich.relay',
        input: { route: 'script/model-call', message: {} },
      };
      const relays = Array.from({ length: 4 }, () => controller.call(
        'runtime.dispatch', relayRequest, { timeoutMs: 20_000 },
      ));
      await allEntered;
      const abortResult = await controller.call('runtime.dispatch', {
        operation: 'runtime.rich.abort',
        input: { route: 'script-run/abort', message: {} },
      }, { timeoutMs: 4_000 });
      expect({ abortResult, abortEffects }).toEqual({
        abortResult: { ok: true, outcomeKnown: true, phase: 'settled' },
        abortEffects: 1,
      });
      release();
      await Promise.all(relays);
      controller.close();
    }
  });

  test('refuses a retired kernel generation', () => {
    const expectedWorkerUrl = 'chrome-extension://id/background/vault-kernel.js';
    const kernelIdentity = Object.freeze({
      ...TEST_CONTROLLER_KERNEL_IDENTITY,
      buildId: `0.7.0:${BUILD_DIGEST}`,
      kernelEpoch: 'runtime-kernel-generation',
    });
    const lease = Object.freeze({
      ...testControllerLease(),
      ...kernelIdentity,
    });
    const handler = makeControllerOfferHandler({
      expectedWorkerUrl,
      expectedBuildDigest: BUILD_DIGEST,
      supportedCaps: ['runtime.dispatch'],
      loadController: async () => createController({
        loadRuntimeHost: async () => ({ createKernelRuntimeHost }),
      }),
    });
    const offer = () => {
      const channel = new MessageChannel();
      const accepted = handler({
        isTrusted: true,
        source: { scriptURL: expectedWorkerUrl },
        data: {
          type: 'peerd/controller-channel', protocol: 2,
          buildDigest: BUILD_DIGEST, kernelEpoch: 'runtime-kernel-generation',
          kernelIdentity,
          lease,
          channelId: crypto.randomUUID(), capabilities: ['runtime.dispatch'],
        },
        ports: [channel.port2],
      } as unknown as MessageEvent);
      channel.port1.close();
      return accepted;
    };
    expect(offer()).toBe(true);
    handler.close();
    expect(offer()).toBe(false);
  });

  test('uses the identical sealed contract through the Firefox direct transport', async () => {
    const controller = await connectDirectController({
      capabilities: ['runtime.dispatch'],
      supportedCapabilities: ['runtime.dispatch'],
      buildDigest: BUILD_DIGEST,
      authorizeCall: () => AUTHORITY,
      loadController: async () => createController({
        loadRuntimeHost: async () => ({ createKernelRuntimeHost }),
      }),
    });
    const result = await controller.call('runtime.dispatch', REQUEST, { timeoutMs: 1_000 });
    expect(result).toMatchObject({
      ok: true, outcomeKnown: true, value: { ready: true }, phase: 'settled',
    });
    await expect(controller.call('runtime.dispatch', {
      operation: 'runtime.unknown', input: {},
    })).resolves.toMatchObject({
      ok: false, code: 'controller-payload-invalid', outcomeKnown: true, phase: 'startup',
    });
    controller.close();
  });

  test('exposes the fixed capability through the production client seam', async () => {
    const client = makeSemanticControllerClient({
      browser: { runtime: { getURL: (path: string) => `moz-extension://id/${path}` } },
      ensureOffscreen: async () => {},
      offscreenUrl: 'offscreen/offscreen.html',
      firefoxDirect: true,
      dwebEnabled: false,
      authorizeRuntimeCall: () => AUTHORITY,
      withDirectLifetime: (operation) => operation(),
      connectDirectController: (deps) => connectDirectController({
        ...deps,
        loadController: async () => createController({
          loadRuntimeHost: async () => ({ createKernelRuntimeHost }),
        }),
      }),
      fetchFn: async () => new Response('', { status: 200 }),
    });
    expect(await client.callRuntime(REQUEST)).toMatchObject({
      ok: true, outcomeKnown: true, value: { ready: true }, phase: 'settled',
    });
    client.close();
  });

  test('Chrome and Firefox route the production bootstrap effect only to runtime authority', async () => {
    for (const firefoxDirect of [false, true]) {
      const scheme = firefoxDirect ? 'moz-extension' : 'chrome-extension';
      const workerUrl = `${scheme}://test/background/vault-kernel.js`;
      const offscreenUrl = `${scheme}://test/offscreen/offscreen.html`;
      const handlers = { runtime: 0, turn: 0, semantic: 0 };
      let client!: ReturnType<typeof makeSemanticControllerClient>;
      const control = createKernelRuntimeControl({
        call: (payload) => client.callRuntime(payload),
        readBootstrap: () => ({ schema: 1, target: firefoxDirect ? 'firefox' : 'chrome',
          dwebEnabled: false }),
      });
      const loadController = async () => createController({
        loadRuntimeHost: async () => ({ createKernelRuntimeHost }),
      });
      const offerHandler = firefoxDirect ? null : makeControllerOfferHandler({
        expectedWorkerUrl: workerUrl,
        expectedBuildDigest: CONTROLLER_BUILD_DIGEST,
        supportedCaps: ['prompt.render', 'runtime.dispatch', 'semantic.dispatch', 'turn.run'],
        loadController,
      });
      client = makeSemanticControllerClient({
        browser: { runtime: { getURL: (path: string) => `${scheme}://test/${path}` } },
        ensureOffscreen: async () => {}, offscreenUrl: 'offscreen/offscreen.html',
        firefoxDirect, dwebEnabled: false,
        authorizeRuntimeCall: control.authorize,
        handleRuntimeKernelCall: (...args) => {
          handlers.runtime += 1;
          return control.handleKernelCall(...args);
        },
        authorizeTurnCall: () => AUTHORITY,
        handleTurnKernelCall: () => { handlers.turn += 1; return { ok: true }; },
        authorizeSemanticCall: () => AUTHORITY,
        handleSemanticKernelCall: () => { handlers.semantic += 1; return { ok: true }; },
        ...(firefoxDirect ? {
          withDirectLifetime: (operation: () => Promise<any>) => operation(),
          connectDirectController: (deps) => connectDirectController({
            ...deps, loadController,
          }),
        } : {
          listWindowClients: async () => [{
            url: offscreenUrl,
            postMessage: (data: unknown, transfer: Transferable[]) => offerHandler?.({
              isTrusted: true, source: { scriptURL: workerUrl }, data, ports: transfer,
            } as unknown as MessageEvent),
          }],
        }),
        fetchFn: async () => new Response('', { status: 200 }),
      });
      await expect(control.bootstrap()).resolves.toMatchObject({
        ok: true, outcomeKnown: true,
        value: { schema: 1, target: firefoxDirect ? 'firefox' : 'chrome', dwebEnabled: false },
      });
      expect(handlers).toEqual({ runtime: 1, turn: 0, semantic: 0 });
      client.close();
      offerHandler?.close();
    }
  });

  test('Chrome and Firefox run the same production rich relay without semantic crossover', async () => {
    for (const firefoxDirect of [false, true]) {
      const scheme = firefoxDirect ? 'moz-extension' : 'chrome-extension';
      const workerUrl = `${scheme}://test/background/vault-kernel.js`;
      const offscreenUrl = `${scheme}://test/offscreen/offscreen.html`;
      const seen: string[] = [];
      let client!: ReturnType<typeof makeSemanticControllerClient>;
      const control = createKernelRuntimeControl({
        call: (payload) => client.callRuntime(payload),
        handleRichKernelCall: richKernelHandler(seen, 'same'),
      });
      const loadController = async () => createController({
        loadRuntimeHost: async () => ({ createKernelRuntimeHost }),
      });
      const offerHandler = firefoxDirect ? null : makeControllerOfferHandler({
        expectedWorkerUrl: workerUrl,
        expectedBuildDigest: CONTROLLER_BUILD_DIGEST,
        supportedCaps: ['prompt.render', 'runtime.dispatch'],
        loadController,
      });
      client = makeSemanticControllerClient({
        browser: { runtime: { getURL: (path: string) => `${scheme}://test/${path}` } },
        ensureOffscreen: async () => {}, offscreenUrl: 'offscreen/offscreen.html',
        firefoxDirect, dwebEnabled: false,
        authorizeRuntimeCall: control.authorize,
        handleRuntimeKernelCall: control.handleKernelCall,
        ...(firefoxDirect ? {
          withDirectLifetime: (operation: () => Promise<any>) => operation(),
          connectDirectController: (deps) => connectDirectController({ ...deps, loadController }),
        } : {
          listWindowClients: async () => [{
            url: offscreenUrl,
            postMessage: (data: unknown, transfer: Transferable[]) => offerHandler?.({
              isTrusted: true, source: { scriptURL: workerUrl }, data, ports: transfer,
            } as unknown as MessageEvent),
          }],
        }),
        fetchFn: async () => new Response('', { status: 200 }),
      });
      await expect(control.relay('script/model-call', {
        ownerSessionId: 'session:1', runId: 'run:1', args: { prompt: 'hello' },
      })).resolves.toMatchObject({
        ok: true, outcomeKnown: true,
        value: { ok: true, value: { text: 'same', model: 'claude-test' } },
      });
      expect(seen).toEqual([
        'rich.script.admit', 'rich.model.open-inference',
        'rich.model.read-inference', 'rich.model.read-inference', 'rich.model.observe-usage',
      ]);
      client.close();
      offerHandler?.close();
    }
  });

  test('Chrome and Firefox refuse runtime effects when the exact handler is absent', async () => {
    for (const firefoxDirect of [false, true]) {
      const scheme = firefoxDirect ? 'moz-extension' : 'chrome-extension';
      const workerUrl = `${scheme}://test/background/vault-kernel.js`;
      const offscreenUrl = `${scheme}://test/offscreen/offscreen.html`;
      const crossover = { turn: 0, semantic: 0 };
      const loadController = async () => createController({
        loadRuntimeHost: async () => ({ createKernelRuntimeHost }),
      });
      const offerHandler = firefoxDirect ? null : makeControllerOfferHandler({
        expectedWorkerUrl: workerUrl,
        expectedBuildDigest: CONTROLLER_BUILD_DIGEST,
        supportedCaps: ['prompt.render', 'runtime.dispatch', 'semantic.dispatch', 'turn.run'],
        loadController,
      });
      const client = makeSemanticControllerClient({
        browser: { runtime: { getURL: (path: string) => `${scheme}://test/${path}` } },
        ensureOffscreen: async () => {}, offscreenUrl: 'offscreen/offscreen.html',
        firefoxDirect, dwebEnabled: false,
        authorizeRuntimeCall: () => AUTHORITY,
        authorizeTurnCall: () => AUTHORITY,
        handleTurnKernelCall: () => { crossover.turn += 1; return { ok: true }; },
        authorizeSemanticCall: () => AUTHORITY,
        handleSemanticKernelCall: () => { crossover.semantic += 1; return { ok: true }; },
        ...(firefoxDirect ? {
          withDirectLifetime: (operation: () => Promise<any>) => operation(),
          connectDirectController: (deps) => connectDirectController({
            ...deps, loadController,
          }),
        } : {
          listWindowClients: async () => [{
            url: offscreenUrl,
            postMessage: (data: unknown, transfer: Transferable[]) => offerHandler?.({
              isTrusted: true, source: { scriptURL: workerUrl }, data, ports: transfer,
            } as unknown as MessageEvent),
          }],
        }),
        fetchFn: async () => new Response('', { status: 200 }),
      });
      await expect(client.callRuntime(BOOTSTRAP)).resolves.toMatchObject({
        ok: false, code: 'kernel-operation-denied', outcomeKnown: true,
      });
      expect(crossover).toEqual({ turn: 0, semantic: 0 });
      client.close();
      offerHandler?.close();
    }
  });
});
