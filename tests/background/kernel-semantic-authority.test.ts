import { describe, expect, test } from 'bun:test';
import { createKernelSemanticAuthority } from '../../extension/background/kernel-semantic-authority.js';
import { createKernelContactsAuthority } from '../../extension/background/kernel-contacts-authority.js';
import { createContactsStore } from '../../extension/peerd-runtime/contacts/store.js';

describe('native local authority boundary', () => {
  const makeAuthority = (overrides: Record<string, any> = {}) =>
    createKernelSemanticAuthority({
      idb: {
        get: async () => undefined, getAll: async () => [],
        put: async () => {}, del: async () => {},
        transact: async () => ({ ok: true }),
        ...overrides.idb,
      },
      kv: overrides.kv ?? { get: async () => null, set: async () => {} },
      auditLog: overrides.auditLog ?? { list: async () => [], append: async () => {} },
      vault: overrides.vault ?? { isLocked: () => false, getSecret: async () => null },
      ready: Promise.resolve(),
      now: overrides.now,
    });

  const call = (authority: any, operation: string, route: string, payload: any = {}) =>
    authority.handle(operation, payload, {
      authority: { target: `semantic:${route}:first-party` },
    });

  test('exposes only the reverse-call authority', () => {
    const authority = makeAuthority();
    expect(Object.keys(authority)).toEqual(['handle']);
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
    const compact = createKernelContactsAuthority({ idb: compactIdb, now });
    const did = 'did:key:z6MkCanonicalPeer';
    const patch = {
      name: '  Alice   Example  ', notes: 'n'.repeat(1_100),
      tags: [' one ', 'one', 'two'], favorite: true,
    };
    const expected = await canonical.upsert(did, patch);
    await expect(compact.upsert(did, patch)).resolves.toEqual(expected);
    expect(compactIdb.contacts.get(did)).toEqual(expected);
  });

  test('provider status reads only its fixed key posture and never exposes a secret', async () => {
    const reads: string[] = [];
    const authority = makeAuthority({
      vault: { isLocked: () => false, getSecret: async (name: string) => {
        reads.push(name);
        return name === 'anthropic_api_key' ? 'sk-ant-secret-value' : null;
      } },
    });
    const result = await call(authority, 'semantic.providers.key-status', 'provider/status');
    expect(result.value.anthropic)
      .toMatchObject({ hasKey: true, keyPreview: 'sk-ant-…lue · 19 chars' });
    expect(result.value.openrouter).toEqual({ hasKey: false, keyPreview: null });
    expect(reads).toEqual([
      'anthropic_api_key', 'openrouter_api_key', 'openai_api_key', 'glm_api_key',
    ]);
    expect(JSON.stringify(result)).not.toContain('secret-value');
  });

  test('refuses operations whose custody moved fully into the kernel', async () => {
    const authority = makeAuthority();
    for (const [operation, route] of [
      ['semantic.contacts.list-saved', 'contacts/list'],
      ['semantic.contacts.upsert', 'contacts/set'],
      ['semantic.toolbox.read-body', 'toolbox/read'],
      ['semantic.skills.list', 'skills/list'],
      ['semantic.memory.export', 'memory/export'],
    ]) {
      await expect(call(authority, operation, route)).resolves.toEqual({
        ok: false, code: 'semantic-kernel-operation-denied', outcomeKnown: true,
      });
    }
  });
});
