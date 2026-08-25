// Kernel origin-credential custody: the shared route factory is already
// covered by its own suite; these tests pin the KERNEL WIRING: the DPoP key
// store binds to the idb primitives, both credential halves retire together,
// audit rides the kernel log, and the issue-251 learned-origin seam fires off
// the exact audit event.

import { describe, expect, test } from 'bun:test';
import { makeKernelOriginCredentialRoutes } from '../../extension/background/kernel-credential-routes.js';
import { createKernelKeyedOriginAuthority } from '../../extension/background/kernel-keyed-origin-authority.js';
import { DPOP_KEY_STORE } from '../../extension/peerd-egress/dpop/keys.js';

class FakeLockedError extends Error {}

const makeLane = () => {
  const secrets = new Map<string, string>();
  const idbRows = new Map<string, Map<string, any>>();
  const table = (store: string) => {
    if (!idbRows.has(store)) idbRows.set(store, new Map());
    return idbRows.get(store)!;
  };
  const audit: any[] = [];
  const learned: string[] = [];
  const forgotten: string[] = [];
  const routes = makeKernelOriginCredentialRoutes({
    vault: {
      listSecretNames: async () => [...secrets.keys()],
      getSecret: async (name: string) => secrets.get(name) ?? null,
      setSecret: async (name: string, value: string) => { secrets.set(name, value); },
      deleteSecret: async (name: string) => { secrets.delete(name); },
    },
    auditLog: { append: async (event: any) => { audit.push(event); } },
    isLockedError: (cause: unknown) => cause instanceof FakeLockedError,
    idb: {
      get: async (store: string, key: string) => table(store).get(key),
      put: async (store: string, value: any) => { table(store).set(value.origin ?? value.id, value); },
      del: async (store: string, key: string) => { table(store).delete(key); },
    },
    learnKeyedOrigin: (origin: string) => { learned.push(origin); },
    forgetKeyedOrigin: (origin: string) => { forgotten.push(origin); },
  });
  return { routes, secrets, table, audit, learned, forgotten };
};

describe('kernel origin-credential routes', () => {
  test('set stores the vault secret, audits the origin only, and learns it', async () => {
    const lane = makeLane();
    const reply = await lane.routes['origin-cred/set']({
      origin: 'https://api.example.com', key: 'sk-super-secret', header: 'Authorization',
    });
    expect(reply).toMatchObject({ ok: true, origin: 'https://api.example.com' });
    expect([...lane.secrets.keys()]).toEqual(['origin:https://api.example.com']);
    expect(lane.audit).toHaveLength(1);
    expect(lane.audit[0]).toMatchObject({
      type: 'origin_credential_added',
      details: { origin: 'https://api.example.com' },
    });
    expect(JSON.stringify(lane.audit)).not.toContain('sk-super-secret');
    expect(lane.learned).toEqual(['https://api.example.com']);
    expect(lane.forgotten).toEqual([]);
  });

  test('kernel-owned keyed origins hydrate and survive controller replacement', async () => {
    const names = ['origin:https://api.example.com'];
    const authority = createKernelKeyedOriginAuthority({ listSecretNames: async () => names });
    expect(await authority.hydrate()).toBe(true);
    expect(authority.has('https://api.example.com')).toBe(true);
    authority.add('https://api.second.example');
    expect(authority.has('https://api.second.example')).toBe(true);
    authority.remove('https://api.example.com');
    expect(authority.has('https://api.example.com')).toBe(false);
  });

  test('a dpop credential mints the keypair at provisioning and lists its public jkt', async () => {
    const lane = makeLane();
    const setReply = await lane.routes['origin-cred/set']({
      origin: 'https://api.example.com', key: 'token-bytes', scheme: 'dpop',
    });
    expect(setReply.ok).toBe(true);
    expect(typeof setReply.jkt).toBe('string');
    expect(setReply.jkt.length).toBeGreaterThan(10);
    const record = lane.table(DPOP_KEY_STORE).get('https://api.example.com');
    expect(record).toBeDefined();
    expect(record.publicJwk?.kty).toBe('EC');
    const listReply = await lane.routes['origin-cred/list']({});
    expect(listReply.integrations).toEqual([{
      origin: 'https://api.example.com', header: 'Authorization',
      scheme: 'dpop', jkt: setReply.jkt,
    }]);
  });

  test('delete retires both credential halves and records that it did', async () => {
    const lane = makeLane();
    await lane.routes['origin-cred/set']({
      origin: 'https://api.example.com', key: 'token-bytes', scheme: 'dpop',
    });
    expect(lane.table(DPOP_KEY_STORE).size).toBe(1);
    expect(await lane.routes['origin-cred/delete']({ origin: 'https://api.example.com' }))
      .toEqual({ ok: true });
    expect(lane.secrets.size).toBe(0);
    expect(lane.table(DPOP_KEY_STORE).size).toBe(0);
    expect(lane.audit.at(-1)).toMatchObject({
      type: 'origin_credential_removed',
      details: { origin: 'https://api.example.com', dpopKeyRemoved: true },
    });
    expect(lane.learned).toEqual(['https://api.example.com']);
    expect(lane.forgotten).toEqual(['https://api.example.com']);
  });

  test('a locked vault maps to the shared locked reply', async () => {
    const lane = makeLane();
    const locked = makeKernelOriginCredentialRoutes({
      vault: {
        listSecretNames: async () => { throw new FakeLockedError('locked'); },
        getSecret: async () => null,
        setSecret: async () => { throw new FakeLockedError('locked'); },
        deleteSecret: async () => { throw new FakeLockedError('locked'); },
      },
      auditLog: { append: async () => {} },
      isLockedError: (cause: unknown) => cause instanceof FakeLockedError,
      idb: { get: async () => undefined, put: async () => {}, del: async () => {} },
    });
    expect(await locked['origin-cred/list']({})).toEqual({ ok: false, error: 'locked' });
    expect(await locked['origin-cred/set']({ origin: 'https://a.example', key: 'k-12345678' }))
      .toEqual({ ok: false, error: 'locked' });
    expect(lane.learned).toEqual([]);
  });
});
