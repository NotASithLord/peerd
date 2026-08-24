import { describe, expect, test } from 'bun:test';
import {
  createKernelSessionReader,
  kernelToolManifestLabel,
  makeKernelSessionRoutes,
} from '../../extension/background/kernel-session-reader.js';
import { manifestLabel } from '../../extension/peerd-runtime/tools/manifests.js';

describe('native kernel session reader', () => {
  test('assembles legacy and v2 records without importing or invoking mutation verbs', async () => {
    const stores: Record<string, any[]> = {
      sessions: [
        { sessionId: 'old', createdAt: 1, messages: [{ id: 'o', when: 2 }] },
        { sessionId: 'new', createdAt: 3, messagesV2: true,
          msgIndex: ['m2', 'missing', 'm1'], latestNonSyntheticUserMessageId: 'm2' },
      ],
      session_messages: [
        { id: 'm1', sessionId: 'new', message: { id: 'm1', when: 4 } },
        { id: 'm2', sessionId: 'new', message: {
          id: 'm2', when: 5, role: 'user', content: 'Build it',
        } },
      ],
    };
    const writes: string[] = [];
    const idb = {
      get: async (store: string, key: string) => stores[store]?.find((row) =>
        row.sessionId === key || row.id === key),
      getAll: async (store: string) => [...(stores[store] ?? [])],
      getMany: async (store: string, keys: string[]) => keys.map((key) =>
        stores[store]?.find((row) => row.id === key)),
      patch: async (store: string, key: string, fields: Record<string, unknown>) => {
        writes.push(`patch:${store}:${key}`);
        const row = stores[store]?.find((candidate) => candidate.sessionId === key);
        if (!row) return undefined;
        Object.assign(row, fields);
        return row;
      },
      put: async () => { writes.push('put'); },
    };
    const reader = createKernelSessionReader(idb);
    expect((await reader.get('new')).messages.map((message: any) => message.id))
      .toEqual(['m2', 'm1']);
    const listed = await reader.list();
    expect(listed.map((session: any) => session.sessionId)).toEqual(['new', 'old']);
    expect(listed[0].messages.map((message: any) => message.id)).toEqual(['m2', 'm1']);
    expect(listed[1]).toMatchObject({ kind: 'chat', depth: 0 });
    expect(await reader.getMetadata('new')).toEqual({
      sessionId: 'new', createdAt: 3, kind: 'chat', depth: 0,
    });
    expect(writes).toEqual([]);
  });

  test('matches canonical manifest labels without loading the manifest feature in production', () => {
    const values = [
      undefined, null, 'bad', {}, { allow: [] }, { allow: ['a'] },
      { preset: ' research ', allow: ['a', '', 3] },
    ];
    for (const value of values) {
      expect(kernelToolManifestLabel(value), JSON.stringify(value)).toBe(manifestLabel(value));
    }
  });

  test('counts only durable real user messages as prior onboarding history', async () => {
    const sessions: any[] = [];
    const messages: any[] = [];
    const reader = createKernelSessionReader({
      get: async (store: string, key: string) => (store === 'session_messages'
        ? messages.find((row) => row.id === key)
        : sessions.find((row) => row.sessionId === key)),
      getAll: async (store: string) => store === 'sessions' ? sessions : messages,
    });
    sessions.push({ sessionId: 'empty', messagesV2: true, msgIndex: [] });
    expect(await reader.hasChat()).toBe(false);
    sessions.push({
      sessionId: 'actor', kind: 'actor', messages: [{ role: 'user', content: 'daemon' }],
    });
    sessions.push({
      sessionId: 'synthetic', messages: [{ role: 'user', content: 'seed', synthetic: true }],
    });
    expect(await reader.hasChat()).toBe(false);
    sessions.push({
      sessionId: 'v2', messagesV2: true, latestNonSyntheticUserMessageId: 'real',
    });
    messages.push({
      id: 'real', sessionId: 'v2', message: { role: 'user', content: 'hello' },
    });
    expect(await reader.hasChat()).toBe(true);
    messages[0].message.content = '   ';
    sessions.push({ sessionId: 'legacy', messages: [{ role: 'user', content: 'legacy' }] });
    expect(await reader.hasChat()).toBe(true);
  });

  test('keeps list/get usable without a feature host and rejects protected reads while locked', async () => {
    let reads = 0;
    const sessions = {
      list: async () => { reads += 1; return [{ sessionId: 'chat', createdAt: 1, messages: [] }]; },
      get: async (id: string) => { reads += 1; return id === 'chat'
        ? { sessionId: id, createdAt: 1, messages: [] } : undefined; },
    };
    const locked = makeKernelSessionRoutes({ vault: { isLocked: () => true }, sessions });
    await expect(locked['session/list']()).resolves.toEqual({ ok: false, error: 'locked' });
    await expect(locked['session/get']({ sessionId: 'chat' })).resolves.toEqual({ ok: false, error: 'locked' });
    expect(reads).toBe(0);

    const routes = makeKernelSessionRoutes({ vault: { isLocked: () => false }, sessions });
    await expect(routes['session/list']()).resolves.toMatchObject({ ok: true, sessions: [{ sessionId: 'chat' }] });
    await expect(routes['session/get']({ sessionId: 'chat' })).resolves.toMatchObject({ ok: true, session: { sessionId: 'chat' } });
    await expect(routes['session/get']({ sessionId: 'missing' })).resolves.toEqual({ ok: false, error: 'session-not-found' });
    await expect(routes['session/contextSnapshots']({ sessionId: 'chat' }))
      .resolves.toEqual({ ok: true, snapshots: [] });
    const withSnapshots = makeKernelSessionRoutes({
      vault: { isLocked: () => false }, sessions,
      contextSnapshots: { snapshotsFor: (id: string) => [{ id, seq: 1 }] },
    });
    await expect(withSnapshots['session/contextSnapshots']({ sessionId: 'chat' }))
      .resolves.toEqual({ ok: true, snapshots: [{ id: 'chat', seq: 1 }] });
  });

  test('atomically changes one session model with bounded validation and no feature host', async () => {
    const rows = new Map([['chat', {
      sessionId: 'chat', provider: 'anthropic', model: 'old', title: 'keep', createdAt: 1,
    }]]);
    const patches: any[] = [];
    const audits: any[] = [];
    const sessions = createKernelSessionReader({
      get: async (_store: string, key: string) => rows.get(key),
      getAll: async () => [...rows.values()],
      patch: async (store: string, key: string, fields: Record<string, unknown>) => {
        patches.push({ store, key, fields });
        const current = rows.get(key);
        if (!current) return undefined;
        const updated = { ...current, ...fields };
        rows.set(key, updated);
        return updated;
      },
    });
    const routes = makeKernelSessionRoutes({
      vault: { isLocked: () => false }, sessions,
      ready: Promise.resolve(),
      sessionCache: { sessionGet: async () => 'chat' },
      auditLog: { append: async (event: any) => { audits.push(event); } },
    });
    await expect(routes['session/setModel']({ model: `  ${'m'.repeat(240)}  ` }))
      .resolves.toEqual({ ok: true, model: 'm'.repeat(200) });
    expect(patches).toEqual([{ store: 'sessions', key: 'chat', fields: { model: 'm'.repeat(200) } }]);
    expect(rows.get('chat')).toMatchObject({ title: 'keep', provider: 'anthropic', model: 'm'.repeat(200) });
    await Promise.resolve();
    expect(audits).toEqual([{
      type: 'session_model_changed', sessionId: 'chat', details: { model: 'm'.repeat(200) },
    }]);

    await expect(routes['session/setModel']({ sessionId: 'missing', model: 'next' }))
      .resolves.toEqual({ ok: false, error: 'session-not-found' });
    await expect(routes['session/setModel']({ model: '  ' }))
      .resolves.toEqual({ ok: false, error: 'invalid-model' });
    const noCurrent = makeKernelSessionRoutes({
      vault: { isLocked: () => false }, sessions,
      sessionCache: { sessionGet: async () => null },
    });
    await expect(noCurrent['session/setModel']({ model: 'next' }))
      .resolves.toEqual({ ok: false, error: 'no-session' });
    const locked = makeKernelSessionRoutes({
      vault: { isLocked: () => true }, sessions,
      sessionCache: { sessionGet: async () => 'chat' },
    });
    await expect(locked['session/setModel']({ model: 'next' }))
      .resolves.toEqual({ ok: false, error: 'locked' });
    expect(patches).toHaveLength(2);
  });

  test('persists permission posture without a host and preserves unknown mutation custody', async () => {
    const rows = new Map([['chat', {
      sessionId: 'chat', createdAt: 1, permissionMode: 'act', confirmActions: false,
    }]]);
    const cache = new Map<string, any>([['currentSessionId', 'chat']]);
    const audits: any[] = [];
    let pushes = 0;
    const sessions = createKernelSessionReader({
      get: async (_store: string, key: string) => rows.get(key),
      getAll: async () => [...rows.values()],
      patch: async (_store: string, key: string, fields: Record<string, unknown>) => {
        const current = rows.get(key);
        if (!current) return undefined;
        const updated = { ...current, ...fields };
        rows.set(key, updated);
        return updated;
      },
    });
    const routes = makeKernelSessionRoutes({
      vault: { isLocked: () => false }, sessions,
      sessionCache: {
        sessionGet: async (key: string) => cache.get(key),
        sessionSet: async (key: string, value: any) => { cache.set(key, value); },
      },
      auditLog: { append: async (event: any) => { audits.push(event); } },
      resolvePermission: (session: any, mode: unknown, confirm: unknown) => ({
        mode: (session?.permissionMode ?? mode) === 'act' ? 'act' : 'plan',
        confirmActions: session?.confirmActions ?? confirm !== false,
      }),
      pushState: async () => { pushes += 1; },
    });
    await expect(routes['permission/set']({ mode: 'plan', confirmActions: true }))
      .resolves.toEqual({ ok: true, permission: { mode: 'plan', confirmActions: true } });
    expect(Object.fromEntries(cache)).toMatchObject({
      currentSessionId: 'chat', currentPermissionMode: 'plan', currentConfirmActions: true,
    });
    expect(rows.get('chat')).toMatchObject({ permissionMode: 'plan', confirmActions: true });
    await Promise.resolve();
    expect(pushes).toBe(1);
    expect(audits.at(-1)).toMatchObject({
      type: 'mode_changed', sessionId: 'chat',
      details: { mode: 'plan', confirmActions: true },
    });
    await expect(routes['permission/set']({})).resolves
      .toEqual({ ok: false, error: 'no-mode-or-confirm' });

    const failing = makeKernelSessionRoutes({
      vault: { isLocked: () => true }, sessions,
      sessionCache: {
        sessionGet: async (key: string) => cache.get(key),
        sessionSet: async () => { throw new Error('storage-session-lost'); },
      },
    });
    const error = await failing['permission/set']({ mode: 'act' })
      .then(() => null, (cause: any) => cause);
    expect(error).toMatchObject({ message: 'storage-session-lost', outcomeKnown: false, retryable: false });
  });

});
