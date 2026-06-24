// @ts-check
// background/routes/vault.js — message-dispatcher routes for vault lifecycle
// + the confirmation answer relay.
//
// These were inline in service-worker.js. They close over NO reassigned
// module state — only stable collaborators (the vault, audit log, storage,
// error classes, and a few SW helpers) — so they move out verbatim with those
// collaborators injected through `deps`. The handler bodies are byte-identical
// to the originals; only the surrounding closure became a destructure of deps.
//
// This module imports NOTHING (every collaborator is injected), which keeps it
// Bun-importable and unit-testable. The static wiring meta-test
// (tests/meta/sw-routes-wiring.test.ts) proves the SW provides every dep this
// destructures; ESLint no-undef proves the SW's routeDeps names real bindings.

/**
 * @param {Record<string, any>} deps
 * @returns {Record<string, (msg?: any) => Promise<any>>}
 */
export const makeVaultRoutes = (deps) => {
  const {
    vault, auditLog, kv, idb, base64ToBytes,
    ensureOffscreen, maybeStartBaseNetwork, pushState, purgeVaultBlob,
    confirmCoordinator, sessionCache, maybeAutoResume, resumeGoalRuns,
    VaultAlreadyInitializedError, WrongPassphraseError, VaultNotInitializedError,
    RecoveryPassphraseNotSetError, PrfNotEnrolledError, PrfUnlockFailedError,
    VaultLockedError,
  } = deps;

  return {
    // --- vault ---
    'vault/initialize': async ({ passphrase }) => {
      try {
        await vault.initialize(passphrase);
        auditLog.append({ type: 'vault_initialized' }).catch(() => {});
        // Bring up the offscreen doc on initialize too, not just unlock.
        // Without this, a fresh first-run user creates a vault, navigates
        // around, and the SW dies after 30s because no keepalive port
        // exists — locking their just-created vault. See bug from
        // V1 manual testing 2026-06-05.
        ensureOffscreen().catch((/** @type {unknown} */ e) => console.error('[sw] ensureOffscreen failed', e));
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
        ensureOffscreen().catch((/** @type {unknown} */ e) => console.error('[sw] ensureOffscreen failed', e));
        maybeStartBaseNetwork('unlock');
        // Re-drive any goal run that paused on a mid-run auto-lock, THEN
        // auto-resume the current chat. Order matters (symmetric to the #55
        // SW-boot fix; #60): resumeGoalRuns() synchronously re-adds a paused run
        // to the runner's map (goalActiveFor → true) before its drive() awaits,
        // so chaining maybeAutoResume AFTER it guarantees the goalActiveFor guard
        // in maybeAutoResume sees the goal run and bails. The opposite order let
        // maybeAutoResume read goalActiveFor=false and re-drive the interrupted
        // turn, contending the slot and spuriously HALTING the goal run.
        // Idempotent; resumes ALL runs (a goal can run in a background chat).
        Promise.resolve(resumeGoalRuns?.())
          .catch(() => {})
          // #72: then auto-resume the current chat if its last turn was
          // interrupted (a cold SW wake unlocks here; finish what the eviction
          // cut off). Fire-and-forget; gated + deduped in the helper.
          .then(() => sessionCache.sessionGet('currentSessionId'))
          .then((/** @type {any} */ cur) => maybeAutoResume(cur))
          .catch(() => {});
        return { ok: true };
      } catch (e) {
        if (e instanceof WrongPassphraseError) return { ok: false, error: 'wrong-passphrase' };
        if (e instanceof VaultNotInitializedError) return { ok: false, error: 'not-initialized' };
        if (e instanceof RecoveryPassphraseNotSetError) return { ok: false, error: 'recovery-not-set' };
        throw e;
      }
    },

    // Passkey-first first-run: create the vault keyed ONLY by the
    // authenticator's PRF — no passphrase. The side panel runs the
    // ceremony (navigator.credentials is unavailable in the SW) and ships
    // the bytes here. A recovery passphrase can be added later from
    // settings (vault/setRecoveryPassphrase). On failure we clear any
    // partial vault so the sign-up flow re-shows cleanly.
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
          // why no shape check here: transports are OPTIONAL routing hints;
          // the vault sanitizes (array-of-short-strings or dropped). A bad
          // shape must never fail an otherwise-good enrollment.
          transports,
        });
      } catch (e) {
        if (e instanceof VaultAlreadyInitializedError) return { ok: false, error: 'already-initialized' };
        console.error('[sw] initializeWithPasskey failed, rolling back', e);
        vault.lock();
        // why purgeVaultBlob (both backends): the blob lives in IDB now,
        // with a possible legacy copy in chrome.storage.local mid-migration.
        await purgeVaultBlob({ kv, idb });
        throw e;
      }
      auditLog.append({ type: 'vault_initialized', details: { prf: true, passkeyOnly: true } }).catch(() => {});
      auditLog.append({ type: 'vault_prf_enrolled' }).catch(() => {});
      ensureOffscreen().catch((/** @type {unknown} */ e) => console.error('[sw] ensureOffscreen failed', e));
      return { ok: true };
    },

    // Add (or replace) the recovery passphrase on an already-unlocked
    // vault. The passkey stays the primary factor; this is the optional
    // fallback for device loss. Requires the vault unlocked (we wrap the
    // live DK).
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
      vault.lock();
      auditLog.append({ type: 'vault_locked' }).catch(() => {});
      // why: without a push the panel keeps rendering the unlocked UI until
      // the next unrelated state change — the Lock button must flip the
      // panel to the vault gate immediately.
      pushState();
      return { ok: true };
    },

    // --- vault: WebAuthn PRF (Touch ID) ---
    //
    // The side panel runs the WebAuthn ceremony because navigator.credentials
    // is unavailable in the MV3 service worker context. The SW receives the
    // raw 32-byte PRF output (base64) and lets the vault do the AES-KW work.
    //
    // We deliberately keep PRF bytes off the long-lived port. They flow in
    // on a one-shot sendMessage and are consumed in the SW's microtask;
    // they're never echoed back, persisted, or logged.

    'vault/prfStatus': async () => {
      // Cheap query — no DK access required. UI calls this before the
      // ceremony so it knows the credentialId + prfSalt to feed WebAuthn.
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
          // Optional routing hints; vault-side sanitize, same as
          // initializeWithPasskey above.
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
        ensureOffscreen().catch((/** @type {unknown} */ e) => console.error('[sw] ensureOffscreen failed', e));
        maybeStartBaseNetwork('unlock-prf');
        // Re-drive paused goal runs BEFORE auto-resume — see the passphrase
        // unlock path above (resume re-adds the run so the goalActiveFor guard in
        // maybeAutoResume bails for a goal-owned session; #60). Idempotent.
        Promise.resolve(resumeGoalRuns?.())
          .catch(() => {})
          // #72: then auto-resume the current chat if its last turn was
          // interrupted. Fire-and-forget; gated + deduped in the helper.
          .then(() => sessionCache.sessionGet('currentSessionId'))
          .then((/** @type {any} */ cur) => maybeAutoResume(cur))
          .catch(() => {});
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

    // --- confirmation ---
    // The side panel posts the user's answer to a pending confirm prompt;
    // we resolve the waiting Promise so the dispatcher proceeds (or blocks).
    'confirm/answer': async ({ id, answer }) => {
      // resolve → settle → onSettled broadcasts confirm/resolved to every surface
      // (DESIGN-12), so no explicit broadcast is needed here.
      confirmCoordinator.resolve(id, answer);
      return { ok: true };
    },
  };
};
