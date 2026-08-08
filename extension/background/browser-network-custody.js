// @ts-check

export class BrowserNetworkCustodyClosedError extends Error {
  constructor() {
    super('browser network custody closed while its durable hold was being stored');
    this.name = 'BrowserNetworkCustodyClosedError';
  }
}

/** @typedef {{ tabId: number, token: string }} BrowserNetworkCustodyClaim */
/** @typedef {BrowserNetworkCustodyClaim & { added: boolean }} BrowserNetworkDurableClaim */

/**
 * Own durable tab holds and operation-scoped leases for the browser network
 * floor. Persistence is serialized so an older snapshot cannot overwrite a
 * newer close, and hydration records close tombstones before restoring IDs.
 *
 * @param {{ persist: (tabIds: readonly number[]) => Promise<unknown>, makeToken?: () => string }} deps
 */
export const createBrowserNetworkCustody = ({ persist, makeToken = () => crypto.randomUUID() }) => {
  const durable = new Set();
  /** @type {Map<number, string>} */
  const durableTokens = new Map();
  /** @type {Map<number, Set<string>>} */
  const leases = new Map();
  /** @type {Map<number, Promise<BrowserNetworkCustodyClaim>>} */
  const pendingDurableAdds = new Map();
  const closedDuringHydration = new Set();
  let hydrated = false;
  let persistQueue = Promise.resolve();

  const persistDurable = () => {
    const snapshot = [...durable];
    const write = persistQueue.catch(() => {}).then(() => persist(snapshot)).then(() => {});
    persistQueue = write;
    return write;
  };

  /** @param {BrowserNetworkCustodyClaim | undefined} claim */
  const isDurableClaimValid = (claim) => Boolean(
    claim
      && typeof claim.tabId === 'number'
      && typeof claim.token === 'string'
      && durable.has(claim.tabId)
      && durableTokens.get(claim.tabId) === claim.token,
  );

  /** @param {BrowserNetworkCustodyClaim | undefined} lease */
  const isLeaseValid = (lease) => Boolean(
    lease
      && typeof lease.tabId === 'number'
      && typeof lease.token === 'string'
      && leases.get(lease.tabId)?.has(lease.token),
  );

  /**
   * @param {number} tabId
   * @param {BrowserNetworkCustodyClaim} [requiredLease]
   * @returns {Promise<BrowserNetworkDurableClaim>}
   */
  const claimDurable = async (tabId, requiredLease) => {
    // An optimistic Set entry is not durable authority. A second caller that
    // arrives while its write is pending must share the outcome instead of
    // mistaking that entry for an already-persisted hold.
    for (;;) {
      if (requiredLease && !isLeaseValid(requiredLease)) {
        throw new BrowserNetworkCustodyClosedError();
      }
      const pending = pendingDurableAdds.get(tabId);
      if (pending) {
        const claim = await pending;
        // Never let a caller waiting on an older tab generation silently adopt
        // a newer tab that reused the same numeric id.
        if (!isDurableClaimValid(claim)
          || (requiredLease && !isLeaseValid(requiredLease))) {
          throw new BrowserNetworkCustodyClosedError();
        }
        return { ...claim, added: false };
      }
      if (durable.has(tabId)) {
        const token = durableTokens.get(tabId);
        if (!token) throw new BrowserNetworkCustodyClosedError();
        return { tabId, token, added: false };
      }

      durable.add(tabId);
      const claim = { tabId, token: makeToken() };
      durableTokens.set(tabId, claim.token);
      const write = (async () => {
        try {
          await persistDurable();
          // close() can remove this hold while its add write is pending. The
          // caller must not continue after the tab lost custody, even if that
          // first snapshot reached storage successfully.
          if (!isDurableClaimValid(claim)
            || (requiredLease && !isLeaseValid(requiredLease))) {
            throw new BrowserNetworkCustodyClosedError();
          }
          return claim;
        } catch (error) {
          // A storage API may commit and still reject. Restore both the live
          // view and the serialized snapshot before any joined caller settles.
          // A failed cleanup is safe but stale: callers still fail closed and
          // hydration may restore an extra guarded tab, never omit one.
          if (durableTokens.get(tabId) === claim.token) {
            durableTokens.delete(tabId);
            if (durable.delete(tabId)) {
              try { await persistDurable(); } catch { /* best-effort rollback */ }
            }
          }
          throw error;
        }
      })();
      pendingDurableAdds.set(tabId, write);
      try {
        const storedClaim = await write;
        if (!isDurableClaimValid(storedClaim)
          || (requiredLease && !isLeaseValid(requiredLease))) {
          throw new BrowserNetworkCustodyClosedError();
        }
        return { ...storedClaim, added: true };
      } finally {
        if (pendingDurableAdds.get(tabId) === write) pendingDurableAdds.delete(tabId);
      }
    }
  };

  /**
   * Preserve the original boolean contract for callers that do not need to
   * retain the tab generation across another asynchronous operation.
   * @param {number} tabId
   * @returns {Promise<boolean>}
   */
  const addDurable = async (tabId) => (await claimDurable(tabId)).added;

  return {
    /** @param {readonly number[]} tabIds */
    async hydrate(tabIds) {
      for (const tabId of tabIds) {
        if (Number.isInteger(tabId) && tabId >= 0 && !closedDuringHydration.has(tabId)) {
          if (!durable.has(tabId)) {
            durable.add(tabId);
            durableTokens.set(tabId, makeToken());
          }
        }
      }
      hydrated = true;
      if (closedDuringHydration.size) await persistDurable();
    },

    /** @param {number} tabId */
    addDurable,

    /**
     * Add or join a durable hold and retain the exact tab generation acquired.
     * Callers can validate it after an asynchronous DNR synchronization so a
     * close or numeric tab-id reuse cannot turn stale custody into authority.
     * @param {number} tabId
     * @param {BrowserNetworkCustodyClaim} [requiredLease]
     * @returns {Promise<BrowserNetworkDurableClaim>}
     */
    claimDurable,

    /** @param {BrowserNetworkCustodyClaim | undefined} claim */
    isDurableClaimValid,

    /** @param {number} tabId */
    async removeDurable(tabId) {
      if (!durable.delete(tabId)) return false;
      durableTokens.delete(tabId);
      await persistDurable();
      return true;
    },

    /** @param {number} tabId */
    acquire(tabId) {
      const token = makeToken();
      const owned = leases.get(tabId) ?? new Set();
      owned.add(token);
      leases.set(tabId, owned);
      return { tabId, token };
    },

    /** @param {{ tabId?: number, token?: string } | undefined} lease */
    release(lease) {
      if (!lease || typeof lease.tabId !== 'number' || typeof lease.token !== 'string') return false;
      const owned = leases.get(lease.tabId);
      if (!owned?.delete(lease.token)) return false;
      if (!owned.size) leases.delete(lease.tabId);
      return true;
    },

    /** @param {BrowserNetworkCustodyClaim | undefined} lease */
    isLeaseValid,

    /** @param {number} tabId */
    async close(tabId) {
      if (!hydrated) closedDuringHydration.add(tabId);
      leases.delete(tabId);
      durableTokens.delete(tabId);
      if (durable.delete(tabId)) await persistDurable();
    },

    /** @param {number} tabId */
    hasDurable: (tabId) => durable.has(tabId),
    tabIds: () => [...new Set([
      ...durable,
      ...[...leases].filter(([, owned]) => owned.size).map(([tabId]) => tabId),
    ])],
  };
};
