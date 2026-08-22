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
import { LEGACY_SEMANTIC_ROUTE_INVENTORY } from '../../extension/shared/semantic-route-inventory.generated.js';
import { createSemanticDispatchRuntime } from '../../extension/offscreen/semantic-dispatch-runtime.js';
import {
  discoverLegacySemanticRoutes,
  renderSemanticRouteInventory,
} from '../../scripts/generate-semantic-route-inventory.mjs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

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

describe('generated semantic route inventory', () => {
  test('is an exact generated projection of the unified legacy dispatcher', async () => {
    const sourceRoot = resolve(import.meta.dir, '../..');
    const discovered = await discoverLegacySemanticRoutes({ sourceRoot });
    expect(discovered).toEqual([...LEGACY_SEMANTIC_ROUTE_INVENTORY]);
    const checkedIn = await readFile(resolve(sourceRoot,
      'extension/shared/semantic-route-inventory.generated.js'), 'utf8');
    expect(renderSemanticRouteInventory(discovered)).toBe(checkedIn);
  }, 15_000);

  test('pins cardinality, channel variance, ownership, and the unwired cutover', () => {
    expect(LEGACY_SEMANTIC_ROUTE_INVENTORY).toHaveLength(161);
    expect(LEGACY_SEMANTIC_ROUTE_INVENTORY.filter((row) => row.channels.length === 1)
      .map((row) => row.route)).toEqual([
      'contributor/disable', 'contributor/enable',
      'contributor/feedback', 'contributor/status',
    ]);
    expect(SEMANTIC_ROUTE_CLASSIFICATION.size).toBe(161);
    expect(SEMANTIC_ROUTE_CLASSIFICATIONS.filter((row) => row.placement === 'kernel'))
      .toHaveLength(76);
    expect(SEMANTIC_ROUTE_CLASSIFICATIONS.filter((row) => row.placement === 'split'))
      .toHaveLength(85);
    expect(SEMANTIC_ROUTE_CLASSIFICATIONS.filter((row) => row.state === 'migrated')
      .map((row) => row.route)).toEqual([
      'actors/count', 'actors/overview',
      'app/editor-delete', 'app/editor-write',
      'app/editor/delete', 'app/editor/list', 'app/editor/read', 'app/editor/write',
      'app/get-meta',
      'apps/favorite', 'apps/import-git', 'apps/list', 'apps/open', 'apps/rename',
      'apps/repository/branch', 'apps/repository/checkout',
      'apps/repository/commit', 'apps/repository/diff',
      'apps/repository/fetch', 'apps/repository/history',
      'apps/repository/link', 'apps/repository/push',
      'apps/repository/restore', 'apps/repository/status',
      'audit/list', 'audit/voice-fetch',
      'commands/list', 'composer/files', 'composer/tabs',
      'contacts/forget', 'contacts/list', 'contacts/set',
      'contributor/disable', 'contributor/enable', 'contributor/status',
      'cost/total',
      'denylist/add', 'denylist/list', 'denylist/remove',
      'git-cred/delete', 'git-cred/list', 'git-cred/set',
      'learned/clear', 'learned/forget', 'learned/list',
      'lifecycle/assert-opfs-writable',
      'local-model/catalog', 'local-model/init', 'local-model/probe', 'local-model/status',
      'memory/delete', 'memory/deleteAll', 'memory/export',
      'memory/suggestions', 'memory/suggestions/approve',
      'memory/suggestions/dismiss', 'memory/write',
      'models/options',
      'onboarding/complete',
      'openrouter/models',
      'permission/set',
      'provider/setKey', 'provider/status', 'provider/test',
      'repository/kernel-fetch',
      'session/contextSnapshots', 'session/get', 'session/list', 'session/setModel',
      'settings/reset', 'settings/update',
      'sidepanel/close',
      'site-client/delete', 'site-client/list',
      'state/get',
      'surfaces/get',
      'toolbox/read', 'toolbox/record',
      'vault/disablePrf', 'vault/enrollPrf', 'vault/initialize',
      'vault/initializeWithPasskey', 'vault/lock', 'vault/prfStatus',
      'vault/setRecoveryPassphrase', 'vault/unlock', 'vault/unlockPrf',
      'vm/get-meta',
    ]);
    expect(SEMANTIC_ROUTE_CUTOVER).toMatchObject({
      ready: false, expected: 161, classified: 161, missing: [], extra: [],
    });
    expect(SEMANTIC_ROUTE_CUTOVER.unmigrated).toHaveLength(73);
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
