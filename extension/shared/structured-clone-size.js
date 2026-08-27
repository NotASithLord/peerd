// @ts-check
// Conservative byte accounting for the plain structured-clone payload subset
// accepted by privileged Peerd channels. Accessors, cycles, exotic objects and
// unsupported primitives fail closed instead of becoming hidden work.

export { CONTROLLER_BUILD_DIGEST } from './controller-build.js';

/**
 * @param {unknown} payload
 * @param {{ maxDepth?: number, maxNodes?: number }} [limits]
 */
export const structuredClonePayloadBytes = (
  payload,
  { maxDepth = 16, maxNodes = 10_000 } = {},
) => {
  const seen = new Set();
  const encoder = new TextEncoder();
  let nodes = 0;
  const size = (/** @type {unknown} */ value, /** @type {number} */ depth) => {
    nodes += 1;
    if (nodes > maxNodes || depth > maxDepth) return Infinity;
    if (value === null || value === undefined) return 1;
    if (typeof value === 'boolean') return 1;
    if (typeof value === 'number' || typeof value === 'bigint') return 8;
    if (typeof value === 'string') return encoder.encode(value).byteLength;
    if (typeof value !== 'object') return Infinity;
    if (value instanceof ArrayBuffer) return value.byteLength;
    if (ArrayBuffer.isView(value)) return value.byteLength;
    if (seen.has(value)) return Infinity;
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        let total = 0;
        for (const [key, descriptor] of Object.entries(
          Object.getOwnPropertyDescriptors(value),
        )) {
          if (key === 'length') continue;
          if (!('value' in descriptor)) return Infinity;
          total += encoder.encode(key).byteLength + size(descriptor.value, depth + 1);
          if (!Number.isFinite(total)) return Infinity;
        }
        return total;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return Infinity;
      let total = 0;
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
        if (!('value' in descriptor)) return Infinity;
        total += encoder.encode(key).byteLength + size(descriptor.value, depth + 1);
        if (!Number.isFinite(total)) return Infinity;
      }
      return total;
    } finally {
      seen.delete(value);
    }
  };
  return size(payload, 0);
};

/** @param {unknown} payload @param {number} maxBytes */
export const structuredClonePayloadFits = (payload, maxBytes) => {
  const bytes = structuredClonePayloadBytes(payload);
  return Number.isFinite(bytes) && bytes <= maxBytes;
};

// Private semantic-controller protocol. Co-locating it with the structured
// clone accounting keeps the authority kernel on its existing reviewed module
// graph while both sides still share one strict wire definition.
export const CONTROLLER_CHANNEL_PROTOCOL = 2;
export const CONTROLLER_CHANNEL_OFFER = 'peerd/controller-channel';
export const CONTROLLER_PHASE = Object.freeze({
  OPENED: 'opened', ACCEPTED: 'accepted', COMMITTING: 'committing',
  COMMITTED: 'committed', SETTLED: 'settled',
});
export const CONTROLLER_REPLAY_CLASSES = Object.freeze(['A', 'B', 'C', 'D', 'E']);
export const SEMANTIC_DISPATCH_PROTOCOL = 1;

/** @param {unknown} value */
export const isControllerBuildDigest = (value) =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** @param {unknown} value */
export const parseControllerAuthority = (value) => {
  if (!value || typeof value !== 'object') return null;
  const input = /** @type {Record<string, unknown>} */ (value);
  const text = (/** @type {string} */ key, nullable = false) => {
    const field = input[key];
    if (nullable && field === null) return null;
    return typeof field === 'string' && field.length > 0 && field.length <= 512
      ? field : undefined;
  };
  const authority = {
    ownerId: text('ownerId'), sessionId: text('sessionId', true),
    instanceId: text('instanceId', true), origin: text('origin', true),
    target: text('target', true), replayClass: input.replayClass,
  };
  if (authority.ownerId === undefined || authority.sessionId === undefined
      || authority.instanceId === undefined || authority.origin === undefined
      || authority.target === undefined
      || !CONTROLLER_REPLAY_CLASSES.includes(/** @type {any} */ (authority.replayClass))
      || Object.keys(input).length !== Object.keys(authority).length) return null;
  /** @type {{ownerId:string,sessionId:string|null,instanceId:string|null,
   * origin:string|null,target:string|null,replayClass:'A'|'B'|'C'|'D'|'E'}} */
  const parsed = /** @type {any} */ (authority);
  return parsed;
};

export const CONTROLLER_REALM_FACT_KEYS = Object.freeze([
  'window', 'document', 'browser', 'chrome', 'fetch', 'xhr', 'webSocket',
  'eventSource', 'webTransport', 'rtc', 'worker', 'sharedWorker',
  'broadcastChannel', 'indexedDB', 'caches', 'opfsRoot', 'serviceWorker',
  'locks', 'sendBeacon', 'importScripts',
]);

/** @param {unknown} value */
export const isSealedControllerRealm = (value) => {
  if (!value || typeof value !== 'object') return false;
  const facts = /** @type {Record<string, unknown>} */ (value);
  return CONTROLLER_REALM_FACT_KEYS.every((key) => facts[key] === false)
    && Object.keys(facts).length === CONTROLLER_REALM_FACT_KEYS.length;
};

/**
 * @param {unknown} value
 * @param {{channelId:string,buildDigest:string,kernelEpoch:string,hostEpoch?:string|null}} binding
 */
export const isControllerChannelMessage = (value, binding) => {
  if (!value || typeof value !== 'object') return false;
  const message = /** @type {Record<string, unknown>} */ (value);
  return message.protocol === CONTROLLER_CHANNEL_PROTOCOL
    && message.channelId === binding.channelId
    && message.buildDigest === binding.buildDigest
    && message.kernelEpoch === binding.kernelEpoch
    && (binding.hostEpoch == null || message.hostEpoch === binding.hostEpoch)
    && Number.isSafeInteger(message.sequence) && Number(message.sequence) > 0
    && typeof message.type === 'string';
};

/** @param {unknown} value @returns {string[] | null} */
export const parseControllerCaps = (value) => {
  if (!Array.isArray(value) || value.length > 64) return null;
  const caps = [];
  const seen = new Set();
  for (const cap of value) {
    if (typeof cap !== 'string' || !/^[a-z][a-z0-9.-]{0,63}$/.test(cap) || seen.has(cap)) {
      return null;
    }
    seen.add(cap);
    caps.push(cap);
  }
  return caps;
};

/** @param {unknown} payload @param {{maxDepth?:number,maxNodes?:number}} [limits] */
export const controllerPayloadBytes = (payload, { maxDepth = 16, maxNodes = 10_000 } = {}) =>
  structuredClonePayloadBytes(payload, { maxDepth, maxNodes });

/** @param {unknown} payload @param {number} maxBytes */
export const payloadFitsControllerCap = (payload, maxBytes) =>
  structuredClonePayloadFits(payload, maxBytes);
