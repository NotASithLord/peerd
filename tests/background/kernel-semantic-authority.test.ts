import { describe, expect, test } from 'bun:test';
import {
  createKernelSemanticRoutes,
} from '../../extension/background/kernel-local-routes.js';
import { createContactsStore } from '../../extension/peerd-runtime/contacts/store.js';

describe('native local authority boundary', () => {
  test('common route surface is direct and contains no semantic bridge API', () => {
    const routes = createKernelSemanticRoutes({
      idb: {
        get: async () => undefined, getAll: async () => [],
        put: async () => {}, del: async () => {},
      },
      auditLog: { list: async () => [] },
      vault: { isLocked: () => false, getSecret: async () => null }, ready: Promise.resolve(),
    });
    expect(Object.keys(routes).sort()).toEqual([
      'contacts/forget', 'contacts/list', 'contacts/set',
      'provider/status', 'toolbox/read', 'toolbox/record',
    ]);
    expect(routes).not.toHaveProperty('handle');
    expect(routes).not.toHaveProperty('dispatch');
  });

  test('compact contact custody is byte-for-byte canonical', async () => {
    const makeIdb = () => {
      const contacts = new Map<string, any>();
      return {
        contacts,
        get: async (store: string, key: string) => store === 'contacts' ? contacts.get(key) : undefined,
        getAll: async (store: string) => store === 'contacts' ? [...contacts.values()] : [],
        put: async (_store: string, value: any) => { contacts.set(value.did, structuredClone(value)); },
        del: async (_store: string, key: string) => { contacts.delete(key); },
      };
    };
    const canonicalIdb = makeIdb();
    const compactIdb = makeIdb();
    const now = () => 42;
    const canonical = createContactsStore({ idb: canonicalIdb, now });
    const compact = createKernelSemanticRoutes({
      idb: compactIdb, auditLog: { list: async () => [] }, now,
      vault: { isLocked: () => false, getSecret: async () => null }, ready: Promise.resolve(),
    });
    const did = 'did:key:z6MkCanonicalPeer';
    const patch = {
      name: '  Alice   Example  ', notes: 'n'.repeat(1_100),
      tags: [' one ', 'one', 'two'], favorite: true,
    };
    const expected = await canonical.upsert(did, patch);
    await expect(compact['contacts/set']({ did, ...patch }))
      .resolves.toEqual({ ok: true, contact: expected });
    expect(compactIdb.contacts.get(did)).toEqual(expected);
  });

  test('locked contacts perform zero storage IO before returning', async () => {
    let io = 0;
    const routes = createKernelSemanticRoutes({
      idb: {
        get: async () => { io += 1; }, getAll: async () => { io += 1; return []; },
        put: async () => { io += 1; }, del: async () => { io += 1; },
      },
      auditLog: { list: async () => { io += 1; return []; } },
      vault: { isLocked: () => true, getSecret: async () => null }, ready: Promise.resolve(),
      now: () => 100,
    });
    await expect(routes['contacts/list']()).resolves.toEqual({ ok: false, error: 'vault-locked' });
    await expect(routes['contacts/set']({ did: 'did:key:z6MkNeverStored' }))
      .resolves.toEqual({ ok: false, error: 'vault-locked' });
    await expect(routes['contacts/forget']({ did: 'did:key:z6MkNeverStored' }))
      .resolves.toEqual({ ok: false, error: 'vault-locked' });
    expect(io).toBe(0);
  });

  test('provider status reads only its fixed key posture and never exposes a secret', async () => {
    const reads: string[] = [];
    const routes = createKernelSemanticRoutes({
      idb: {
        get: async () => undefined, getAll: async () => [],
        put: async () => {}, del: async () => {},
      },
      auditLog: { list: async () => [] }, ready: Promise.resolve(),
      vault: { isLocked: () => false, getSecret: async (name: string) => {
        reads.push(name);
        return name === 'anthropic_api_key' ? 'sk-ant-secret-value' : null;
      } },
    });
    const result = await routes['provider/status']();
    expect(result.ok).toBe(true);
    expect(result.providers.find((provider: any) => provider.name === 'anthropic'))
      .toMatchObject({ hasKey: true, keyPreview: 'sk-ant-…lue · 19 chars' });
    expect(result.providers.find((provider: any) => provider.name === 'openrouter'))
      .toMatchObject({ hasKey: false, keyPreview: null });
    expect(reads).toEqual([
      'anthropic_api_key', 'openrouter_api_key', 'openai_api_key', 'glm_api_key',
    ]);
    expect(JSON.stringify(result)).not.toContain('secret-value');
  });
});
