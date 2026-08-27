// @ts-check
// Preview-only, single-use Contributor Metrics capability. The heavy canonical
// formatter stays lazy offscreen; storage and mutation authority stay in the
// service worker.

export const CONTRIBUTOR_CHANNEL_OFFER = 'peerd/contributor-channel';
export const CONTRIBUTOR_CHANNEL_PROTOCOL = 1;
export const CONTRIBUTOR_CHANNEL_CALL = 'contributor/kernel-call';
export const CONTRIBUTOR_CHANNEL_REPLY = 'contributor/kernel-reply';
export const CONTRIBUTOR_CHANNEL_RESULT = 'contributor/result';
export const CONTRIBUTOR_CHANNEL_MAX_PAYLOAD_BYTES = 512 * 1024;
// Closed, content-free cohort facts are co-located with their only wire. This
// keeps the preview kernel on one fixed module edge as the semantic schema grows.
export const CONTRIBUTOR_FEATURES = Object.freeze(['web_actor_surface']);
export const CONTRIBUTOR_SURFACES = Object.freeze(['code', 'tools']);
export const CONTRIBUTOR_FALLBACKS = Object.freeze([
  'none', 'worker_unavailable', 'capability_grant_incomplete',
]);
export const CONTRIBUTOR_BROWSERS = Object.freeze(['chrome', 'firefox']);
export const CONTRIBUTOR_CHANNELS = Object.freeze(['store', 'preview', 'dev', 'web']);
export const CONTRIBUTOR_OUTCOMES = Object.freeze(['completed', 'cancelled', 'error']);
export const CONTRIBUTOR_FAILURES = Object.freeze([
  'none', 'policy', 'auth', 'limits', 'provider', 'timeout', 'aborted',
  'environment', 'agent', 'internal',
]);
export const CONTRIBUTOR_ACTION_KINDS = Object.freeze(['page_code', 'page_action']);
export const CONTRIBUTOR_FEEDBACK = Object.freeze(['worked', 'didnt_work']);
export const CONTRIBUTOR_CLASSIFICATION_CODE_MAX = 255;
const ROUTES = new Set([
  'contributor/status', 'contributor/enable', 'contributor/disable',
  'contributor/settlement', 'contributor/feedback',
]);

/**
 * Bound the private channel's plain-data subset without importing the broader
 * controller protocol into Preview's authority graph.
 * @param {unknown} payload
 */
export const contributorPayloadFits = (payload) => {
  const seen = new Set();
  const encoder = new TextEncoder();
  let nodes = 0;
  const size = (/** @type {unknown} */ value, /** @type {number} */ depth) => {
    nodes += 1;
    if (nodes > 10_000 || depth > 16) return Infinity;
    if (value == null || typeof value === 'boolean') return 1;
    if (typeof value === 'number') return 8;
    if (typeof value === 'string') return encoder.encode(value).byteLength;
    if (!value || typeof value !== 'object' || seen.has(value)) return Infinity;
    if (Array.isArray(value) && value.length > 10_000) return Infinity;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== Array.prototype
        && prototype !== null) return Infinity;
    seen.add(value);
    let total = 0;
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!('value' in descriptor)) { total = Infinity; break; }
      total += encoder.encode(key).byteLength + size(descriptor.value, depth + 1);
      if (!Number.isFinite(total) || total > CONTRIBUTOR_CHANNEL_MAX_PAYLOAD_BYTES) break;
    }
    seen.delete(value);
    return total;
  };
  return size(payload, 0) <= CONTRIBUTOR_CHANNEL_MAX_PAYLOAD_BYTES;
};

/**
 * Consent-rotated opaque identifier used before the first durable write.
 * Keeping this primitive on the authority wire avoids importing semantic
 * provider/model catalogs into the service worker.
 * @param {string} kind @param {string} generation @param {string} value
 */
export const opaqueContributorToken = async (kind, generation, value) => {
  const input = new TextEncoder().encode(`${kind}\u0000${generation}\u0000${value}`);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', input));
  return `${kind}:${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
};

/** @param {unknown} value @param {'operation'|'context'|'selection'} kind */
export const validContributorToken = (value, kind) => typeof value === 'string'
  && new RegExp(`^${kind}:[0-9a-f]{64}$`).test(value);

/** @param {unknown} value */
export const parseContributorProjection = (value) => {
  const candidate = /** @type {any} */ (value);
  const keys = ['providerCode', 'modelFamilyCode', 'outcome', 'failure', 'actions'];
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
      || Object.keys(candidate).sort().join('\0') !== keys.sort().join('\0')
      || !Number.isSafeInteger(candidate.providerCode) || candidate.providerCode < 0
      || candidate.providerCode > CONTRIBUTOR_CLASSIFICATION_CODE_MAX
      || !Number.isSafeInteger(candidate.modelFamilyCode) || candidate.modelFamilyCode < 0
      || candidate.modelFamilyCode > CONTRIBUTOR_CLASSIFICATION_CODE_MAX
      || !CONTRIBUTOR_OUTCOMES.includes(candidate.outcome)
      || !CONTRIBUTOR_FAILURES.includes(candidate.failure)
      || !Array.isArray(candidate.actions) || candidate.actions.length > 128
      || candidate.actions.some((/** @type {unknown} */ action) =>
        !CONTRIBUTOR_ACTION_KINDS.includes(/** @type {any} */ (action)))) return null;
  return Object.freeze({ ...candidate, actions: Object.freeze([...candidate.actions]) });
};

/** @param {unknown} value */
export const parseContributorOffer = (value) => {
  const offer = /** @type {any} */ (value);
  return offer?.type === CONTRIBUTOR_CHANNEL_OFFER
    && offer.protocol === CONTRIBUTOR_CHANNEL_PROTOCOL
    && typeof offer.channelId === 'string' && offer.channelId.length >= 8
    && offer.channelId.length <= 128 && ROUTES.has(offer.route)
    && contributorPayloadFits(offer.message ?? {})
    && offer.lease && typeof offer.lease === 'object' ? offer : null;
};
