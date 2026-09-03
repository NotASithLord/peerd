import { describe, test, expect } from 'bun:test';
import { makeContactsRoutes } from '../../extension/background/routes/contacts.js';

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
  test('post-dispatch contact failures are unknown and never expose storage details', async () => {
    const raw = 'private-idb-transaction-42';
    const set = makeContactsRoutes(deps({
      contacts: { upsert: async () => { throw new Error(raw); } },
    }));
    const setReply = await set['contacts/set']({ did: 'd1', name: 'A' });
    expect(setReply).toMatchObject({
      ok: false, code: 'contact-set-outcome-unknown', outcomeKnown: false,
      outcomeKind: 'unknown', retryable: false,
    });
    expect(setReply.error).not.toContain(raw);

    const forget = makeContactsRoutes(deps({
      contacts: { remove: async () => { throw new Error(raw); } },
    }));
    const forgetReply = await forget['contacts/forget']({ did: 'd1' });
    expect(forgetReply).toMatchObject({
      ok: false, code: 'contact-forget-outcome-unknown', outcomeKnown: false,
      retryable: false,
    });
    expect(forgetReply.error).not.toContain(raw);
  });
});
