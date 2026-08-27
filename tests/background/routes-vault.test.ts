import { describe, test, expect } from 'bun:test';
import {
  makeConfirmAnswerRoute,
  makeLegacyVaultUnlockEffect,
  makeVaultRoutes,
} from '../../extension/background/routes/vault.js';

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
    isActualSidepanelSender: (sender: any) => sender?.surface === 'sidepanel',
    isActualHomeSender: (sender: any) => sender?.surface === 'home',
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

// #60: on an interactive unlock, goal runs must resume BEFORE auto-resume —
// resume() re-adds a paused run to the runner's map (goalActiveFor → true)
// before maybeAutoResume checks its guard, so the guard bails for a goal-owned
// session instead of re-driving its interrupted turn and spuriously halting it.
// A late-resolving resumeGoalRuns distinguishes the fix (auto-resume waits for
// resume to settle) from the old inverted order (auto-resume fired first).
describe('vault unlock — goal resume ordering (#60)', () => {
  const orderingDeps = (order: string[]) => ({
    vault: { unlock: async () => {}, unlockWithPrf: async () => {} },
    auditLog: { append: async () => {} },
    onInitialized: async () => {},
    onLocked: async () => {},
    onUnlocked: () => {},
    base64ToBytes: () => new Uint8Array([1]),
    sessionCache: { sessionGet: async () => 'cur' },
    resumeGoalRuns: async () => { await new Promise((r) => setTimeout(r, 30)); order.push('resume'); },
    maybeAutoResumeAfterRecovery: () => { order.push('autoresume'); },
    resumeSchedules: async () => {},
    WrongPassphraseError, VaultNotInitializedError, RecoveryPassphraseNotSetError,
    PrfNotEnrolledError, PrfUnlockFailedError, VaultLockedError,
  });
  const settle = async (order: string[]) => {
    for (let i = 0; i < 60 && order.length < 2; i++) await new Promise((res) => setTimeout(res, 5));
  };

  test('vault/unlock awaits goal resume BEFORE auto-resume (passphrase)', async () => {
    const order: string[] = [];
    const deps = orderingDeps(order);
    const r = makeVaultRoutes({
      ...deps, onUnlocked: makeLegacyVaultUnlockEffect(deps),
    } as any);
    expect(await r['vault/unlock']({ passphrase: 'pw' })).toEqual({ ok: true });
    await settle(order);
    expect(order).toEqual(['resume', 'autoresume']);
  });

  test('vault/unlockPrf awaits goal resume BEFORE auto-resume (Touch ID / PRF)', async () => {
    const order: string[] = [];
    const deps = orderingDeps(order);
    const r = makeVaultRoutes({
      ...deps, onUnlocked: makeLegacyVaultUnlockEffect(deps),
    } as any);
    expect(await r['vault/unlockPrf']({ prfOutput: 'AAAA' })).toEqual({ ok: true });
    await settle(order);
    expect(order).toEqual(['resume', 'autoresume']);
  });
});
