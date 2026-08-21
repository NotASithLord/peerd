// @ts-check
// Pure vault authority hosted in a sealed Worker. Browser storage remains in
// the kernel and is reachable only through the exact reverse operations below.

import {
  VAULT_AUTHORITY_CALL,
  VAULT_AUTHORITY_EVENT,
  VAULT_AUTHORITY_PROTOCOL,
  VAULT_AUTHORITY_READY,
  VAULT_AUTHORITY_RESULT,
  VAULT_AUTHORITY_STORAGE,
  VAULT_AUTHORITY_STORAGE_RESULT,
  parseVaultAuthorityCall,
} from '../shared/vault-authority-protocol.js';
import { createVault } from '../peerd-egress/vault/vault.js';

// Passkey-only users never compile the vendored Argon graph. The fixed KDF
// entry is separately packaging- and digest-bound.
const deriveArgon2id = async (/** @type {any} */ args) =>
  (await import('../shared/argon2id.js')).deriveArgon2id(args);

const VAULT_STORE = 'vault';
const VAULT_KEY = 'vault.v1';
const SESSION_DK_KEY = 'vault.unlocked.v1';

/** @param {unknown} value */
const record = (value) => value && typeof value === 'object' && !Array.isArray(value)
  ? /** @type {Record<string, any>} */ (value) : null;
/** @param {unknown} value @param {number} max */
const text = (value, max) => typeof value === 'string' && value.length <= max ? value : null;
/** @param {unknown} value @param {number} exact */
const bytes = (value, exact) => value instanceof Uint8Array && value.byteLength === exact
  ? value : null;

/** @param {unknown} cause */
const classifyError = (cause) => {
  const name = cause instanceof Error ? cause.name : '';
  const known = new Map([
    ['VaultAlreadyInitializedError', 'already-initialized'],
    ['WrongPassphraseError', 'wrong-passphrase'],
    ['VaultNotInitializedError', 'not-initialized'],
    ['RecoveryPassphraseNotSetError', 'recovery-not-set'],
    ['PrfNotEnrolledError', 'prf-not-enrolled'],
    ['PrfUnlockFailedError', 'prf-unlock-failed'],
    ['VaultLockedError', 'locked'],
    ['KdfUnavailableError', 'kdf-unavailable'],
  ]);
  return {
    code: known.get(name) ?? 'vault-authority-failed',
    message: cause instanceof Error ? cause.message : String(cause),
  };
};

/** @param {string} method @param {unknown} args */
const normalizeArgs = (method, args) => {
  if (['status', 'attemptResume', 'prfStatus', 'disablePrf', 'listSecretNames'].includes(method)) {
    return args == null ? [] : null;
  }
  if (method === 'setAutoLockMs' || method === 'boot') {
    return typeof args === 'number' && Number.isFinite(args) && args >= 0 ? [args] : null;
  }
  if (method === 'lock') {
    return args == null || args === 'manual' || args === 'idle' ? [args ?? 'manual'] : null;
  }
  if (['initialize', 'unlock', 'setRecoveryPassphrase'].includes(method)) {
    const passphrase = text(args, 4096);
    return passphrase === null ? null : [passphrase];
  }
  if (method === 'unlockWithPrf') {
    const prfOutput = bytes(args, 32);
    return prfOutput ? [prfOutput] : null;
  }
  if (method === 'initializeWithPrfOnly' || method === 'enrollPrf') {
    const input = record(args);
    const prfOutput = bytes(input?.prfOutput, 32);
    const credentialId = input?.credentialId instanceof Uint8Array
      && input.credentialId.byteLength > 0 && input.credentialId.byteLength <= 1024
      ? input.credentialId : null;
    const prfSalt = bytes(input?.prfSalt, 32);
    const transports = input?.transports == null ? null
      : Array.isArray(input.transports) && input.transports.length <= 8
        && input.transports.every((item) => typeof item === 'string' && item.length <= 32)
        ? input.transports : undefined;
    if (!prfOutput || !credentialId || !prfSalt || transports === undefined) return null;
    return [{ prfOutput, credentialId, prfSalt, transports }];
  }
  if (method === 'setSecret') {
    const input = record(args);
    const name = text(input?.name, 256);
    const plaintext = text(input?.plaintext, 1024 * 1024);
    return name && plaintext !== null ? [name, plaintext] : null;
  }
  if (method === 'getSecret' || method === 'deleteSecret') {
    const name = text(args, 256);
    return name ? [name] : null;
  }
  return null;
};

/**
 * @param {{port:MessagePort,channelId:string}} input
 */
export const serveVaultAuthority = async ({ port, channelId }) => {
  if (!port || typeof channelId !== 'string') throw new TypeError('vault-authority-config-invalid');
  let storageSequence = 0;
  /** @type {Map<string,{resolve:(value:any)=>void,reject:(cause:unknown)=>void}>} */
  const pendingStorage = new Map();
  let callQueue = Promise.resolve();

  /** @param {string} operation @param {any[]} args */
  const storageCall = (operation, args) => new Promise((resolve, reject) => {
    const requestId = `storage-${++storageSequence}`;
    pendingStorage.set(requestId, { resolve, reject });
    port.postMessage({
      type: VAULT_AUTHORITY_STORAGE,
      protocol: VAULT_AUTHORITY_PROTOCOL,
      channelId,
      requestId,
      operation,
      args,
    });
  });

  const kv = {
    get: (/** @type {string} */ key) => storageCall('kv.get', [key]),
    set: (/** @type {string} */ key, /** @type {any} */ value) => storageCall('kv.set', [key, value]),
    delete: (/** @type {string} */ key) => storageCall('kv.delete', [key]),
    list: (/** @type {string|undefined} */ prefix) => storageCall('kv.get', [`prefix:${prefix ?? ''}`]),
    clear: async () => { throw new Error('vault authority cannot clear storage'); },
  };
  const idb = {
    get: (/** @type {string} */ store, /** @type {IDBValidKey} */ key) => storageCall('idb.get', [store, key]),
    put: (/** @type {string} */ store, /** @type {any} */ value) => storageCall('idb.put', [store, value]),
    del: (/** @type {string} */ store, /** @type {IDBValidKey} */ key) => storageCall('idb.del', [store, key]),
  };
  const sessionCache = {
    sessionGet: (/** @type {string} */ key) => storageCall('session.get', [key]),
    sessionSet: (/** @type {string} */ key, /** @type {any} */ value) => storageCall('session.set', [key, value]),
    sessionDelete: (/** @type {string} */ key) => storageCall('session.delete', [key]),
  };
  const vault = createVault({ kv, idb, sessionCache, argon2: deriveArgon2id });
  vault.subscribe((event) => {
    port.postMessage({
      type: VAULT_AUTHORITY_EVENT,
      protocol: VAULT_AUTHORITY_PROTOCOL,
      channelId,
      event,
    });
  });

  const status = async () => {
    const [initialized, prf, hasRecovery] = await Promise.all([
      vault.isInitialized(), vault.prfStatus(), vault.hasRecoveryPassphrase(),
    ]);
    return {
      initialized,
      prfEnrolled: prf.enrolled,
      hasRecovery,
      prf,
      locked: vault.isLocked(),
      unlockedAt: vault.unlockedAt(),
      lockReason: vault.lockReason(),
    };
  };
  const MUTATING_METHODS = new Set([
    'boot', 'attemptResume', 'setAutoLockMs', 'initialize', 'initializeWithPrfOnly',
    'unlock', 'setRecoveryPassphrase', 'lock', 'enrollPrf', 'unlockWithPrf',
    'disablePrf', 'setSecret', 'deleteSecret',
  ]);

  /** @param {ReturnType<typeof parseVaultAuthorityCall>} call */
  const execute = async (call) => {
    if (!call || call.channelId !== channelId) return;
    const args = normalizeArgs(call.method, call.args);
    if (!args) {
      port.postMessage({
        type: VAULT_AUTHORITY_RESULT, protocol: VAULT_AUTHORITY_PROTOCOL,
        channelId, requestId: call.requestId, ok: false,
        error: 'vault-authority-arguments-invalid',
      });
      return;
    }
    try {
      const value = call.method === 'status'
        ? await status()
        : call.method === 'boot'
          ? (() => {
            vault.setAutoLockMs(/** @type {number} */ (args[0]));
            return vault.attemptResume().then((resumed) => ({ resumed }));
          })()
          : await (/** @type {any} */ (vault))[call.method](...args);
      port.postMessage({
        type: VAULT_AUTHORITY_RESULT, protocol: VAULT_AUTHORITY_PROTOCOL,
        channelId, requestId: call.requestId, ok: true,
        value: MUTATING_METHODS.has(call.method)
          ? { result: await value, authorityStatus: await status() }
          : value,
      });
    } catch (cause) {
      const failure = classifyError(cause);
      port.postMessage({
        type: VAULT_AUTHORITY_RESULT, protocol: VAULT_AUTHORITY_PROTOCOL,
        channelId, requestId: call.requestId, ok: false,
        error: failure.code, message: failure.message,
      });
    }
  };

  port.onmessage = (event) => {
    const message = event.data;
    if (message?.type === VAULT_AUTHORITY_STORAGE_RESULT
        && message.protocol === VAULT_AUTHORITY_PROTOCOL
        && message.channelId === channelId
        && typeof message.requestId === 'string') {
      const pending = pendingStorage.get(message.requestId);
      if (!pending) return;
      pendingStorage.delete(message.requestId);
      if (message.ok === true) pending.resolve(message.value);
      else pending.reject(new Error(message.error ?? 'vault storage operation failed'));
      return;
    }
    if (message?.type !== VAULT_AUTHORITY_CALL) return;
    const call = parseVaultAuthorityCall(message);
    callQueue = callQueue.then(() => execute(call), () => execute(call));
  };
  port.onmessageerror = () => {
    for (const pending of pendingStorage.values()) {
      pending.reject(new Error('vault authority storage channel corrupt'));
    }
    pendingStorage.clear();
  };
  port.start();
  port.postMessage({
    type: VAULT_AUTHORITY_READY,
    protocol: VAULT_AUTHORITY_PROTOCOL,
    channelId,
  });
  // Keep the bootstrap alive for the lifetime of the private Port.
  await new Promise((resolve) => port.addEventListener('close', resolve, { once: true }));
};

export const VAULT_AUTHORITY_STORAGE_SCOPE = Object.freeze({
  kvKeys: [VAULT_KEY, 'secret:*'],
  idb: { store: VAULT_STORE, key: VAULT_KEY },
  sessionKeys: [SESSION_DK_KEY],
});
