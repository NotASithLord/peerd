// @ts-check
// Exact repository offer supervisor. The heavy repository graph and OPFS calls
// live in one disposable Worker per offer so a stuck storage realm cannot take
// controller, dweb, or vault down with it.

import {
  REPOSITORY_CHANNEL_CANCEL,
  REPOSITORY_CHANNEL_RESULT,
  REPOSITORY_WORKER_BOOTSTRAP,
  REPOSITORY_WORKER_SETTLED,
  sameRepositoryLease,
} from '/shared/repository-channel.js';
import {
  REPOSITORY_CHANNEL_PROTOCOL,
  parseRepositoryChannelOffer,
} from '/shared/feature-lease-protocol.js';

/** @typedef {{worker:Worker,lease:any}} ActiveCall */
/** @type {Map<string,ActiveCall>} */
const calls = new Map();
const seenChannels = new Set();
/** @type {string[]} */ const seenOrder = [];
/** @type {Map<string,any>} */ const settledCalls = new Map();

/** @param {string} channelId */
const rememberChannel = (channelId) => {
  if (seenChannels.has(channelId)) return false;
  seenChannels.add(channelId);
  seenOrder.push(channelId);
  if (seenOrder.length > 1024) {
    const expired = seenOrder.shift();
    if (expired !== undefined) seenChannels.delete(expired);
  }
  return true;
};

/** @param {string} channelId @param {Worker} worker */
const finish = (channelId, worker) => {
  const active = calls.get(channelId);
  if (active?.worker !== worker) return false;
  calls.delete(channelId);
  try { worker.terminate(); } catch { /* already stopped */ }
  settledCalls.set(channelId, active.lease);
  while (settledCalls.size > 1024) {
    settledCalls.delete(/** @type {string} */ (settledCalls.keys().next().value));
  }
  return true;
};

export const abortRepositoryHostCalls = () => {
  const active = [...calls.entries()];
  for (const [channelId, { worker }] of active) finish(channelId, worker);
  return active.length;
};

/**
 * @param {unknown} value
 */
export const cancelRepositoryCall = (value) => {
  const message = /** @type {any} */ (value);
  const active = typeof message?.channelId === 'string' ? calls.get(message.channelId) : null;
  if (message?.type !== REPOSITORY_CHANNEL_CANCEL
      || message?.protocol !== REPOSITORY_CHANNEL_PROTOCOL) return false;
  if (active && sameRepositoryLease(active.lease, message.lease)) {
    return finish(message.channelId, active.worker);
  }
  return sameRepositoryLease(settledCalls.get(message.channelId), message.lease);
};

/**
 * Exact admitted ServiceWorker offer. Sender and initial lease admission are
 * checked by the cold supervisor; the lease is rechecked here after lazy load.
 * @param {MessageEvent} event
 * @param {{ownsLease?:(lease:any)=>boolean,createWorker?:()=>Worker}} [deps]
 */
export const acceptRepositoryOffer = (event, {
  ownsLease = () => false,
  createWorker = () => new Worker(new URL('./repository-worker.js', import.meta.url), {
    type: 'module', name: 'peerd-repository-operation',
  }),
} = {}) => {
  const offer = parseRepositoryChannelOffer(event.data);
  const port = event.ports?.length === 1 ? event.ports[0] : null;
  if (!offer || !port) {
    try { port?.close(); } catch { /* invalid */ }
    return false;
  }
  if (!ownsLease(offer.lease)) {
    try { port.postMessage({
      type: REPOSITORY_CHANNEL_RESULT,
      protocol: REPOSITORY_CHANNEL_PROTOCOL,
      channelId: offer.channelId,
      ok: false,
      code: 'repository-channel-lease-stale',
      error: 'repository channel lease is no longer active',
      outcomeKnown: true,
    }); } catch { /* invalid/closed */ }
    try { port.close(); } catch { /* invalid/closed */ }
    return false;
  }
  if (!rememberChannel(offer.channelId)) {
    try { port.close(); } catch { /* replay */ }
    return false;
  }
  let worker;
  try { worker = createWorker(); }
  catch {
    try { port.postMessage({
      type: REPOSITORY_CHANNEL_RESULT,
      protocol: REPOSITORY_CHANNEL_PROTOCOL,
      channelId: offer.channelId,
      ok: false,
      code: 'repository-host-load-failed',
      error: 'repository worker failed to start',
      outcomeKnown: true,
    }); } catch { /* invalid/closed */ }
    try { port.close(); } catch { /* invalid/closed */ }
    return false;
  }
  calls.set(offer.channelId, { worker, lease: offer.lease });
  worker.onmessage = (message) => {
    const reply = message.data;
    if (reply?.type === REPOSITORY_WORKER_SETTLED
        && reply?.protocol === REPOSITORY_CHANNEL_PROTOCOL
        && reply?.channelId === offer.channelId) finish(offer.channelId, worker);
  };
  worker.onerror = () => { finish(offer.channelId, worker); };
  worker.onmessageerror = () => { finish(offer.channelId, worker); };
  try {
    worker.postMessage({
      type: REPOSITORY_WORKER_BOOTSTRAP,
      offer,
    }, [port]);
  } catch {
    finish(offer.channelId, worker);
    try { port.close(); } catch { /* invalid/transferred */ }
    return false;
  }
  return true;
};
