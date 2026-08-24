// @ts-check
// Fixed private protocol between the authority kernel and the sealed vault
// Worker. This module is deliberately browser-neutral and contains no dynamic
// routing: every call and reverse-storage operation is enumerated here.

export const VAULT_AUTHORITY_PROTOCOL = 1;
export const VAULT_AUTHORITY_OFFER = 'peerd/vault-authority-channel';
export const VAULT_AUTHORITY_BOOTSTRAP = 'vault-authority-worker/bootstrap';
export const VAULT_AUTHORITY_READY = 'vault-authority/ready';
export const VAULT_AUTHORITY_CALL = 'vault-authority/call';
export const VAULT_AUTHORITY_RESULT = 'vault-authority/result';
export const VAULT_AUTHORITY_STORAGE = 'vault-authority/storage';
export const VAULT_AUTHORITY_STORAGE_RESULT = 'vault-authority/storage-result';
export const VAULT_AUTHORITY_EVENT = 'vault-authority/event';

export const VAULT_AUTHORITY_METHODS = Object.freeze([
  'status',
  'boot',
  'attemptResume',
  'setAutoLockMs',
  'initialize',
  'initializeWithPrfOnly',
  'unlock',
  'setRecoveryPassphrase',
  'lock',
  'prfStatus',
  'enrollPrf',
  'unlockWithPrf',
  'disablePrf',
  'setSecret',
  'getSecret',
  'deleteSecret',
  'listSecretNames',
]);
const methodSet = new Set(VAULT_AUTHORITY_METHODS);

export const VAULT_AUTHORITY_STORAGE_OPERATIONS = Object.freeze([
  'kv.get', 'kv.set', 'kv.delete',
  'idb.get', 'idb.put', 'idb.del',
  'session.get', 'session.set', 'session.delete',
]);
const storageOperationSet = new Set(VAULT_AUTHORITY_STORAGE_OPERATIONS);

/** @param {unknown} value @param {number} [max] */
const boundedId = (value, max = 160) => typeof value === 'string'
  && value.length >= 8 && value.length <= max
  && /^[a-zA-Z0-9._:-]+$/.test(value);

/** @param {unknown} value */
export const parseVaultAuthorityOffer = (value) => {
  if (!value || typeof value !== 'object') return null;
  const offer = /** @type {Record<string, unknown>} */ (value);
  if (offer.type !== VAULT_AUTHORITY_OFFER
      || offer.protocol !== VAULT_AUTHORITY_PROTOCOL
      || !boundedId(offer.channelId)
      || !offer.lease || typeof offer.lease !== 'object'
      || Array.isArray(offer.lease)) return null;
  return Object.freeze({
    type: VAULT_AUTHORITY_OFFER,
    protocol: VAULT_AUTHORITY_PROTOCOL,
    channelId: /** @type {string} */ (offer.channelId),
    lease: Object.freeze({ ...offer.lease }),
  });
};

/**
 * @param {MessageEvent|any} event
 * @param {string} expectedScriptUrl
 * @param {(lease:unknown)=>boolean} ownsLease
 */
export const admitVaultAuthorityOffer = (event, expectedScriptUrl, ownsLease) => {
  if (event?.data?.type !== VAULT_AUTHORITY_OFFER) {
    return { matched: false, ok: false, reason: 'not-vault-authority-offer', offer: null };
  }
  const offer = parseVaultAuthorityOffer(event.data);
  if (!event.isTrusted || event.source?.scriptURL !== expectedScriptUrl) {
    return { matched: true, ok: false, reason: 'sender-invalid', offer };
  }
  if (!offer || event.ports?.length !== 1) {
    return { matched: true, ok: false, reason: 'offer-invalid', offer };
  }
  if (typeof ownsLease !== 'function' || !ownsLease(offer.lease)) {
    return { matched: true, ok: false, reason: 'lease-inactive', offer };
  }
  return { matched: true, ok: true, reason: null, offer };
};

/** @param {unknown} value */
export const parseVaultAuthorityCall = (value) => {
  if (!value || typeof value !== 'object') return null;
  const call = /** @type {Record<string, unknown>} */ (value);
  if (call.type !== VAULT_AUTHORITY_CALL
      || call.protocol !== VAULT_AUTHORITY_PROTOCOL
      || !boundedId(call.channelId)
      || !boundedId(call.requestId)
      || typeof call.method !== 'string'
      || !methodSet.has(call.method)) return null;
  return Object.freeze({
    channelId: /** @type {string} */ (call.channelId),
    requestId: /** @type {string} */ (call.requestId),
    method: /** @type {string} */ (call.method),
    args: call.args,
  });
};

/** @param {unknown} value */
export const parseVaultAuthorityStorageCall = (value) => {
  if (!value || typeof value !== 'object') return null;
  const call = /** @type {Record<string, unknown>} */ (value);
  if (call.type !== VAULT_AUTHORITY_STORAGE
      || call.protocol !== VAULT_AUTHORITY_PROTOCOL
      || !boundedId(call.channelId)
      || !boundedId(call.requestId)
      || typeof call.operation !== 'string'
      || !storageOperationSet.has(call.operation)
      || !Array.isArray(call.args)) return null;
  return Object.freeze({
    channelId: /** @type {string} */ (call.channelId),
    requestId: /** @type {string} */ (call.requestId),
    operation: /** @type {string} */ (call.operation),
    args: call.args,
  });
};
