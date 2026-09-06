// @ts-check
// Shallow artifact-channel admission for the cold offscreen supervisor. Exact
// clone byte rails are rechecked by the lazy host before it allocates a Worker.

export const ARTIFACT_CHANNEL_OFFER = 'peerd/artifact-channel';
export const ARTIFACT_CHANNEL_PROTOCOL = 1;
export const ARTIFACT_CHANNEL_OPERATIONS = Object.freeze([
  'buildAppExport', 'buildNotebookExport', 'buildVmRecipeExport',
  'openEnvelope', 'inspectEnvelope', 'exportFilename',
]);
const OPERATIONS = new Set(ARTIFACT_CHANNEL_OPERATIONS);
const OFFER_KEYS = 'args\nchannelId\noperation\nprotocol\ntype';
const LEASED_OFFER_KEYS = 'args\nchannelId\nlease\noperation\nprotocol\ntype';

/** @param {unknown} operation */
export const artifactChannelOperationAllowed = (operation) =>
  typeof operation === 'string' && OPERATIONS.has(operation);

/** @param {unknown} value */
export const parseArtifactChannelOffer = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const message = /** @type {Record<string,unknown>} */ (value);
  const keys = Object.keys(message).sort().join('\n');
  if ((keys !== OFFER_KEYS && keys !== LEASED_OFFER_KEYS)
      || message.type !== ARTIFACT_CHANNEL_OFFER
      || message.protocol !== ARTIFACT_CHANNEL_PROTOCOL
      || typeof message.channelId !== 'string'
      || message.channelId.length < 8 || message.channelId.length > 256
      || /[\u0000-\u001f\u007f]/.test(message.channelId)
      || typeof message.operation !== 'string'
      || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(message.operation)
      || !Array.isArray(message.args) || message.args.length > 8) return null;
  return Object.freeze({
    type: ARTIFACT_CHANNEL_OFFER,
    protocol: ARTIFACT_CHANNEL_PROTOCOL,
    channelId: message.channelId,
    operation: /** @type {string} */ (message.operation),
    args: message.args,
    ...(keys === LEASED_OFFER_KEYS ? { lease: message.lease } : {}),
  });
};

/** @param {any} event @param {string} workerUrl @param {boolean|((lease:unknown)=>boolean)} ownsLease */
export const admitArtifactChannelOffer = (event, workerUrl, ownsLease) => {
  if (event?.data?.type !== ARTIFACT_CHANNEL_OFFER) {
    return { matched: false, ok: false, reason: 'not-artifact-offer', offer: null };
  }
  const source = /** @type {{scriptURL?:unknown}|null} */ (event.source ?? null);
  if (event.isTrusted !== true || !workerUrl || source?.scriptURL !== workerUrl) {
    return { matched: true, ok: false, reason: 'sender-invalid', offer: null };
  }
  if (!Array.isArray(event.ports) || event.ports.length !== 1 || !event.ports[0]) {
    return { matched: true, ok: false, reason: 'port-invalid', offer: null };
  }
  const offer = parseArtifactChannelOffer(event.data);
  if (!offer) return { matched: true, ok: false, reason: 'offer-invalid', offer: null };
  if (!artifactChannelOperationAllowed(offer.operation)) {
    return { matched: true, ok: false, reason: 'operation-denied', offer };
  }
  return (typeof ownsLease === 'function' ? ownsLease(offer.lease) : ownsLease)
    ? { matched: true, ok: true, reason: null, offer }
    : { matched: true, ok: false, reason: 'lease-inactive', offer };
};
