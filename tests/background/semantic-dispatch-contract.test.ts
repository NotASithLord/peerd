import { describe, expect, test } from 'bun:test';
import {
  compileSemanticRouteClassification,
  parseSemanticDispatchRequest,
  semanticDispatchCutoverReport,
} from '../../extension/shared/semantic-dispatch-contract.js';
import {
  SEMANTIC_ROUTE_CLASSIFICATION,
  SEMANTIC_ROUTE_CLASSIFICATIONS,
  SEMANTIC_ROUTE_CUTOVER,
} from '../../extension/shared/semantic-route-classification.js';
import { SEMANTIC_ROUTE_INVENTORY } from '../../extension/shared/semantic-route-inventory.js';
import { createSemanticDispatchRuntime } from '../../extension/offscreen/semantic-dispatch-runtime.js';
import { createSemanticDemandQuota } from '../../extension/shared/semantic-demand-policy.js';
import { SEMANTIC_HOST_ROUTE_CLASSIFICATIONS } from '../../extension/shared/semantic-host-route-manifest.js';

const AUTHORITY = Object.freeze({
  ownerId: 'root:test', sessionId: 'session:test', instanceId: null,
  origin: null, target: null, replayClass: 'E',
});
const classification = (route: string, placement: 'kernel' | 'semantic-host' | 'split',
  state: 'migrated' | 'unmigrated' = 'migrated') => ({
  route, channels: ['store', 'preview'], source: 'test-fixture.js', placement, state,
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
  'contacts/list', 'memory/export', 'skills/list', 'skills/remove', 'skills/setEnabled',
];

describe('semantic route inventory', () => {
  test('pins cardinality, channel variance, ownership, and the complete cutover', () => {
    expect(SEMANTIC_ROUTE_INVENTORY).toHaveLength(167);
    expect(SEMANTIC_ROUTE_INVENTORY.filter((row) => row.channels.length === 1)
      .map((row) => row.route)).toEqual([
      'contributor/disable', 'contributor/enable',
      'contributor/feedback', 'contributor/status',
    ]);
    expect(SEMANTIC_ROUTE_CLASSIFICATION.size).toBe(167);
    expect(SEMANTIC_ROUTE_CLASSIFICATIONS.filter((row) => row.placement === 'kernel'))
      .toHaveLength(149);
    expect(SEMANTIC_ROUTE_CLASSIFICATIONS.filter((row) => row.placement === 'split'))
      .toHaveLength(18);
    expect(SEMANTIC_ROUTE_CLASSIFICATIONS.filter((row) => row.state === 'migrated')
      .map((row) => row.route)).toEqual(
        SEMANTIC_ROUTE_INVENTORY.map((row) => row.route),
      );
    expect(SEMANTIC_ROUTE_CUTOVER).toMatchObject({
      ready: true, expected: 167, classified: 167, missing: [], extra: [],
    });
    expect(SEMANTIC_ROUTE_CUTOVER.unmigrated).toEqual([]);
  });

  test('does not let a candidate table hide missing, extra, or unmigrated routes', () => {
    const table = compileSemanticRouteClassification([
      classification('test/one', 'split'),
      classification('test/extra', 'split'),
      classification('test/two', 'kernel', 'unmigrated'),
    ]);
    expect(semanticDispatchCutoverReport(table, [
      { route: 'test/one' }, { route: 'test/two' }, { route: 'test/missing' },
    ])).toEqual({
      ready: false, expected: 3, classified: 3,
      missing: ['test/missing'], extra: ['test/extra'], unmigrated: ['test/two'],
    });
  });

  test('direct authority routes have no semantic-host or reverse-call edge', () => {
    const reverseOperations = [
      'semantic.contacts.list-saved', 'semantic.contacts.list-apps',
      'semantic.contacts.list-audit', 'semantic.contacts.upsert', 'semantic.contacts.remove',
      'semantic.memory.export', 'semantic.skills.list', 'semantic.skills.set-enabled',
      'semantic.skills.remove',
    ];
    for (const route of DIRECT_KERNEL_ROUTES) {
      expect(SEMANTIC_ROUTE_CLASSIFICATION.get(route)).toMatchObject({ placement: 'kernel' });
      expect(SEMANTIC_HOST_ROUTE_CLASSIFICATIONS.some((row) => row.route === route)).toBe(false);
      const quota = createSemanticDemandQuota(request(route));
      expect(quota.pendingCap).toBe(0);
      for (const operation of reverseOperations) {
        expect(quota.admit(operation, {})).toMatchObject({
          ok: false, code: 'kernel-operation-denied',
        });
      }
    }
  });

  test('rejects duplicate, malformed, and silently extended classification rows', () => {
    expect(() => compileSemanticRouteClassification([
      classification('test/one', 'split'), classification('test/one', 'split'),
    ])).toThrow('semantic-route-name-invalid-or-duplicate');
    expect(() => compileSemanticRouteClassification([{
      ...classification('test/one', 'split'), surprise: true,
    }])).toThrow('semantic-route-row-shape-invalid');
    expect(() => compileSemanticRouteClassification([
      { ...classification('test/one', 'split'), channels: ['store', 'store'] },
    ])).toThrow('semantic-route-row-value-invalid');
  });
});

describe('semantic.dispatch protocol and host registry', () => {
  test('passes only the kernel-derived authority and kernelCall into an admitted handler', async () => {
    const calls: any[] = [];
    const kernelCall = async (operation: string, payload: unknown) => ({ operation, payload });
    const runtime = createSemanticDispatchRuntime({
      classifications: [classification('test/semantic', 'split')],
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
      classifications: [classification('test/semantic', 'semantic-host')],
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

  test('refuses unknown, unmigrated, and kernel-owned routes before a handler', async () => {
    const migrated = createSemanticDispatchRuntime({
      classifications: [classification('test/semantic', 'semantic-host')],
      handlers: { 'test/semantic': async () => ({ ok: true }) },
    });
    await expect(migrated.dispatch(request('test/unknown'), options())).resolves.toEqual({
      ok: false, code: 'semantic-dispatch-route-unknown', outcomeKnown: true,
    });
    const unmigrated = createSemanticDispatchRuntime({
      classifications: [classification('test/unmigrated', 'split', 'unmigrated')],
      handlers: {},
    });
    await expect(unmigrated.dispatch(request('test/unmigrated'), options())).resolves.toEqual({
      ok: false, code: 'semantic-dispatch-route-unmigrated', outcomeKnown: true,
    });
    const kernel = createSemanticDispatchRuntime({
      classifications: [classification('test/kernel', 'kernel')], handlers: {},
    });
    await expect(kernel.dispatch(request('test/kernel'), options())).resolves.toEqual({
      ok: false, code: 'semantic-dispatch-route-kernel-owned', outcomeKnown: true,
    });
  });

  test('construction refuses registrations that are unknown, kernel-owned, or incomplete', () => {
    expect(() => createSemanticDispatchRuntime({
      classifications: [classification('test/kernel', 'kernel')],
      handlers: { 'test/kernel': async () => ({ ok: true }) },
    })).toThrow('semantic-handler-route-not-admitted:test/kernel');
    expect(() => createSemanticDispatchRuntime({
      classifications: [classification('test/semantic', 'split')], handlers: {},
    })).toThrow('semantic-handler-missing:test/semantic');
    expect(() => createSemanticDispatchRuntime({
      classifications: [classification('test/semantic', 'split')],
      handlers: { 'test/unknown': async () => ({ ok: true }) },
    })).toThrow('semantic-handler-route-not-admitted:test/unknown');
  });

  test('invalid authority, signal, pre-abort, and expired deadline are known-safe', async () => {
    let calls = 0;
    const runtime = createSemanticDispatchRuntime({
      classifications: [classification('test/semantic', 'split')],
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
        classifications: [classification('test/semantic', 'split')],
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
