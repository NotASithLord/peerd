import { describe, expect, test } from 'bun:test';
import { createVault } from '../../extension/peerd-egress/vault/vault.js';
import { makeWebFetch, withDpopCredentials } from '../../extension/peerd-egress/fetch/web-fetch.js';

const setup = async () => {
  const key = 'vault.unlocked.v1';
  const session = new Map<string, any>();
  const prfOutput = new Uint8Array(32).fill(7);
  const data = new Map<string, any>();
  let wait: Promise<void> | undefined;
  const vault = createVault({
    kv: { get: async (k) => data.get(k), set: async (k, v) => { await wait; data.set(k, v); },
      delete: async (k) => { await wait; data.delete(k); }, list: async () => ({}), clear: async () => {} },
    sessionCache: { sessionGet: async (k) => session.get(k),
      sessionSet: async (k, v) => { session.set(k, v); }, sessionDelete: async (k) => { session.delete(k); } },
    autoLockMs: 0, now: () => 1,
  });
  await vault.initializeWithPrfOnly({
    prfOutput, credentialId: new Uint8Array([1, 2, 3]), prfSalt: new Uint8Array(32).fill(9),
  });
  const mirror = session.get(key);
  return { vault, setWait: (value: Promise<void> | undefined) => { wait = value; },
    reopen: () => vault.unlockWithPrf(prfOutput),
    replayMirror: async () => { session.set(key, mirror); await vault.attemptResume(); } };
};

describe('raw vault request preparation authority', () => {
  test('a stale session mirror cannot act as a fresh unlock', async () => {
    const { vault, replayMirror } = await setup();
    const before = vault.captureRequestAuthority();
    await vault.lock();
    await replayMirror();
    expect(vault.isLocked()).toBe(true);
    expect(before()).toBe(false);
    expect(vault.captureRequestAuthority()()).toBe(false);
  });

  test.each(['replace', 'delete'])('%s revokes before storage and does not revive captured leases', async (kind) => {
    const { vault, setWait } = await setup();
    const gate = Promise.withResolvers<void>();
    const before = vault.captureRequestAuthority();
    setWait(gate.promise);
    const changing = kind === 'replace' ? vault.setSecret('origin:https://app.example', 'new')
      : vault.deleteSecret('origin:https://app.example');
    expect(before()).toBe(false);
    const during = vault.captureRequestAuthority();
    expect(during()).toBe(false);
    gate.resolve();
    await changing;
    expect(before()).toBe(false);
    expect(during()).toBe(false);
    expect(vault.captureRequestAuthority()()).toBe(true);
  });

  test.each(['lock-unlock', 'replace', 'delete'])('%s cannot revive a request that holds decrypted headers', async (kind) => {
    const { vault, reopen } = await setup();
    await vault.setSecret('origin:https://app.example', 'old-secret');
    const before = vault.captureRequestAuthority();
    let calls = 0;
    const raw = makeWebFetch({ getDenylist: () => [], matchDenylist: () => false,
      pace: { canonicalOrigin: (origin) => origin, isWriteMethod: () => true,
        reserve: async () => {
          if (kind === 'lock-unlock') { await vault.lock(); await reopen(); }
          else if (kind === 'replace') await vault.setSecret('origin:https://app.example', 'new-secret');
          else await vault.deleteSecret('origin:https://app.example');
          return { outcome: 'waited', waitedMs: 1 };
        },
        observe: async () => {} },
      fetchFn: (async () => { calls += 1; return new Response('sent'); }) as unknown as typeof fetch });
    const send = withDpopCredentials(raw, () => 'https://app.example', {
      getSecret: vault.getSecret, getDpopKey: async () => null, captureRequestAuthority: vault.captureRequestAuthority,
    });
    await expect(send('https://app.example/write', { method: 'POST' })).rejects.toMatchObject({ performed: false });
    expect(vault.isLocked()).toBe(false);
    expect(before()).toBe(false);
    expect(vault.captureRequestAuthority()()).toBe(true);
    expect(calls).toBe(0);
  });
});
