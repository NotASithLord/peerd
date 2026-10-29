// @ts-check
// why: a single caller's cancellation must not retire another download's ICE
// attempt. One bounded owner per target fans completion out into separate leases.
export const CONTENT_DIAL_WAITERS = 32;
/** @typedef {{release:()=>void}} Lease */
/** @param {{limit:number, has:(did:string)=>boolean,
 * acquire:(did:string, options:{signal?:AbortSignal})=>Lease,
 * connect:(via:string,did:string,signal:AbortSignal)=>Promise<Lease>}} options */
export const createContentDials = ({limit, has, acquire, connect}) => {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('invalid content dial limit');
  /** @typedef {{resolve:(lease:Lease)=>void, reject:(error:Error)=>void, signal?:AbortSignal,
   * cancel:()=>void}} Waiter */
  /** @typedef {{controller:AbortController, waiters:Set<Waiter>}} Entry */
  /** @type {Map<string,Entry>} */ const pending = new Map();
  let stopped = false;
  let waiterCount = 0;
  const cancelled = () => new Error('content dial cancelled');
  /** @param {string} did @param {Entry} entry */
  const forget = (did, entry) => { if (pending.get(did) === entry) pending.delete(did); };
  /** @param {Entry} entry @param {Waiter} waiter */
  const detach = (entry, waiter) => {
    if (entry.waiters.delete(waiter)) waiterCount--;
    waiter.signal?.removeEventListener('abort', waiter.cancel);
  };
  return {
    /** @param {string} via @param {string} did @param {{signal?:AbortSignal}} [options] */
    open(via, did, {signal} = {}) {
      if (stopped || signal?.aborted) return Promise.reject(cancelled());
      if (has(did)) {
        try { return Promise.resolve(acquire(did, {signal})); }
        catch (error) { return Promise.reject(error); }
      }
      if (waiterCount >= CONTENT_DIAL_WAITERS) return Promise.reject(new Error('content waiter capacity'));
      let entry = pending.get(did);
      const fresh = !entry;
      if (!entry) {
        if (pending.size >= limit) return Promise.reject(new Error('content dial capacity'));
        entry = {controller:new AbortController(),waiters:new Set()}; pending.set(did,entry);
      }
      const owned = entry;
      /** @type {Promise<Lease>} */
      const result = new Promise((resolve, reject) => {
        /** @type {Waiter} */
        const waiter = {resolve,reject,signal,cancel:() => {
          if (!owned.waiters.has(waiter)) return;
          detach(owned, waiter); reject(cancelled());
          if (!owned.waiters.size) { forget(did,owned); owned.controller.abort(); }
        }};
        owned.waiters.add(waiter); waiterCount++; signal?.addEventListener('abort',waiter.cancel,{once:true});
      });
      if (fresh) {
        // The connecting operation returns its own lease even on late success.
        // Release it only after handing each live consumer a separate claim.
        Promise.resolve().then(() => {
          if (owned.controller.signal.aborted) throw cancelled();
          return connect(via,did,owned.controller.signal);
        }).then(hold => {
          forget(did,owned);
          try {
            for (const waiter of [...owned.waiters]) {
              detach(owned,waiter);
              if (stopped || waiter.signal?.aborted) { waiter.reject(cancelled()); continue; }
              try { waiter.resolve(acquire(did,{signal:waiter.signal})); }
              catch (error) { waiter.reject(error instanceof Error ? error : new Error(String(error))); }
            }
          } finally { hold.release(); }
        }, error => {
          forget(did,owned);
          for (const waiter of [...owned.waiters]) { detach(owned,waiter); waiter.reject(error); }
        }).catch(() => { /* lease cleanup cannot create an unhandled rejection */ });
      }
      return result;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      for (const entry of pending.values()) {
        entry.controller.abort();
        for (const waiter of [...entry.waiters]) { detach(entry,waiter); waiter.reject(cancelled()); }
      }
      pending.clear();
    },
  };
};
