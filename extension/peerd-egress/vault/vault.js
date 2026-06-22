// @ts-check
// The vault — owns the unwrapped data key, the lock state machine, and
// the auto-lock timer.
//
// State machine
// -------------
//
//                    initialize()
//   uninitialized ───────────────► unlocked
//          ▲                          ▲ │
//          │                          │ │ lock() / auto-lock
//          │                          │ ▼
//          │       unlock()          locked
//          │ ◄────────────────────── │
//          │       (clear storage)
//
// `uninitialized` is detected by the absence of the wrapped DK in
// storage; we never expose a public reset on the vault instance (the SW
// chassis uses purgeVaultBlob for its failed-init rollback), but in dev
// the user can clear extension storage to get back here.
//
// Passphrase KDF
// --------------
// vault.v2 wraps the DK under an Argon2id-derived KEK (memory-hard;
// blunts offline GPU brute force of the at-rest blob) and records its
// full cost descriptor in the blob. Argon2id is the ONLY passphrase
// KDF — the pre-release PBKDF2 v1 format and its lazy migration were
// deleted 2026-06-12 (owner decision: 0.x, no installs in the wild, no
// compat code for users who don't exist). The WebAuthn PRF wrap is
// full-entropy and has no KDF — untouched by all of this. Policy is
// pure in kdf.js; the Argon2 derive is an injected dep (vendored WASM
// behind ./argon2.js).
//
// Blob home
// ---------
// The blob (wrapped DK + wrap metadata) lives in IndexedDB (store
// 'vault') when an `idb` dep is wired, joining the rest of the
// extension's persistent state; chrome.storage.local is the legacy
// home. Migration is decided by the pure table in blob-migration.js and
// performed lazily on the first blob access per vault instance: copy →
// read back → verify → only then delete the storage.local original. Any
// failure silently falls back to storage.local for this SW lifetime and
// retries on the next boot. Hygiene only — the blob is ciphertext in
// either backend.
//
// Auto-lock
// ---------
// Idle auto-lock is ON by default (DEFAULT_AUTO_LOCK_MS, 45min), reset on
// every `touch()`. `setSecret`/`getSecret` touch automatically; the SW also
// touches on user-initiated messages. The SW applies the user's persisted
// `vaultAutoLockMs` setting via setAutoLockMs() after async settings load
// (0 = never). Re-unlock is cheap — a single Touch ID / Windows Hello tap
// once a passkey is enrolled (unlockWithPrf). The default bounds how long
// the unwrapped DK sits live within a browser session.
//
// What this file deliberately does NOT do
// ---------------------------------------
//  - Persist the unwrapped DK to DISK. It is mirrored to
//    chrome.storage.session (RAM-only, cleared on browser close) so the DK
//    survives an MV3 SW restart within a session — never the disk. See the
//    "DK persistence" block below for the threat model.
//  - Talk to the side panel directly. The SW glues the vault to the
//    side panel via the messaging layer.
//  - Cache decrypted plaintext. Every getSecret() does a fresh decrypt.

import {
  generateDK, wrapDK, unwrapDK,
  encryptString, decryptString, generateSalt,
  importPrfKEK, importRawKEK,
} from './keys.js';
import {
  VaultLockedError, VaultNotInitializedError,
  VaultAlreadyInitializedError, WrongPassphraseError,
  PrfNotEnrolledError, PrfUnlockFailedError,
  RecoveryPassphraseNotSetError, KdfUnavailableError,
} from './errors.js';
import { planVaultBlobMigration, blobsEqual } from './blob-migration.js';
import { sanitizeTransports } from './enroll-options.js';
import {
  ARGON2_DEFAULT_PARAMS, isArgon2Params,
  planPassphraseUnlock,
  hasPassphraseWrap, withPassphraseWrap,
} from './kdf.js';
import { bytesToBase64, base64ToBytes } from '/shared/util.js';

const VAULT_KEY = 'vault.v1';
// IDB object store holding the blob (records: { key: VAULT_KEY, value }).
const VAULT_STORE = 'vault';
export const DEFAULT_AUTO_LOCK_MS = 45 * 60 * 1000;
const SECRET_PREFIX = 'secret:';

/**
 * @typedef {Object} SessionCacheLike
 * @property {(key: string) => Promise<any>} sessionGet
 * @property {(key: string, value: any) => Promise<void>} sessionSet
 * @property {(key: string) => Promise<void>} sessionDelete
 */

/**
 * @typedef {Object} IdbLike
 * @property {(store: string, key: IDBValidKey) => Promise<any>} get
 * @property {(store: string, value: any) => Promise<void>} put
 * @property {(store: string, key: IDBValidKey) => Promise<void>} del
 */

/**
 * @typedef {Object} Argon2Fn
 *           Derives 32 bytes of KEK material from a passphrase under
 *           Argon2id. Production wiring injects deriveArgon2id from
 *           ./argon2.js (the vendored WASM); tests inject deterministic
 *           fakes. Injected rather than imported so the vault core
 *           stays WASM-free and Bun-testable.
 * @type {(args: { passphrase: string, salt: Uint8Array, memKiB: number,
 *                 iters: number, parallelism: number }) => Promise<Uint8Array>}
 */

/**
 * @typedef {Object} VaultDeps
 * @property {import('../storage/kv.js').KV} kv
 * @property {IdbLike} [idb]                      IndexedDB wrapper; when provided,
 *                                                the vault blob lives in the IDB
 *                                                'vault' store (with a one-time,
 *                                                verified migration off
 *                                                chrome.storage.local). Absent →
 *                                                legacy kv-resident blob.
 * @property {Argon2Fn} [argon2]                  Argon2id derive — REQUIRED for any
 *                                                passphrase factor (the only KDF).
 *                                                Absent → the vault is PRF-only:
 *                                                passphrase initialize/set/unlock
 *                                                throw KdfUnavailableError.
 * @property {Argon2ParamsInput} [argon2Params]   Argon2id cost-parameter override
 *                                                ({ algo, memKiB, iters,
 *                                                parallelism }); defaults to
 *                                                ARGON2_DEFAULT_PARAMS. Params are
 *                                                data — each wrap records its own
 *                                                descriptor. The fields are typed
 *                                                loosely because isArgon2Params
 *                                                is the runtime gate (it pins
 *                                                algo/parallelism); the factory
 *                                                throws on anything it rejects.
 * @property {SessionCacheLike} [sessionCache]    chrome.storage.session wrapper;
 *                                                when provided, the vault persists
 *                                                the unwrapped DK across SW restarts.
 * @property {() => number} [now]                used by tests; defaults to Date.now
 * @property {(n: number) => Uint8Array} [randomBytes]
 * @property {number} [autoLockMs]               default 45min
 * @property {(fn: () => void, ms: number) => any} [setTimer]   defaults to setTimeout
 * @property {(handle: any) => void} [clearTimer]               defaults to clearTimeout
 */

/**
 * Argon2id cost parameters as accepted from a caller / build override —
 * the salt-less half of the descriptor. Looser than Argon2Descriptor on
 * purpose: isArgon2Params validates algo === 'argon2id' and
 * parallelism === 1 at runtime, so the static type doesn't re-pin them.
 *
 * @typedef {Object} Argon2ParamsInput
 * @property {string} algo
 * @property {number} memKiB
 * @property {number} iters
 * @property {number} parallelism
 */

/**
 * @typedef {Object} VaultEvent
 * @property {'initialized' | 'unlocked' | 'locked' | 'prf_enrolled' | 'prf_disabled' | 'recovery_set'} type
 */

// Key in chrome.storage.session under which the unwrapped DK bytes live
// when sessionCache is wired. Session storage is RAM-only and cleared
// on browser close, so this never lands on disk — it's purely a way to
// survive SW restart during a single browser session.
const SESSION_DK_KEY = 'vault.unlocked.v1';

/**
 * Factory for the vault. The vault is a long-lived singleton in the SW
 * (one per extension instance); tests build a fresh one per case with
 * a mock KV.
 *
 * @param {VaultDeps} deps
 */
export const createVault = (deps) => {
  const {
    kv,
    idb,
    sessionCache,
    argon2,
    now = Date.now,
    randomBytes,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = deps;
  const argon2Params = deps.argon2Params ?? ARGON2_DEFAULT_PARAMS;
  if (!isArgon2Params(argon2Params)) {
    // why throw at construction: bad params here are a programmer error
    // (the descriptor every future wrap would record), not user input —
    // fail at wiring time, not at the first unlock.
    throw new TypeError('vault: invalid argon2Params');
  }
  // Mutable so setAutoLockMs() can change the idle policy at runtime (the
  // SW applies the user's persisted setting after async settings load,
  // which happens AFTER the vault is constructed).
  let autoLockMs = deps.autoLockMs ?? DEFAULT_AUTO_LOCK_MS;

  /** @type {CryptoKey | null} */
  let dk = null;
  /** @type {ReturnType<typeof setTimer> | null} */
  let timerHandle = null;
  let unlockedAt = 0;
  /** @type {Set<(e: VaultEvent) => void>} */
  const listeners = new Set();

  /** @param {VaultEvent} event */
  const notify = (event) => {
    for (const l of listeners) {
      try { l(event); }
      catch (e) { console.error('[vault] listener threw', e); }
    }
  };

  const armAutoLock = () => {
    if (timerHandle !== null) clearTimer(timerHandle);
    // autoLockMs ≤ 0 (or non-finite) is the "never auto-lock" opt-out
    // (set via the vaultAutoLockMs setting). Even then the vault still
    // locks on:
    //   - explicit vault.lock() (e.g. user clicks a Lock button)
    //   - SW termination (but the DK is mirrored to chrome.storage.session,
    //     so a restart within the session resumes unlocked — see attemptResume)
    //   - browser shutdown (session storage is cleared)
    // The DEFAULT is ON (45min) so the unwrapped DK doesn't sit live for the
    // whole browser session; re-unlock is a single passkey tap.
    if (!(autoLockMs > 0) || !Number.isFinite(autoLockMs)) return;
    timerHandle = setTimer(lock, autoLockMs);
  };

  const isLocked = () => dk === null;

  const touch = () => { if (!isLocked()) armAutoLock(); };

  /**
   * Change the idle auto-lock interval at runtime. `ms <= 0` (or
   * non-finite) disables idle auto-lock; a positive value (re)arms it.
   * Re-arms immediately when the vault is unlocked so a setting change
   * takes effect without waiting for the next touch().
   *
   * @param {number} ms
   */
  const setAutoLockMs = (ms) => {
    autoLockMs = (Number.isFinite(ms) && ms > 0) ? ms : 0;
    if (!isLocked()) armAutoLock();
  };

  const lock = () => {
    if (dk === null) return;
    dk = null;
    if (timerHandle !== null) {
      clearTimer(timerHandle);
      timerHandle = null;
    }
    unlockedAt = 0;
    // Clear the persisted DK so a SW restart doesn't auto-unlock.
    _clearPersistedDK();
    notify({ type: 'locked' });
  };

  // ---- Blob home (IDB with verified migration off chrome.storage.local) --
  // All blob reads/writes funnel through getBlob/setBlob, which resolve
  // the backend ONCE per vault instance (≈ once per SW boot). The pure
  // decision table lives in blob-migration.js; only the IO is here.

  /** @type {Promise<'idb' | 'kv'> | null} */
  let blobHomePromise = null;

  const _migrateBlob = async () => {
    // why: _blobHome only calls this when `idb` is wired, so this never
    // fires at runtime — it narrows `idb` to non-undefined for the type
    // checker across the four uses below.
    if (!idb) return 'kv';
    let idbValue, kvValue;
    try {
      idbValue = (await idb.get(VAULT_STORE, VAULT_KEY))?.value;
      kvValue  = await kv.get(VAULT_KEY);
    } catch (e) {
      // IDB unreadable (corrupt profile, version race) — storage.local
      // still works, so keep the vault usable and retry next boot.
      console.warn('[vault] blob backend probe failed; staying on storage.local', e);
      return 'kv';
    }
    const plan = planVaultBlobMigration({ idbValue, kvValue });
    try {
      if (plan.action === 'delete-kv') {
        // Verified copies on both sides — finish an interrupted
        // migration. A failed delete is retried next boot.
        await kv.delete(VAULT_KEY);
      } else if (plan.action === 'delete-idb') {
        // Poisoned IDB leftover from a failed copy — scrub it so a
        // later migration starts clean. Best-effort: kv stays the
        // backend either way.
        await idb.del(VAULT_STORE, VAULT_KEY).catch(() => {});
      } else if (plan.action === 'copy') {
        await idb.put(VAULT_STORE, { key: VAULT_KEY, value: kvValue });
        const readBack = (await idb.get(VAULT_STORE, VAULT_KEY))?.value;
        // why read-back-and-verify: the wrapped DK is the only path to
        // every stored secret. We never delete the storage.local
        // original on the strength of a resolved put() alone.
        if (!blobsEqual(readBack, kvValue)) throw new Error('read-back mismatch');
        await kv.delete(VAULT_KEY);
      }
    } catch (e) {
      if (plan.action === 'copy') {
        // Surface nothing (per the migration contract): scrub the
        // unverified IDB record, keep serving from storage.local, and
        // let the next SW boot retry.
        console.warn('[vault] blob migration failed; staying on storage.local', e);
        await idb.del(VAULT_STORE, VAULT_KEY).catch(() => {});
        return 'kv';
      }
      // delete-kv cleanup failing doesn't change where the truth lives.
      console.warn('[vault] blob migration cleanup failed', e);
    }
    return plan.backend;
  };

  const _blobHome = () => {
    if (!idb) return Promise.resolve('kv');
    blobHomePromise ??= _migrateBlob();
    return blobHomePromise;
  };

  // why the casts in getBlob/setBlob: the 'idb' branch is only taken when
  // _blobHome resolved to 'idb', which it only does when `idb` is wired —
  // an invariant the checker can't see from the string result.
  const getBlob = async () =>
    (await _blobHome()) === 'idb'
      ? (await (/** @type {IdbLike} */ (idb)).get(VAULT_STORE, VAULT_KEY))?.value
      : kv.get(VAULT_KEY);

  /** @param {any} value */
  const setBlob = async (value) => {
    if ((await _blobHome()) === 'idb') {
      await (/** @type {IdbLike} */ (idb)).put(VAULT_STORE, { key: VAULT_KEY, value });
    } else {
      await kv.set(VAULT_KEY, value);
    }
  };

  const isInitialized = async () => {
    return (await getBlob()) !== undefined;
  };

  // ---- DK persistence (chrome.storage.session) ---------------------------
  // When sessionCache is wired, we export the unwrapped DK as raw bytes,
  // base64 them, and store under SESSION_DK_KEY so the next SW boot can
  // restore the unlocked state via attemptResume(). Session storage is
  // RAM-only and cleared on browser close, so this never lands on disk.
  //
  // Threat model: anything with extension code execution already has
  // access to SW memory (and thus the DK). Persisting to session
  // storage exposes the DK to the same set of attackers; no new surface.

  const _persistDK = async () => {
    if (!sessionCache || dk === null) return;
    try {
      const raw = await crypto.subtle.exportKey('raw', dk);
      await sessionCache.sessionSet(SESSION_DK_KEY,
        bytesToBase64(new Uint8Array(raw)));
    } catch (e) {
      console.error('[vault] persist DK failed', e);
    }
  };

  const _clearPersistedDK = () => {
    if (!sessionCache) return;
    sessionCache.sessionDelete(SESSION_DK_KEY).catch((e) =>
      console.error('[vault] clear persisted DK failed', e));
  };

  /**
   * Attempt to restore an unlocked vault from chrome.storage.session.
   * Used at SW boot to survive SW-restart-due-to-idle-timeout.
   *
   * Returns true if the resume succeeded (vault is now unlocked),
   * false otherwise (vault remains in its prior state — typically
   * locked). Safe to call when already unlocked (returns true) or
   * when no sessionCache is wired (returns false).
   */
  const attemptResume = async () => {
    if (!sessionCache) return false;
    if (!isLocked()) return true;
    const stored = await sessionCache.sessionGet(SESSION_DK_KEY);
    if (!stored) return false;
    try {
      const bytes = base64ToBytes(stored);
      dk = await crypto.subtle.importKey(
        'raw',
        // why the cast: see keys.js — a plain Uint8Array isn't a
        // BufferSource to the DOM types, but the vault never SAB-backs one.
        /** @type {BufferSource} */ (bytes),
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt'],
      );
      unlockedAt = now();
      armAutoLock();
      notify({ type: 'unlocked' });
      return true;
    } catch (e) {
      console.error('[vault] resume failed; clearing persisted DK', e);
      _clearPersistedDK();
      return false;
    }
  };

  // chrome.storage.local serializes via JSON, which doesn't preserve
  // Uint8Array. We base64-encode all binary values at the kv boundary
  // and decode on read. The vault is the only V1 caller storing binary
  // data, so the encoding lives here. If more callers need binary
  // storage later, this moves into the kv wrapper as a transparent
  // type-tagged shim.
  /** @param {string} v   base64 */
  const _bytes = (v) => base64ToBytes(v);

  // ---- Passphrase KDF (vault.v2 Argon2id, legacy v1 PBKDF2) ---------------
  // The pure policy (descriptor validation, unlock planning, migration
  // decision, blob building) lives in kdf.js; only the derive IO is here.

  /**
   * Derive an AES-KW KEK from a passphrase under an Argon2id descriptor.
   *
   * @param {string} passphrase
   * @param {import('./kdf.js').Argon2Descriptor} kdf
   */
  const _deriveArgon2KEK = async (passphrase, kdf) => {
    // why the cast: this is private and only reached on paths that have
    // already established argon2 is wired (_makePassphraseWrap guards it;
    // unlock only gets here when planPassphraseUnlock returned 'argon2id',
    // which requires argon2Available). The type can't see that invariant.
    const raw = await (/** @type {Argon2Fn} */ (argon2))({
      passphrase,
      salt: _bytes(kdf.salt),
      memKiB: kdf.memKiB,
      iters: kdf.iters,
      parallelism: kdf.parallelism,
    });
    const kek = await importRawKEK(raw);
    // why: importKey copies; zero our reference so the raw KEK material
    // doesn't linger in JS heap longer than it must. Best-effort hygiene.
    raw.fill(0);
    return kek;
  };

  /**
   * Wrap a DK under a passphrase — Argon2id (vault.v2), the ONLY
   * passphrase KDF. There is no PBKDF2 fallback and no v1 migration
   * path: peerd is 0.x with no installs in the wild (owner decision,
   * 2026-06-12), so backwards compat would be code for users who don't
   * exist. A vault built without the argon2 dep simply has no
   * passphrase factor (PRF-only). Every wrap gets a FRESH salt and
   * records its full descriptor — params are data.
   *
   * @param {string} passphrase
   * @param {CryptoKey} dkToWrap
   */
  const _makePassphraseWrap = async (passphrase, dkToWrap) => {
    if (!argon2) throw new KdfUnavailableError();
    const salt = generateSalt(randomBytes);
    // why the cast: argon2Params passed isArgon2Params at construction, so
    // algo === 'argon2id' and parallelism === 1 hold — the literal fields
    // an Argon2Descriptor requires but Argon2ParamsInput types loosely.
    const kdf = /** @type {import('./kdf.js').Argon2Descriptor} */ (
      { ...argon2Params, salt: bytesToBase64(salt) });
    const kek = await _deriveArgon2KEK(passphrase, kdf);
    return { wrappedDK: bytesToBase64(await wrapDK(dkToWrap, kek)), kdf };
  };

  /** @param {string} passphrase */
  const initialize = async (passphrase) => {
    if (await isInitialized()) throw new VaultAlreadyInitializedError();
    const newDK = await generateDK();
    const wrap = await _makePassphraseWrap(passphrase, newDK);
    await setBlob({
      ...withPassphraseWrap({}, wrap),
      createdAt: now(),
    });
    dk = newDK;
    unlockedAt = now();
    armAutoLock();
    _persistDK();
    notify({ type: 'initialized' });
  };

  /**
   * Passkey-first initialization. Creates the vault with the DK wrapped
   * ONLY under the WebAuthn PRF KEK — no passphrase wrap. The vault is
   * recoverable solely via the bound authenticator until the user later
   * calls setRecoveryPassphrase(). The caller runs the WebAuthn ceremony
   * and supplies the bytes; the vault stays navigator.credentials-free.
   *
   * @param {Object} args
   * @param {Uint8Array} args.prfOutput     32 bytes from the authenticator
   * @param {Uint8Array} args.credentialId  WebAuthn credential ID
   * @param {Uint8Array} args.prfSalt       Salt used in the PRF eval
   * @param {string[] | null} [args.transports]  getTransports() hints
   */
  const initializeWithPrfOnly = async ({ prfOutput, credentialId, prfSalt, transports }) => {
    if (await isInitialized()) throw new VaultAlreadyInitializedError();
    const newDK = await generateDK();
    const prfKEK = await importPrfKEK(prfOutput);
    const wrapped = await wrapDK(newDK, prfKEK);
    // why prfTransports is ADDITIVE and optional: blobs written before
    // transports were recorded (or by authenticators that don't report
    // them) simply lack the field, and the unlock ceremony treats the
    // absence as "let the platform try everything" — the legacy behavior.
    const prfTransports = sanitizeTransports(transports);
    await setBlob({
      version: 1,
      // why: NO wrappedDK / salt — there is no passphrase factor yet.
      // setRecoveryPassphrase() adds one later, non-destructively.
      wrappedDK_prf: bytesToBase64(wrapped),
      credentialId:  bytesToBase64(credentialId),
      prfSalt:       bytesToBase64(prfSalt),
      ...(prfTransports ? { prfTransports } : {}),
      createdAt: now(),
    });
    dk = newDK;
    unlockedAt = now();
    armAutoLock();
    _persistDK();
    notify({ type: 'initialized' });
    notify({ type: 'prf_enrolled' });
  };

  /** @param {string} passphrase */
  const unlock = async (passphrase) => {
    const stored = await getBlob();
    if (!stored) throw new VaultNotInitializedError();
    const plan = planPassphraseUnlock({ blob: stored, argon2Available: !!argon2 });
    // why: a passkey-only vault has no passphrase wrap. Surface that
    // distinctly so the UI says "unlock with your passkey" rather than
    // "wrong passphrase".
    if (plan.path === 'none') throw new RecoveryPassphraseNotSetError();
    // why a distinct error (not WrongPassphraseError): on these paths NO
    // passphrase can ever succeed — the descriptor is unknown/tampered,
    // or this build has no Argon2 wired for a v2 wrap. Telling the user
    // to retype their passphrase would be a lie. No new side channel:
    // the descriptor is plaintext blob metadata either way.
    if (plan.path === 'unsupported' || plan.path === 'unavailable') {
      throw new KdfUnavailableError();
    }
    // Only the 'argon2id' path remains, and planPassphraseUnlock always
    // carries the descriptor on it — narrow the optional field.
    const kek = await _deriveArgon2KEK(passphrase, /** @type {import('./kdf.js').Argon2Descriptor} */ (plan.kdf));
    try {
      // unwrapDK throws on tampered ciphertext or wrong KEK; either way
      // we surface WrongPassphraseError. We intentionally don't leak the
      // underlying SubtleCrypto error to the caller — that would be a
      // small side channel for distinguishing "wrong passphrase" from
      // "tampered ciphertext" which an attacker with storage access
      // shouldn't get to differentiate.
      dk = await unwrapDK(_bytes(stored.wrappedDK), kek);
    } catch (_e) {
      throw new WrongPassphraseError();
    }
    unlockedAt = now();
    armAutoLock();
    _persistDK();
    notify({ type: 'unlocked' });
  };

  // ---- PRF (WebAuthn Touch ID) unlock path -------------------------------
  // The vault is symmetric in unlock paths: the same DK can be wrapped
  // multiple times under different KEKs (passphrase, PRF, future others)
  // and any one wrap suffices to recover it. We store the PRF wrap
  // alongside the passphrase wrap under `wrappedDK_prf`, with the
  // credentialId + prfSalt needed to drive the WebAuthn ceremony on
  // future unlocks. Disabling PRF is non-destructive — the passphrase
  // wrap is never touched.
  //
  // The vault itself is WebAuthn-agnostic. The 32-byte PRF output is
  // supplied by the caller (the side panel runs the ceremony; the SW
  // forwards the bytes here). This keeps the document-context dep —
  // navigator.credentials — out of the SW and out of the egress
  // module's pure surface.

  /**
   * why the explicit discriminated union: without it TS widens `enrolled` to
   * `boolean` across the two returns, so `if (status.enrolled)` doesn't narrow
   * and callers can't reach credentialId/prfSalt/transports without a cast.
   * @returns {Promise<{ enrolled: false } | { enrolled: true, credentialId: string, prfSalt: string, transports?: string[] }>}
   */
  const prfStatus = async () => {
    const stored = await getBlob();
    if (!stored?.wrappedDK_prf || !stored?.credentialId || !stored?.prfSalt) {
      return { enrolled: false };
    }
    const transports = sanitizeTransports(stored.prfTransports);
    return {
      enrolled: true,
      credentialId: stored.credentialId,   // base64; UI passes opaque
      prfSalt:      stored.prfSalt,        // base64; UI passes opaque
      // Plain strings (or absent on pre-transports enrollments); the UI
      // feeds them into allowCredentials so a security-key unlock
      // prompts for the key instead of poking the platform authenticator.
      ...(transports ? { transports } : {}),
    };
  };

  /**
   * Whether a recovery passphrase wrap exists. Cheap (one blob read); the
   * SW surfaces this so settings can show "Set recovery passphrase" vs
   * "Change recovery passphrase", and so the unlock UI only offers the
   * passphrase path when it can actually succeed.
   */
  const hasRecoveryPassphrase = async () => {
    const stored = await getBlob();
    return hasPassphraseWrap(stored);
  };

  /**
   * Add (or replace) the passphrase recovery factor on an unlocked
   * vault. Wraps the live DK under a freshly-salted passphrase KEK and
   * stores it alongside any existing PRF wrap — non-destructive, mirrors
   * enrollPrf but for the passphrase factor. This is how a passkey-first
   * user opts into a recovery passphrase later, from settings.
   *
   * @param {string} passphrase
   */
  const setRecoveryPassphrase = async (passphrase) => {
    if (isLocked()) throw new VaultLockedError();
    const stored = await getBlob();
    if (!stored) throw new VaultNotInitializedError();
    // dk is non-null here: isLocked() threw above otherwise. The checker
    // can't narrow through the isLocked() helper, so assert it.
    const wrap = await _makePassphraseWrap(passphrase, /** @type {CryptoKey} */ (dk));
    await setBlob(withPassphraseWrap(stored, wrap));
    notify({ type: 'recovery_set' });
  };

  /**
   * Bind a platform authenticator's PRF output to this vault. Requires
   * the vault to be unlocked (we need access to the DK to wrap it). The
   * caller is responsible for running the WebAuthn ceremony and passing
   * us the resulting bytes; the vault does not depend on
   * navigator.credentials.
   *
   * Idempotent at the API level: enrolling a new credential overwrites
   * the previous binding. There is no V1 surface for keeping multiple
   * concurrent PRF credentials enrolled.
   *
   * @param {Object} args
   * @param {Uint8Array} args.prfOutput     32 bytes from the authenticator
   * @param {Uint8Array} args.credentialId  WebAuthn credential ID
   * @param {Uint8Array} args.prfSalt       Salt the caller used in eval.first
   * @param {string[] | null} [args.transports]  getTransports() hints
   */
  const enrollPrf = async ({ prfOutput, credentialId, prfSalt, transports }) => {
    if (isLocked()) throw new VaultLockedError();
    const stored = await getBlob();
    if (!stored) throw new VaultNotInitializedError();
    const prfKEK = await importPrfKEK(prfOutput);
    // dk is non-null here: isLocked() threw above otherwise.
    const wrapped = await wrapDK(/** @type {CryptoKey} */ (dk), prfKEK);
    const prfTransports = sanitizeTransports(transports);
    const next = {
      ...stored,
      wrappedDK_prf: bytesToBase64(wrapped),
      credentialId:  bytesToBase64(credentialId),
      prfSalt:       bytesToBase64(prfSalt),
      ...(prfTransports ? { prfTransports } : {}),
    };
    // why delete on re-enroll without transports: the field describes
    // THIS credential; a stale list from the previous credential could
    // mis-route the unlock prompt (e.g. ask for a USB key after the
    // user re-enrolled Touch ID).
    if (!prfTransports) delete next.prfTransports;
    await setBlob(next);
    notify({ type: 'prf_enrolled' });
  };

  /**
   * Unlock via a 32-byte PRF output obtained from a previously enrolled
   * authenticator. Surfaces PrfNotEnrolledError if no PRF wrap is
   * stored; surfaces PrfUnlockFailedError if the unwrap fails (wrong
   * authenticator, tampered storage, etc.).
   *
   * @param {Uint8Array} prfOutput
   */
  const unlockWithPrf = async (prfOutput) => {
    const stored = await getBlob();
    if (!stored) throw new VaultNotInitializedError();
    if (!stored.wrappedDK_prf) throw new PrfNotEnrolledError();
    const prfKEK = await importPrfKEK(prfOutput);
    try {
      dk = await unwrapDK(_bytes(stored.wrappedDK_prf), prfKEK);
    } catch (_e) {
      // why: do not leak whether the bytes were wrong or the ciphertext
      // tampered — same side-channel concern as WrongPassphraseError.
      throw new PrfUnlockFailedError();
    }
    unlockedAt = now();
    armAutoLock();
    _persistDK();
    notify({ type: 'unlocked' });
  };

  /**
   * Tear down the PRF binding. Leaves the passphrase wrap intact. The
   * UI is expected to call this when the user clicks "Stop using Touch
   * ID" or when an unlock attempt keeps failing.
   */
  const disablePrf = async () => {
    if (isLocked()) throw new VaultLockedError();
    const stored = await getBlob();
    if (!stored) throw new VaultNotInitializedError();
    if (!stored.wrappedDK_prf) return;     // already disabled — idempotent
    // why: never strip the LAST unlock factor. On a passkey-only vault
    // (no passphrase wrap) removing the PRF wrap would make the DK
    // unrecoverable the moment the vault locks. Force the user to set a
    // recovery passphrase first. Either wrap generation (v1 salt or v2
    // kdf descriptor) counts.
    if (!hasPassphraseWrap(stored)) throw new RecoveryPassphraseNotSetError();
    const next = { ...stored };
    delete next.wrappedDK_prf;
    delete next.credentialId;
    delete next.prfSalt;
    delete next.prfTransports;
    await setBlob(next);
    notify({ type: 'prf_disabled' });
  };

  /** @param {string} name @param {string} plaintext */
  const setSecret = async (name, plaintext) => {
    if (isLocked()) throw new VaultLockedError();
    // dk is non-null here: isLocked() threw above otherwise.
    const blob = await encryptString(/** @type {CryptoKey} */ (dk), plaintext);
    await kv.set(SECRET_PREFIX + name, bytesToBase64(blob));
    touch();
  };

  /** @param {string} name */
  const getSecret = async (name) => {
    if (isLocked()) throw new VaultLockedError();
    const stored = await kv.get(SECRET_PREFIX + name);
    if (stored === undefined || stored === null) return null;
    touch();
    // dk is non-null here: isLocked() threw above otherwise.
    return decryptString(/** @type {CryptoKey} */ (dk), _bytes(stored));
  };

  /**
   * Remove a stored secret. No-op if missing. Touches the vault.
   *
   * @param {string} name
   */
  const deleteSecret = async (name) => {
    if (isLocked()) throw new VaultLockedError();
    await kv.delete(SECRET_PREFIX + name);
    touch();
  };

  /**
   * List stored secret names. Does NOT decrypt; cheap to call from UI
   * to render "you have keys for: anthropic, openai".
   */
  const listSecretNames = async () => {
    if (isLocked()) throw new VaultLockedError();
    const all = await kv.list(SECRET_PREFIX);
    touch();
    return Object.keys(all).map((k) => k.slice(SECRET_PREFIX.length));
  };

  /** @param {(e: VaultEvent) => void} l */
  const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l); };

  return Object.freeze({
    initialize,
    initializeWithPrfOnly,
    unlock,
    lock,
    touch,
    setAutoLockMs,
    isLocked,
    isInitialized,
    setSecret,
    getSecret,
    deleteSecret,
    listSecretNames,
    subscribe,
    attemptResume,
    prfStatus,
    hasRecoveryPassphrase,
    setRecoveryPassphrase,
    enrollPrf,
    unlockWithPrf,
    disablePrf,
    /** Current unlock timestamp, 0 if locked. The SW reports it to the
     * UI so the side panel can show an "older than auto-lock" hint
     * without poking the vault first (see session-cache.js header). */
    unlockedAt: () => unlockedAt,
  });
};

/**
 * Remove the vault blob from BOTH backends. This is the SW chassis's
 * rollback for a failed passkey-first initialization (a half-written
 * blob would wedge the vault in "initialized but un-unlockable") — kept
 * out of the vault instance so there is still no public reset on the
 * object that holds the DK. Best-effort on each backend (same posture
 * as the pre-migration rollback's swallowed kv.delete).
 *
 * @param {{ kv: import('../storage/kv.js').KV, idb?: IdbLike }} deps
 */
export const purgeVaultBlob = async ({ kv, idb }) => {
  await kv.delete(VAULT_KEY).catch(() => {});
  if (idb) await idb.del(VAULT_STORE, VAULT_KEY).catch(() => {});
};
