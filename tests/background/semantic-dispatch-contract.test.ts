import { describe, expect, test } from 'bun:test';
import {
  compileSemanticHostRouteManifest,
  parseSemanticDispatchRequest,
} from '../../extension/shared/semantic-dispatch-contract.js';
import { createSemanticDispatchRuntime } from '../../extension/offscreen/semantic-dispatch-runtime.js';
import { SEMANTIC_HOST_ROUTE_MANIFEST } from '../../extension/shared/semantic-host-route-manifest.js';

const AUTHORITY = Object.freeze({
  ownerId: 'root:test', sessionId: 'session:test', instanceId: null,
  origin: null, target: null, replayClass: 'E',
});
const manifestRow = (route: string) => ({
  route, channels: ['store', 'preview'],
});
const request = (route = 'test/semantic', message: Record<string, unknown> = {}) => ({
  protocol: 1 as const, route, message: { type: route, ...message },
});
const options = (extra: Record<string, unknown> = {}) => ({
  signal: new AbortController().signal,
  authority: AUTHORITY,
  ...extra,
});
const DIRECT_KERNEL_ROUTES = [
  'actors/count', 'actors/overview',
  'contacts/list', 'memory/export', 'skills/list', 'skills/remove', 'skills/setEnabled',
];

describe('semantic host manifest', () => {
  test('contains only the exact executable host routes', () => {
    const compiled = compileSemanticHostRouteManifest(SEMANTIC_HOST_ROUTE_MANIFEST);
    expect(compiled.size).toBe(SEMANTIC_HOST_ROUTE_MANIFEST.length);
    for (const route of DIRECT_KERNEL_ROUTES) {
      expect(compiled.has(route)).toBe(false);
    }
  });

  test('rejects duplicate, malformed, and silently extended manifest rows', () => {
    expect(() => compileSemanticHostRouteManifest([
      manifestRow('test/one'), manifestRow('test/one'),
    ])).toThrow('semantic-route-name-invalid-or-duplicate');
    expect(() => compileSemanticHostRouteManifest([{
      ...manifestRow('test/one'), surprise: true,
    }])).toThrow('semantic-route-row-shape-invalid');
    expect(() => compileSemanticHostRouteManifest([
      { ...manifestRow('test/one'), channels: ['store', 'store'] },
    ])).toThrow('semantic-route-row-value-invalid');
  });
});

describe('semantic.dispatch protocol and host registry', () => {
  test('passes only the kernel-derived authority and kernelCall into an admitted handler', async () => {
    const calls: any[] = [];
    const kernelCall = async (operation: string, payload: unknown) => ({ operation, payload });
    const runtime = createSemanticDispatchRuntime({
      manifest: [manifestRow('test/semantic')],
      handlers: {
        'test/semantic': async (message, context) => {
          calls.push({ message, context });
          return { ok: true, outcomeKnown: true,
            kernel: await context.kernelCall?.('state.read', { exact: true }) };
        },
      },
    });
    await expect(runtime.dispatch(request('test/semantic', { value: 3 }),
      options({ kernelCall }))).resolves.toEqual({
      ok: true, outcomeKnown: true,
      kernel: { operation: 'state.read', payload: { exact: true } },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].message).toEqual({ type: 'test/semantic', value: 3 });
    expect(calls[0].context.authority).toEqual(AUTHORITY);
    expect(calls[0].context).not.toHaveProperty('sender');
    expect(runtime.routes).toEqual(['test/semantic']);
  });

  test('fails closed before execution for malformed, mismatched, oversized, and polluted requests', async () => {
    let calls = 0;
    const runtime = createSemanticDispatchRuntime({
      manifest: [manifestRow('test/semantic')],
      handlers: { 'test/semantic': async () => { calls += 1; return { ok: true }; } },
    });
    const polluted = Object.create({ route: 'test/semantic' });
    Object.assign(polluted, { protocol: 1, message: { type: 'test/semantic' } });
    for (const payload of [
      null,
      { ...request(), extra: true },
      { ...request(), message: { type: 'test/other' } },
      request('test/semantic', { huge: 'x'.repeat(300_000) }),
      polluted,
    ]) {
      await expect(runtime.dispatch(payload, options())).resolves.toEqual({
        ok: false, code: 'semantic-dispatch-request-invalid', outcomeKnown: true,
      });
    }
    expect(calls).toBe(0);
  });

  test('refuses an unknown route before a handler', async () => {
    const runtime = createSemanticDispatchRuntime({
      manifest: [manifestRow('test/semantic')],
      handlers: { 'test/semantic': async () => ({ ok: true }) },
    });
    await expect(runtime.dispatch(request('test/unknown'), options())).resolves.toEqual({
      ok: false, code: 'semantic-dispatch-route-unknown', outcomeKnown: true,
    });
  });

  test('construction refuses registrations that are unknown or incomplete', () => {
    expect(() => createSemanticDispatchRuntime({
      manifest: [manifestRow('test/semantic')], handlers: {},
    })).toThrow('semantic-handler-missing:test/semantic');
    expect(() => createSemanticDispatchRuntime({
      manifest: [manifestRow('test/semantic')],
      handlers: { 'test/unknown': async () => ({ ok: true }) },
    })).toThrow('semantic-handler-route-not-admitted:test/unknown');
  });

  test('invalid authority, signal, pre-abort, and expired deadline are known-safe', async () => {
    let calls = 0;
    const runtime = createSemanticDispatchRuntime({
      manifest: [manifestRow('test/semantic')],
      handlers: { 'test/semantic': async () => { calls += 1; return { ok: true }; } },
      now: () => 100,
    });
    await expect(runtime.dispatch(request(), options({ authority: { ...AUTHORITY, extra: true } })))
      .resolves.toMatchObject({ code: 'semantic-dispatch-authority-invalid', outcomeKnown: true });
    await expect(runtime.dispatch(request(), { authority: AUTHORITY } as any))
      .resolves.toMatchObject({ code: 'semantic-dispatch-signal-invalid', outcomeKnown: true });
    const abort = new AbortController(); abort.abort();
    await expect(runtime.dispatch(request(), options({ signal: abort.signal })))
      .resolves.toMatchObject({ code: 'semantic-dispatch-aborted', outcomeKnown: true });
    await expect(runtime.dispatch(request(), options({ deadlineAt: 100 })))
      .resolves.toMatchObject({ code: 'semantic-dispatch-deadline-expired', outcomeKnown: true });
    expect(calls).toBe(0);
  });

  test('post-dispatch throw and invalid or excessive results are outcome-unknown and leak no cause', async () => {
    for (const handler of [
      async () => { throw new Error('private handler detail'); },
      async () => ({ ok: true, callback: () => {} }),
      async () => ({ ok: true, huge: 'x'.repeat(300_000) }),
    ]) {
      const runtime = createSemanticDispatchRuntime({
        manifest: [manifestRow('test/semantic')],
        handlers: { 'test/semantic': handler },
      });
      const result = await runtime.dispatch(request(), options());
      expect(result).toMatchObject({ ok: false, outcomeKnown: false });
      expect(JSON.stringify(result)).not.toContain('private handler detail');
    }
  });

  test('request parser requires an own matching type and exact envelope', () => {
    const inherited = Object.create({ type: 'test/semantic' });
    expect(parseSemanticDispatchRequest({ protocol: 1, route: 'test/semantic', message: inherited }))
      .toBeNull();
    expect(parseSemanticDispatchRequest(request())).toEqual(request());
  });
});
