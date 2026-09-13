import { describe, expect, test } from 'bun:test';
import { createKernelSemanticControl } from '../../extension/background/kernel-semantic-control.js';
import { SEMANTIC_DISPATCH_PROTOCOL } from '../../extension/shared/semantic-dispatch-contract.js';
import { createKernelSemanticAuthority } from '../../extension/background/kernel-semantic-authority.js';
import { createControllerKernelQuota } from '../../extension/shared/controller-kernel-quota.js';

describe('kernel semantic control', () => {
  test('binds reverse App entry updates to the host request and its manifest', async () => {
    const writes: Array<{ appId: string; entryFile: string }> = [];
    const vault = { isLocked: () => true };
    const authority = createKernelSemanticAuthority({
      vault, ready: Promise.resolve(), memory: { routes: {} }, contacts: {},
      appCatalog: { setEntryFile: async (appId: string, entryFile: string) => {
        writes.push({ appId, entryFile });
        return { id: appId, entryFile };
      } },
    });
    const manifest = (entry: string) => JSON.stringify({
      schema: 1, kind: 'app', entry, agent: { kind: 'bound-app' }, capabilities: [],
    });
    const attempt = async (appId: string, entryFile: string, manifestText: string,
      paths = ['index.html', 'next.html']) => {
      const control = createKernelSemanticControl({
        vault, authority, isHomeSender: () => true,
        callSemantic: async (outerPayload: any) => {
          const grant = control.authorize(outerPayload);
          const quota = createControllerKernelQuota('semantic.dispatch', outerPayload);
          const payload = { appId, entryFile };
          expect(quota.admit('semantic.apps.set-entry', payload).ok).toBe(true);
          return control.handleKernelCall('semantic.apps.set-entry', payload, {
            capability: 'semantic.dispatch', outerPayload, authority: grant,
          });
        },
      });
      return control.dispatchProjected('app/get-meta', {
        app: { id: 'app-a', entryFile: 'index.html' }, manifestText, paths,
      }, 'app');
    };
    expect(await attempt('app-b', 'next.html', manifest('next.html')))
      .toMatchObject({ ok: false, code: 'semantic-app-target-denied', outcomeKnown: true });
    for (const [entry, declared, paths] of [
      ['index.html', 'next.html', ['index.html', 'next.html']],
      ['../foreign.html', '../foreign.html', ['../foreign.html']],
      ['next.html', 'next.html', ['index.html']],
    ] as const) {
      expect(await attempt('app-a', entry, manifest(declared), [...paths]))
        .toMatchObject({ ok: false, code: 'semantic-app-entry-denied', outcomeKnown: true });
    }
    expect(await attempt('app-a', 'next.html', 'invalid json'))
      .toMatchObject({ ok: false, code: 'semantic-app-entry-denied' });
    expect(writes).toHaveLength(0);
    expect(await attempt('app-a', 'next.html', manifest('next.html')))
      .toMatchObject({ ok: true, value: { id: 'app-a', entryFile: 'next.html' } });
    expect(writes).toEqual([{ appId: 'app-a', entryFile: 'next.html' }]);
  });

  test('binds one route grant to the exact dispatched object', async () => {
    let sent: any;
    const control = createKernelSemanticControl({
      callSemantic: async (payload: any) => { sent = payload; return { ok: true }; },
      isHomeSender: () => true,
      vault: { isLocked: () => false },
      authority: { handle: () => ({ ok: true }) },
      routes: ['contacts/set'],
    });
    await control.routes['contacts/set']({ type: 'contacts/set', did: 'did:key:test' }, {});
    expect(sent).toEqual({
      protocol: SEMANTIC_DISPATCH_PROTOCOL,
      route: 'contacts/set',
      message: { type: 'contacts/set', did: 'did:key:test' },
    });
    expect(control.authorize({ ...sent })).toBeNull();
    expect(control.authorize(sent)).toMatchObject({
      target: 'semantic:contacts/set:first-party', replayClass: 'E',
    });
    expect(control.authorize(sent)).toBeNull();
  });

  test('keeps locked and actor provenance refusals inside the kernel', async () => {
    let calls = 0;
    const make = (locked: boolean, home: boolean) => createKernelSemanticControl({
      callSemantic: async () => { calls += 1; },
      isHomeSender: () => home,
      vault: { isLocked: () => locked },
      authority: { handle: () => ({ ok: true }) },
      routes: ['actors/count', 'memory/export'],
    });
    expect(await make(false, false).routes['actors/count']({}, {}))
      .toEqual({ ok: false, error: 'actor-overview-unauthorized' });
    expect(await make(true, true).routes['memory/export']({}, {}))
      .toEqual({ ok: false, error: 'vault-locked' });
    expect(calls).toBe(0);
  });

  test('returns actor authority state directly without accepting it from the message', async () => {
    let semanticCalls = 0;
    const control = createKernelSemanticControl({
      callSemantic: async () => { semanticCalls += 1; return { ok: true }; },
      isHomeSender: () => true,
      vault: { isLocked: () => false },
      authority: { handle: () => ({ ok: true }) },
      actorCount: () => ({ activeActors: 4 }),
      routes: ['actors/count'],
    });
    expect(await control.routes['actors/count']({ kernelContext: { activeActors: 99 } }, {}))
      .toEqual({ ok: true, activeActors: 4 });
    expect(semanticCalls).toBe(0);
  });

  test('preserves an authority projection failure instead of wrapping it as success', async () => {
    const control = createKernelSemanticControl({
      callSemantic: async () => { throw new Error('unused'); },
      isHomeSender: () => true,
      vault: { isLocked: () => false },
      authority: { handle: () => ({ ok: true }) },
      actorOverview: () => ({ ok: false, code: 'kernel-turn-runtime-load-timeout' }),
      routes: ['actors/overview'],
    });
    expect(await control.routes['actors/overview']({}, {})).toEqual({
      ok: false, code: 'kernel-turn-runtime-load-timeout',
    });
  });

  test('keeps large local authority reads outside the controller channel', async () => {
    let calls = 0;
    const control = createKernelSemanticControl({
      callSemantic: async () => { calls += 1; },
      isHomeSender: () => true,
      vault: { isLocked: () => false },
      authority: { handle: () => ({ ok: true }) },
      localRoutes: {
        'memory/export': async () => ({ ok: true, payload: { docs: ['x'.repeat(300_000)] } }),
      },
      routes: ['memory/export'],
    });
    expect(await control.routes['memory/export']()).toMatchObject({ ok: true });
    expect(calls).toBe(0);
  });

  test('waits for vault recovery before private IO and reports startup failure distinctly', async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    let io = 0;
    const make = (awaitReady: () => Promise<void>) => createKernelSemanticControl({
      callSemantic: async () => { throw new Error('unused'); },
      isHomeSender: () => true,
      vault: { isLocked: () => false },
      authority: { handle: () => ({ ok: true }) },
      localRoutes: { 'memory/export': async () => { io += 1; return { ok: true }; } },
      awaitReady,
      routes: ['memory/export'],
    });
    const pending = make(() => ready).routes['memory/export']();
    await Promise.resolve();
    expect(io).toBe(0);
    release();
    await expect(pending).resolves.toEqual({ ok: true });
    expect(io).toBe(1);
    await expect(make(async () => { throw new Error('resume failed'); })
      .routes['memory/export']()).resolves.toMatchObject({
      ok: false, code: 'kernel-semantic-startup-failed', outcomeKnown: true,
      phase: 'startup', retryable: true,
    });
    expect(io).toBe(1);
  });
});
