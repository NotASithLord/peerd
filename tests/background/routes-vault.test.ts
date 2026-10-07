import { makeConfirmAnswerRoute } from '../../extension/background/kernel-confirmation.js';
import { describe, test, expect } from 'bun:test';
import {
  makeVaultRoutes,
  createVaultLockLifecycle,
} from '../../extension/background/routes/vault.js';
import { createDwebPublicationFence } from '../../extension/background/dweb-publication-fence.js';

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
    onInitialized: async () => { calls.ensureOffscreen.push(1); },
    onUnlocked: (reason: string) => {
      calls.ensureOffscreen.push(1);
      calls.maybeStart.push(reason);
    },
    pushState: () => { calls.pushState.push(1); },
    purgeVaultBlob: async () => {},
    sessionCache: { sessionGet: async () => 'chat-a' },
    maybeAutoResumeAfterRecovery: () => {},
    isSidepanelSender: (sender: any) => sender?.surface === 'sidepanel',
    isHomeSender: (sender: any) => sender?.surface === 'home',
    onLocked: async () => {},
    confirmCoordinator: {
      resolve: (claim: Record<string, unknown>, answer: string, via: string) => {
        calls.resolve = [claim, answer, via];
        return claim.ownerSessionId === 'chat-a'
          && claim.sessionId === 'actor-a'
          && claim.dispatchId === 'tu-a';
      },
    },
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

  test('locked posture publishes during hanging cleanup; both unlock paths stay fenced until acknowledgement', async () => {
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let locked = false;
    let unlocks = 0;
    let settled = false;
    const projected: any[] = [];
    const { deps } = makeDeps({
      lock: async () => { locked = true; },
      unlock: async () => { unlocks += 1; },
      unlockWithPrf: async () => { unlocks += 1; },
    });
    const lifecycle = createVaultLockLifecycle({
      stop: async () => { entered(); await held; return [{ ok: true }]; },
      publish: (cleanup: string | null) => projected.push({ locked, cleanup }),
    });
    const routes = makeVaultRoutes({ ...deps, onLocked: lifecycle.run,
      beforeUnlock: () => lifecycle.state() ? { ok: false, error: 'vault-cleanup-pending' } : null });
    const locking = routes['vault/lock']().then(result => { settled = true; return result; });
    await started;
    expect(projected).toEqual([{ locked: true, cleanup: 'pending' }]);
    expect(settled).toBe(false);
    expect(await routes['vault/unlock']({ passphrase: 'pw' })).toEqual({ ok: false, error: 'vault-cleanup-pending' });
    expect(await routes['vault/unlockPrf']({ prfOutput: 'aa' })).toEqual({ ok: false, error: 'vault-cleanup-pending' });
    expect(unlocks).toBe(0);
    release();
    expect(await locking).toEqual({ ok: true });
    expect(projected).toEqual([{ locked: true, cleanup: 'pending' }, { locked: true, cleanup: null }]);
    expect(await routes['vault/unlock']({ passphrase: 'pw' })).toEqual({ ok: true });
    expect(unlocks).toBe(1);
  });

  test('failed cleanup remains unconfirmed and blocks unlock until an explicit successful retry', async () => {
    const failure = new Error('host shutdown unknown');
    let attempts = 0;
    const projected: any[] = [];
    const lifecycle = createVaultLockLifecycle({
      stop: () => { if (++attempts === 1) throw failure; return Promise.resolve([{ ok: true }]); },
      publish: (state: string | null) => { projected.push(state); },
    });
    const { deps } = makeDeps();
    const routes = makeVaultRoutes({ ...deps, onLocked: lifecycle.run,
      beforeUnlock: () => lifecycle.state() ? { ok: false, error: 'vault-cleanup-unconfirmed' } : null });
    await expect(routes['vault/lock']()).rejects.toBe(failure);
    expect(projected).toEqual(['pending', 'unconfirmed']);
    expect(await routes['vault/unlock']({ passphrase: 'pw' }))
      .toEqual({ ok: false, error: 'vault-cleanup-unconfirmed' });
    expect(await routes['vault/lock']()).toEqual({ ok: true });
    expect(projected).toEqual(['pending', 'unconfirmed', 'pending', null]);
  });

  test.each(['reject', 'failure'])('Firefox voice %s requires browser restart even after an inactive retry', async failure => {
    let calls = 0;
    let stopped = 0;
    let revoked = false;
    const states: any[] = [];
    const lifecycle = createVaultLockLifecycle({
      firefox: true,
      revoke: () => { revoked = true; },
      voice: async () => {
        if (++calls > 1) return { ok: true, inactive: true };
        if (failure === 'reject') throw new Error('voice stop timeout');
        return { ok: false, outcomeKnown: false };
      },
      stop: async () => { stopped += 1; return [{ ok: true }]; },
      publish: (state: string | null) => { expect(revoked).toBe(true); states.push(state); },
    });
    await expect(lifecycle.run()).rejects.toThrow('vault-cleanup-unconfirmed');
    expect(stopped).toBe(1);
    expect(lifecycle.state()).toBe('restart-required');
    await expect(lifecycle.run()).rejects.toThrow('vault-cleanup-unconfirmed');
    expect(stopped).toBe(2);
    expect(lifecycle.state()).toBe('restart-required');
    expect(states).toEqual(['pending', 'restart-required', 'pending', 'restart-required']);
  });

  test('resolved failure receipts remain unconfirmed and rendering cannot replace a cleanup error', async () => {
    const states: any[] = [];
    const lifecycle = createVaultLockLifecycle({
      stop: async () => [{ ok: false, outcomeKnown: false }],
      publish: (state: string | null) => { states.push(state); throw new Error('render unavailable'); },
    });
    await expect(lifecycle.run()).rejects.toThrow('vault-cleanup-unconfirmed');
    expect(lifecycle.state()).toBe('unconfirmed');
    expect(states).toEqual(['pending', 'unconfirmed']);
  });

  test('lock: pushes state so the panel flips to the gate immediately', async () => {
    const { r, calls } = routes();
    expect(await r['vault/lock']()).toEqual({ ok: true });
    expect(calls.pushState.length).toBe(1);
  });

  test('lock: settles an asynchronous authority realm before retiring its host', async () => {
    const order: string[] = [];
    let releaseLock = () => {};
    const pendingLock = new Promise<void>((resolve) => { releaseLock = resolve; });
    const { deps } = makeDeps({
      lock: async () => {
        order.push('lock:start');
        await pendingLock;
        order.push('lock:settled');
      },
    });
    deps.onLocked = async () => { order.push('host:retired'); };
    const handler = makeVaultRoutes(deps)['vault/lock'];
    const result = handler();
    await Promise.resolve();
    expect(order).toEqual(['lock:start']);
    releaseLock();
    await expect(result).resolves.toEqual({ ok: true });
    expect(order).toEqual(['lock:start', 'lock:settled', 'host:retired']);
  });

  test('lock then unlock cannot revive an admitted dweb publication', async () => {
    const fence = createDwebPublicationFence();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    let admitted!: () => boolean;
    const publication = fence.run(async (current) => {
      admitted = current;
      enter();
      await held;
      return current();
    });
    await entered;
    const { deps } = makeDeps();
    deps.onLocked = async () => { fence.invalidate(); };
    const vaultRoutes = makeVaultRoutes(deps);
    expect(admitted()).toBe(true);
    await vaultRoutes['vault/lock']();
    await vaultRoutes['vault/unlock']({ passphrase: 'pw' });
    expect(admitted()).toBe(false);
    release();
    expect(await publication).toBe(false);
  });

  test('lock: reconciles host, audit, and UI even when durable finality rejects', async () => {
    const order: string[] = [];
    const { deps } = makeDeps({
      lock: async () => { order.push('lock'); throw new Error('mirror-and-fence-failed'); },
    });
    deps.onLocked = async () => { order.push('host'); };
    deps.auditLog.append = async () => { order.push('audit'); };
    deps.pushState = () => { order.push('state'); };
    const result = makeVaultRoutes(deps)['vault/lock']();
    await expect(result).rejects.toThrow('mirror-and-fence-failed');
    expect(order).toEqual(['lock', 'host', 'audit', 'state']);
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
    const { deps, calls } = makeDeps();
    const answer = makeConfirmAnswerRoute(deps);
    const message = {
      id: 'x', answer: 'yes_once', ownerSessionId: 'chat-a',
      sessionId: 'actor-a', dispatchId: 'tu-a',
    };
    expect(await answer(message, { surface: 'sidepanel' })).toEqual({ ok: true });
    expect(calls.resolve).toEqual([{
      id: 'x', ownerSessionId: 'chat-a', sessionId: 'actor-a', dispatchId: 'tu-a',
    }, 'yes_once', 'sidepanel']);
  });

  test('confirm/answer: derives the answering surface from sender provenance', async () => {
    const { deps, calls } = makeDeps();
    const answer = makeConfirmAnswerRoute(deps);
    const message = {
      id: 'x', answer: 'yes_once', ownerSessionId: 'chat-a',
      sessionId: 'actor-a', dispatchId: 'tu-a', surface: 'home',
    };
    expect(await answer(message, { surface: 'sidepanel' })).toEqual({ ok: true });
    expect(calls.resolve).toEqual([{
      id: 'x', ownerSessionId: 'chat-a', sessionId: 'actor-a', dispatchId: 'tu-a',
    }, 'yes_once', 'sidepanel']);
  });

  test('confirm/answer: a foreign chat UUID or non-human surface cannot grant authority', async () => {
    const { deps, calls } = makeDeps();
    const answer = makeConfirmAnswerRoute(deps);
    const base = {
      id: 'leaked', answer: 'yes_once', sessionId: 'actor-a', dispatchId: 'tu-a',
    };
    expect(await answer(
      { ...base, ownerSessionId: 'chat-a' }, { surface: 'engine' },
    )).toEqual({ ok: false, error: 'confirm-answer-unauthorized-sender' });
    expect(await answer(
      { ...base, ownerSessionId: 'chat-b' }, { surface: 'home' },
    )).toEqual({ ok: false, error: 'confirm-answer-foreign-owner' });
    expect(calls.resolve).toBeUndefined();
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
  test.each(['vault/initialize', 'vault/initializeWithPasskey'])('%s preserves its post-mutation rollback boundary', async name => {
    let purged = false;
    const { deps } = makeDeps();
    deps.onInitialized = () => { throw new Error('post-mutation hook failed'); };
    deps.purgeVaultBlob = async () => { purged = true; };
    await expect(makeVaultRoutes(deps)[name]({ passphrase: 'pw',
      credentialId: 'a', prfSalt: 'b', prfOutput: 'c' })).rejects.toThrow('post-mutation hook failed');
    expect(purged).toBe(name === 'vault/initialize');
  });

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
  test('passphrase initialization failure rolls back the same first-run state', async () => {
    const order: string[] = [];
    const { deps } = makeDeps({
      initialize: async () => { throw new Error('mirror write failed'); },
      lock: async () => { order.push('lock'); throw new Error('mirror delete failed'); },
    });
    deps.onLocked = async () => { order.push('host'); };
    deps.purgeVaultBlob = async () => { order.push('purge'); };
    await expect(makeVaultRoutes(deps)['vault/initialize']({ passphrase: 'pw' }))
      .rejects.toThrow('mirror write failed');
    expect(order).toEqual(['lock', 'host', 'purge']);
  });

  test('passkey rollback purges even when its lock cleanup rejects', async () => {
    let purged = false;
    const { deps } = makeDeps({
      initializeWithPrfOnly: async () => { throw new Error('hardware'); },
      lock: async () => { throw new Error('session unavailable'); },
    });
    deps.purgeVaultBlob = async () => { purged = true; };
    await expect(makeVaultRoutes(deps)['vault/initializeWithPasskey']({
      credentialId: 'a', prfSalt: 'b', prfOutput: 'c',
    })).rejects.toThrow('hardware');
    expect(purged).toBe(true);
  });
  test('malformed passkey bytes cannot cross the mutation or rollback boundary', async () => {
    let locked = false; let retired = false; let purged = false;
    const { deps } = makeDeps({ lock: () => { locked = true; } });
    deps.base64ToBytes = () => { throw new Error('invalid-base64'); };
    deps.onLocked = async () => { retired = true; };
    deps.purgeVaultBlob = async () => { purged = true; };
    const r = makeVaultRoutes(deps);
    await expect(r['vault/initializeWithPasskey']({
      credentialId: 'bad', prfSalt: 'bad', prfOutput: 'bad',
    })).resolves.toEqual({ ok: false, error: 'invalid-prf-payload' });
    expect({ locked, retired, purged }).toEqual({ locked: false, retired: false, purged: false });
  });
  test('malformed enrollment bytes never dispatch a vault mutation', async () => {
    let enrolled = false;
    const { deps } = makeDeps({ enrollPrf: async () => { enrolled = true; } });
    deps.base64ToBytes = () => { throw new Error('invalid-base64'); };
    const r = makeVaultRoutes(deps);
    await expect(r['vault/enrollPrf']({
      credentialId: 'bad', prfSalt: 'bad', prfOutput: 'bad',
    })).resolves.toEqual({ ok: false, error: 'invalid-prf-payload' });
    expect(enrolled).toBe(false);
  });
  test('setRecoveryPassphrase rejects short passphrase', async () => {
    const { r } = routes();
    expect(await r['vault/setRecoveryPassphrase']({ passphrase: 'short' })).toEqual({ ok: false, error: 'invalid-passphrase' });
  });
});
