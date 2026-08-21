// @ts-check

/**
 * @param {Record<string, any>} deps
 * @returns {Record<string, (msg?: any, sender?: unknown) => Promise<any>>}
 */
export const makeVaultRoutes = (deps) => {
  const {
    vault, auditLog, kv, idb, base64ToBytes,
    ensureOffscreen, maybeStartBaseNetwork, pushState, purgeVaultBlob,
    onInitialized, onUnlocked, onLocked,
    confirmCoordinator, sessionCache, isActualSidepanelSender, isActualHomeSender,
    maybeAutoResumeAfterRecovery, resumeGoalRuns, resumeSchedules,
    VaultAlreadyInitializedError, WrongPassphraseError, VaultNotInitializedError,
    RecoveryPassphraseNotSetError, PrfNotEnrolledError, PrfUnlockFailedError,
    VaultLockedError,
  } = deps;

  const runInitialized = typeof onInitialized === 'function'
    ? onInitialized
    : () => ensureOffscreen?.();
  const runUnlocked = typeof onUnlocked === 'function'
    ? onUnlocked
    : (/** @type {string} */ reason) => {
      ensureOffscreen?.();
      maybeStartBaseNetwork?.(reason);
    };
  const runLocked = typeof onLocked === 'function' ? onLocked : async () => {};

  return {
    'vault/initialize': async ({ passphrase }) => {
      try {
        await vault.initialize(passphrase);
        auditLog.append({ type: 'vault_initialized' }).catch(() => {});
        Promise.resolve(runInitialized()).catch((/** @type {unknown} */ e) =>
          console.error('[sw] post-initialize transition failed', e));
        return { ok: true };
      } catch (e) {
        if (e instanceof VaultAlreadyInitializedError) return { ok: false, error: 'already-initialized' };
        throw e;
      }
    },

    'vault/unlock': async ({ passphrase }) => {
      try {
        await vault.unlock(passphrase);
        auditLog.append({ type: 'vault_unlocked' }).catch(() => {});
        Promise.resolve(runUnlocked('unlock')).catch((/** @type {unknown} */ e) =>
          console.error('[sw] post-unlock transition failed', e));
        Promise.resolve(resumeGoalRuns?.())
          .catch(() => {})
          .then(() => sessionCache.sessionGet('currentSessionId'))
          .then((/** @type {any} */ cur) => maybeAutoResumeAfterRecovery(cur))
          .catch(() => {});
        Promise.resolve(resumeSchedules?.()).catch(() => {});
        return { ok: true };
      } catch (e) {
        if (e instanceof WrongPassphraseError) return { ok: false, error: 'wrong-passphrase' };
        if (e instanceof VaultNotInitializedError) return { ok: false, error: 'not-initialized' };
        if (e instanceof RecoveryPassphraseNotSetError) return { ok: false, error: 'recovery-not-set' };
        throw e;
      }
    },

    'vault/initializeWithPasskey': async ({ credentialId, prfSalt, prfOutput, transports }) => {
      if (typeof credentialId !== 'string'
          || typeof prfSalt !== 'string'
          || typeof prfOutput !== 'string') {
        return { ok: false, error: 'invalid-prf-payload' };
      }
      try {
        await vault.initializeWithPrfOnly({
          prfOutput:    base64ToBytes(prfOutput),
          credentialId: base64ToBytes(credentialId),
          prfSalt:      base64ToBytes(prfSalt),
          transports,
        });
      } catch (e) {
        if (e instanceof VaultAlreadyInitializedError) return { ok: false, error: 'already-initialized' };
        console.error('[sw] initializeWithPasskey failed, rolling back', e);
        await vault.lock();
        await runLocked();
        await purgeVaultBlob({ kv, idb });
        throw e;
      }
      auditLog.append({ type: 'vault_initialized', details: { prf: true, passkeyOnly: true } }).catch(() => {});
      auditLog.append({ type: 'vault_prf_enrolled' }).catch(() => {});
      Promise.resolve(runInitialized()).catch((/** @type {unknown} */ e) =>
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
      await vault.lock();
      await runLocked();
      auditLog.append({ type: 'vault_locked' }).catch(() => {});
      pushState();
      return { ok: true };
    },

    'vault/prfStatus': async () => {
      const status = await vault.prfStatus();
      return { ok: true, ...status };
    },

    'vault/enrollPrf': async ({ credentialId, prfSalt, prfOutput, transports }) => {
      if (typeof credentialId !== 'string'
          || typeof prfSalt !== 'string'
          || typeof prfOutput !== 'string') {
        return { ok: false, error: 'invalid-prf-payload' };
      }
      try {
        await vault.enrollPrf({
          prfOutput:    base64ToBytes(prfOutput),
          credentialId: base64ToBytes(credentialId),
          prfSalt:      base64ToBytes(prfSalt),
          transports,
        });
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
        Promise.resolve(runUnlocked('unlock-prf')).catch((/** @type {unknown} */ e) =>
          console.error('[sw] post-unlock transition failed', e));
        Promise.resolve(resumeGoalRuns?.())
          .catch(() => {})
          .then(() => sessionCache.sessionGet('currentSessionId'))
          .then((/** @type {any} */ cur) => maybeAutoResumeAfterRecovery(cur))
          .catch(() => {});
        Promise.resolve(resumeSchedules?.()).catch(() => {});
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

    'confirm/answer': async ({
      id, answer, ownerSessionId, sessionId, dispatchId,
    }, sender) => {
      const fromSidepanel = isActualSidepanelSender?.(sender) === true;
      const fromHome = isActualHomeSender?.(sender) === true;
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
      if (!resolved) return { ok: false, error: 'confirm-answer-stale-or-foreign' };
      return { ok: true };
    },
  };
};
