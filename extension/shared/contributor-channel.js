// @ts-check
// Preview-only, single-use Contributor Metrics capability. The heavy canonical
// formatter stays lazy offscreen; storage and mutation authority stay in the
// service worker.

export const CONTRIBUTOR_CHANNEL_OFFER = 'peerd/contributor-channel';
export const CONTRIBUTOR_CHANNEL_PROTOCOL = 1;
export const CONTRIBUTOR_CHANNEL_CALL = 'contributor/kernel-call';
export const CONTRIBUTOR_CHANNEL_REPLY = 'contributor/kernel-reply';
export const CONTRIBUTOR_CHANNEL_RESULT = 'contributor/result';
const ROUTES = new Set([
  'contributor/status', 'contributor/enable', 'contributor/disable',
  'contributor/arm', 'contributor/settlement', 'contributor/feedback',
]);

/** @param {unknown} value */
export const parseContributorOffer = (value) => {
  const offer = /** @type {any} */ (value);
  return offer?.type === CONTRIBUTOR_CHANNEL_OFFER
    && offer.protocol === CONTRIBUTOR_CHANNEL_PROTOCOL
    && typeof offer.channelId === 'string' && offer.channelId.length >= 8
    && offer.channelId.length <= 128 && ROUTES.has(offer.route)
    && offer.lease && typeof offer.lease === 'object' ? offer : null;
};
