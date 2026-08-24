import { describe, expect, test } from 'bun:test';
import {
  KERNEL_EXECUTABLE_ROUTE_NAMES,
  KERNEL_RELAY_ROUTE_NAMES,
  KERNEL_TRANSFER_ROUTE_NAMES,
} from '../../extension/background/kernel-executable-inventory.js';
import { createKernelExecutableRuntime } from '../../extension/background/kernel-executable-runtime.js';

const routes = (names: readonly string[]) => (deps: any) => Object.fromEntries(
  names.map((name) => [name, (message: any, sender: any) => ({
    ok: true, name, allowed: deps.isAllowed(name, message, sender),
  })]),
);

describe('kernel executable runtime', () => {
  test('assembles only owned routes and derives every sender gate from admission', async () => {
    let appCallLoads = 0;
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
      makeKernelAppCallRoutes: (deps: any) => ({
        'app/call': async (message: any, sender: any) => ({
          ok: true, allowed: deps.isRelay(sender), value: await deps.callApp(message),
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
      engine: {}, actorChat: {}, appCall: {},
      relay: { relayRoutes: routes(KERNEL_RELAY_ROUTE_NAMES)({ isAllowed: () => true }) },
      transfer: {}, factories,
      importAppCall: async () => {
        appCallLoads += 1;
        return { makeAppCallHandler: () => async (message: any) => message.method };
      },
    });
    expect(Object.keys(runtime.routes).sort()).toEqual([...KERNEL_EXECUTABLE_ROUTE_NAMES].sort());
    expect(runtime.routes['pod/get-meta']({}, 'trusted')).toMatchObject({ allowed: true });
    expect(appCallLoads).toBe(0);
    expect(runtime.routes['pod/get-meta']({}, 'forged')).toMatchObject({ allowed: false });
    expect(runtime.routes['app/actor-chat']({}, 'trusted')).toMatchObject({
      allowed: true, trusted: true,
    });
    expect(await runtime.routes['app/call']({ method: 'read' }, 'trusted')).toMatchObject({
      allowed: true, value: 'read',
    });
    expect(appCallLoads).toBe(1);
    expect(runtime.routes['pod/git']).toBeFunction();
    expect(await runtime.routes['page/call']({}, 'trusted')).toMatchObject({ ok: true });
    expect(await runtime.routes['site-fetch/call']({}, 'forged')).toMatchObject({
      ok: false, error: 'kernel-relay-unauthorized', outcomeKnown: true,
    });
  });

  test('mints transfer handlers only for the exact private capability', () => {
    const runtime = createKernelExecutableRuntime({
      admit: () => true,
      engine: {}, actorChat: {}, appCall: {},
      relay: { relayRoutes: routes(KERNEL_RELAY_ROUTE_NAMES)({ isAllowed: () => true }) },
      transfer: {},
      factories: {
        makeKernelPodRoutes: routes(['pod/cancel-io', 'pod/get-meta', 'pod/git', 'pod/web-fetch']),
        makeKernelWebFetchRoutes: routes(['sw/web-fetch', 'sw/web-fetch-abort']),
        makeKernelArtifactRoutes: routes(['export/artifact', 'import/inspect', 'import/apply']),
        makeKernelAppDeleteRoutes: routes(['apps/delete']),
        makeKernelAppActorChatRoutes: () => ({ 'app/actor-chat': () => ({ ok: true }) }),
        makeKernelAppCallRoutes: () => ({ 'app/call': () => ({ ok: true }) }),
        makeAppCallHandler: () => async () => ({ ok: true }),
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
