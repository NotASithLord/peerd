// @ts-check
// Locally observed authenticated referrals remain bounded; content retrieval
// borrows a separate lease while routing discovery retains routing authority.
import { MAX_PROVIDER_BROKERS } from '../dht/provider-routes.js';
import {createDirectoryTraversal} from './directory-traversal.js';

/** @typedef {Awaited<ReturnType<typeof import('./rooms.js').joinRoom>>} Room */
/** @typedef {{did:string,hints?:{broker?:string},brokers?:string[]}} Contact */
/** @template T
 * @param {Room} room @param {Contact} contact @param {AbortSignal|undefined} signal
 * @param {(broker:string, signal:AbortSignal)=>Promise<T|null>} connect */
const throughReferral = async (room, contact, signal, connect) => {
  if (signal?.aborted) return null;
  const brokers = [...new Set([contact.hints?.broker, ...(contact.brokers ?? [])])]
    .filter((broker) => typeof broker === 'string' && room.mesh.hasLink(broker)).slice(0, MAX_PROVIDER_BROKERS);
  const life = new AbortController();
  const cancel = () => life.abort(signal?.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  // why: a provider index is not proof of a current signaling route. Check
  // bounded authenticated rosters concurrently so one stale route cannot spend
  // the whole caller deadline before a useful alternate is considered.
  const pending = new Map(brokers.map((broker, index) => [index,
    room.mesh.requestRoster(/** @type {string} */ (broker), { signal: life.signal })
      .then(members => ({ index, broker, reachable: Array.isArray(members) && members.includes(contact.did) }))
      .catch(() => ({ index, broker, reachable: false })),
  ]));
  try {
    while (pending.size && !life.signal.aborted) {
      const result = await Promise.race(pending.values());
      pending.delete(result.index);
      if (!result.reachable || life.signal.aborted) continue;
      try {
        const value = await connect(/** @type {string} */ (result.broker), life.signal);
        if (value !== null) return value;
      }
      catch { /* another observed route may still work within the same deadline */ }
    }
    return null;
  } finally {
    signal?.removeEventListener('abort', cancel);
    life.abort();
  }
};

/** @param {Room} room */
export const makeDhtDialer = (room) => {
  /** @param {Contact} contact @param {{signal?:AbortSignal}} [options] */
  const dial = async (contact, {signal} = {}) => {
    if (signal?.aborted) return false;
    if (room.mesh.hasLink(contact.did)) return true;
    return await throughReferral(room, contact, signal, async (broker, active) => {
      await room.dialVia(broker, contact.did, {signal:active});
      return !active.aborted && room.mesh.hasLink(contact.did) ? true : null;
    }) ?? false;
  };
  return Object.assign(dial, {retrieval:room.retrieval, createTraversal: room.temporaryCapacity >= 2 ? (/** @type {Parameters<typeof createDirectoryTraversal>[1]} */ options = {}) => createDirectoryTraversal(room,options) : undefined, acquireLookup: room.contentTransfersEnabled ?
    /** @param {Contact} contact @param {{signal?:AbortSignal}} options */
    async (contact, options) => {
      options.signal?.throwIfAborted();
      if (room.mesh.hasLookupLink(contact.did)) return room.mesh.acquireLookupLink(contact.did, options);
      // No caller signal means explicit release owns the lease, not the
      // short-lived referral search signal that retires when this returns.
      const lease = await throughReferral(room, contact, options.signal, (broker, active) =>
        room.acquireLookupVia(broker, contact.did, {signal:active, leaseSignal:options.signal ?? null}));
      if (!lease) throw new Error('lookup broker unavailable');
      return lease;
    } : undefined, acquireContent: room.contentTransfersEnabled ?
    /** @param {Contact} contact
     * @param {{signal?:AbortSignal,leaseSignal?:AbortSignal|null}} options */
    async (contact, options) => {
      options.signal?.throwIfAborted();
      if (room.mesh.hasContentLink(contact.did)) return room.mesh.acquireContentLink(contact.did, {signal:(options.leaseSignal === undefined ? options.signal : options.leaseSignal) ?? undefined});
      const lease = await throughReferral(room, contact, options.signal, (broker, active) =>
        room.acquireContentVia(broker, contact.did, {signal:active, leaseSignal:options.leaseSignal === undefined ? (options.signal ?? null) : options.leaseSignal}));
      if (!lease) throw new Error('content broker unavailable');
      return lease;
    } : undefined});
};
