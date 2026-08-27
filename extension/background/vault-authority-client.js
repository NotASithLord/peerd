// @ts-check

import {
  parseVaultAuthorityOffer,
  parseVaultAuthorityStorageCall,
  VAULT_AUTHORITY_BOOTSTRAP,
  VAULT_AUTHORITY_CALL,
  VAULT_AUTHORITY_EVENT,
  VAULT_AUTHORITY_OFFER,
  VAULT_AUTHORITY_PROTOCOL,
  VAULT_AUTHORITY_READY,
  VAULT_AUTHORITY_RESULT,
  VAULT_AUTHORITY_STORAGE_RESULT,
} from '../shared/vault-authority-protocol.js';

export class VaultAuthorityChannelError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {boolean} outcomeKnown
   */
  constructor(message, code = 'vault-authority-channel-failed', outcomeKnown = false) {
    super(message);
    this.name = 'VaultAuthorityChannelError';
    this.code = code;
    this.outcomeKnown = outcomeKnown;
  }
}

/** @param {unknown} value */
const errorMessage = (value) => value instanceof Error ? value.message : String(value);
const sameLease = (/** @type {any} */ left, /** @type {any} */ right) => !!left && !!right
  && left.schema === right.schema && left.scope === right.scope && left.leaseId === right.leaseId
  && left.generation === right.generation && left.buildId === right.buildId
  && left.bootId === right.bootId && left.kernelEpoch === right.kernelEpoch
  && left.hostEpoch === right.hostEpoch;

/**
 * @param {Object} deps
 * @param {boolean} deps.offscreen
 * @param {string} deps.offscreenUrl
 * @param {string} deps.workerUrl
 * @param {<T>(operation:(lease:any)=>Promise<T>,context?:{method:string})=>Promise<T>} deps.withHost
 * @param {{get:(key:string)=>Promise<any>,set:(key:string,value:any)=>Promise<void>,delete:(key:string)=>Promise<void>,list:(prefix?:string)=>Promise<Record<string,any>>}} deps.kv
 * @param {{get:(store:string,key:IDBValidKey)=>Promise<any>,put:(store:string,value:any)=>Promise<void>,del:(store:string,key:IDBValidKey)=>Promise<void>}} deps.idb
 * @param {{sessionGet:(key:string)=>Promise<any>,sessionSet:(key:string,value:any)=>Promise<void>,sessionDelete:(key:string)=>Promise<void>}} deps.sessionCache
 * @param {()=>Promise<any[]>} [deps.listWindowClients]
 * @param {(url:string,options:{type:'module',name:string})=>Worker} [deps.createWorker]
 * @param {()=>MessageChannel} [deps.createChannel]
 * @param {()=>string} [deps.newId]
 * @param {number} [deps.timeoutMs]
 * @param {Record<string,new (...args:any[])=>Error>} [deps.errorTypes]
 */
export const makeVaultAuthorityClient = ({
  offscreen,
  offscreenUrl,
  workerUrl,
  withHost,
  kv,
  idb,
  sessionCache,
  listWindowClients = async () => {
    const api = /** @type {any} */ (globalThis).clients;
    return typeof api?.matchAll === 'function'
      ? api.matchAll({ type: 'window', includeUncontrolled: true }) : [];
  },
  createWorker = (url, options) => new Worker(url, options),
  createChannel = () => new MessageChannel(),
  newId = () => crypto.randomUUID(),
  timeoutMs = 10 * 60_000,
  errorTypes = {},
}) => {
  if (typeof withHost !== 'function' || !kv || !idb || !sessionCache
      || typeof offscreenUrl !== 'string' || typeof workerUrl !== 'string'
      || timeoutMs <= 0) throw new TypeError('vault-authority-client-config-invalid');

  /** @type {null|{channelId:string,port:MessagePort,worker:Worker|null,lease:any,ready:Promise<void>,close:()=>void}} */
  let active = null;
  /** @type {Map<string,{resolve:(value:any)=>void,reject:(cause:unknown)=>void,dispatched:boolean,method:string,timer:ReturnType<typeof setTimeout>}>} */
  const pending = new Map();
  /** @type {Set<(event:any)=>void>} */
  const listeners = new Set();
  /** @type {Promise<any>|null} */
  let connecting = null;
  let sequence = 0;
  let cached = {
    initialized: false,
    prfEnrolled: false,
    hasRecovery: false,
    locked: true,
    unlockedAt: 0,
    lockReason: /** @type {'idle'|'manual'|null} */ (null),
  };

  const methodTimeoutMs = (/** @type {string} */ method) => Math.min(timeoutMs,
    ['status', 'prfStatus', 'getSecret', 'listSecretNames'].includes(method)
      ? 15_000
      : ['boot', 'attemptResume'].includes(method)
        ? 30_000
        : 60_000);

  const rejectPending = (/** @type {unknown} */ cause) => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new VaultAuthorityChannelError(
        errorMessage(cause),
        'vault-authority-channel-lost',
        !item.dispatched,
      ));
    }
    pending.clear();
  };

  /** @param {string} code @param {string} message */
  const mappedError = (code, message) => {
    const Type = errorTypes[code];
    return Type ? new Type(message) : new VaultAuthorityChannelError(message, code, true);
  };

  /** @param {ReturnType<typeof parseVaultAuthorityStorageCall>} call */
  const executeStorage = async (call) => {
    if (!call || !active || call.channelId !== active.channelId) {
      throw new Error('vault-authority-storage-call-invalid');
    }
    const [first, second] = call.args;
    const secretKey = typeof first === 'string' && first.startsWith('secret:')
      && first.length > 'secret:'.length && first.length <= 263;
    if (call.operation === 'kv.get') {
      if (first === 'vault.v1' || secretKey) return kv.get(first);
      if (first === 'prefix:secret:') return kv.list('secret:');
    }
    if (call.operation === 'kv.set' && (first === 'vault.v1' || secretKey)) {
      await kv.set(first, second); return null;
    }
    if (call.operation === 'kv.delete' && (first === 'vault.v1' || secretKey)) {
      await kv.delete(first); return null;
    }
    if (call.operation === 'idb.get' && first === 'vault' && second === 'vault.v1') {
      return idb.get(first, second);
    }
    if (call.operation === 'idb.put' && first === 'vault'
        && second?.key === 'vault.v1') {
      await idb.put(first, second); return null;
    }
    if (call.operation === 'idb.del' && first === 'vault' && second === 'vault.v1') {
      await idb.del(first, second); return null;
    }
    if (call.operation === 'session.get' && first === 'vault.unlocked.v1') {
      return sessionCache.sessionGet(first);
    }
    if (call.operation === 'session.set' && first === 'vault.unlocked.v1') {
      await sessionCache.sessionSet(first, second); return null;
    }
    if (call.operation === 'session.delete' && first === 'vault.unlocked.v1') {
      await sessionCache.sessionDelete(first); return null;
    }
    throw new Error('vault-authority-storage-operation-refused');
  };

  const retire = (/** @type {unknown} */ cause = 'vault authority retired',
    /** @type {typeof active} */ expected = active) => {
    if (expected && active !== expected) return;
    const prior = active;
    active = null;
    connecting = null;
    if (!prior) return;
    rejectPending(cause);
    try { prior.port.close(); } catch { /* closed */ }
    try { prior.worker?.terminate(); } catch { /* stopped */ }
  };

  const connect = async (/** @type {any} */ lease) => {
    if (active && offscreen && !sameLease(active.lease, lease)) {
      retire('vault authority lease changed', active);
    }
    if (active) {
      await active.ready;
      return active;
    }
    if (connecting) return connecting;
    connecting = (async () => {
      // A successor host starts with a fresh sealed vault heap. If this client
      // was unlocked before its lease/channel changed, restore the DK from the
      // bounded session mirror before allowing the first caller onto the new
      // connection. Otherwise a routine feature-host replacement silently
      // turns a live unlocked session into a locked one.
      const resumeSuccessor = cached.locked === false;
      const channelId = `vault-${newId()}`;
      const offer = {
        type: VAULT_AUTHORITY_OFFER,
        protocol: VAULT_AUTHORITY_PROTOCOL,
        channelId,
        lease,
      };
      if (offscreen && !parseVaultAuthorityOffer(offer)) {
        throw new Error('vault-authority-channel-identity-invalid');
      }
      const { port1, port2 } = createChannel();
      /** @type {Worker|null} */
      let worker = null;
      /** @type {()=>void} */
      let resolveReady = () => {};
      /** @type {(cause:unknown)=>void} */
      let rejectReady = (/** @type {unknown} */ _cause) => {};
      /** @type {Promise<void>} */
      const ready = new Promise((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      /** @type {{channelId:string,port:MessagePort,worker:Worker|null,lease:any,ready:Promise<void>,close:()=>void}} */
      const connection = {
        channelId, port: port1, worker, lease, ready,
        close: () => retire('vault authority channel closed', connection),
      };
      active = connection;
      port1.onmessage = (event) => {
        const message = event.data;
        if (message?.protocol !== VAULT_AUTHORITY_PROTOCOL
            || message?.channelId !== channelId) return;
        if (message.type === VAULT_AUTHORITY_READY) {
          resolveReady(); return;
        }
        if (message.type === VAULT_AUTHORITY_EVENT) {
          const explicitLockPending = message.event?.type === 'locked'
            && [...pending.values()].some((item) => item.method === 'lock');
          if (message.event?.type === 'initialized' || message.event?.type === 'unlocked') {
            cached = { ...cached, initialized: true, locked: false, lockReason: null };
          } else if (message.event?.type === 'locked') {
            cached = { ...cached, locked: true, unlockedAt: 0 };
          } else if (message.event?.type === 'prf_enrolled') {
            cached = { ...cached, prfEnrolled: true };
          } else if (message.event?.type === 'prf_disabled') {
            cached = { ...cached, prfEnrolled: false };
          } else if (message.event?.type === 'recovery_set') {
            cached = { ...cached, hasRecovery: true };
          }
          if (!explicitLockPending) {
            for (const listener of listeners) listener(message.event);
          }
          return;
        }
        if (message.type === VAULT_AUTHORITY_RESULT && typeof message.requestId === 'string') {
          if (message.requestId === 'bootstrap-error') {
            rejectReady(new Error(message.error ?? 'vault authority bootstrap failed'));
            retire(message.error ?? 'vault authority bootstrap failed', connection);
            return;
          }
          const item = pending.get(message.requestId);
          if (!item) return;
          pending.delete(message.requestId);
          clearTimeout(item.timer);
          if (message.ok === true) {
            if (message.value?.authorityStatus) {
              cached = { ...cached, ...message.value.authorityStatus };
            }
            item.resolve(message.value);
          }
          else item.reject(mappedError(
            typeof message.error === 'string' ? message.error : 'vault-authority-failed',
            typeof message.message === 'string' ? message.message : String(message.error),
          ));
          return;
        }
        const storageCall = parseVaultAuthorityStorageCall(message);
        if (!storageCall) return;
        Promise.resolve(executeStorage(storageCall)).then(
          (value) => port1.postMessage({
            type: VAULT_AUTHORITY_STORAGE_RESULT,
            protocol: VAULT_AUTHORITY_PROTOCOL,
            channelId,
            requestId: storageCall.requestId,
            ok: true,
            value,
          }),
          (cause) => port1.postMessage({
            type: VAULT_AUTHORITY_STORAGE_RESULT,
            protocol: VAULT_AUTHORITY_PROTOCOL,
            channelId,
            requestId: storageCall.requestId,
            ok: false,
            error: errorMessage(cause),
          }),
        );
      };
      port1.onmessageerror = () => retire('vault authority message clone failed', connection);
      port1.addEventListener?.('close', () => retire(
        'vault authority port closed', connection,
      ), { once: true });
      port1.start();
      if (offscreen) {
        const matches = (await listWindowClients()).filter((client) => client?.url === offscreenUrl);
        if (matches.length !== 1) {
          retire('vault authority host unavailable or ambiguous', connection);
          port2.close();
          throw new Error('vault authority host unavailable or ambiguous');
        }
        matches[0].postMessage(offer, [port2]);
      } else {
        worker = createWorker(workerUrl, { type: 'module', name: 'peerd-vault-authority' });
        connection.worker = worker;
        worker.postMessage({
          type: VAULT_AUTHORITY_BOOTSTRAP,
          protocol: VAULT_AUTHORITY_PROTOCOL,
          channelId,
        }, [port2]);
      }
      /** @type {ReturnType<typeof setTimeout>|null} */
      let bootstrapTimer = null;
      try {
        await Promise.race([
          ready,
          new Promise((_, reject) => {
            bootstrapTimer = setTimeout(
              () => reject(new Error('vault authority bootstrap timed out')),
              Math.min(timeoutMs, 30_000),
            );
          }),
        ]);
      } catch (cause) {
        retire(cause, connection); throw cause;
      } finally {
        if (bootstrapTimer !== null) clearTimeout(bootstrapTimer);
      }
      if (resumeSuccessor) await dispatch(connection, 'attemptResume', null);
      return connection;
    })().finally(() => { connecting = null; });
    return connecting;
  };

  const dispatch = (/** @type {NonNullable<typeof active>} */ connection,
    /** @type {string} */ method, /** @type {unknown} */ args) => {
      const requestId = `call-${++sequence}-${newId()}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          retire('vault authority call timed out', connection);
          reject(new VaultAuthorityChannelError(
            'vault authority call timed out', 'vault-authority-timeout', false,
          ));
        }, methodTimeoutMs(method));
        const item = { resolve, reject, dispatched: false, method, timer };
        pending.set(requestId, item);
        try {
          connection.port.postMessage({
            type: VAULT_AUTHORITY_CALL,
            protocol: VAULT_AUTHORITY_PROTOCOL,
            channelId: connection.channelId,
            requestId,
            method,
            args,
          });
          item.dispatched = true;
        } catch (cause) {
          pending.delete(requestId); clearTimeout(timer);
          reject(new VaultAuthorityChannelError(
            errorMessage(cause), 'vault-authority-dispatch-failed', true,
          ));
        }
      });
  };

  const call = (/** @type {string} */ method, /** @type {unknown} */ args = null) =>
    withHost(async (lease) => dispatch(await connect(lease), method, args), { method });

  const refreshStatus = async () => {
    cached = { ...cached, ...(await call('status')) };
    return Object.freeze({ ...cached });
  };
  const invokeAndRefresh = async (/** @type {string} */ method, /** @type {unknown} */ args) => {
    const value = await call(method, args);
    return value?.authorityStatus ? value.result : value;
  };
  const attemptResume = async () => {
    const value = await call('attemptResume');
    return value?.authorityStatus ? value.result === true : value === true;
  };
  const boot = async (/** @type {number} */ autoLockMs) => {
    const value = await call('boot', autoLockMs);
    return value?.authorityStatus
      ? { ...value.result, status: Object.freeze({ ...cached }) }
      : value;
  };
  const subscribe = (/** @type {(event:any)=>void} */ listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  return Object.freeze({
    status: refreshStatus,
    boot,
    initialize: (/** @type {string} */ passphrase) => invokeAndRefresh('initialize', passphrase),
    initializeWithPrfOnly: (/** @type {any} */ value) => invokeAndRefresh('initializeWithPrfOnly', value),
    unlock: (/** @type {string} */ passphrase) => invokeAndRefresh('unlock', passphrase),
    setRecoveryPassphrase: (/** @type {string} */ passphrase) => invokeAndRefresh('setRecoveryPassphrase', passphrase),
    lock: (/** @type {'manual'|'idle'} */ reason = 'manual') => invokeAndRefresh('lock', reason),
    prfStatus: () => call('prfStatus'),
    enrollPrf: (/** @type {any} */ value) => invokeAndRefresh('enrollPrf', value),
    unlockWithPrf: (/** @type {Uint8Array} */ value) => invokeAndRefresh('unlockWithPrf', value),
    disablePrf: () => invokeAndRefresh('disablePrf', null),
    setSecret: (/** @type {string} */ name, /** @type {string} */ plaintext) => call('setSecret', { name, plaintext }),
    getSecret: (/** @type {string} */ name) => call('getSecret', name),
    deleteSecret: (/** @type {string} */ name) => call('deleteSecret', name),
    listSecretNames: () => call('listSecretNames'),
    attemptResume,
    setAutoLockMs: (/** @type {number} */ value) => invokeAndRefresh('setAutoLockMs', value),
    isLocked: () => cached.locked,
    isInitialized: () => cached.initialized,
    unlockedAt: () => cached.unlockedAt,
    lockReason: () => cached.lockReason,
    hasRecoveryPassphrase: async () => (await refreshStatus()).hasRecovery,
    subscribe,
    close: () => retire('vault authority client closed'),
  });
};
