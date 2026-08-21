// @ts-check
// Tiny browser-neutral wire contract shared by the authority kernel and the
// offscreen host. Keep host implementation out of the cold service-worker
// graph; this file must remain constants only.

export const FEATURE_LEASE_HOST_PROTOCOL = 1;
export const FEATURE_LEASE_KEEPALIVE_PORT = 'feature-lease-keepalive';
export const LOCAL_MODEL_CHANNEL_OFFER = 'peerd/local-model-channel';
export const LOCAL_MODEL_CHANNEL_RESULT = 'local-model/result';
export const LOCAL_MODEL_CHANNEL_PROTOCOL = 1;
export const OFFSCREEN_FEATURE_LEASE_SCOPES = Object.freeze([
  'controller', 'dweb', 'dom-host', 'media-host', 'model-host', 'vault-authority',
]);

const LOCAL_MODEL_METHODS = new Set(['status', 'catalog', 'probe', 'init']);

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
  return offer;
};

/** @param {string} method */
export const localModelMethodIsRead = (method) => method !== 'init';
