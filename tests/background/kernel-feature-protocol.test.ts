import { describe, expect, test } from 'bun:test';
import { createKernelFeatureControl } from '../../extension/background/kernel-feature-control.js';
import {
  connectOffscreenController,
  makeSemanticControllerClient,
} from '../../extension/background/offscreen-controller-client.js';
import { connectDirectController } from '../../extension/background/direct-controller-client.js';
import { createController } from '../../extension/offscreen/controller-runtime.js';
import { createKernelFeatureHost } from '../../extension/offscreen/kernel-feature-host.js';
import { bindControllerChannel } from '../../extension/offscreen/controller-shell.js';
import {
  KERNEL_FEATURE_DISPATCH_CAPABILITY,
  createKernelFeatureEffectQuota,
  kernelFeatureAuthorityAllowed,
  kernelFeatureAuthorityFor,
  kernelFeaturePayloadAllowed,
  parseKernelFeatureDispatch,
} from '../../extension/shared/kernel-feature-policy.js';
import {
  KERNEL_ADMINISTRATIVE_ROUTE_NAMES,
} from '../../extension/shared/kernel-feature-policy.js';
import {
  KERNEL_DWEB_ROUTE_NAMES,
  KERNEL_EXECUTABLE_ROUTE_NAMES,
} from '../../extension/shared/kernel-feature-route-inventory.js';
import * as backgroundInventory from '../../extension/shared/kernel-feature-route-inventory.js';
import { TEST_CONTROLLER_KERNEL_IDENTITY } from './controller-test-identity.ts';

const BUILD_DIGEST = 'a'.repeat(64);
const request = (overrides: Record<string, unknown> = {}) => Object.freeze({
  cluster: 'administrative', route: 'hooks/list',
  dispatchId: 'dispatch-fixed-1', message: Object.freeze({}),
  ...overrides,
});
const options = (payload: unknown, overrides: Record<string, unknown> = {}) => ({
  signal: new AbortController().signal,
  authority: kernelFeatureAuthorityFor(KERNEL_FEATURE_DISPATCH_CAPABILITY, payload),
  deadlineAt: Date.now() + 10_000,
  ...overrides,
});

describe('sealed kernel feature protocol', () => {
  test('shares the executable and dweb route inventories with the live owners', () => {
    expect(backgroundInventory.KERNEL_EXECUTABLE_ROUTE_NAMES)
      .toBe(KERNEL_EXECUTABLE_ROUTE_NAMES);
    expect(backgroundInventory.KERNEL_DWEB_ROUTE_NAMES).toBe(KERNEL_DWEB_ROUTE_NAMES);
    expect(KERNEL_ADMINISTRATIVE_ROUTE_NAMES).toEqual([
      'hooks/list', 'hooks/save', 'hooks/remove', 'hooks/toggle',
      'memory/init', 'skills/installGit', 'skills/installLocal', 'skills/installManifest',
    ]);
  });

  test('rejects forged clusters, routes, fields, oversized payloads, and authorities', () => {
    const valid = request();
    const authority = kernelFeatureAuthorityFor(KERNEL_FEATURE_DISPATCH_CAPABILITY, valid);
    expect(parseKernelFeatureDispatch(valid)?.route).toBe('hooks/list');
    expect(kernelFeaturePayloadAllowed(KERNEL_FEATURE_DISPATCH_CAPABILITY, valid)).toBe(true);
    expect(kernelFeaturePayloadAllowed(KERNEL_FEATURE_DISPATCH_CAPABILITY, {
      ...valid, cluster: 'executable', route: 'hooks/list',
    })).toBe(false);
    expect(kernelFeaturePayloadAllowed(KERNEL_FEATURE_DISPATCH_CAPABILITY, {
      ...valid, route: 'hooks/forged',
    })).toBe(false);
    expect(kernelFeaturePayloadAllowed(KERNEL_FEATURE_DISPATCH_CAPABILITY, {
      ...valid, extra: true,
    })).toBe(false);
    expect(kernelFeaturePayloadAllowed(KERNEL_FEATURE_DISPATCH_CAPABILITY, request({
      message: { value: 'x'.repeat(300 * 1024) },
    }))).toBe(false);
    expect(kernelFeatureAuthorityAllowed(
      KERNEL_FEATURE_DISPATCH_CAPABILITY, valid, authority,
    )).toBe(true);
    expect(kernelFeatureAuthorityAllowed(
      KERNEL_FEATURE_DISPATCH_CAPABILITY, valid, { ...authority, replayClass: 'E' },
    )).toBe(false);
    expect(kernelFeatureAuthorityAllowed(
      KERNEL_FEATURE_DISPATCH_CAPABILITY, valid, { ...authority, target: 'kernel-feature:administrative:hooks/save' },
    )).toBe(false);
  });

  test('binds one exact effect and one call budget to each route', () => {
    const quota = createKernelFeatureEffectQuota(
      KERNEL_FEATURE_DISPATCH_CAPABILITY, request(),
    );
    expect(quota.pendingCap).toBe(1);
    expect(quota.admit('administrative.hooks.write', { records: [] }))
      .toMatchObject({ ok: false, code: 'feature-effect-denied' });
    expect(quota.admit('administrative.hooks.read', { forged: {} }))
      .toMatchObject({ ok: false, code: 'feature-effect-denied' });
    expect(quota.admit('administrative.hooks.read', {}))
      .toMatchObject({ ok: true });
    expect(quota.admit('administrative.hooks.read', {}))
      .toMatchObject({ ok: false, code: 'feature-effect-budget-exhausted' });
    expect(quota.observe('administrative.hooks.read', {}, {
      ok: true, outcomeKnown: true, value: 'x'.repeat(300 * 1024),
    })).toMatchObject({ ok: false, code: 'feature-effect-result-too-large' });
  });

  test('uses one-use client grants and refuses forged reverse effects', async () => {
    const calls: any[] = [];
    let authority: any;
    let effect: any;
    let control!: ReturnType<typeof createKernelFeatureControl>;
    control = createKernelFeatureControl({
      newId: () => 'dispatch-control-1',
      call: async (capability, payload) => {
        calls.push([capability, payload]);
        authority = control.authorize(capability, payload);
        expect(control.authorize(capability, payload)).toBeNull();
        effect = await control.handleKernelCall(
          'administrative.hooks.read', {}, { capability, authority },
        );
        return { ok: true };
      },
      handleEffect: async (operation, payload) => ({
        ok: true, outcomeKnown: true, value: { operation, payload },
      }),
    });
    await control.dispatch('administrative', 'hooks/list', {});
    const [capability, payload] = calls[0];
    expect(authority).toEqual(kernelFeatureAuthorityFor(capability, payload));
    expect(effect).toMatchObject({ ok: true });
    expect(await control.handleKernelCall(
      'administrative.hooks.read', {}, { capability, authority },
    )).toMatchObject({ ok: false, code: 'kernel-operation-denied' });
    expect(await control.handleKernelCall(
      'administrative.hooks.read', {}, {
        capability: 'feature.event', authority,
      },
    )).toMatchObject({ ok: false, code: 'kernel-operation-denied' });
  });

  test('retires an unredeemed payload grant on settlement', async () => {
    let retained: unknown;
    const control = createKernelFeatureControl({
      newId: () => 'dispatch-unredeemed-1',
      call: async (_capability, payload) => {
        retained = payload;
        return { ok: true, outcomeKnown: true };
      },
    });
    await control.dispatch('administrative', 'hooks/list', {});
    expect(control.authorize(KERNEL_FEATURE_DISPATCH_CAPABILITY, retained)).toBeNull();
  });

  test('binds concurrent same-route effects to their exact dispatch and retires both', async () => {
    const pending: Array<{payload:any,resolve:(value:any)=>void}> = [];
    let sequence = 0;
    const control = createKernelFeatureControl({
      newId: () => `dispatch-concurrent-${++sequence}`,
      call: (_capability, payload) => new Promise((resolve) => {
        pending.push({ payload, resolve });
      }),
      handleEffect: (operation, payload: any, context) => operation === 'administrative.hooks.remove'
        && payload?.id === (context.message as any)?.id
        ? { ok: true, outcomeKnown: true }
        : { ok: false, code: 'kernel-operation-denied', outcomeKnown: true },
    });
    const first = control.dispatch('administrative', 'hooks/remove', { id: 'first' });
    const second = control.dispatch('administrative', 'hooks/remove', { id: 'second' });
    const authorities = pending.map(({ payload }) => control.authorize(payload));
    for (let index = 0; index < 2; index += 1) {
      const other = index === 0 ? 'second' : 'first';
      expect(await control.handleKernelCall('administrative.hooks.remove', { id: other }, {
        capability: KERNEL_FEATURE_DISPATCH_CAPABILITY,
        authority: authorities[index],
      })).toMatchObject({ ok: false, code: 'kernel-operation-denied' });
    }
    pending[0].resolve({ ok: true });
    pending[1].resolve({ ok: true });
    await Promise.all([first, second]);
    expect(await control.handleKernelCall('administrative.hooks.remove', { id: 'first' }, {
      capability: KERNEL_FEATURE_DISPATCH_CAPABILITY, authority: authorities[0],
    })).toMatchObject({ ok: false, code: 'kernel-operation-denied' });
  });

  test('classifies a hung module as a retryable known startup failure', async () => {
    const payload = request();
    const host = createKernelFeatureHost({
      loaders: { administrative: () => new Promise(() => {}) },
      loadTimeoutMs: 5,
    });
    expect(await host.dispatch(payload, options(payload))).toEqual({
      ok: false,
      code: 'feature-administrative-load-timeout',
      outcomeKnown: true,
      phase: 'startup',
      retryable: true,
    });
  });

  test('enforces route concurrency independently and releases it on settlement', async () => {
    let releaseMutation = () => {};
    let mutationStarted = () => {};
    const mutationGate = new Promise<void>((resolve) => { releaseMutation = resolve; });
    const mutationReady = new Promise<void>((resolve) => { mutationStarted = resolve; });
    let releaseReads = () => {};
    const readGate = new Promise<void>((resolve) => { releaseReads = resolve; });
    let reads = 0;
    let readsReady = () => {};
    const eightReads = new Promise<void>((resolve) => { readsReady = resolve; });
    const host = createKernelFeatureHost({ loaders: {
      administrative: async () => ({ routes: {
        'hooks/remove': async () => { mutationStarted(); await mutationGate; return {}; },
        'hooks/list': async () => {
          reads += 1;
          if (reads === 8) readsReady();
          await readGate;
          return {};
        },
        'hooks/save': async () => ({}),
      } }),
    } });
    const mutation = request({
      route: 'hooks/remove', dispatchId: 'dispatch-mutation-1', message: { id: 'one' },
    });
    const firstMutation = host.dispatch(mutation, options(mutation));
    await mutationReady;
    const competingMutation = request({
      route: 'hooks/remove', dispatchId: 'dispatch-mutation-2', message: { id: 'two' },
    });
    expect(await host.dispatch(competingMutation, options(competingMutation))).toMatchObject({
      ok: false, code: 'feature-route-concurrency-exhausted', outcomeKnown: true,
    });
    releaseMutation();
    await firstMutation;
    expect(await host.dispatch(competingMutation, options(competingMutation))).toMatchObject({
      ok: true,
    });

    const readCalls = Array.from({ length: 8 }, (_, index) => {
      const payload = request({ dispatchId: `dispatch-read-${index + 10}` });
      return host.dispatch(payload, options(payload));
    });
    await eightReads;
    const ninth = request({ dispatchId: 'dispatch-read-ninth' });
    expect(await host.dispatch(ninth, options(ninth))).toMatchObject({
      ok: false, code: 'feature-route-concurrency-exhausted', outcomeKnown: true,
    });
    const other = request({
      route: 'hooks/save', dispatchId: 'dispatch-other-route',
      message: { markdown: '---\nid: h\nevent: pre-tool-use\nrule:\n  matchArg: url\n  pattern: x\n---' },
    });
    expect(await host.dispatch(other, options(other))).toMatchObject({ ok: true });
    releaseReads();
    await Promise.all(readCalls);
  });

  test('keeps read-route failures known after a safe effect', async () => {
    for (const afterEffect of [false, true]) {
      const payload = request();
      const host = createKernelFeatureHost({
        loaders: {
          administrative: async () => ({ routes: {
            'hooks/list': async (_message: unknown, context: any) => {
              if (afterEffect) {
                await context.effects.call('administrative.hooks.read', {});
              }
              throw new Error('failed');
            },
          } }),
        },
      });
      expect(await host.dispatch(payload, options(payload, {
        kernelCall: async () => ({ ok: true, outcomeKnown: true }),
      }))).toMatchObject({
        ok: false, code: 'feature-dispatch-failed', outcomeKnown: true, phase: 'run',
      });
    }
  });

  test('retains settled mutation custody when the handler later fails', async () => {
    for (const afterEffect of [false, true]) {
      const payload = request({
        route: 'hooks/remove', dispatchId: `dispatch-mutation-failure-${afterEffect}`,
        message: { id: 'hook' },
      });
      const host = createKernelFeatureHost({
        loaders: {
          administrative: async () => ({ routes: {
            'hooks/remove': async (_message: unknown, context: any) => {
              if (afterEffect) {
                await context.effects.call('administrative.hooks.remove', { id: 'hook' });
              }
              throw new Error('failed');
            },
          } }),
        },
      });
      expect(await host.dispatch(payload, options(payload, {
        kernelCall: async () => ({ ok: true, outcomeKnown: true }),
      }))).toMatchObject({
        ok: false, code: 'feature-dispatch-failed', outcomeKnown: true,
        retryable: !afterEffect, phase: 'run',
      });
    }
  });

  test('preserves exact loss custody across pending and settled effects', async () => {
    const cases = [
      { route: 'hooks/list', operation: 'administrative.hooks.read',
        message: {}, effectResult: null, outcomeKnown: true, retryable: true },
      { route: 'hooks/remove', operation: 'administrative.hooks.remove',
        message: { id: 'hook' }, effectResult: null, outcomeKnown: false, retryable: false },
      { route: 'hooks/remove', operation: 'administrative.hooks.remove',
        message: { id: 'hook' }, effectResult: { ok: true, outcomeKnown: true },
        outcomeKnown: true, retryable: false },
      { route: 'hooks/remove', operation: 'administrative.hooks.remove',
        message: { id: 'hook' }, effectResult: {
          ok: false, code: 'write-refused', outcomeKnown: true, retryable: true,
        }, outcomeKnown: true, retryable: true },
    ] as const;
    for (const [index, testCase] of cases.entries()) {
      const payload = request({
        route: testCase.route, dispatchId: `dispatch-loss-custody-${index}`,
        message: testCase.message,
      });
      const abort = new AbortController();
      let effectEntered = () => {};
      const entered = new Promise<void>((resolve) => { effectEntered = resolve; });
      let effectSettled = () => {};
      const settled = new Promise<void>((resolve) => { effectSettled = resolve; });
      const host = createKernelFeatureHost({ loaders: {
        administrative: async () => ({ routes: {
          [testCase.route]: async (_message: unknown, context: any) => {
            await context.effects.call(testCase.operation,
              testCase.message as Record<string, unknown>);
            effectSettled();
            return new Promise(() => {});
          },
        } }),
      } });
      const running = host.dispatch(payload, options(payload, {
        signal: abort.signal,
        kernelCall: async () => {
          effectEntered();
          if (testCase.effectResult) return testCase.effectResult;
          return new Promise(() => {});
        },
      }));
      await entered;
      if (testCase.effectResult) await settled;
      abort.abort();
      expect(await running).toMatchObject({
        ok: false, code: 'feature-host-generation-expired',
        outcomeKnown: testCase.outcomeKnown, retryable: testCase.retryable,
      });
    }
  });

  test('does not let a handler launder unknown mutation custody', async () => {
    const cases = [
      { kernelCall: () => new Promise(() => {}), awaitEffect: false },
      { kernelCall: async () => ({ ok: false, code: 'effect-lost', outcomeKnown: false }),
        awaitEffect: true },
    ];
    for (const testCase of cases) {
      const payload = request({
        route: 'hooks/remove', dispatchId: `dispatch-no-launder-${crypto.randomUUID()}`,
        message: { id: 'hook' },
      });
      const host = createKernelFeatureHost({ loaders: {
        administrative: async () => ({ routes: {
          'hooks/remove': async (_message: unknown, context: any) => {
            const effect = context.effects.call('administrative.hooks.remove', { id: 'hook' });
            if (testCase.awaitEffect) await effect;
            else await Promise.resolve();
            throw Object.assign(new Error('claimed-known'), { outcomeKnown: true });
          },
        } }),
      } });
      expect(await host.dispatch(payload, options(payload, {
        kernelCall: testCase.kernelCall,
      }))).toMatchObject({
        ok: false, code: 'feature-dispatch-failed', outcomeKnown: false,
        retryable: false, phase: 'run',
      });
    }
  });

  test('closes a captured effect grant on settlement without a kernel call', async () => {
    const payload = request();
    let lateEffect!: () => Promise<any>;
    let kernelCalls = 0;
    const host = createKernelFeatureHost({ loaders: {
      administrative: async () => ({ routes: {
        'hooks/list': async (_message: unknown, context: any) => {
          lateEffect = () => context.effects.call('administrative.hooks.read', {});
          return { hooks: [] };
        },
      } }),
    } });
    expect(await host.dispatch(payload, options(payload, {
      kernelCall: async () => {
        kernelCalls += 1;
        return { ok: true, outcomeKnown: true };
      },
    }))).toMatchObject({ ok: true });
    expect(await lateEffect()).toMatchObject({
      ok: false, code: 'feature-grant-settled', outcomeKnown: true,
    });
    expect(kernelCalls).toBe(0);
  });

  test('a hung handler poisons its full feature generation', async () => {
    const first = request({
      route: 'hooks/remove', dispatchId: 'dispatch-hung-first', message: { id: 'first' },
    });
    const second = request({
      route: 'hooks/remove', dispatchId: 'dispatch-hung-second', message: { id: 'second' },
    });
    let calls = 0;
    const host = createKernelFeatureHost({ loaders: {
      administrative: async () => ({ routes: {
        'hooks/remove': async () => {
          calls += 1;
          if (calls === 1) return new Promise(() => {});
          return { hooks: [] };
        },
      } }),
    } });
    expect(await host.dispatch(first, options(first, {
      deadlineAt: Date.now() + 5,
    }))).toMatchObject({
      ok: false, code: 'feature-host-generation-expired',
      outcomeKnown: true, retryable: true,
    });
    expect(await host.dispatch(second, options(second))).toMatchObject({
      ok: false, code: 'feature-host-generation-retired', outcomeKnown: true,
    });
    expect(calls).toBe(1);
  });

  test('poisons concurrent grants before a stale handler can influence effects', async () => {
    const first = request({
      route: 'hooks/remove', dispatchId: 'dispatch-poison-first', message: { id: 'first' },
    });
    const second = request({ dispatchId: 'dispatch-poison-second' });
    let releaseSecond = () => {};
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    let secondStarted = () => {};
    const secondReady = new Promise<void>((resolve) => { secondStarted = resolve; });
    let kernelCalls = 0;
    const host = createKernelFeatureHost({ loaders: {
      administrative: async () => ({ routes: {
        'hooks/remove': async () => new Promise(() => {}),
        'hooks/list': async (_message: unknown, context: any) => {
          secondStarted();
          await secondGate;
          return context.effects.call('administrative.hooks.read', {});
        },
      } }),
    } });
    const firstRun = host.dispatch(first, options(first, { deadlineAt: Date.now() + 5 }));
    const secondRun = host.dispatch(second, options(second, {
      kernelCall: async () => {
        kernelCalls += 1;
        return { ok: true, outcomeKnown: true, value: { hooks: [] } };
      },
    }));
    await secondReady;
    await expect(firstRun).resolves.toMatchObject({
      ok: false, code: 'feature-host-generation-expired', outcomeKnown: true,
    });
    releaseSecond();
    await expect(secondRun).resolves.toMatchObject({
      ok: false, code: 'feature-host-generation-expired', outcomeKnown: true,
    });
    expect(kernelCalls).toBe(0);
  });

  test('refuses synchronous completion after its deadline', async () => {
    let now = 1;
    const payload = request({ dispatchId: 'dispatch-late-completion' });
    const host = createKernelFeatureHost({
      now: () => now,
      setTimeoutFn: (() => 1) as unknown as typeof setTimeout,
      clearTimeoutFn: (() => {}) as unknown as typeof clearTimeout,
      loaders: { administrative: async () => ({ routes: {
        'hooks/list': async () => { now = 11; return { hooks: [] }; },
      } }) },
    });
    await expect(host.dispatch(payload, options(payload, { deadlineAt: 10 })))
      .resolves.toMatchObject({
        ok: false, code: 'feature-host-generation-expired', outcomeKnown: true,
      });
    await expect(host.dispatch(request({ dispatchId: 'dispatch-after-late' }), options(
      request({ dispatchId: 'dispatch-after-late' }), { deadlineAt: 20 },
    ))).resolves.toMatchObject({
      ok: false, code: 'feature-host-generation-retired', outcomeKnown: true,
    });
  });

  test('retires a poisoned direct controller before admitting a successor', async () => {
    let semantic!: ReturnType<typeof makeSemanticControllerClient>;
    let generations = 0;
    let closed = 0;
    const control = createKernelFeatureControl({
      call: (capability, payload) => semantic.callFeature(payload),
    });
    semantic = makeSemanticControllerClient({
      browser: { runtime: { getURL: (path: string) => `moz-extension://test/${path}` } },
      ensureOffscreen: async () => {}, offscreenUrl: 'offscreen/offscreen.html',
      firefoxDirect: true, dwebEnabled: false,
      kernelIdentity: TEST_CONTROLLER_KERNEL_IDENTITY,
      authorizeFeatureCall: control.authorize,
      handleFeatureKernelCall: control.handleKernelCall,
      withDirectLifetime: (operation) => operation(),
      connectDirectController: (async () => {
        const generation = ++generations;
        return {
          call: async () => generation === 1
            ? {
              ok: false, code: 'feature-host-generation-expired',
              outcomeKnown: true, retryable: true,
            }
            : { ok: true, outcomeKnown: true, value: { hooks: [] } },
          close: () => { closed += 1; },
        };
      }) as any,
      fetchFn: async () => new Response('', { status: 200 }),
    });
    await expect(control.dispatch('administrative', 'hooks/list', {})).resolves.toMatchObject({
      ok: false, code: 'feature-host-generation-expired', outcomeKnown: true,
    });
    await expect(control.dispatch('administrative', 'hooks/list', {})).resolves.toMatchObject({
      ok: true,
    });
    expect(generations).toBe(2);
    expect(closed).toBeGreaterThanOrEqual(1);
    semantic.close();
  });

  test('carries an exact route through the sealed channel and reverse effect quota', async () => {
    let controller: any = null;
    const effects: any[] = [];
    const control = createKernelFeatureControl({
      call: (capability, payload) => controller.call(capability, payload),
      handleEffect: async (operation, payload) => {
        effects.push([operation, payload]);
        return { ok: true, outcomeKnown: true, value: { hooks: [] } };
      },
    });
    const featureHost = createKernelFeatureHost({
      loaders: {
        administrative: async () => ({ routes: {
          'hooks/list': async (_message: unknown, context: any) =>
            context.effects.call('administrative.hooks.read', {}),
        } }),
      },
    });
    let host: ReturnType<typeof bindControllerChannel> | null = null;
    controller = await connectOffscreenController({
      ensureOffscreen: async () => {},
      capabilities: [KERNEL_FEATURE_DISPATCH_CAPABILITY],
      buildDigest: BUILD_DIGEST,
      authorizeCall: control.authorize,
      handleKernelCall: control.handleKernelCall,
      findHost: async () => ({
        postMessage: (offer: any, transfer: Transferable[]) => {
          host = bindControllerChannel({
            port: transfer[0] as MessagePort,
            channelId: offer.channelId,
            buildDigest: offer.buildDigest,
            kernelEpoch: offer.kernelEpoch,
            hostEpoch: 'feature-host-epoch',
            offeredCaps: offer.capabilities,
            supportedCaps: [KERNEL_FEATURE_DISPATCH_CAPABILITY],
            loadController: async () => createController({ featureHost }),
          });
        },
      }),
    });
    expect(await control.dispatch('administrative', 'hooks/list', {})).toMatchObject({
      ok: true,
      value: { ok: true, outcomeKnown: true, value: { hooks: [] } },
    });
    expect(effects).toEqual([['administrative.hooks.read', {}]]);
    controller.close();
    (host as any)?.close();
  });

  test('keeps settled effect custody through a sealed-channel timeout', async () => {
    for (const testCase of [
      { route: 'hooks/list', message: {}, operation: 'administrative.hooks.read', payload: {}, retryable: true },
      { route: 'hooks/remove', message: { id: 'hook' }, operation: 'administrative.hooks.remove', payload: { id: 'hook' }, retryable: false },
    ] as const) {
      let controller: any;
      let effectSettled!: () => void;
      const settled = new Promise<void>((resolve) => { effectSettled = resolve; });
      const control = createKernelFeatureControl({
        call: (capability, payload, callOptions) => controller.call(capability, payload, callOptions),
        handleEffect: async () => ({ ok: true, outcomeKnown: true, value: {} }),
      });
      const featureHost = createKernelFeatureHost({ loaders: {
        administrative: async () => ({ routes: {
          [testCase.route]: async (_message: unknown, context: any) => {
            await context.effects.call(testCase.operation, testCase.payload);
            effectSettled();
            return new Promise(() => {});
          },
        } }),
      } });
      let host: ReturnType<typeof bindControllerChannel> | null = null;
      controller = await connectOffscreenController({
        ensureOffscreen: async () => {},
        capabilities: [KERNEL_FEATURE_DISPATCH_CAPABILITY],
        buildDigest: BUILD_DIGEST,
        authorizeCall: control.authorize,
        handleKernelCall: control.handleKernelCall,
        findHost: async () => ({ postMessage: (offer: any, transfer: Transferable[]) => {
          host = bindControllerChannel({
            port: transfer[0] as MessagePort,
            channelId: offer.channelId, buildDigest: offer.buildDigest,
            kernelEpoch: offer.kernelEpoch, hostEpoch: 'custody-host',
            offeredCaps: offer.capabilities,
            supportedCaps: [KERNEL_FEATURE_DISPATCH_CAPABILITY],
            loadController: async () => createController({ featureHost }),
          });
        } }),
      });
      const result = control.dispatch(
        'administrative', testCase.route, testCase.message, { timeoutMs: 20 },
      );
      await settled;
      await expect(result).resolves.toMatchObject({
        ok: false, code: 'controller-call-timeout',
        outcomeKnown: true, retryable: testCase.retryable,
      });
      controller.close();
      (host as any)?.close();
    }
  });

  test('ignores a stale kernel epoch before loading the feature host', async () => {
    const { port1, port2 } = new MessageChannel();
    let loads = 0;
    const host = bindControllerChannel({
      port: port1,
      channelId: 'feature-channel',
      buildDigest: BUILD_DIGEST,
      kernelEpoch: 'kernel-current',
      hostEpoch: 'host-current',
      offeredCaps: [KERNEL_FEATURE_DISPATCH_CAPABILITY],
      supportedCaps: [KERNEL_FEATURE_DISPATCH_CAPABILITY],
      loadController: async () => {
        loads += 1;
        return createController();
      },
    });
    const payload = request();
    port2.postMessage({
      protocol: 2,
      channelId: 'feature-channel',
      buildDigest: BUILD_DIGEST,
      kernelEpoch: 'kernel-stale',
      hostEpoch: 'host-current',
      sequence: 1,
      type: 'kernel/open',
      requestId: 'request-stale',
      grantId: 'grant-stale',
      deadlineAt: Date.now() + 5_000,
      capability: KERNEL_FEATURE_DISPATCH_CAPABILITY,
      authority: kernelFeatureAuthorityFor(KERNEL_FEATURE_DISPATCH_CAPABILITY, payload),
      payload,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(loads).toBe(0);
    host.close();
    port2.close();
  });
});
