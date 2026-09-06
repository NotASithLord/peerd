import { describe, expect, test } from 'bun:test';
import { makeKernelDemandRoutes } from '../../extension/background/kernel-demand-routes.js';

describe('kernel demand routes', () => {
  test('loads one exact owner and preserves arguments', async () => {
    let loads = 0;
    const sender = { id: 'sender' };
    const routes = makeKernelDemandRoutes({
      names: ['a/read', 'a/write'],
      load: async () => {
        loads += 1;
        return {
          'a/read': (message: any, source: any) => ({ message, source }),
          'a/write': () => ({ ok: true }),
        };
      },
    });
    expect(await routes['a/read']({ value: 1 }, sender))
      .toEqual({ message: { value: 1 }, source: sender });
    expect(await routes['a/write']()).toEqual({ ok: true });
    expect(loads).toBe(1);
  });

  test('returns a stable pre-dispatch failure and retries failed loads', async () => {
    let loads = 0;
    const routes = makeKernelDemandRoutes({
      names: ['a/read'],
      load: async () => {
        loads += 1;
        if (loads === 1) throw new Error('hidden');
        return { 'a/read': () => ({ ok: true }) };
      },
    });
    expect(await routes['a/read']()).toEqual({
      ok: false, error: 'Temporarily unavailable. Try again.',
      code: 'kernel-owner-load-failed', outcomeKnown: true,
      phase: 'startup', retryable: true,
    });
    expect(await routes['a/read']()).toEqual({ ok: true });
    expect(loads).toBe(2);
  });

  test('rejects duplicate names and incomplete owners', async () => {
    expect(() => makeKernelDemandRoutes({ names: ['a', 'a'], load: async () => ({}) }))
      .toThrow('kernel-demand-route-names-invalid');
    const routes = makeKernelDemandRoutes({ names: ['a'], load: async () => ({}) });
    expect(await routes.a()).toMatchObject({
      code: 'kernel-owner-load-failed', outcomeKnown: true, phase: 'startup', retryable: true,
    });
  });

  test('never presents a post-admission effect failure as retryable', async () => {
    let effects = 0;
    const routes = makeKernelDemandRoutes({
      names: ['a/write'],
      load: async () => ({
        'a/write': () => { effects += 1; throw new Error('after effect'); },
      }),
    });
    expect(await routes['a/write']()).toEqual({
      ok: false,
      error: 'The operation outcome could not be confirmed.',
      code: 'kernel-owner-dispatch-failed',
      outcomeKnown: false,
      outcomeKind: 'unknown',
      retryable: false,
    });
    expect(effects).toBe(1);
  });

  test('can refuse before evaluating the owner', async () => {
    let loads = 0;
    const routes = makeKernelDemandRoutes({
      names: ['private/read', 'public/read'],
      beforeLoad: (name) => name === 'private/read' ? { ok: false, error: 'locked' } : null,
      load: async () => {
        loads += 1;
        return {
          'private/read': () => ({ ok: true }),
          'public/read': () => ({ ok: true }),
        };
      },
    });
    expect(await routes['private/read']()).toEqual({ ok: false, error: 'locked' });
    expect(loads).toBe(0);
    expect(await routes['public/read']()).toEqual({ ok: true });
    expect(loads).toBe(1);
  });

  test('an interrupt dominates a guarded request frozen on first load', async () => {
    let resolveOwner!: (routes: Record<string, Function>) => void;
    const pending = new Promise<Record<string, Function>>((resolve) => {
      resolveOwner = resolve;
    });
    let liveStops = 0;
    const routes = makeKernelDemandRoutes({
      names: ['agent/send', 'agent/stop'],
      load: () => pending,
      interrupt: {
        name: 'agent/stop', guards: ['agent/send'],
        refusal: () => ({ ok: false, code: 'stopped-before-dispatch' }),
      },
    });
    const send = routes['agent/send']({ text: 'held' });
    await expect(routes['agent/stop']()).resolves.toEqual({ ok: true });
    resolveOwner({
      'agent/send': () => ({ ok: true }),
      'agent/stop': () => { liveStops += 1; return { ok: true }; },
    });
    await expect(send).resolves.toEqual({ ok: false, code: 'stopped-before-dispatch' });
    await expect(routes['agent/send']({ text: 'next' })).resolves.toEqual({ ok: true });
    await expect(routes['agent/stop']()).resolves.toEqual({ ok: true });
    expect(liveStops).toBe(1);
  });
});
