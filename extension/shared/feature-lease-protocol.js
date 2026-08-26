// @ts-check
// Tiny browser-neutral wire contract shared by the authority kernel and the
// offscreen host. Keep host implementation out of the cold service-worker
// graph; this file must remain constants only.

export const FEATURE_LEASE_HOST_PROTOCOL = 1;
export const FEATURE_LEASE_KEEPALIVE_PORT = 'feature-lease-keepalive';
export const LOCAL_MODEL_CHANNEL_OFFER = 'peerd/local-model-channel';
export const LOCAL_MODEL_CHANNEL_RESULT = 'local-model/result';
export const LOCAL_MODEL_CHANNEL_CHUNK = 'local-model/chunk';
export const LOCAL_MODEL_CHANNEL_CANCEL = 'local-model/cancel';
export const LOCAL_MODEL_CHANNEL_PROTOCOL = 1;
export const REPOSITORY_CHANNEL_OFFER = 'peerd/repository-channel';
export const REPOSITORY_CHANNEL_PROTOCOL = 1;
export const REPOSITORY_CHANNEL_MAX_BYTES = 80 * 1024 * 1024;
export const OFFSCREEN_FEATURE_LEASE_SCOPES = Object.freeze([
  'controller', 'dweb', 'dom-host', 'media-host', 'model-host', 'vault-authority',
]);

const LOCAL_MODEL_METHODS = new Set(['status', 'catalog', 'probe', 'init', 'generate']);
export const REPOSITORY_METHODS = Object.freeze([
  'init', 'stage', 'commit', 'status', 'branches', 'history', 'diff', 'restore',
  'branch', 'checkout', 'setRemote', 'getRemote', 'fetch', 'push', 'clone',
  'snapshot', 'matches', 'fork', 'replaceWorkingTree', 'destroy',
  'appRead', 'appList', 'appInspect', 'appWrite', 'appDelete',
]);
const METHODS = new Set(REPOSITORY_METHODS);
const MUTATING_METHODS = new Set([
  'init', 'stage', 'commit', 'restore', 'branch', 'checkout', 'setRemote',
  'fetch', 'push', 'clone', 'fork', 'replaceWorkingTree', 'destroy',
  'snapshot', 'matches',
  'appWrite', 'appDelete',
]);
const NETWORK_METHODS = new Set(['fetch', 'push', 'clone']);
const APP_FILE_METHODS = new Set(['appRead', 'appList', 'appInspect', 'appWrite', 'appDelete']);
const OFFER_KEYS = 'args\nchannelId\nlease\nmethod\nprotocol\ntype';
const safeId = (/** @type {unknown} */ value, /** @type {number} */ max = 256) =>
  typeof value === 'string' && value.length >= 8 && value.length <= max
  && !/[\u0000-\u001f\u007f]/.test(value);

/** @param {unknown} value */
export const parseLocalModelChannelOffer = (value) => {
  const offer = /** @type {any} */ (value);
  if (offer?.type !== LOCAL_MODEL_CHANNEL_OFFER
      || offer.protocol !== LOCAL_MODEL_CHANNEL_PROTOCOL
      || typeof offer.channelId !== 'string' || offer.channelId.length < 8
      || offer.channelId.length > 128 || !LOCAL_MODEL_METHODS.has(offer.method)
      || !offer.args || typeof offer.args !== 'object' || Array.isArray(offer.args)
      || (offer.args.model !== undefined
        && (typeof offer.args.model !== 'string' || offer.args.model.length > 128))
      || (offer.args.includeSupport !== undefined
        && typeof offer.args.includeSupport !== 'boolean')
      || !offer.lease || typeof offer.lease !== 'object') return null;
  if (offer.method === 'generate') {
    const keys = Object.keys(offer.args).sort().join('\n');
    if (keys !== 'maxTokens\nmessages\nmodel\nsystem\ntools'
        || !Array.isArray(offer.args.messages) || offer.args.messages.length > 256
        || offer.args.messages.some((/** @type {any} */ message) => !message || typeof message !== 'object'
          || !['user', 'assistant'].includes(message.role)
          || (!Array.isArray(message.content) && typeof message.content !== 'string'))
        || typeof offer.args.system !== 'string'
        || !Array.isArray(offer.args.tools) || offer.args.tools.length > 256
        || !Number.isSafeInteger(offer.args.maxTokens) || offer.args.maxTokens < 1
        || offer.args.maxTokens > 64_000) return null;
    try {
      if (new TextEncoder().encode(JSON.stringify(offer.args)).byteLength > 2 * 1024 * 1024) {
        return null;
      }
    } catch { return null; }
  }
  return offer;
};

/** @param {string} method */
export const localModelMethodIsRead = (method) => method !== 'init';

/** @param {Set<string>} methods */
const methodPredicate = (methods) => (/** @type {unknown} */ method) =>
  typeof method === 'string' && methods.has(method);
export const repositoryMethodIsKnown = methodPredicate(METHODS);
export const repositoryMethodIsMutating = methodPredicate(MUTATING_METHODS);
export const repositoryMethodMayFetch = methodPredicate(NETWORK_METHODS);
export const repositoryMethodIsAppFile = methodPredicate(APP_FILE_METHODS);

/** @param {unknown} value @param {number} [maxBytes] */
export const repositoryChannelPayloadFits = (
  value,
  maxBytes = REPOSITORY_CHANNEL_MAX_BYTES,
) => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return false;
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= maxBytes;
  } catch { return false; }
};

/** @param {unknown} value */
export const parseRepositoryChannelOffer = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const message = /** @type {Record<string,any>} */ (value);
  const lease = message.lease;
  if (Object.keys(message).sort().join('\n') !== OFFER_KEYS
      || message.type !== REPOSITORY_CHANNEL_OFFER
      || message.protocol !== REPOSITORY_CHANNEL_PROTOCOL
      || !safeId(message.channelId) || !repositoryMethodIsKnown(message.method)
      || !Array.isArray(message.args) || message.args.length > 8
      || !lease || typeof lease !== 'object' || Array.isArray(lease)
      || lease.scope !== 'controller' || !safeId(lease.leaseId)
      || !Number.isSafeInteger(lease.generation) || lease.generation <= 0
      || !safeId(lease.buildId) || !safeId(lease.kernelEpoch)
      || !safeId(lease.hostEpoch)
      || (lease.schema !== undefined && lease.schema !== 1)
      || (lease.bootId !== undefined && !safeId(lease.bootId))) return null;
  if (!repositoryChannelPayloadFits(message.args)) return null;
  return Object.freeze({
    type: REPOSITORY_CHANNEL_OFFER,
    protocol: REPOSITORY_CHANNEL_PROTOCOL,
    channelId: message.channelId,
    method: message.method,
    args: message.args,
    lease: Object.freeze({ ...lease }),
  });
};
