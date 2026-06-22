import { describe, test, expect } from 'bun:test';
import { makeVaultRoutes } from '../../extension/background/routes/vault.js';

// The vault routes moved out of the service worker verbatim. These pin the
// part with real branching — the typed-error → stable-error-code mapping — and
// confirm the deps wiring (audit append, pushState, ensureOffscreen, the
// base-network kick) fires where it should. Behavior must match the inline
// originals exactly.

// Stand-in typed errors (the real ones live in peerd-egress; routes only need
// `instanceof` to work).
class VaultAlreadyInitializedError extends Error {}
class WrongPassphraseError extends Error {}
class VaultNotInitializedError extends Error {}
class RecoveryPassphraseNotSetError extends Error {}
class PrfNotEnrolledError extends Error {}
class PrfUnlockFailedError extends Error {}
class VaultLockedError extends Error {}

const makeDeps = (vaultOver: Record<string, any> = {}) => {
  const calls: Record<string, any[]> = { audit: [], pushState: [], ensureOffscreen: [], maybeStart: [] };
  const vault = {
    initialize: async () => {},
    unlock: async () => {},
    lock: () => {},
    initializeWithPrfOnly: async () => {},
    setRecoveryPassphrase: async () => {},
    prfStatus: async () => ({ enrolled: false }),
    enrollPrf: async () => {},
    unlockWithPrf: async () => {},
    disablePrf: async () => {},
    ...vaultOver,
  };
  const deps = {
    vault,
    auditLog: { append: async (e: any) => { calls.audit.push(e); } },
    kv: {}, idb: {},
    base64ToBytes: (s: string) => new Uint8Array([s.length]),
    ensureOffscreen: async () => { calls.ensureOffscreen.push(1); },
    maybeStartBaseNetwork: (r: string) => { calls.maybeStart.push(r); },
    pushState: () => { calls.pushState.push(1); },
    purgeVaultBlob: async () => {},
    sessionCache: { sessionGet: async () => null },
    maybeAutoResume: () => {},
    confirmCoordinator: { resolve: (id: string, answer: string) => { calls.resolve = [id, answer]; } },
    VaultAlreadyInitializedError, WrongPassphraseError, VaultNotInitializedError,
    RecoveryPassphraseNotSetError, PrfNotEnrolledError, PrfUnlockFailedError, VaultLockedError,
  };
  return { deps, calls, vault };
};

const routes = (over?: Record<string, any>) => {
  const { deps, calls, vault } = makeDeps(over);
  return { r: makeVaultRoutes(deps), calls, vault };
};

describe('vault routes — success paths', () => {
  test('initialize: audits + ensures offscreen', async () => {
    const { r, calls } = routes();
    expect(await r['vault/initialize']({ passphrase: 'pw' })).toEqual({ ok: true });
    await Promise.resolve();
    expect(calls.audit[0]).toEqual({ type: 'vault_initialized' });
    expect(calls.ensureOffscreen.length).toBe(1);
  });

  test('unlock: audits, ensures offscreen, kicks base network with reason', async () => {
    const { r, calls } = routes();
    expect(await r['vault/unlock']({ passphrase: 'pw' })).toEqual({ ok: true });
    expect(calls.maybeStart).toEqual(['unlock']);
    expect(calls.ensureOffscreen.length).toBe(1);
  });

  test('lock: pushes state so the panel flips to the gate immediately', async () => {
    const { r, calls } = routes();
    expect(await r['vault/lock']()).toEqual({ ok: true });
    expect(calls.pushState.length).toBe(1);
  });

  test('unlockPrf: kicks base network with unlock-prf reason', async () => {
    const { r, calls } = routes();
    expect(await r['vault/unlockPrf']({ prfOutput: 'AAAA' })).toEqual({ ok: true });
    expect(calls.maybeStart).toEqual(['unlock-prf']);
  });

  test('prfStatus: spreads vault status into the reply', async () => {
    const { r } = routes({ prfStatus: async () => ({ enrolled: true, credentialId: 'c' }) });
    expect(await r['vault/prfStatus']()).toEqual({ ok: true, enrolled: true, credentialId: 'c' });
  });

  test('confirm/answer: relays to the coordinator', async () => {
    const { r, calls } = routes();
    expect(await r['confirm/answer']({ id: 'x', answer: 'yes_once' })).toEqual({ ok: true });
    expect(calls.resolve).toEqual(['x', 'yes_once']);
  });
});

describe('vault routes — typed error → code mapping', () => {
  test('initialize already-initialized', async () => {
    const { r } = routes({ initialize: async () => { throw new VaultAlreadyInitializedError(); } });
    expect(await r['vault/initialize']({ passphrase: 'p' })).toEqual({ ok: false, error: 'already-initialized' });
  });
  test('unlock maps each typed error', async () => {
    expect(await routes({ unlock: async () => { throw new WrongPassphraseError(); } }).r['vault/unlock']({ passphrase: 'p' }))
      .toEqual({ ok: false, error: 'wrong-passphrase' });
    expect(await routes({ unlock: async () => { throw new VaultNotInitializedError(); } }).r['vault/unlock']({ passphrase: 'p' }))
      .toEqual({ ok: false, error: 'not-initialized' });
    expect(await routes({ unlock: async () => { throw new RecoveryPassphraseNotSetError(); } }).r['vault/unlock']({ passphrase: 'p' }))
      .toEqual({ ok: false, error: 'recovery-not-set' });
  });
  test('unlock rethrows unknown errors (not swallowed to a code)', async () => {
    const { r } = routes({ unlock: async () => { throw new Error('boom'); } });
    await expect(r['vault/unlock']({ passphrase: 'p' })).rejects.toThrow('boom');
  });
  test('unlockPrf maps prf-specific errors', async () => {
    expect(await routes({ unlockWithPrf: async () => { throw new PrfNotEnrolledError(); } }).r['vault/unlockPrf']({ prfOutput: 'A' }))
      .toEqual({ ok: false, error: 'prf-not-enrolled' });
    expect(await routes({ unlockWithPrf: async () => { throw new PrfUnlockFailedError(); } }).r['vault/unlockPrf']({ prfOutput: 'A' }))
      .toEqual({ ok: false, error: 'prf-unlock-failed' });
  });
  test('disablePrf requires a recovery passphrase', async () => {
    const { r } = routes({ disablePrf: async () => { throw new RecoveryPassphraseNotSetError(); } });
    expect(await r['vault/disablePrf']()).toEqual({ ok: false, error: 'recovery-not-set' });
  });
});

describe('vault routes — payload validation', () => {
  test('initializeWithPasskey rejects a non-string payload', async () => {
    const { r } = routes();
    expect(await r['vault/initializeWithPasskey']({ credentialId: 1, prfSalt: 's', prfOutput: 'o' }))
      .toEqual({ ok: false, error: 'invalid-prf-payload' });
  });
  test('initializeWithPasskey rolls back (lock + purge) on a non-typed failure', async () => {
    let locked = false; let purged = false;
    const { deps } = makeDeps({
      initializeWithPrfOnly: async () => { throw new Error('hardware'); },
      lock: () => { locked = true; },
    });
    deps.purgeVaultBlob = async () => { purged = true; };
    const r = makeVaultRoutes(deps);
    await expect(r['vault/initializeWithPasskey']({ credentialId: 'a', prfSalt: 'b', prfOutput: 'c' })).rejects.toThrow('hardware');
    expect(locked).toBe(true);
    expect(purged).toBe(true);
  });
  test('setRecoveryPassphrase rejects short passphrase', async () => {
    const { r } = routes();
    expect(await r['vault/setRecoveryPassphrase']({ passphrase: 'short' })).toEqual({ ok: false, error: 'invalid-passphrase' });
  });
});
