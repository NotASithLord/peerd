// @ts-check

/** Lock cleanup is single-flight; publishing never changes its outcome.
 * @param {any} deps */
export const createVaultLockLifecycle = ({ stop, publish, revoke = () => {}, voice = async () => ({ ok: true }), firefox = false }) => {
  /** @type {Promise<void>|null} */ let pending = null;
  /** @type {'pending'|'unconfirmed'|'restart-required'|null} */ let state = null;
  let restart = false;
  const announce = () => { try { publish(state); } catch { /* rendering is advisory */ } };
  return {
    state: () => state,
    run: () => {
      if (pending) return pending;
      state = 'pending';
      // Revoke publication authority synchronously before paint.
      pending = (async () => {
        revoke();
        let receipt;
        try { receipt = await voice(); } catch { receipt = { ok: false }; }
        restart ||= firefox && receipt?.ok !== true;
        const results = await stop();
        if (restart || receipt?.ok !== true || !Array.isArray(results) || results.some(result => result?.ok !== true)) {
          throw new Error('vault-cleanup-unconfirmed');
        }
      })().then(() => { state = null; }, (cause) => {
        state = restart ? 'restart-required' : 'unconfirmed'; throw cause;
      }).finally(() => { pending = null; announce(); });
      announce();
      return pending;
    },
  };
};

/**
 * @param {Record<string, any>} deps
 * @returns {Record<string, (msg?: any, sender?: unknown) => Promise<any>>}
 */
export const makeVaultRoutes = (deps) => {
  const {
    vault, auditLog, kv, idb, base64ToBytes,
    pushState, purgeVaultBlob, onInitialized, onUnlocked, onLocked,
    VaultAlreadyInitializedError, WrongPassphraseError, VaultNotInitializedError,
    RecoveryPassphraseNotSetError, PrfNotEnrolledError, PrfUnlockFailedError,
    VaultLockedError, beforeUnlock = () => null,
  } = deps;
  let locking = false;
  const unlockRefusal = () => locking
    ? { ok: false, error: 'vault-cleanup-pending' } : beforeUnlock();

  const notInitialized = [VaultNotInitializedError, 'not-initialized'];
  const recoveryMissing = [RecoveryPassphraseNotSetError, 'recovery-not-set'];
  const lockedErrors = [[VaultLockedError, 'locked'], notInitialized];
  /** @param {()=>Promise<any>} operation @param {any} audit @param {any[][]} errors @param {()=>void} [after] */
  const mutate = async (operation, audit, errors, after = () => {}) => {
    try {
      await operation();
      auditLog.append(audit).catch(() => {});
      after();
      return { ok: true };
    } catch (cause) {
      for (const [Type, error] of errors) if (cause instanceof Type) return { ok: false, error };
      throw cause;
    }
  };
  /** @param {()=>Promise<any>} operation @param {any[][]} errors @param {boolean} [prf] */
  const unlock = async (operation, errors, prf = false) => unlockRefusal() ?? mutate(operation,
    { type: 'vault_unlocked', ...(prf ? { details: { via: 'prf' } } : {}) }, errors,
    () => { Promise.resolve(onUnlocked(prf ? 'unlock-prf' : 'unlock')).catch((/** @type {unknown} */ error) =>
      console.error('[sw] post-unlock transition failed', error)); });

  const prfPayload = (/** @type {any} */ input) => {
    if (typeof input?.credentialId !== 'string' || typeof input?.prfSalt !== 'string'
        || typeof input?.prfOutput !== 'string') return null;
    try {
      return {
        prfOutput: base64ToBytes(input.prfOutput),
        credentialId: base64ToBytes(input.credentialId),
        prfSalt: base64ToBytes(input.prfSalt),
        transports: input.transports,
      };
    } catch {
      // Malformed bytes never crossed the mutation boundary, so rolling back
      // here could destroy an already-existing vault.
      return null;
    }
  };

  const rollbackInitialization = async () => {
    for (const [step, cleanup] of [
      ['vault lock', () => vault.lock()], ['host', onLocked],
      ['blob', () => purgeVaultBlob({ kv, idb })],
    ]) {
      try { await cleanup(); }
      catch (error) { console.error(`[sw] failed-init ${step} cleanup failed`, error); }
    }
  };

  const initialized = (prf = false) => {
    auditLog.append({ type: 'vault_initialized',
      ...(prf ? { details: { prf: true, passkeyOnly: true } } : {}) }).catch(() => {});
    if (prf) auditLog.append({ type: 'vault_prf_enrolled' }).catch(() => {});
    Promise.resolve(onInitialized()).catch((/** @type {unknown} */ error) =>
      console.error('[sw] post-initialize transition failed', error));
    return { ok: true };
  };

  return {
    'vault/initialize': async ({ passphrase }) => {
      try {
        await vault.initialize(passphrase);
        return initialized();
      } catch (e) {
        if (e instanceof VaultAlreadyInitializedError) return { ok: false, error: 'already-initialized' };
        await rollbackInitialization();
        throw e;
      }
    },

    'vault/unlock': async ({ passphrase }) => unlock(() => vault.unlock(passphrase), [
      [WrongPassphraseError, 'wrong-passphrase'], notInitialized, recoveryMissing,
    ]),

    'vault/initializeWithPasskey': async (input) => {
      try {
        const payload = prfPayload(input);
        if (!payload) return { ok: false, error: 'invalid-prf-payload' };
        await vault.initializeWithPrfOnly(payload);
      } catch (e) {
        if (e instanceof VaultAlreadyInitializedError) return { ok: false, error: 'already-initialized' };
        console.error('[sw] initializeWithPasskey failed, rolling back', e);
        await rollbackInitialization();
        throw e;
      }
      return initialized(true);
    },

    'vault/setRecoveryPassphrase': async ({ passphrase }) => {
      if (typeof passphrase !== 'string' || passphrase.length < 8) {
        return { ok: false, error: 'invalid-passphrase' };
      }
      return mutate(() => vault.setRecoveryPassphrase(passphrase),
        { type: 'vault_recovery_set' }, lockedErrors);
    },

    'vault/lock': async () => {
      if (locking) return { ok: false, error: 'vault-cleanup-pending' };
      locking = true;
      try {
        let failure = null;
        try { await vault.lock(); }
        catch (error) { failure = error; }
        try { await onLocked(); }
        catch (error) { failure ??= error; }
        await auditLog.append({ type: 'vault_locked' }).catch(() => {});
        await Promise.resolve(pushState()).catch(() => {});
        if (failure) throw failure;
        return { ok: true };
      } finally { locking = false; }
    },

    'vault/prfStatus': async () => {
      const status = await vault.prfStatus();
      return { ok: true, ...status };
    },

    'vault/enrollPrf': async (input) => {
      const payload = prfPayload(input);
      return payload ? mutate(() => vault.enrollPrf(payload),
        { type: 'vault_prf_enrolled' }, lockedErrors, pushState)
        : { ok: false, error: 'invalid-prf-payload' };
    },

    'vault/unlockPrf': async ({ prfOutput }) => {
      const refusal = unlockRefusal();
      if (refusal) return refusal;
      return typeof prfOutput === 'string' ? unlock(() => vault.unlockWithPrf(base64ToBytes(prfOutput)), [
        [PrfNotEnrolledError, 'prf-not-enrolled'], [PrfUnlockFailedError, 'prf-unlock-failed'], notInitialized,
      ], true) : { ok: false, error: 'invalid-prf-payload' };
    },

    'vault/disablePrf': async () => mutate(() => vault.disablePrf(),
      { type: 'vault_prf_disabled' }, [...lockedErrors, recoveryMissing], pushState),
  };
};
