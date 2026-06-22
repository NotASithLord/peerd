import { describe, test, expect } from 'bun:test';
import { makeMemoryRoutes } from '../../extension/background/routes/memory.js';
import { makeContactsRoutes } from '../../extension/background/routes/contacts.js';

// memory + contacts route groups — moved verbatim. Pin the vault gate, the
// user-origin write contract, and the approve-before-resolve ordering.

const USER_DOC_SCOPE = { kind: 'user' };

describe('memory routes', () => {
  const deps = (over: any = {}) => ({
    vault: { isLocked: () => false },
    auditLog: { append: async () => {} },
    memory: {
      exportAll: async () => ({ docs: [] }),
      deleteAll: async () => ({ deleted: 2 }),
      writeWithConfirm: async () => ({ ok: true, op: 'write', id: 'm1' }),
      deleteScope: async () => ({ ok: true, op: 'delete', id: 'm1' }),
      readScope: async () => ({ body: 'prior' }),
    },
    memorySuggestions: {
      listPending: async () => [{ id: 's1', text: 't' }],
      get: async (id: string) => (id === 's1' ? { id, text: 'note', sessionId: 'sess' } : null),
      resolve: async () => ({ ok: true, suggestion: { sessionId: 'sess' } }),
    },
    runInit: async () => {},
    postChatNote: () => {},
    USER_DOC_SCOPE,
    appendNoteToUserDoc: (prior: string, note: string) => `${prior}\n- ${note}`,
    pushState: () => {},
    profileState: { completeOnboarding: async ({ peerName }: any) => ({ id: 'default', peerName, onboardingComplete: true }) },
    seedUserDocBody: (facts: any) => (facts && Object.keys(facts).length ? `# facts\n${JSON.stringify(facts)}` : ''),
    ...over,
  });

  test('all reads refused when locked', async () => {
    const r = makeMemoryRoutes(deps({ vault: { isLocked: () => true } }));
    expect(await r['memory/export']()).toEqual({ ok: false, error: 'vault-locked' });
    expect(await r['memory/suggestions']()).toEqual({ ok: false, error: 'vault-locked' });
    expect(await r['memory/write']({ scope: USER_DOC_SCOPE, body: 'x' })).toEqual({ ok: false, error: 'vault-locked' });
  });
  test('write rejects a bad scope', async () => {
    const r = makeMemoryRoutes(deps());
    expect(await r['memory/write']({ scope: {}, body: 'x' })).toEqual({ ok: false, error: 'bad-scope' });
  });
  test('write returns op + id on success', async () => {
    const r = makeMemoryRoutes(deps());
    expect(await r['memory/write']({ scope: USER_DOC_SCOPE, body: 'x' })).toEqual({ ok: true, op: 'write', id: 'm1' });
  });
  test('suggestions/approve appends to user doc then resolves', async () => {
    const order: string[] = [];
    const r = makeMemoryRoutes(deps({
      memory: {
        readScope: async () => ({ body: 'prior' }),
        writeWithConfirm: async ({ body }: any) => { order.push(`write:${body}`); return { ok: true }; },
      },
      memorySuggestions: {
        get: async () => ({ id: 's1', text: 'note', sessionId: 'sess' }),
        resolve: async () => { order.push('resolve'); return { ok: true }; },
      },
    }));
    expect(await r['memory/suggestions/approve']({ id: 's1' })).toEqual({ ok: true });
    expect(order).toEqual(['write:prior\n- note', 'resolve']);
  });
  test('suggestions/approve keeps suggestion pending if the write fails', async () => {
    let resolved = false;
    const r = makeMemoryRoutes(deps({
      memory: { readScope: async () => ({ body: '' }), writeWithConfirm: async () => ({ ok: false, reason: 'denied' }) },
      memorySuggestions: { get: async () => ({ id: 's1', text: 'n' }), resolve: async () => { resolved = true; return { ok: true }; } },
    }));
    expect(await r['memory/suggestions/approve']({ id: 's1' })).toEqual({ ok: false, error: 'denied' });
    expect(resolved).toBe(false);
  });
  test('suggestions/approve unknown id → not-found', async () => {
    const r = makeMemoryRoutes(deps({ memorySuggestions: { get: async () => null } }));
    expect(await r['memory/suggestions/approve']({ id: 'ghost' })).toEqual({ ok: false, error: 'not-found' });
  });

  test('onboarding/complete latches the profile + seeds the user doc when facts given', async () => {
    let wrote: any = null;
    const r = makeMemoryRoutes(deps({
      memory: { readScope: async () => ({ body: '' }), writeWithConfirm: async (a: any) => { wrote = a; return { ok: true }; } },
    }));
    const res = await r['onboarding/complete']({ peerName: 'Ada', facts: { role: 'dev' } });
    expect(res).toEqual({ ok: true, profile: { id: 'default', peerName: 'Ada', onboardingComplete: true } });
    expect(wrote).toMatchObject({ scope: USER_DOC_SCOPE, origin: 'user' });
  });
  test('onboarding/complete with no facts writes no memory (skip path)', async () => {
    let wrote = false;
    const r = makeMemoryRoutes(deps({
      memory: { readScope: async () => ({ body: '' }), writeWithConfirm: async () => { wrote = true; return { ok: true }; } },
    }));
    const res = await r['onboarding/complete']({ peerName: 'Ada', facts: null });
    expect(res.ok).toBe(true);
    expect(wrote).toBe(false);
  });
  test('onboarding/complete refused when locked', async () => {
    const r = makeMemoryRoutes(deps({ vault: { isLocked: () => true } }));
    expect(await r['onboarding/complete']({ peerName: 'Ada' })).toEqual({ ok: false, error: 'vault-locked' });
  });
});

describe('contacts routes', () => {
  const deps = (over: any = {}) => ({
    vault: { isLocked: () => false },
    auditLog: { list: async () => [] },
    contacts: {
      list: async () => [{ did: 'd1', name: 'A' }],
      upsert: async (did: string, patch: any) => ({ did, ...patch }),
      remove: async (did: string) => did === 'd1',
    },
    appRegistry: { list: async () => [] },
    mergeContacts: ({ saved }: any) => saved,
    ...over,
  });
  test('list refused when locked', async () => {
    const r = makeContactsRoutes(deps({ vault: { isLocked: () => true } }));
    expect(await r['contacts/list']()).toEqual({ ok: false, error: 'vault-locked' });
  });
  test('list feeds ALL THREE sources (saved + installed apps + audit) into mergeContacts', async () => {
    // Non-tautological: distinct inputs + a merge fake that reports what it received,
    // so dropping any source (or not calling a collaborator) would fail.
    let received: any = null;
    const r = makeContactsRoutes(deps({
      contacts: { list: async () => [{ did: 'd1' }] },
      appRegistry: { list: async () => [{ id: 'app1', dweb: { publisher: 'd2' } }] },
      auditLog: { list: async () => [{ type: 'dweb_app_installed', details: { publisher: 'd3' } }] },
      mergeContacts: (sources: any) => { received = sources; return [{ did: 'merged' }]; },
    }));
    const res = await r['contacts/list']();
    expect(res).toEqual({ ok: true, contacts: [{ did: 'merged' }] });
    expect(received.saved).toEqual([{ did: 'd1' }]);
    expect(received.installedApps).toEqual([{ id: 'app1', dweb: { publisher: 'd2' } }]);
    expect(received.auditEntries).toEqual([{ type: 'dweb_app_installed', details: { publisher: 'd3' } }]);
  });
  test('set requires a did', async () => {
    const r = makeContactsRoutes(deps());
    expect(await r['contacts/set']({})).toEqual({ ok: false, error: 'did-required' });
  });
  test('set passes only present fields (omitted left untouched)', async () => {
    let received: any;
    const r = makeContactsRoutes(deps({ contacts: { upsert: async (_d: string, patch: any) => { received = patch; return { ok: 1 }; } } }));
    await r['contacts/set']({ did: 'd1', name: 'New' });
    expect(received).toEqual({ name: 'New' });
  });
  test('forget unknown contact → contact-not-found', async () => {
    const r = makeContactsRoutes(deps());
    expect(await r['contacts/forget']({ did: 'nope' })).toEqual({ ok: false, error: 'contact-not-found' });
  });
});
