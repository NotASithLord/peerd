import { describe, expect, test } from 'bun:test';
import { createKernelSessionAuthority } from '../../extension/background/kernel-session-authority.js';
import { createKernelSupportControl } from '../../extension/background/kernel-support-control.js';
import { makeKernelDemandRoutes } from '../../extension/background/kernel-demand-routes.js';
import { makeSessionSupportPreflight } from '../../extension/background/vault-kernel-core.js';
import { createKernelFeatureHost } from '../../extension/offscreen/kernel-feature-host.js';
import {
  KERNEL_FEATURE_DISPATCH_CAPABILITY,
  createKernelFeatureEffectQuota,
  kernelFeatureAuthorityFor,
} from '../../extension/shared/kernel-feature-policy.js';
import {
  KERNEL_SESSION_SUPPORT_ROUTE_NAMES,
  KERNEL_SUPPORT_EFFECT_OPERATIONS,
} from '../../extension/shared/kernel-support-protocol.js';

const session = (overrides: Record<string, unknown> = {}) => ({
  kind: 'chat', sessionId: 'chat-1', title: 'Chat', createdAt: 10,
  messages: [{ when: 11, content: 'private message bytes' }],
  provider: 'anthropic', model: 'old', toolManifest: { preset: 'web', allow: ['script'] },
  customSystemPrompt: 'private prompt bytes', ...overrides,
});

const harness = (overrides: Record<string, any> = {}) => {
  const rows = new Map<string, any>([
    ['chat-1', session()],
    ['actor-1', session({ kind: 'actor', sessionId: 'actor-1' })],
  ]);
  const cache = new Map<string, any>([['currentSessionId', 'chat-1']]);
  let locked = false;
  let pushes = 0;
  const audits: any[] = [];
  const deps = {
    ready: Promise.resolve(),
    vault: { isLocked: () => locked },
    sessions: {
      listSummaries: async () => [...rows.values()].map((row) => ({
        kind: row.kind, sessionId: row.sessionId, title: row.title, createdAt: row.createdAt,
        lastMessageAt: row.messages.at(-1)?.when ?? row.createdAt,
        messageCount: row.messages.length, archivedAt: row.archivedAt,
        provider: row.provider, model: row.model,
        hasCustomSystemPrompt: typeof row.customSystemPrompt === 'string'
          && row.customSystemPrompt.length > 0,
        toolManifest: row.toolManifest,
      })),
      get: async (id: string) => rows.get(id) ?? null,
      updateMetadata: async (id: string, patch: Record<string, unknown>) => {
        const row = rows.get(id);
        if (!row) return null;
        const next = { ...row, ...patch };
        rows.set(id, next);
        return next;
      },
    },
    contextSnapshots: { snapshotsFor: (id: string) => [{ id, capturedAt: 12 }] },
    sessionCache: {
      sessionGet: async (key: string) => cache.get(key),
      sessionSet: async (key: string, value: unknown) => { cache.set(key, value); },
    },
    auditLog: { append: async (event: unknown) => { audits.push(event); } },
    resolvePermission: (row: any, mode: unknown, confirmActions: unknown) => ({
      mode: (row?.permissionMode ?? mode) === 'act' ? 'act' : 'plan',
      confirmActions: row?.confirmActions ?? confirmActions !== false,
    }),
    pushState: async () => { pushes += 1; },
    admitRoute: (route: string, _message: unknown, sender: any) => route === 'session/list'
      ? sender?.surface === 'sidepanel' || sender?.surface === 'options'
      : sender?.surface === 'sidepanel',
    ...overrides.deps,
  };
  const authority = createKernelSessionAuthority(deps);
  const calls: Array<[string, Record<string, unknown>]> = [];
  const effects = Object.fromEntries(Object.entries(authority.effects).map(([operation, run]) => [
    operation,
    async (payload: Record<string, unknown>, context: unknown) => {
      calls.push([operation, payload]);
      if (overrides.failOperation === operation) {
        const error = new Error('private effect failure');
        Object.assign(error, { outcomeKnown: false });
        throw error;
      }
      return (run as any)(payload, context);
    },
  ]));
  let loads = 0;
  const host = createKernelFeatureHost({
    loaders: { support: overrides.loader ?? (async () => {
      loads += 1;
      return import('../../extension/offscreen/kernel-support-host.js');
    }) },
    loadTimeoutMs: 50,
  });
  let control!: ReturnType<typeof createKernelSupportControl>;
  control = createKernelSupportControl({
    admit: overrides.admit ?? authority.admit,
    effectAllowed: overrides.effectAllowed ?? authority.effectAllowed,
    effects,
    callFeature: async (payload: any) => {
      const granted = control.authorize(payload);
      const signal = new AbortController().signal;
      const deadlineAt = Date.now() + 60_000;
      return host.dispatch(payload, {
        authority: granted, signal, deadlineAt,
        kernelCall: (operation: string, value: unknown) => control.handleKernelCall(
          operation, value, {
            capability: KERNEL_FEATURE_DISPATCH_CAPABILITY,
            authority: granted, signal, deadlineAt,
          },
        ),
      });
    },
  });
  return {
    audits, cache, calls, control, rows,
    get loads() { return loads; },
    get pushes() { return pushes; },
    setLocked(value: boolean) { locked = value; },
    authority,
  };
};

describe('session support cutover', () => {
  test('owns exactly five session routes and never exports list message bodies', async () => {
    const lane = harness();
    expect(Object.keys(lane.control.routes).sort())
      .toEqual([...KERNEL_SESSION_SUPPORT_ROUTE_NAMES].sort());
    expect([...KERNEL_SUPPORT_EFFECT_OPERATIONS].sort()).toEqual([
      'support.permission.commit',
      'support.session.context-snapshots',
      'support.session.model.commit',
      'support.session.read',
      'support.sessions.list',
    ]);
    const snapshot = await lane.authority.effects['support.sessions.list']();
    expect(JSON.stringify(snapshot)).not.toContain('private message bytes');
    expect(JSON.stringify(snapshot)).not.toContain('private prompt bytes');
    await expect(lane.control.routes['session/list']({}, { surface: 'options' })).resolves.toEqual({
      ok: true,
      sessions: [{
        sessionId: 'chat-1', title: 'Chat', createdAt: 10, lastMessageAt: 11,
        messageCount: 1, archived: false, provider: 'anthropic', model: 'old',
        hasCustomSystemPrompt: true, toolManifestLabel: 'web +1',
      }],
    });
  });

  test('preserves legacy tool manifest labels', async () => {
    const lane = harness();
    for (const [manifest, label] of [
      [undefined, null],
      ['bad', 'custom (0 tools)'],
      [{}, 'custom (0 tools)'],
      [{ allow: ['a'] }, 'custom (1 tool)'],
      [{ preset: ' research ', allow: ['a', '', 3] }, 'research +1'],
    ] as const) {
      lane.rows.get('chat-1').toolManifest = manifest;
      const result = await lane.control.routes['session/list']({}, { surface: 'sidepanel' });
      expect(result.sessions[0].toolManifestLabel).toBe(label);
    }
  });

  test('preserves read, current-model, lock, and permission null parity', async () => {
    const lane = harness();
    await expect(lane.control.routes['session/get'](
      { sessionId: 'chat-1' }, { surface: 'sidepanel' },
    )).resolves.toMatchObject({ ok: true, session: { sessionId: 'chat-1' } });
    await expect(lane.control.routes['session/contextSnapshots'](
      { sessionId: 'chat-1' }, { surface: 'sidepanel' },
    )).resolves.toEqual({ ok: true, snapshots: [{ id: 'chat-1', capturedAt: 12 }] });
    await expect(lane.control.routes['session/contextSnapshots'](
      { sessionId: 'missing' }, { surface: 'sidepanel' },
    )).resolves.toEqual({ ok: true, snapshots: [{ id: 'missing', capturedAt: 12 }] });
    await expect(lane.control.routes['session/setModel'](
      { model: `  ${'m'.repeat(240)}  ` }, { surface: 'sidepanel' },
    )).resolves.toEqual({ ok: true, model: 'm'.repeat(200) });
    expect(lane.rows.get('chat-1').model).toBe('m'.repeat(200));
    expect(lane.calls.find(([operation]) => operation === 'support.session.model.commit')?.[1])
      .toEqual({ sessionId: null, model: 'm'.repeat(200) });
    await Promise.resolve();
    expect(lane.audits.at(-1)).toMatchObject({
      type: 'session_model_changed', sessionId: 'chat-1',
      details: { model: 'm'.repeat(200) },
    });
    expect(lane.pushes).toBe(1);
    await expect(lane.control.routes['session/setModel'](
      { sessionId: 'missing', model: 'next' }, { surface: 'sidepanel' },
    )).resolves.toEqual({ ok: false, error: 'session-not-found' });
    await expect(lane.control.routes['permission/set'](
      { mode: null, confirmActions: null }, { surface: 'sidepanel' },
    )).resolves.toEqual({ ok: true, permission: { mode: 'plan', confirmActions: true } });
    expect(Object.fromEntries(lane.cache)).toMatchObject({
      currentSessionId: 'chat-1', currentPermissionMode: 'plan', currentConfirmActions: true,
    });
    await Promise.resolve();
    expect(lane.audits.at(-1)).toMatchObject({
      type: 'mode_changed', sessionId: 'chat-1',
      details: { mode: 'plan', confirmActions: true },
    });
    expect(lane.pushes).toBe(2);
    await expect(lane.control.routes['permission/set'](
      {}, { surface: 'sidepanel' },
    )).resolves.toEqual({ ok: false, error: 'no-mode-or-confirm' });
    lane.setLocked(true);
    await expect(lane.control.routes['session/get'](
      {}, { surface: 'sidepanel' },
    )).resolves.toEqual({ ok: false, error: 'locked' });
    await expect(lane.control.routes['session/contextSnapshots'](
      { sessionId: 'x'.repeat(300) }, { surface: 'sidepanel' },
    )).resolves.toEqual({ ok: false, error: 'locked' });
    await expect(lane.control.routes['session/get'](
      { sessionId: 'chat-1' }, { surface: 'sidepanel' },
    )).resolves.toEqual({ ok: false, error: 'locked' });
    await expect(lane.control.routes['session/setModel'](
      { model: null }, { surface: 'sidepanel' },
    )).resolves.toEqual({ ok: false, error: 'locked' });
    lane.setLocked(false);
    await expect(lane.control.routes['session/get'](
      {}, { surface: 'sidepanel' },
    )).resolves.toEqual({ ok: false, error: 'sessionId-required' });
    await expect(lane.control.routes['session/contextSnapshots'](
      { sessionId: 42 }, { surface: 'sidepanel' },
    )).resolves.toEqual({ ok: false, error: 'sessionId-required' });
    await expect(lane.control.routes['session/contextSnapshots'](
      { sessionId: 'x'.repeat(300) }, { surface: 'sidepanel' },
    )).resolves.toEqual({
      ok: true, snapshots: [{ id: 'x'.repeat(300), capturedAt: 12 }],
    });
    lane.cache.delete('currentSessionId');
    await expect(lane.control.routes['session/setModel'](
      { model: null }, { surface: 'sidepanel' },
    )).resolves.toEqual({ ok: false, error: 'no-session' });
    lane.cache.set('currentSessionId', 'chat-1');
    await expect(lane.control.routes['session/setModel'](
      { model: null }, { surface: 'sidepanel' },
    )).resolves.toEqual({ ok: false, error: 'invalid-model' });
  });

  test('admits the sender before loading the host or reading authority', async () => {
    const lane = harness();
    await expect(lane.control.routes['session/list']({}, { surface: 'app' })).resolves.toEqual({
      ok: false, error: 'kernel-route-unauthorized', outcomeKnown: true,
    });
    expect(lane.loads).toBe(0);
    expect(lane.calls).toEqual([]);
  });

  test('bounds legacy summary fields before the controller boundary', async () => {
    const lane = harness({ deps: { sessions: {
      listSummaries: async () => [{
        kind: 'chat', sessionId: 'legacy', title: 42,
        createdAt: null, lastMessageAt: null, messageCount: -4,
        provider: null, model: null, toolManifest: { preset: 'x'.repeat(200) },
      }],
    } } });
    await expect(lane.authority.effects['support.sessions.list']()).resolves.toEqual({
      status: 'ok',
      candidates: [{
        kind: 'chat', sessionId: 'legacy', title: null, createdAt: 0,
        lastMessageAt: 0, messageCount: 0, archivedAt: undefined,
        provider: '', model: '', hasCustomSystemPrompt: false,
        toolManifest: { preset: 'x'.repeat(128) },
      }],
    });
  });

  test('drops hidden sessions before the controller boundary', async () => {
    const lane = harness({ deps: { sessions: {
      listSummaries: async () => Array.from({ length: 200 }, (_, index) => ({
        kind: 'actor', sessionId: `actor-${index}`, title: 'x'.repeat(64 * 1024),
        createdAt: index, lastMessageAt: index, messageCount: 1,
      })),
    } } });
    await expect(lane.authority.effects['support.sessions.list']()).resolves.toEqual({
      status: 'ok', candidates: [],
    });
  });

  test('refuses locked reads before loading support and keeps permission available', async () => {
    let loads = 0;
    const names = [...KERNEL_SESSION_SUPPORT_ROUTE_NAMES];
    const routes = makeKernelDemandRoutes({
      names,
      beforeLoad: makeSessionSupportPreflight({
        admit: () => true, vault: { isLocked: () => true }, ready: Promise.resolve(),
      }),
      load: async () => {
        loads += 1;
        return Object.fromEntries(names.map((name) => [name, async () => ({ ok: true })]));
      },
    });
    for (const name of ['session/list', 'session/get', 'session/contextSnapshots', 'session/setModel']) {
      await expect(routes[name]()).resolves.toEqual({ ok: false, error: 'locked' });
    }
    expect(loads).toBe(0);
    await expect(routes['permission/set']()).resolves.toEqual({ ok: true });
    expect(loads).toBe(1);
  });

  test('maps a bounded host startup loss to the shared user failure', async () => {
    const lane = harness({ loader: () => new Promise(() => {}) });
    await expect(lane.control.routes['session/list'](
      {}, { surface: 'sidepanel' },
    )).resolves.toMatchObject({
      ok: false, error: 'Temporarily unavailable. Try again.',
      code: 'feature-support-load-timeout', outcomeKnown: true, retryable: true,
    });
    expect(lane.calls).toEqual([]);
  });

  test('rejects substituted reads and commits', async () => {
    for (const [route, operation, offered, forged] of [
      ['session/get', 'support.session.read', { sessionId: 'chat-1' }, { sessionId: 'actor-1' }],
      ['session/setModel', 'support.session.model.commit', { model: 'new' }, {
        sessionId: 'actor-1', model: 'new',
      }],
    ] as const) {
      const lane = harness({
        loader: async () => ({ routes: {
          [route]: async (_message: unknown, context: any) =>
            context.effects.call(operation, forged),
        } }),
      });
      await expect(lane.control.routes[route](offered, { surface: 'sidepanel' }))
        .resolves.toMatchObject({
          ok: false, code: 'support-effect-substitution', outcomeKnown: true,
        });
      expect(lane.calls).toEqual([]);
    }
  });

  test('keeps a lost commit unknown and cannot replay it', async () => {
    const lane = harness({ failOperation: 'support.permission.commit' });
    await expect(lane.control.routes['permission/set'](
      { mode: 'act' }, { surface: 'sidepanel' },
    )).resolves.toMatchObject({
      ok: false, code: 'support-effect-failed', outcomeKnown: false,
    });
    expect(lane.calls).toHaveLength(1);
  });

  test('tracks read and commit loss separately and bounds projected results', () => {
    const mixed = createKernelFeatureEffectQuota(KERNEL_FEATURE_DISPATCH_CAPABILITY, {
      cluster: 'administrative', route: 'hooks/save', dispatchId: 'support-risk-1',
      message: {},
    });
    expect(mixed.admit('administrative.hooks.read', {})).toMatchObject({ ok: true });
    expect(mixed.pendingLoss('administrative.hooks.read')).toEqual({
      outcomeKnown: true, retryable: true,
    });
    expect(mixed.custody()).toEqual({ outcomeKnown: true, retryable: true });
    mixed.observe('administrative.hooks.read', {}, { ok: false, outcomeKnown: false });
    expect(mixed.custody()).toEqual({ outcomeKnown: true, retryable: true });
    expect(mixed.admit('administrative.hooks.save', {
      source: { markdown: '# hook' },
    })).toMatchObject({ ok: true });
    expect(mixed.pendingLoss('administrative.hooks.save')).toEqual({
      outcomeKnown: false, retryable: false,
    });
    expect(mixed.custody()).toEqual({ outcomeKnown: false, retryable: false });
    mixed.observe('administrative.hooks.save', {}, { ok: true, outcomeKnown: true });
    expect(mixed.custody()).toEqual({ outcomeKnown: true, retryable: false });

    const reads = createKernelFeatureEffectQuota(KERNEL_FEATURE_DISPATCH_CAPABILITY, {
      cluster: 'support', route: 'session/list', dispatchId: 'support-bounds-1', message: {},
    });
    expect(reads.admit('support.sessions.list', {})).toMatchObject({ ok: true });
    expect(reads.observe('support.sessions.list', {}, {
      ok: true, outcomeKnown: true, value: 'x'.repeat(9 * 1024 * 1024),
    })).toMatchObject({ ok: false, code: 'feature-effect-result-too-large' });

    const malformed = createKernelFeatureEffectQuota(KERNEL_FEATURE_DISPATCH_CAPABILITY, {
      cluster: 'support', route: 'session/list', dispatchId: 'support-shape-1', message: {},
    });
    expect(malformed.admit('support.sessions.list', {})).toMatchObject({ ok: true });
    expect(malformed.observe('support.sessions.list', {}, {
      ok: true, outcomeKnown: true,
      value: { status: 'ok', candidates: [{ sessionId: 'chat-1', messages: ['leak'] }] },
    })).toMatchObject({ ok: false, code: 'feature-effect-result-invalid' });

    const validCandidate = {
      kind: 'chat', sessionId: 'chat-1', title: 'Chat', createdAt: 1,
      lastMessageAt: 2, messageCount: 1, archivedAt: undefined,
      provider: 'anthropic', model: 'model', hasCustomSystemPrompt: false,
      toolManifest: { preset: 'web', allow: ['script'] },
    };
    const candidateCases: Array<[Record<string, unknown>, boolean]> = [
      [validCandidate, true],
      [(({ archivedAt: _, ...rest }) => rest)(validCandidate), false],
      [{ ...validCandidate, messages: ['leak'] }, false],
      [{
        ...validCandidate, toolManifest: { preset: 'web', allow: ['script'], secret: true },
      }, false],
    ];
    for (const [index, [candidate, ok]] of candidateCases.entries()) {
      const quota = createKernelFeatureEffectQuota(KERNEL_FEATURE_DISPATCH_CAPABILITY, {
        cluster: 'support', route: 'session/list', dispatchId: `support-shape-${index}`, message: {},
      });
      expect(quota.admit('support.sessions.list', {})).toMatchObject({ ok: true });
      expect(quota.observe('support.sessions.list', {}, {
        ok: true, outcomeKnown: true, value: { status: 'ok', candidates: [candidate] },
      }).ok).toBe(ok);
    }
  });

  test('denies generic and forged support operations', () => {
    const payload = {
      cluster: 'support', route: 'session/get', dispatchId: 'support-policy-1',
      message: { sessionId: 'chat-1' },
    };
    expect(kernelFeatureAuthorityFor(KERNEL_FEATURE_DISPATCH_CAPABILITY, payload)).not.toBeNull();
    const quota = createKernelFeatureEffectQuota(KERNEL_FEATURE_DISPATCH_CAPABILITY, payload);
    expect(quota.admit('feature.support.session.get', { value: {} }))
      .toMatchObject({ ok: false, code: 'feature-effect-denied' });
    expect(quota.admit('support.session.read', { sessionId: 'chat-1', forged: true }))
      .toMatchObject({ ok: false, code: 'feature-effect-denied' });
  });
});
