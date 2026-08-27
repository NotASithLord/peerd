import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXTENSION_DIR } from '../../packaging/lib.ts';
import { makeVaultAuthorityClient } from '../../extension/background/vault-authority-client.js';
import { serveVaultAuthority } from '../../extension/offscreen/vault-authority-runtime.js';
import {
  admitVaultAuthorityOffer,
  parseVaultAuthorityCall,
  parseVaultAuthorityStorageCall,
  VAULT_AUTHORITY_PROTOCOL,
  VAULT_AUTHORITY_CALL,
  VAULT_AUTHORITY_READY,
} from '../../extension/shared/vault-authority-protocol.js';

const offscreenUrl = 'chrome-extension://test/offscreen/offscreen.html';
const workerUrl = 'chrome-extension://test/offscreen/vault-authority-worker.js';
const vaultLease = Object.freeze({
  scope: 'vault-authority', leaseId: 'vault-lease-one', generation: 1,
  buildId: 'build-identity-one', kernelEpoch: 'kernel-epoch-one', hostEpoch: 'host-epoch-one',
});

const makeStorage = () => {
  const local = new Map<string, any>();
  const database = new Map<string, any>();
  const session = new Map<string, any>();
  return {
    local,
    database,
    session,
    kv: {
      get: async (key: string) => local.get(key),
      set: async (key: string, value: any) => { local.set(key, structuredClone(value)); },
      delete: async (key: string) => { local.delete(key); },
      list: async (prefix = '') => Object.fromEntries(
        [...local].filter(([key]) => key.startsWith(prefix)),
      ),
    },
    idb: {
      get: async (store: string, key: IDBValidKey) => database.get(`${store}:${String(key)}`),
      put: async (store: string, value: any) => {
        database.set(`${store}:${String(value.key)}`, structuredClone(value));
      },
      del: async (store: string, key: IDBValidKey) => {
        database.delete(`${store}:${String(key)}`);
      },
    },
    sessionCache: {
      sessionGet: async (key: string) => session.get(key),
      sessionSet: async (key: string, value: any) => { session.set(key, structuredClone(value)); },
      sessionDelete: async (key: string) => { session.delete(key); },
    },
  };
};

describe('sealed vault authority channel', () => {
  test('offscreen offer carries the exact host lease', async () => {
    const storage = makeStorage();
    const offers: any[] = [];
    let currentLease: any = vaultLease;
    const client = makeVaultAuthorityClient({
      offscreen: true,
      offscreenUrl,
      workerUrl,
      kv: storage.kv,
      idb: storage.idb,
      sessionCache: storage.sessionCache,
      withHost: async (operation) => operation(currentLease),
      listWindowClients: async () => [{
        url: offscreenUrl,
        postMessage: (offer: any, ports: MessagePort[]) => {
          offers.push(offer);
          void serveVaultAuthority({ port: ports[0], channelId: offer.channelId });
        },
      }],
    });

    await expect(client.status()).resolves.toMatchObject({ initialized: false, locked: true });
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      type: 'peerd/vault-authority-channel', protocol: 1, lease: vaultLease,
    });
    currentLease = { ...vaultLease, leaseId: 'vault-lease-two', generation: 2 };
    await client.status();
    expect(offers).toHaveLength(2);
    expect(offers[1].lease).toEqual(currentLease);
    client.close();
  });

  test('an unlocked vault resumes before the first call on a successor lease', async () => {
    const storage = makeStorage();
    let currentLease: any = vaultLease;
    const client = makeVaultAuthorityClient({
      offscreen: true,
      offscreenUrl,
      workerUrl,
      kv: storage.kv,
      idb: storage.idb,
      sessionCache: storage.sessionCache,
      withHost: async (operation) => operation(currentLease),
      listWindowClients: async () => [{
        url: offscreenUrl,
        postMessage: (offer: any, ports: MessagePort[]) => {
          void serveVaultAuthority({ port: ports[0], channelId: offer.channelId });
        },
      }],
    });

    await client.initializeWithPrfOnly({
      prfOutput: new Uint8Array(32).fill(5),
      credentialId: new Uint8Array([1, 2, 3]),
      prfSalt: new Uint8Array(32).fill(6),
    });
    await client.setSecret('provider:test', 'survives-host-replacement');
    expect(client.isLocked()).toBe(false);
    expect(storage.session.has('vault.unlocked.v1')).toBe(true);

    currentLease = { ...vaultLease, leaseId: 'vault-lease-successor', generation: 2 };
    await expect(client.getSecret('provider:test')).resolves.toBe('survives-host-replacement');
    await expect(client.status()).resolves.toMatchObject({ initialized: true, locked: false });
    client.close();
  });

  test('does not admit a concurrent lock ahead of successor resume', async () => {
    const storage = makeStorage();
    let currentLease: any = vaultLease;
    let holdSuccessor = false;
    let releaseSuccessor = () => {};
    let successorListed = Promise.resolve();
    const client = makeVaultAuthorityClient({
      offscreen: true,
      offscreenUrl,
      workerUrl,
      kv: storage.kv,
      idb: storage.idb,
      sessionCache: storage.sessionCache,
      withHost: async (operation) => operation(currentLease),
      listWindowClients: async () => {
        if (holdSuccessor) {
          successorListed = new Promise((resolve) => { releaseSuccessor = resolve; });
          await successorListed;
        }
        return [{
          url: offscreenUrl,
          postMessage: (offer: any, ports: MessagePort[]) => {
            void serveVaultAuthority({ port: ports[0], channelId: offer.channelId });
          },
        }];
      },
    });
    await client.initializeWithPrfOnly({
      prfOutput: new Uint8Array(32).fill(5),
      credentialId: new Uint8Array([1, 2, 3]),
      prfSalt: new Uint8Array(32).fill(6),
    });
    await client.setSecret('provider:test', 'secret');

    currentLease = { ...vaultLease, leaseId: 'vault-lease-successor', generation: 2 };
    holdSuccessor = true;
    const read = client.getSecret('provider:test');
    await Promise.resolve();
    const locking = client.lock('manual');
    releaseSuccessor();

    await expect(read).resolves.toBe('secret');
    await expect(locking).resolves.toBeUndefined();
    await expect(client.status()).resolves.toMatchObject({ locked: true });
    expect(storage.session.has('vault.unlocked.v1')).toBe(false);
    client.close();
  });

  test('an older successor finalizer cannot clear a newer connecting generation', async () => {
    const storage = makeStorage();
    let currentLease: any = vaultLease;
    let listing = 0;
    let rejectLeaseB = () => {};
    const leaseBFailure = new Promise<void>((_, reject) => {
      rejectLeaseB = () => reject(new Error('lease-b-host-retired'));
    });
    let leaseCOffer: any = null;
    let leaseCPort: MessagePort | null = null;
    const client = makeVaultAuthorityClient({
      offscreen: true,
      offscreenUrl,
      workerUrl,
      kv: storage.kv,
      idb: storage.idb,
      sessionCache: storage.sessionCache,
      withHost: async (operation) => operation(currentLease),
      listWindowClients: async () => {
        listing += 1;
        if (listing === 2) {
          await leaseBFailure;
        }
        return [{
          url: offscreenUrl,
          postMessage: (offer: any, ports: MessagePort[]) => {
            if (offer.lease.generation === 3) {
              leaseCOffer = offer;
              leaseCPort = ports[0];
              return;
            }
            void serveVaultAuthority({ port: ports[0], channelId: offer.channelId });
          },
        }];
      },
    });
    await client.status();

    currentLease = { ...vaultLease, leaseId: 'lease-b', generation: 2 };
    const callB = client.status();
    while (listing < 2) await Promise.resolve();
    currentLease = { ...vaultLease, leaseId: 'lease-c', generation: 3 };
    const callC = client.status();
    while (listing < 3 || !leaseCPort) await Promise.resolve();

    rejectLeaseB();
    await expect(callB).rejects.toThrow('lease-b-host-retired');
    const joiningC = client.status();
    await Promise.resolve();
    expect(listing).toBe(3);
    void serveVaultAuthority({
      port: /** @type {MessagePort} */ (leaseCPort),
      channelId: leaseCOffer.channelId,
    });
    await expect(callC).resolves.toMatchObject({ locked: true });
    await expect(joiningC).resolves.toMatchObject({ locked: true });
    expect(listing).toBe(3);
    client.close();
  });

  test('a rejected first-run mutation refreshes cached initialized status', async () => {
    const storage = makeStorage();
    storage.sessionCache.sessionSet = async () => {
      throw new Error('session mirror unavailable');
    };
    storage.idb.del = async () => {
      throw new Error('blob rollback unavailable');
    };
    const client = makeVaultAuthorityClient({
      offscreen: true,
      offscreenUrl,
      workerUrl,
      kv: storage.kv,
      idb: storage.idb,
      sessionCache: storage.sessionCache,
      withHost: async (operation) => operation(vaultLease),
      listWindowClients: async () => [{
        url: offscreenUrl,
        postMessage: (offer: any, ports: MessagePort[]) => {
          void serveVaultAuthority({ port: ports[0], channelId: offer.channelId });
        },
      }],
    });

    await expect(client.initializeWithPrfOnly({
      prfOutput: new Uint8Array(32).fill(5),
      credentialId: new Uint8Array([1, 2, 3]),
      prfSalt: new Uint8Array(32).fill(6),
    })).rejects.toThrow('session mirror unavailable');
    expect(client.isInitialized()).toBe(true);
    expect(client.isLocked()).toBe(true);
    await expect(client.status()).resolves.toMatchObject({ initialized: true, locked: true });
    client.close();
  });

  test('manual lock crosses the exact reverse fence when session deletion is unavailable', async () => {
    const storage = makeStorage();
    const deleteSession = storage.sessionCache.sessionDelete;
    const client = makeVaultAuthorityClient({
      offscreen: true,
      offscreenUrl,
      workerUrl,
      kv: storage.kv,
      idb: storage.idb,
      sessionCache: storage.sessionCache,
      withHost: async (operation) => operation(vaultLease),
      listWindowClients: async () => [{
        url: offscreenUrl,
        postMessage: (offer: any, ports: MessagePort[]) => {
          void serveVaultAuthority({ port: ports[0], channelId: offer.channelId });
        },
      }],
    });
    await client.initializeWithPrfOnly({
      prfOutput: new Uint8Array(32).fill(5),
      credentialId: new Uint8Array([1, 2, 3]),
      prfSalt: new Uint8Array(32).fill(6),
    });
    // Bun's in-process MessageChannel needs one task turn after resolving a
    // result handler before the same port can deliver a nested reverse call.
    // A real second user action naturally has this separation.
    await new Promise((resolve) => setTimeout(resolve, 0));
    storage.sessionCache.sessionDelete = async () => {
      throw new Error('session delete unavailable');
    };

    await expect(client.lock('manual')).resolves.toBeUndefined();
    expect(client.isLocked()).toBe(true);
    expect(storage.session.has('vault.unlocked.v1')).toBe(true);
    expect(storage.local.get('vault.resume-fence.v1')).toMatchObject({ reason: 'manual' });

    storage.sessionCache.sessionDelete = deleteSession;
    await expect(client.attemptResume()).resolves.toBe(false);
    expect(storage.session.has('vault.unlocked.v1')).toBe(false);
    expect(storage.local.has('vault.resume-fence.v1')).toBe(false);
    client.close();
  });

  test('runs passkey vault and secret custody through exact reverse storage only', async () => {
    const storage = makeStorage();
    let depth = 0;
    let terminated = 0;
    const client = makeVaultAuthorityClient({
      offscreen: false,
      offscreenUrl,
      workerUrl,
      kv: storage.kv,
      idb: storage.idb,
      sessionCache: storage.sessionCache,
      newId: (() => { let value = 0; return () => `identity-${++value}`; })(),
      withHost: async (operation) => {
        depth += 1;
        try { return await operation(null); } finally { depth -= 1; }
      },
      createWorker: ((url: string, options: any) => ({
        postMessage(bootstrap: any, ports: MessagePort[]) {
          expect(url).toBe(workerUrl);
          expect(options).toEqual({ type: 'module', name: 'peerd-vault-authority' });
          void serveVaultAuthority({ port: ports[0], channelId: bootstrap.channelId });
        },
        terminate() { terminated += 1; },
      })) as any,
    });

    expect((await client.status()).initialized).toBe(false);
    const prfOutput = new Uint8Array(32).fill(5);
    await client.initializeWithPrfOnly({
      prfOutput,
      credentialId: new Uint8Array([1, 2, 3, 4]),
      prfSalt: new Uint8Array(32).fill(6),
      transports: ['internal'],
    });
    expect(client.isLocked()).toBe(false);
    expect((await client.status())).toMatchObject({
      initialized: true, prfEnrolled: true, hasRecovery: false, locked: false,
    });
    await client.setSecret('provider:test', 'private-value');
    expect(await client.getSecret('provider:test')).toBe('private-value');
    expect(await client.listSecretNames()).toEqual(['provider:test']);
    await client.setRecoveryPassphrase('private-recovery-passphrase');
    const explicitLockEvents: any[] = [];
    client.subscribe((event) => {
      if (event?.type === 'locked') {
        explicitLockEvents.push(event);
        client.close();
      }
    });
    await client.lock('manual');
    // The route that issued an explicit lock owns host retirement after the
    // result settles. A premature subscriber callback would close this call's
    // channel and make the promise reject instead.
    expect(explicitLockEvents).toEqual([]);
    expect(client.isLocked()).toBe(true);
    expect(storage.session.has('vault.unlocked.v1')).toBe(false);
    expect(storage.database.has('vault:vault.v1')).toBe(true);
    expect(depth).toBe(0);
    client.close();
    expect(terminated).toBe(1);
    await client.unlock('private-recovery-passphrase');
    expect(client.isLocked()).toBe(false);
    expect((await client.status()).hasRecovery).toBe(true);
    await client.lock('manual');
    client.close();
    expect(terminated).toBe(2);
  });

  test('protocol refuses unknown methods, storage operations, and forged provenance', () => {
    expect(parseVaultAuthorityCall({
      type: 'vault-authority/call', protocol: VAULT_AUTHORITY_PROTOCOL,
      channelId: 'channel-123', requestId: 'request-123', method: 'vault.raw', args: null,
    })).toBeNull();
    expect(parseVaultAuthorityStorageCall({
      type: 'vault-authority/storage', protocol: VAULT_AUTHORITY_PROTOCOL,
      channelId: 'channel-123', requestId: 'request-123',
      operation: 'storage.clear', args: [],
    })).toBeNull();
    const expected = 'chrome-extension://test/background/vault-kernel.js';
    const event = (overrides: Record<string, any> = {}) => ({
      isTrusted: true,
      source: { scriptURL: expected },
      data: {
        type: 'peerd/vault-authority-channel', protocol: 1, channelId: 'channel-123',
        lease: vaultLease,
      },
      ports: [{}],
      ...overrides,
    });
    const ownsLease = (candidate: any) => candidate?.leaseId === vaultLease.leaseId;
    expect(admitVaultAuthorityOffer(event(), expected, ownsLease)).toMatchObject({ ok: true });
    expect(admitVaultAuthorityOffer(event({ isTrusted: false }), expected, ownsLease))
      .toMatchObject({ ok: false, reason: 'sender-invalid' });
    expect(admitVaultAuthorityOffer(event({ ports: [{}, {}] }), expected, ownsLease))
      .toMatchObject({ ok: false, reason: 'offer-invalid' });
    expect(admitVaultAuthorityOffer(event(), expected, () => false))
      .toMatchObject({ ok: false, reason: 'lease-inactive' });
  });

  test('bootstrap seals the realm before the fixed runtime import', () => {
    const source = readFileSync(join(EXTENSION_DIR, 'offscreen/vault-authority-worker.js'), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
    const seal = source.indexOf("denyGlobal('postMessage')");
    const runtime = source.indexOf("import('./vault-authority-runtime.js')");
    expect(seal).toBeGreaterThan(0);
    expect(runtime).toBeGreaterThan(seal);
    for (const primitive of ['fetch', 'Worker', 'indexedDB', 'caches', 'BroadcastChannel']) {
      expect(source).toContain(`'${primitive}'`);
    }
    const runtimeSource = readFileSync(
      join(EXTENSION_DIR, 'offscreen/vault-authority-runtime.js'), 'utf8',
    );
    expect(runtimeSource).toContain("from '../peerd-egress/offscreen.js'");
    expect(runtimeSource).not.toContain("from '../peerd-egress/vault/");
    expect(runtimeSource).not.toMatch(/^\s*import .*argon2id/m);
    expect(runtimeSource).toContain("import('../shared/argon2id.js')");
  });

  test('the fixed bootstrap and runtime are explicit packaged lazy entries', () => {
    const source = readFileSync(join(EXTENSION_DIR, '..', 'packaging', 'lazy-entry-manifest.ts'), 'utf8');
    expect(source).toContain("'offscreen/vault-authority-worker.js'");
    expect(source).toContain("'offscreen/vault-authority-runtime.js'");
  });

  test('a never-settling dispatched credential commit is bounded and outcome-unknown', async () => {
    const storage = makeStorage();
    let calls = 0;
    let terminated = 0;
    const client = makeVaultAuthorityClient({
      offscreen: false,
      offscreenUrl,
      workerUrl,
      kv: storage.kv,
      idb: storage.idb,
      sessionCache: storage.sessionCache,
      timeoutMs: 5,
      withHost: async (operation) => operation(null),
      createWorker: (() => ({
        postMessage(bootstrap: any, ports: MessagePort[]) {
          const port = ports[0];
          port.onmessage = (event) => {
            if (event.data?.type === VAULT_AUTHORITY_CALL) calls += 1;
          };
          port.start();
          port.postMessage({
            type: VAULT_AUTHORITY_READY,
            protocol: VAULT_AUTHORITY_PROTOCOL,
            channelId: bootstrap.channelId,
          });
        },
        terminate() { terminated += 1; },
      })) as any,
    });
    await expect(client.initializeWithPrfOnly({
      prfOutput: new Uint8Array(32),
      credentialId: new Uint8Array([1]),
      prfSalt: new Uint8Array(32),
    })).rejects.toMatchObject({
      code: 'vault-authority-timeout', outcomeKnown: false,
    });
    expect(calls).toBe(1);
    expect(terminated).toBe(1);
  });
});
