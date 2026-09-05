import { describe, test, expect } from 'bun:test';
import { makeContactsRoutes } from '../../extension/background/routes/contacts.js';
import { dispatchContactSemanticRoute } from '../../extension/offscreen/semantic-routes/contacts.js';

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
  test('sealed contact writes require a did', async () => {
    expect(await dispatchContactSemanticRoute('contacts/set', {}, {
      kernelCall: async () => ({ ok: true }),
    })).toEqual({ ok: false, error: 'did-required' });
  });
  test('sealed contact writes pass only present fields (omitted left untouched)', async () => {
    let received: any;
    await dispatchContactSemanticRoute('contacts/set', { did: 'd1', name: 'New' }, {
      kernelCall: async (_operation: string, payload: any) => {
        received = payload.patch;
        return { ok: true, value: { did: payload.did, ...payload.patch } };
      },
    });
    expect(received).toEqual({ name: 'New' });
  });
  test('sealed forget maps an unknown contact to contact-not-found', async () => {
    expect(await dispatchContactSemanticRoute('contacts/forget', { did: 'nope' }, {
      kernelCall: async () => ({ ok: true, value: false }),
    })).toEqual({ ok: false, error: 'contact-not-found' });
  });
  test('lost sealed contact effects are unknown and never expose storage details', async () => {
    const raw = 'private-idb-transaction-42';
    const kernelCall = async () => { throw new Error(raw); };
    const setReply = await dispatchContactSemanticRoute(
      'contacts/set', { did: 'd1', name: 'A' }, { kernelCall },
    );
    expect(setReply).toMatchObject({
      ok: false, code: 'contact-set-outcome-unknown', outcomeKnown: false,
      outcomeKind: 'unknown', retryable: false,
    });
    expect(setReply.error).not.toContain(raw);

    const forgetReply = await dispatchContactSemanticRoute(
      'contacts/forget', { did: 'd1' }, { kernelCall },
    );
    expect(forgetReply).toMatchObject({
      ok: false, code: 'contact-forget-outcome-unknown', outcomeKnown: false,
      retryable: false,
    });
    expect(forgetReply.error).not.toContain(raw);
  });
});
