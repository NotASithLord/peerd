import { describe, expect, test } from 'bun:test';
import { createKernelSemanticControl } from '../../extension/background/kernel-semantic-control.js';
import { SEMANTIC_DISPATCH_PROTOCOL } from '../../extension/shared/semantic-dispatch-contract.js';

describe('kernel semantic control', () => {
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
    const toolboxStore = {
      getBody: async () => 'export const ok = true;', recordRuns: async () => {},
    };
    const make = (locked: boolean, home: boolean) => createKernelSemanticControl({
      callSemantic: async () => { calls += 1; },
      isHomeSender: () => home,
      vault: { isLocked: () => locked },
      authority: { handle: () => ({ ok: true }) },
      toolboxStore,
      routes: ['actors/count', 'memory/export', 'toolbox/read'],
    });
    expect(await make(false, false).routes['actors/count']({}, {}))
      .toEqual({ ok: false, error: 'actor-overview-unauthorized' });
    expect(await make(true, true).routes['memory/export']({}, {}))
      .toEqual({ ok: false, error: 'vault-locked' });
    expect(await make(true, true).routes['toolbox/read']({ name: 'known' }, {}))
      .toEqual({ ok: true, body: 'export const ok = true;' });
    expect(calls).toBe(0);
  });

  test('injects actor state without accepting it from the message', async () => {
    let sent: any;
    const control = createKernelSemanticControl({
      callSemantic: async (payload: any) => { sent = payload; return { ok: true }; },
      isHomeSender: () => true,
      vault: { isLocked: () => false },
      authority: { handle: () => ({ ok: true }) },
      actorCount: () => ({ activeActors: 4 }),
      routes: ['actors/count'],
    });
    await control.routes['actors/count']({ kernelContext: { activeActors: 99 } }, {});
    expect(sent.message.kernelContext).toEqual({ activeActors: 4 });
    expect(control.authorize(sent)).toMatchObject({ replayClass: 'A' });
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
