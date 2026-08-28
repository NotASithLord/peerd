import { describe, expect, test } from 'bun:test';
import { useFakeIndexedDB } from '../setup.ts';
import {
  createKernelSemanticRuntime,
  KERNEL_SEMANTIC_DIRECT_ROUTE_NAMES,
} from '../../extension/background/kernel-semantic-runtime.js';
import { SEMANTIC_HOST_ROUTE_CLASSIFICATIONS } from '../../extension/shared/semantic-host-route-manifest.js';
import { createKernelControllerGateway } from '../../extension/background/kernel-controller-gateway.js';

await useFakeIndexedDB();

const controller = (overrides: Record<string, any> = {}) => ({
  callSemantic: async () => ({ ok: true }),
  callTurn: async () => ({ ok: true }),
  callRuntime: async () => ({ ok: true }),
  callFeature: async () => ({ ok: true }),
  renderSystemPrompt: async () => '',
  projectTurnTools: async () => [],
  planToolsCommand: async () => ({ action: 'note', note: 'ok' }),
  composeTurn: async ({ text }: any) => ({ text, refs: [], command: null }),
  withRun: async (operation: () => Promise<any>) => operation(),
  retire: () => {},
  close: () => {},
  ...overrides,
});

const gateway = (makeController: (deps: any) => any) => createKernelControllerGateway({
  controller: {}, loadController: async () => makeController,
});

const makeRuntime = (locked = false, docs: any[] = [], withTurn = false) => {
  let controllerCalls = 0;
  let controllerCreates = 0;
  let io = 0;
  const controllerGateway = gateway(() => {
    controllerCreates += 1;
    return controller({
      callSemantic: async () => { controllerCalls += 1; return { ok: true }; },
    });
  });
  const runtime = createKernelSemanticRuntime({
    controllerGateway,
    idbFactory: indexedDB,
    idb: {
      get: async () => { io += 1; return undefined; },
      getAll: async (store: string) => { io += 1; return store === 'agents_memory' ? docs : []; },
      put: async () => { io += 1; },
      del: async () => { io += 1; },
      transact: async () => { io += 1; return { ok: true }; },
    },
    kv: { get: async () => null, set: async () => {} },
    auditLog: { list: async () => { io += 1; return []; }, append: async () => {} },
    vault: { isLocked: () => locked, getSecret: async () => null },
    appCatalog: {
      list: async () => { io += 1; return []; },
      get: async () => null,
    },
    appFiles: null,
    isAppSender: () => true,
    ready: Promise.resolve(),
    canWrite: () => {}, pushState: () => {}, isHomeSender: () => true,
    actorCount: () => ({ activeActors: 0 }), actorOverview: () => ({ roots: [] }),
    ...(withTurn ? {
      loadTurnRuntime: async () => ({
        turnDeps: {
          makeAgentSendCustody: () => ({
            validOperationId: () => false, operationWindowValid: () => false,
            sendFingerprint: async () => '', unknownSend: () => ({}),
            sendReceiptStatus: async () => ({}),
            withSendReceipt: async (_id: any, _binding: any, operation: any) => operation(),
          }),
        },
        sessionDeps: {},
        isolationDeps: { retryActorIsolation: async () => ({ ok: true }) },
        actorCount: async () => ({ activeActors: 0 }),
        actorOverview: async () => ({ roots: [] }),
      }),
    } : {}),
  });
  return {
    runtime, controllerGateway, controllerCalls: () => controllerCalls,
    controllerCreates: () => controllerCreates, io: () => io,
  };
};

describe('kernel semantic runtime', () => {
  test('direct and host ownership have no overlap', () => {
    const host = new Set(SEMANTIC_HOST_ROUTE_CLASSIFICATIONS.map((row) => row.route));
    expect(KERNEL_SEMANTIC_DIRECT_ROUTE_NAMES.filter((route) => host.has(route))).toEqual([]);
  });

  test('all direct routes execute without crossing the controller channel', async () => {
    const state = makeRuntime();
    const calls: [string, any][] = [
      ['apps/list', {}],
      ['contacts/list', {}],
      ['memory/export', {}],
      ['skills/list', {}],
      ['skills/setEnabled', {}],
      ['skills/remove', {}],
    ];
    for (const [route, message] of calls) {
      expect(state.runtime.routes[route], route).toBeFunction();
      await state.runtime.routes[route](message, {});
    }
    expect(state.controllerCalls()).toBe(0);
    expect(state.controllerCreates()).toBe(0);
  });

  test('contact route shells cross the sealed controller while storage stays local', async () => {
    const state = makeRuntime();
    for (const route of ['contacts/set', 'contacts/forget']) {
      await state.runtime.routes[route]({}, {});
    }
    expect(state.controllerCalls()).toBe(2);
    expect(state.controllerCreates()).toBe(1);
  });

  test('App metadata sender custody and file reads stay local to an exact host projection', async () => {
    const payloads: any[] = [];
    let controllerCreates = 0;
    const controllerGateway = gateway(() => {
      controllerCreates += 1;
      return controller({
        callSemantic: async (payload: any) => { payloads.push(payload); return { ok: true }; },
      });
    });
    const runtime = createKernelSemanticRuntime({
      controllerGateway,
      idbFactory: indexedDB,
      idb: {
        get: async () => undefined, getAll: async () => [], put: async () => {},
        del: async () => {}, transact: async () => ({ ok: true }),
      },
      kv: { get: async () => null, set: async () => {} },
      auditLog: { list: async () => [], append: async () => {} },
      vault: { isLocked: () => true, getSecret: async () => null },
      ready: Promise.resolve(), canWrite: () => {}, pushState: () => {},
      isHomeSender: () => true, actorCount: () => ({}), actorOverview: () => ({}),
      appCatalog: { get: async () => ({
        id: 'a', name: 'Alpha', entryFile: 'index.html', fileKinds: {}, dweb: null,
        thumbnail: 'private-thumbnail', ownerSessionId: 'private-owner',
      }) },
      appFiles: {
        readText: async () => '{"schema":1}',
        listApp: async () => ['/peerd.json', '/index.html'],
      },
      isAppSender: (sender: unknown) => sender === 'owned-app',
    });
    await expect(runtime.routes['app/get-meta']({ appId: 'a' }, 'forged'))
      .resolves.toEqual({ ok: false, error: 'app-meta-unauthorized' });
    expect(controllerCreates).toBe(0);
    await expect(runtime.routes['app/get-meta']({ appId: 'a' }, 'owned-app'))
      .resolves.toEqual({ ok: true });
    expect(payloads[0]).toMatchObject({
      route: 'app/get-meta', message: {
        app: { id: 'a', name: 'Alpha', entryFile: 'index.html', fileKinds: {}, dweb: null },
        manifestText: '{"schema":1}', paths: ['/peerd.json', '/index.html'],
      },
    });
    expect(JSON.stringify(payloads[0])).not.toContain('private-');
  });

  test('wires the fixed runtime probe through the injected controller gateway', async () => {
    for (const target of ['chrome', 'firefox']) {
      let authority: any;
      const controllerGateway = gateway((deps: any) => {
        authority = deps;
        return controller({
          callRuntime: async (payload: any) => ({
            ok: true, payload, authority: deps.authorizeRuntimeCall(payload), target,
          }),
        });
      });
      const state = createKernelSemanticRuntime({
        controllerGateway,
        idbFactory: indexedDB,
        idb: {
          get: async () => undefined, getAll: async () => [], put: async () => {},
          del: async () => {}, transact: async () => ({ ok: true }),
        },
        kv: { get: async () => null, set: async () => {} },
        auditLog: { list: async () => [], append: async () => {} },
        vault: { isLocked: () => false, getSecret: async () => null },
        ready: Promise.resolve(), canWrite: () => {}, pushState: () => {},
        isHomeSender: () => true, actorCount: () => ({ activeActors: 0 }),
        actorOverview: () => ({ roots: [] }), firefox: target === 'firefox',
      });
      await expect(state.runtime.probe()).resolves.toMatchObject({
        ok: true,
        payload: { operation: 'runtime.probe', input: {} },
        authority: { target: 'kernel-runtime', replayClass: 'A' },
        target,
      });
      expect(authority.authorizeRuntimeCall).toBeFunction();
    }
  });

  test('the vault gate precedes storage access for private direct routes', async () => {
    const state = makeRuntime(true);
    for (const route of [
      'contacts/list', 'contacts/set', 'contacts/forget', 'memory/export',
      'apps/list', 'apps/favorite', 'apps/open', 'apps/rename',
      'skills/list', 'skills/setEnabled', 'skills/remove',
    ]) {
      expect(await state.runtime.routes[route]({}, {}))
        .toEqual({ ok: false, error: 'vault-locked' });
    }
    expect(state.io()).toBe(0);
    expect(state.controllerCalls()).toBe(0);
    expect(state.controllerCreates()).toBe(0);
  });

  test('returns an export above the controller limit without touching the controller', async () => {
    const body = 'x'.repeat(300_000);
    const state = makeRuntime(false, [{ id: 'user', kind: 'user', body }]);
    const result = await state.runtime.routes['memory/export']();
    expect(result.payload.docs[0].body).toBe(body);
    expect(state.controllerCreates()).toBe(0);
    expect(state.controllerCalls()).toBe(0);
  });

  test('a production-shaped turn loader stays cold for a large direct export', async () => {
    const body = 'x'.repeat(300_000);
    const state = makeRuntime(false, [{ id: 'user', kind: 'user', body }], true);
    const result = await state.runtime.routes['memory/export']();
    expect(result.payload.docs[0].body).toBe(body);
    expect(state.controllerCreates()).toBe(0);
    expect(state.controllerCalls()).toBe(0);
  });

  test('shares one controller gateway with the demand-loaded turn owner', async () => {
    let creates = 0;
    let semanticCalls = 0;
    let physicalRuns = 0;
    let productionRuns = 0;
    const semanticPayloads: any[] = [];
    let authority: any;
    const base = makeRuntime();
    const controllerGateway = gateway((deps: any) => {
      creates += 1;
      authority = deps;
      return controller({
        callSemantic: async (payload: any) => {
          semanticCalls += 1;
          semanticPayloads.push(payload);
          return { ok: true };
        },
        withRun: async (operation: () => Promise<any>) => {
          physicalRuns += 1;
          return operation();
        },
      });
    });
    const runtime = createKernelSemanticRuntime({
      controllerGateway,
      idbFactory: indexedDB,
      idb: {
        get: async () => undefined, getAll: async () => [], put: async () => {},
        del: async () => {}, transact: async () => ({ ok: true }),
      },
      kv: { get: async () => null, set: async () => {} },
      auditLog: { list: async () => [], append: async () => {} },
      vault: { isLocked: () => false, getSecret: async () => null },
      ready: Promise.resolve(), canWrite: () => {}, pushState: () => {},
      isHomeSender: () => true,
      actorCount: () => { throw new Error('fallback projection used'); },
      actorOverview: () => { throw new Error('fallback projection used'); },
      withProductionRun: async (operation: () => Promise<any>) => {
        productionRuns += 1;
        return operation();
      },
      loadTurnRuntime: async (seams: any) => {
        await seams.withRun(async () => {});
        return ({
        turnDeps: {
          makeAgentSendCustody: () => ({
            validOperationId: () => false, operationWindowValid: () => false,
            sendFingerprint: async () => '', unknownSend: () => ({}),
            sendReceiptStatus: async () => ({}),
            withSendReceipt: async (_id: any, _binding: any, operation: any) => operation(),
          }),
        }, sessionDeps: {},
        isolationDeps: { retryActorIsolation: async () => ({ ok: true }) },
        actorCount: async () => ({ activeActors: 2 }),
        actorOverview: async () => ({ roots: [{ sessionId: 'root' }] }),
        relays: { sessions: base.runtime },
      }); },
    });

    await expect(runtime.routes['provider/status']({ provider: 'anthropic' }))
      .resolves.toEqual({ ok: true });
    await expect(runtime.routes['actors/count']()).resolves.toEqual({ ok: true });
    await expect(runtime.routes['actor-isolation/retry']()).resolves.toEqual({ ok: true });
    expect(creates).toBe(1);
    expect(semanticCalls).toBe(2);
    expect(semanticPayloads.at(-1).message.kernelContext)
      .toEqual({ activeActors: 2 });
    expect(authority.authorizeSemanticCall).toBeFunction();
    expect(authority.handleSemanticKernelCall).toBeFunction();
    expect(authority.authorizeTurnCall).toBeFunction();
    expect(authority.handleTurnKernelCall).toBeFunction();
    expect({ physicalRuns, productionRuns }).toEqual({ physicalRuns: 0, productionRuns: 1 });
    expect(runtime.relays).toEqual({ sessions: base.runtime });
    await runtime.close();
  });

  test('a compose-owner conflict rolls back the paired turn binding for retry', async () => {
    const state = makeRuntime(false, [], true);
    const composeBlocker = state.controllerGateway.bindCompose({
      authorize: () => null,
      handle: async () => ({ ok: false }),
    });
    expect(() => state.runtime.actorCount()).toThrow('kernel-compose-owner-conflict');
    const recoveredTurn = state.controllerGateway.bindTurn({
      authorize: () => null,
      handle: async () => ({ ok: false }),
    });
    recoveredTurn.release();
    composeBlocker.release();
    await expect(state.runtime.actorCount()).resolves.toEqual({ activeActors: 0 });
    await state.runtime.close();
  });
});
