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
// The idle TIMER only bounds THIS service worker's memory — it dies with
// the SW. The session mirror below outlives it, so it carries its own
// deadline and attemptResume() enforces it; see "DK persistence".
//
// The resident DK is non-extractable
// -----------------------------------
// The DK this file holds in `dk` — the one handed to encryptString /
// decryptString — is unwrapped NON-EXTRACTABLE, so `exportKey` on it
// rejects and a bug that leaks the reference cannot turn it into bytes
// (residual R11). The two operations that must WRAP the live DK under a
// NEW factor (setRecoveryPassphrase, enrollPrf) are never given the
// factor the blob is already sealed under, so they cannot re-derive a
// KEK and re-unwrap it. They go through `_wrappableDK()` instead — see
// the "Re-wrap seam" block below.
//
// What this file deliberately does NOT do
// ---------------------------------------
//  - Persist the unwrapped DK to DISK. It is mirrored to
//    chrome.storage.session (RAM-only, cleared on browser close) so the DK
//    survives an MV3 SW restart within a session — never the disk. That
//    mirror is bounded: it carries the unlock time + the auto-lock policy
//    in force, and a resume past that deadline is refused and the mirror
//    purged. See the "DK persistence" block below for the threat model.
//  - Talk to the side panel directly. The SW glues the vault to the
//    side panel via the messaging layer.
//  - Cache decrypted plaintext. Every getSecret() does a fresh decrypt.

import {
  generateDK, wrapDK, unwrapDK, unwrapWrappableDK,
  importWrappableDK, exportRawDK, generateRewrapKEK,
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
import { DEFAULT_AUTO_LOCK_MS } from './constants.js';
export { DEFAULT_AUTO_LOCK_MS } from './constants.js';
export { purgeVaultBlob } from './purge.js';

const VAULT_KEY = 'vault.v1';
// IDB object store holding the blob (records: { key: VAULT_KEY, value }).
const VAULT_STORE = 'vault';
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

// ---- The session DK mirror: pure core ------------------------------------
// The mirror is the one piece of vault state that OUTLIVES the service
// worker, so it cannot rely on anything held in SW memory (the idle timer
// dies with the SW). It therefore carries its own deadline, and every boot
// re-judges it before touching the bytes. The decision is a pure function so
// the interesting cases — stale, legacy, malformed, opted-out — are testable
// without a browser; all IO (read, purge, import) stays in the vault shell.

/**
 * The record written to chrome.storage.session under SESSION_DK_KEY.
 *
 * @typedef {Object} DKMirror
 * @property {string} dk           raw DK bytes, base64
 * @property {number} unlockedAt   ms epoch of the unlock this mirror belongs
 *                                 to — the deadline anchor. PRESERVED across a
 *                                 resume, so resuming can never extend the
 *                                 window.
 * @property {number} autoLockMs   the idle policy in force when the mirror was
 *                                 written; 0 = the user's "never" opt-out
 *                                 (unbounded mirror). why it is RECORDED rather
 *                                 than read at resume time: the SW constructs
 *                                 the vault with the DEFAULT interval and only
 *                                 applies the user's stored setting once
 *                                 storage has loaded — a boot-time resume races
 *                                 that, and would otherwise judge the mirror
 *                                 against a policy the user never chose.
 */

/**
 * Build the mirror record. Normalizes the "never auto-lock" opt-out (≤ 0 or
 * non-finite) to a plain 0 so the planner has exactly one shape to read.
 *
 * @param {{ dk: string, unlockedAt: number, autoLockMs: number }} args
 * @returns {DKMirror}
 */
export const makeMirrorRecord = ({ dk, unlockedAt, autoLockMs }) => ({
  dk,
  unlockedAt,
  autoLockMs: (Number.isFinite(autoLockMs) && autoLockMs > 0) ? autoLockMs : 0,
});

/**
 * Decide what a fresh service worker may do with whatever sits under
 * SESSION_DK_KEY. Pure — the caller does the read, the purge and the import.
 *
 * why 'refuse' is distinct from 'absent': a refused mirror must also be
 * PURGED. Anything we decline to use is either past its deadline or
 * unreadable, and leaving it there just hands the next boot the same
 * decision over older bytes.
 *
 * why a missing or unparseable timestamp fails CLOSED: without one the age of
 * the bytes is unknowable, and "unknown age" is exactly the unbounded
 * lifetime this check exists to close. That also covers the pre-deadline
 * mirror format (a bare base64 string): one re-unlock, once, on upgrade.
 *
 * @param {Object} args
 * @param {unknown} args.stored       whatever sessionGet returned
 * @param {number} args.now           ms epoch
 * @param {number} args.autoLockMs    fallback policy, used only when the
 *                                    record does not carry its own
 * @returns {{ action: 'absent' }
 *          | { action: 'refuse', reason: 'legacy' | 'malformed' | 'expired' }
 *          | { action: 'resume', dk: string, unlockedAt: number }}
 */
export const planMirrorResume = ({ stored, now, autoLockMs }) => {
  if (stored === undefined || stored === null || stored === '') return { action: 'absent' };
  if (typeof stored === 'string') return { action: 'refuse', reason: 'legacy' };
  if (typeof stored !== 'object') return { action: 'refuse', reason: 'malformed' };
  const { dk, unlockedAt, autoLockMs: written } = /** @type {any} */ (stored);
  if (typeof dk !== 'string' || dk === '') return { action: 'refuse', reason: 'malformed' };
  if (!Number.isFinite(unlockedAt) || unlockedAt <= 0) return { action: 'refuse', reason: 'malformed' };
  const policy = Number.isFinite(written) ? written : autoLockMs;
  // The "never auto-lock" opt-out: an unbounded mirror, today's behavior.
  if (!(policy > 0)) return { action: 'resume', dk, unlockedAt };
  if (now - unlockedAt >= policy) return { action: 'refuse', reason: 'expired' };
  return { action: 'resume', dk, unlockedAt };
};

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

  /** The resident data key. NON-EXTRACTABLE — see the file header.
   * @type {CryptoKey | null} */
  let dk = null;
  // ---- Re-wrap seam ------------------------------------------------------
  // The DK, kept a second time as CIPHERTEXT under an ephemeral,
  // non-extractable AES-KW key that never leaves this closure. Both halves
  // are minted at adopt time and dropped on lock().
  //
  // why this exists: enrollPrf / setRecoveryPassphrase have to feed the
  // live DK to wrapKey, which refuses a non-extractable key, and they
  // arrive holding only the NEW factor — nothing that opens the stored
  // blob. Rather than keep an extractable DK resident for the whole
  // session (exactly what R11 names), they materialize one here, spend it
  // on a single wrapKey, and drop it.
  //
  // why ciphertext + a browser-held key rather than the raw bytes: a heap
  // dump, a stray log, or an accidental serialization of this closure
  // yields a 40-byte AES-KW blob, not a key. Recovering the DK from it
  // takes a reference to `rewrapKek` too, and that one is non-extractable
  // by construction. This is defense in depth, not a new trust boundary:
  // code that already owns the vault closure can just call getSecret.
  /** @type {CryptoKey | null} */
  let rewrapKek = null;
  /** @type {Uint8Array | null} */
  let rewrappedDK = null;
  /** @type {ReturnType<typeof setTimer> | null} */
  let timerHandle = null;
  let unlockedAt = 0;
  /** Bumped by every lock() call, including a lock on an already-locked
   * vault. Anything that wants to WRITE the session mirror captures it
   * first and re-checks before the write: a lock that lands mid-flight
   * must win, or an in-flight persist would resurrect bytes the user just
   * asked us to forget. */
  let lockEpoch = 0;
  // WHY the vault locked, for the unlock screen's one added sentence (§5g):
  // 'idle' (the auto-lock timer, or a mirror expired past the idle policy),
  // 'manual' (an explicit lock()), or null - a fresh SW that never locked
  // this session, which is also what "absent on first unlock" requires.
  /** @type {'idle'|'manual'|null} */
  let lockReason = null;
  /** Tail of the serialized session-mirror write/delete chain.
   * @type {Promise<void>} */
  let mirrorQueue = Promise.resolve();
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
    timerHandle = setTimer(() => lock('idle'), autoLockMs);
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
    if (isLocked()) return;
    armAutoLock();
    // The mirror outlives this SW, so the new policy has to reach it too.
    _restampMirrorPolicy();
  };

  /**
   * Take a freshly obtained EXTRACTABLE data key and make it the
   * resident one. Mints the re-wrap material, then re-derives `dk` as a
   * non-extractable handle on the same key. The caller's `fresh` handle
   * is the transient one — it must not be stored.
   *
   * why all three assignments land together at the end: a throw part-way
   * (generateKey/wrap/unwrap) must leave the vault LOCKED rather than
   * half-unlocked with no way to re-wrap.
   *
   * @param {CryptoKey} fresh   extractable; from generateDK, unwrapWrappableDK
   *                            or importWrappableDK
   */
  const _adoptDK = async (fresh) => {
    const kek = await generateRewrapKEK();
    const rewrapped = await wrapDK(fresh, kek);
    const resident = await unwrapDK(rewrapped, kek);
    rewrapKek = kek;
    rewrappedDK = rewrapped;
    dk = resident;
    // Every unlock path adopts a DK, so this is the one place the previous
    // lock's reason ends. (A lock racing a resume re-sets it in lock().)
    lockReason = null;
  };

  /**
   * Materialize a transient EXTRACTABLE handle on the live DK, for the
   * one wrapKey the caller is about to do. Never store the result.
   *
   * @returns {Promise<CryptoKey>}
   */
  const _wrappableDK = async () => {
    // why re-check rather than trust the caller's isLocked() guard: this
    // is the only door to extractable key material in the vault, so it
    // states its own precondition.
    if (rewrapKek === null || rewrappedDK === null) throw new VaultLockedError();
    return unwrapWrappableDK(rewrappedDK, rewrapKek);
  };

  /** @param {'idle'|'manual'} [reason] */
  const lock = (reason = 'manual') => {
    // why the epoch bump + the clear come FIRST, ABOVE the already-locked
    // early return: the mirror lives in chrome.storage.session, which
    // outlives this service worker's memory. A lock that arrives when `dk`
    // is already null — a double lock, or a lock on a fresh SW that has not
    // resumed yet — must still be able to erase bytes THIS instance never
    // held. Lock is idempotent against STORAGE, not merely against memory.
    lockEpoch += 1;
    _clearPersistedDK();
    if (dk === null) return;
    // Recorded only on a real transition - a double lock keeps the first
    // reason (the one that actually ended the unlocked session).
    lockReason = reason;
    dk = null;
    rewrapKek = null;
    rewrappedDK = null;
    if (timerHandle !== null) {
      clearTimer(timerHandle);
      timerHandle = null;
    }
    unlockedAt = 0;
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
  // base64 them, and store a DKMirror record under SESSION_DK_KEY so the
  // next SW boot can restore the unlocked state via attemptResume().
  // Session storage is RAM-only and cleared on browser close, so this never
  // lands on disk.
  //
  // Threat model: anything with extension code execution already has
  // access to SW memory (and thus the DK). Persisting to session
  // storage exposes the DK to the same set of attackers; no new surface.
  // It IS the honest limit on the non-extractable-DK hardening above:
  // while the vault is unlocked the bytes are readable via
  // chrome.storage.session by any in-origin code (R7), so R11's export
  // concern is narrowed to a leaked key REFERENCE, not eliminated.
  //
  // Lifetime — the two properties that make "unlocked" bounded even though
  // the idle timer dies with the SW:
  //   1. After lock() returns, no write can resurrect the mirror. lock()
  //      clears it regardless of memory state and bumps lockEpoch; every
  //      write is queued behind the same chain and re-checks the epoch at
  //      write time, so last-CALL wins rather than last-COMPLETION.
  //   2. The mirror carries its own deadline (unlockedAt + the auto-lock
  //      policy in force). attemptResume refuses and purges a mirror past
  //      it, and PRESERVES unlockedAt on a successful resume, so resuming
  //      cannot extend the window. NOT idle-refreshed: touch() re-arms the
  //      in-memory timer but does not re-stamp the mirror, so the mirror's
  //      lifetime is an ABSOLUTE cap measured from the last real unlock —
  //      deliberately at or tighter than what the user's idle setting
  //      promises, never looser. The `autoLockMs: 0` opt-out keeps today's
  //      unbounded behavior.

  /**
   * Serialize every mirror write and delete through one chain.
   *
   * why: lock() must be able to erase a mirror an in-flight _persistDK is
   * about to write. With both on this chain the LAST CALLER WINS BY CALL
   * ORDER — a delete issued after a set can never be overtaken by it,
   * whatever chrome.storage does with two concurrent ops on one key.
   *
   * @param {(cache: SessionCacheLike) => Promise<void>} op
   * @returns {Promise<void>}
   */
  const _enqueueMirror = (op) => {
    const cache = sessionCache;
    if (!cache) return Promise.resolve();
    // why the catch is INSIDE the assignment: a rejected link would poison
    // every later op on the chain, including the lock's delete.
    mirrorQueue = mirrorQueue
      .then(() => op(cache))
      .catch((e) => console.error('[vault] session DK mirror op failed', e));
    return mirrorQueue;
  };

  /**
   * Mirror the DK bytes into chrome.storage.session.
   *
   * why it takes the key instead of reading `dk`: `dk` is
   * non-extractable, and every call site is a path that JUST obtained
   * the transient extractable handle (generate / unwrap / import). Taking
   * it as an argument keeps this the only exportKey in the vault and
   * avoids re-materializing one.
   *
   * @param {CryptoKey} wrappable
   */
  const _persistDK = async (wrappable) => {
    if (!sessionCache || isLocked()) return;
    // Snapshot the state this write belongs to BEFORE the async export: a
    // lock (or a second unlock) can land while exportRawDK is in flight.
    const epoch = lockEpoch;
    const at = unlockedAt;
    const policy = autoLockMs;
    try {
      const dkBase64 = bytesToBase64(await exportRawDK(wrappable));
      await _enqueueMirror(async (cache) => {
        // why re-check here and not only above: this runs after the export
        // AND after everything already queued. A lock that landed anywhere
        // in between wins — it has already issued its delete.
        if (lockEpoch !== epoch || isLocked()) return;
        await cache.sessionSet(SESSION_DK_KEY, makeMirrorRecord({
          dk: dkBase64, unlockedAt: at, autoLockMs: policy,
        }));
      });
    } catch (e) {
      console.error('[vault] persist DK failed', e);
    }
  };

  const _clearPersistedDK = () => {
    _enqueueMirror((cache) => cache.sessionDelete(SESSION_DK_KEY));
  };

  /**
   * Re-stamp the mirror's recorded policy after a live setAutoLockMs.
   *
   * why: the record carries the policy in force when it was WRITTEN (see
   * DKMirror), so a policy the user TIGHTENS mid-session has to reach the
   * copy that outlives this SW too. Read-modify-write of a record we
   * already wrote — no key material is exported, the DK bytes are copied
   * back verbatim, and a mirror that is absent, stale or unreadable is
   * left alone for attemptResume to refuse and purge.
   */
  const _restampMirrorPolicy = () => {
    const epoch = lockEpoch;
    const policy = autoLockMs;
    _enqueueMirror(async (cache) => {
      if (lockEpoch !== epoch || isLocked()) return;
      const plan = planMirrorResume({
        stored: await cache.sessionGet(SESSION_DK_KEY), now: now(), autoLockMs: policy,
      });
      if (plan.action !== 'resume') return;
      if (lockEpoch !== epoch || isLocked()) return;
      await cache.sessionSet(SESSION_DK_KEY, makeMirrorRecord({
        dk: plan.dk, unlockedAt: plan.unlockedAt, autoLockMs: policy,
      }));
    });
  };

  /**
   * Attempt to restore an unlocked vault from chrome.storage.session.
   * Used at SW boot to survive SW-restart-due-to-idle-timeout.
   *
   * Returns true if the resume succeeded (vault is now unlocked),
   * false otherwise (vault remains in its prior state — typically
   * locked). Safe to call when already unlocked (returns true) or
   * when no sessionCache is wired (returns false).
   *
   * A mirror past its deadline (or from before mirrors carried one) is
   * REFUSED and purged: the user believes an idle vault auto-locked, and
   * the timer that would have done it died with the previous SW.
   */
  const attemptResume = async () => {
    if (!sessionCache) return false;
    if (!isLocked()) return true;
    const epoch = lockEpoch;
    const stored = await sessionCache.sessionGet(SESSION_DK_KEY);
    const plan = planMirrorResume({ stored, now: now(), autoLockMs });
    if (plan.action === 'absent') return false;
    if (plan.action === 'refuse') {
      console.warn(`[vault] refusing session DK mirror (${plan.reason}); clearing`);
      // A mirror past the idle policy IS an idle lock - it just fired while
      // no SW was alive to run the timer. Say so on the unlock screen.
      if (plan.reason === 'expired') lockReason = 'idle';
      _clearPersistedDK();
      return false;
    }
    try {
      // Adopt-and-drop, same as every unlock path: the imported handle is
      // extractable only long enough to mint the re-wrap material.
      await _adoptDK(await importWrappableDK(base64ToBytes(plan.dk)));
      if (lockEpoch !== epoch) {
        // A lock landed while we were reading + unwrapping. It wins: drop
        // what we just adopted rather than coming back UNLOCKED after the
        // user asked for locked. lock() also re-purges the mirror.
        lock();
        return false;
      }
      // why the ORIGINAL timestamp rather than now(): the deadline is
      // anchored to the unlock this mirror belongs to. Re-stamping it here
      // would let a vault live forever by being resumed once per window —
      // precisely the unbounded lifetime the deadline exists to close.
      unlockedAt = plan.unlockedAt;
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
    await _adoptDK(newDK);
    unlockedAt = now();
    armAutoLock();
    // A successful initialize must already be restart-safe. The authority host
    // may be replaced immediately after this call, so returning before the
    // session mirror lands can turn a successful unlock into a silent lock.
    await _persistDK(newDK);
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
    await _adoptDK(newDK);
    unlockedAt = now();
    armAutoLock();
    await _persistDK(newDK);
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
    /** @type {CryptoKey} */
    let fresh;
    try {
      // unwrapWrappableDK throws on tampered ciphertext or wrong KEK;
      // either way we surface WrongPassphraseError. We intentionally
      // don't leak the underlying SubtleCrypto error to the caller —
      // that would be a small side channel for distinguishing "wrong
      // passphrase" from "tampered ciphertext" which an attacker with
      // storage access shouldn't get to differentiate.
      //
      // why ONLY the unwrap sits in the try: _adoptDK failing is a
      // crypto-plumbing bug, not a bad passphrase, and mapping it to
      // WrongPassphraseError would send the user round a retry loop
      // that can never succeed.
      fresh = await unwrapWrappableDK(_bytes(stored.wrappedDK), kek);
    } catch (_e) {
      throw new WrongPassphraseError();
    }
    await _adoptDK(fresh);
    unlockedAt = now();
    armAutoLock();
    await _persistDK(fresh);
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
    // why _wrappableDK() and not `dk`: the resident DK is non-extractable
    // and wrapKey would refuse it. This mints a transient extractable
    // handle on the same key, spends it here, and lets it go.
    const wrap = await _makePassphraseWrap(passphrase, await _wrappableDK());
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
    // why _wrappableDK(): see setRecoveryPassphrase — the resident DK is
    // non-extractable, so wrapKey needs a transient extractable handle.
    const wrapped = await wrapDK(await _wrappableDK(), prfKEK);
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
    /** @type {CryptoKey} */
    let fresh;
    try {
      fresh = await unwrapWrappableDK(_bytes(stored.wrappedDK_prf), prfKEK);
    } catch (_e) {
      // why: do not leak whether the bytes were wrong or the ciphertext
      // tampered — same side-channel concern as WrongPassphraseError.
      // (And, as in unlock(), _adoptDK stays outside the try.)
      throw new PrfUnlockFailedError();
    }
    await _adoptDK(fresh);
    unlockedAt = now();
    armAutoLock();
    await _persistDK(fresh);
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
    /** Why the vault is locked ('idle' | 'manual'), null when unlocked or on
     * a fresh SW that never locked - drives the §5g unlock-screen sentence. */
    lockReason: () => lockReason,
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
