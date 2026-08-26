import { describe, expect, test } from 'bun:test';
import {
  KERNEL_ENGINE_ATTACH_ROUTE_NAMES,
  KERNEL_EXECUTABLE_ROUTE_NAMES,
  KERNEL_RELAY_ROUTE_NAMES,
  KERNEL_TRANSFER_ROUTE_NAMES,
} from '../../extension/shared/kernel-feature-route-inventory.js';
import { createKernelExecutableRuntime } from '../../extension/background/kernel-executable-runtime.js';

const routes = (names: readonly string[]) => (deps: any) => Object.fromEntries(
  names.map((name) => [name, (message: any, sender: any) => ({
    ok: true, name, allowed: deps.isAllowed(name, message, sender),
  })]),
);

describe('kernel executable runtime', () => {
  test('assembles only owned routes and derives every sender gate from admission', async () => {
    let appRuntimeLoads = 0;
    const factories = {
      makeKernelPodRoutes: routes(['pod/cancel-io', 'pod/get-meta', 'pod/git', 'pod/web-fetch']),
      makeKernelWebFetchRoutes: routes(['sw/web-fetch', 'sw/web-fetch-abort']),
      makeKernelArtifactRoutes: routes(['export/artifact', 'import/inspect', 'import/apply']),
      makeKernelAppDeleteRoutes: routes(['apps/delete']),
      makeKernelAppActorChatRoutes: (deps: any) => ({
        'app/actor-chat': (message: any, sender: any) => ({
          ok: true,
          allowed: deps.isAllowed(sender, message),
          trusted: deps.isTrustedSender(sender),
        }),
      }),
      makeKernelAppRuntimeRoutes: (deps: any) => ({
        'app-code/observe': async (message: any, sender: any) => ({
          ok: true, allowed: deps.isRelay(sender),
          value: await (await deps.load()).observeAppRuntime(message),
        }),
        'app-code/act': async (message: any, sender: any) => ({
          ok: true, allowed: deps.isRelay(sender),
          value: await (await deps.load()).actAppRuntime(message),
        }),
      }),
      makeKernelTransferRoutes: ({ privateTransferAuthorization }: any) =>
        Object.fromEntries(KERNEL_TRANSFER_ROUTE_NAMES.map((name) => [name, (message: any) => ({
          ok: true, name,
          authorized: message.privateTransferAuthorization === privateTransferAuthorization,
        })])),
    };
    const runtime = createKernelExecutableRuntime({
      admit: (_route: string, _message: any, sender: any) => sender === 'trusted',
      engine: {}, actorChat: {}, appRuntime: {
        load: async () => {
          appRuntimeLoads += 1;
          return {
            observeAppRuntime: async () => 'observed',
            actAppRuntime: async () => 'acted',
          };
        },
      },
      relay: {
        dispatch: async (name: string, message: any) => ({
          ok: true, outcomeKnown: true, value: { ok: true, name, message },
        }),
        relayRoutes: routes([
          ...KERNEL_RELAY_ROUTE_NAMES, ...KERNEL_ENGINE_ATTACH_ROUTE_NAMES,
        ])({ isAllowed: () => true }),
      },
      transfer: {}, factories,
    });
    expect(Object.keys(runtime.routes).sort()).toEqual([...KERNEL_EXECUTABLE_ROUTE_NAMES].sort());
    expect(runtime.routes['pod/get-meta']({}, 'trusted')).toMatchObject({ allowed: true });
    expect(appRuntimeLoads).toBe(0);
    expect(runtime.routes['pod/get-meta']({}, 'forged')).toMatchObject({ allowed: false });
    expect(runtime.routes['app/actor-chat']({}, 'trusted')).toMatchObject({
      allowed: true, trusted: true,
    });
    expect(await runtime.routes['app-code/observe']({}, 'trusted')).toMatchObject({
      allowed: true, value: 'observed',
    });
    expect(appRuntimeLoads).toBe(1);
    expect(runtime.routes['pod/git']).toBeFunction();
    expect(await runtime.routes['page-program/navigate']({}, 'trusted')).toMatchObject({ ok: true });
    expect(await runtime.routes['script/model-call']({ runId: 'run:1' }, 'trusted'))
      .toEqual({ ok: true, name: 'script/model-call', message: { runId: 'run:1' } });
    expect(await runtime.routes['vm/tab-ready']({ vmId: 'vm-1' }, 'trusted'))
      .toMatchObject({ ok: true, name: 'vm/tab-ready' });
    expect(await runtime.routes['app/actor-retry']({ appId: 'app-1' }, 'forged'))
      .toMatchObject({ ok: false, error: 'kernel-relay-unauthorized', outcomeKnown: true });
    expect(await runtime.routes['site-fetch/call']({}, 'forged')).toMatchObject({
      ok: false, error: 'kernel-relay-unauthorized', outcomeKnown: true,
    });
  });

  test('mints transfer handlers only for the exact private capability', () => {
    const runtime = createKernelExecutableRuntime({
      admit: () => true,
      engine: {}, actorChat: {}, appRuntime: {},
      relay: { relayRoutes: routes([
        ...KERNEL_RELAY_ROUTE_NAMES, ...KERNEL_ENGINE_ATTACH_ROUTE_NAMES,
      ])({ isAllowed: () => true }) },
      transfer: {},
      factories: {
        makeKernelPodRoutes: routes(['pod/cancel-io', 'pod/get-meta', 'pod/git', 'pod/web-fetch']),
        makeKernelWebFetchRoutes: routes(['sw/web-fetch', 'sw/web-fetch-abort']),
        makeKernelArtifactRoutes: routes(['export/artifact', 'import/inspect', 'import/apply']),
        makeKernelAppDeleteRoutes: routes(['apps/delete']),
        makeKernelAppActorChatRoutes: () => ({ 'app/actor-chat': () => ({ ok: true }) }),
        makeKernelAppRuntimeRoutes: () => ({
          'app-code/observe': () => ({ ok: true }),
          'app-code/act': () => ({ ok: true }),
        }),
        makeKernelTransferRoutes: ({ privateTransferAuthorization }: any) =>
          Object.fromEntries(KERNEL_TRANSFER_ROUTE_NAMES.map((name) => [name,
            (message: any) => ({
              ok: message.privateTransferAuthorization === privateTransferAuthorization,
            })])),
      },
    });
    const authorization = Symbol('private');
    const transfer = runtime.makeTransferRoutes(authorization);
    expect(transfer['transfer/import']({ privateTransferAuthorization: authorization }))
      .toEqual({ ok: true });
    expect(transfer['transfer/import']({ privateTransferAuthorization: Symbol('forged') }))
      .toEqual({ ok: false });
  });
});
