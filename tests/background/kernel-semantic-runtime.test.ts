import { describe, expect, test } from 'bun:test';
import { useFakeIndexedDB } from '../setup.ts';
import {
  createKernelSemanticRuntime,
  KERNEL_SEMANTIC_DIRECT_ROUTE_NAMES,
} from '../../extension/background/kernel-semantic-runtime.js';
import { SEMANTIC_HOST_ROUTE_CLASSIFICATIONS } from '../../extension/shared/semantic-host-route-manifest.js';

await useFakeIndexedDB();

const makeRuntime = (locked = false, docs: any[] = [], withTurn = false) => {
  let controllerCalls = 0;
  let controllerCreates = 0;
  let io = 0;
  const runtime = createKernelSemanticRuntime({
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
    ready: Promise.resolve(),
    canWrite: () => {}, pushState: () => {}, isHomeSender: () => true,
    actorCount: () => ({ activeActors: 0 }), actorOverview: () => ({ roots: [] }),
    makeController: () => { controllerCreates += 1; return ({
      callSemantic: async () => { controllerCalls += 1; return { ok: true }; },
      callTurn: async () => ({ ok: true }), renderSystemPrompt: async () => '',
      withRun: async (operation: () => Promise<void>) => operation(),
      close: () => {},
    }); },
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
    runtime, controllerCalls: () => controllerCalls,
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
      ['toolbox/read', { name: 'missing' }],
      ['toolbox/record', { names: [], ok: true }],
      ['contacts/list', {}],
      ['contacts/set', {}],
      ['contacts/forget', {}],
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

  test('the vault gate precedes storage access for private direct routes', async () => {
    const state = makeRuntime(true);
    for (const route of [
      'contacts/list', 'contacts/set', 'contacts/forget', 'memory/export',
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
    const semanticPayloads: any[] = [];
    let authority: any;
    const base = makeRuntime();
    const runtime = createKernelSemanticRuntime({
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
      makeController: (deps: any) => {
        creates += 1;
        authority = deps;
        return {
          callSemantic: async (payload: any) => {
            semanticCalls += 1;
            semanticPayloads.push(payload);
            return { ok: true };
          },
          callTurn: async () => ({ ok: true }),
          renderSystemPrompt: async () => '',
          withRun: async (operation: () => Promise<void>) => operation(),
          close: () => {},
        };
      },
      loadTurnRuntime: async () => ({
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
      }),
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
    expect(runtime.relays).toEqual({ sessions: base.runtime });
    await runtime.close();
  });
});
