// @ts-check

/** @param {Record<string, any>} deps */
export const makeLegacyVaultUnlockEffect = ({
  onUnlocked, resumeGoalRuns, sessionCache, maybeAutoResumeAfterRecovery, resumeSchedules,
}) => (/** @type {string} */ reason) => {
  Promise.resolve(onUnlocked(reason)).catch((/** @type {unknown} */ error) =>
    console.error('[sw] post-unlock transition failed', error));
  Promise.resolve(resumeGoalRuns())
    .catch(() => {})
    .then(() => sessionCache.sessionGet('currentSessionId'))
    .then((/** @type {any} */ current) => maybeAutoResumeAfterRecovery(current))
    .catch(() => {});
  Promise.resolve(resumeSchedules()).catch(() => {});
};

/** @param {Record<string, any>} deps */
export const makeConfirmAnswerRoute = ({
  confirmCoordinator, sessionCache, isActualSidepanelSender, isActualHomeSender,
}) => async (/** @type {any} */ {
  id, answer, ownerSessionId, sessionId, dispatchId,
}, /** @type {unknown} */ sender) => {
  const fromSidepanel = isActualSidepanelSender(sender) === true;
  const fromHome = isActualHomeSender(sender) === true;
  if (!fromSidepanel && !fromHome) {
    return { ok: false, error: 'confirm-answer-unauthorized-sender' };
  }
  const activeOwnerSessionId = await sessionCache.sessionGet('currentSessionId');
  if ((activeOwnerSessionId ?? null) !== (ownerSessionId ?? null)) {
    return { ok: false, error: 'confirm-answer-foreign-owner' };
  }
  const resolved = confirmCoordinator.resolve({
    id, ownerSessionId, sessionId, dispatchId,
  }, answer, fromHome ? 'home' : 'sidepanel');
  return resolved ? { ok: true } : { ok: false, error: 'confirm-answer-stale-or-foreign' };
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
    VaultLockedError,
  } = deps;

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
    try { await vault.lock(); }
    catch (error) { console.error('[sw] failed-init vault lock cleanup failed', error); }
    try { await onLocked(); }
    catch (error) { console.error('[sw] failed-init host cleanup failed', error); }
    try { await purgeVaultBlob({ kv, idb }); }
    catch (error) { console.error('[sw] failed-init blob cleanup failed', error); }
  };

  return {
    'vault/initialize': async ({ passphrase }) => {
      try {
        await vault.initialize(passphrase);
        auditLog.append({ type: 'vault_initialized' }).catch(() => {});
        Promise.resolve(onInitialized()).catch((/** @type {unknown} */ e) =>
          console.error('[sw] post-initialize transition failed', e));
        return { ok: true };
      } catch (e) {
        if (e instanceof VaultAlreadyInitializedError) return { ok: false, error: 'already-initialized' };
        await rollbackInitialization();
        throw e;
      }
    },

    'vault/unlock': async ({ passphrase }) => {
      try {
        await vault.unlock(passphrase);
        auditLog.append({ type: 'vault_unlocked' }).catch(() => {});
        Promise.resolve(onUnlocked('unlock')).catch((/** @type {unknown} */ e) =>
          console.error('[sw] post-unlock transition failed', e));
        return { ok: true };
      } catch (e) {
        if (e instanceof WrongPassphraseError) return { ok: false, error: 'wrong-passphrase' };
        if (e instanceof VaultNotInitializedError) return { ok: false, error: 'not-initialized' };
        if (e instanceof RecoveryPassphraseNotSetError) return { ok: false, error: 'recovery-not-set' };
        throw e;
      }
    },

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
      auditLog.append({ type: 'vault_initialized', details: { prf: true, passkeyOnly: true } }).catch(() => {});
      auditLog.append({ type: 'vault_prf_enrolled' }).catch(() => {});
      Promise.resolve(onInitialized()).catch((/** @type {unknown} */ e) =>
        console.error('[sw] post-initialize transition failed', e));
      return { ok: true };
    },

    'vault/setRecoveryPassphrase': async ({ passphrase }) => {
      if (typeof passphrase !== 'string' || passphrase.length < 8) {
        return { ok: false, error: 'invalid-passphrase' };
      }
      try {
        await vault.setRecoveryPassphrase(passphrase);
        auditLog.append({ type: 'vault_recovery_set' }).catch(() => {});
        return { ok: true };
      } catch (e) {
        if (e instanceof VaultLockedError) return { ok: false, error: 'locked' };
        if (e instanceof VaultNotInitializedError) return { ok: false, error: 'not-initialized' };
        throw e;
      }
    },

    'vault/lock': async () => {
      let failure = null;
      try { await vault.lock(); }
      catch (error) { failure = error; }
      try { await onLocked(); }
      catch (error) { failure ??= error; }
      await auditLog.append({ type: 'vault_locked' }).catch(() => {});
      await Promise.resolve(pushState()).catch(() => {});
      if (failure) throw failure;
      return { ok: true };
    },

    'vault/prfStatus': async () => {
      const status = await vault.prfStatus();
      return { ok: true, ...status };
    },

    'vault/enrollPrf': async (input) => {
      try {
        const payload = prfPayload(input);
        if (!payload) return { ok: false, error: 'invalid-prf-payload' };
        await vault.enrollPrf(payload);
        auditLog.append({ type: 'vault_prf_enrolled' }).catch(() => {});
        pushState();
        return { ok: true };
      } catch (e) {
        if (e instanceof VaultLockedError) return { ok: false, error: 'locked' };
        if (e instanceof VaultNotInitializedError) return { ok: false, error: 'not-initialized' };
        throw e;
      }
    },

    'vault/unlockPrf': async ({ prfOutput }) => {
      if (typeof prfOutput !== 'string') {
        return { ok: false, error: 'invalid-prf-payload' };
      }
      try {
        await vault.unlockWithPrf(base64ToBytes(prfOutput));
        auditLog.append({ type: 'vault_unlocked', details: { via: 'prf' } }).catch(() => {});
        Promise.resolve(onUnlocked('unlock-prf')).catch((/** @type {unknown} */ e) =>
          console.error('[sw] post-unlock transition failed', e));
        return { ok: true };
      } catch (e) {
        if (e instanceof PrfNotEnrolledError) return { ok: false, error: 'prf-not-enrolled' };
        if (e instanceof PrfUnlockFailedError) return { ok: false, error: 'prf-unlock-failed' };
        if (e instanceof VaultNotInitializedError) return { ok: false, error: 'not-initialized' };
        throw e;
      }
    },

    'vault/disablePrf': async () => {
      try {
        await vault.disablePrf();
        auditLog.append({ type: 'vault_prf_disabled' }).catch(() => {});
        pushState();
        return { ok: true };
      } catch (e) {
        if (e instanceof VaultLockedError) return { ok: false, error: 'locked' };
        if (e instanceof VaultNotInitializedError) return { ok: false, error: 'not-initialized' };
        if (e instanceof RecoveryPassphraseNotSetError) return { ok: false, error: 'recovery-not-set' };
        throw e;
      }
    },
  };
};
