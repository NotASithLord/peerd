// @ts-check

/**
 * Track the public page domains whose no-tab worker requests belong inside the
 * browser network floor. Tab custody remains the authority: stale rows are
 * ignored as soon as their tab loses its durable hold or operation lease.
 *
 * DNR exposes a worker's initiator domain, not an exact origin or calling tab.
 * Keep that lossy projection here so the wider scope is visible and testable.
 *
 * @param {{ isGuarded: (tabId: number) => boolean, allowUrl?: (rawUrl: string) => boolean,
 *   persist?: (rows: readonly (readonly [number, readonly string[]])[]) => Promise<unknown>,
 *   deferUntilHydrated?: boolean }} deps
 */
export const createBrowserOriginCustody = ({
  isGuarded,
  allowUrl = () => true,
  persist = async () => {},
  deferUntilHydrated = false,
}) => {
  /** @type {Map<number, Set<string>>} */
  const domainsByTab = new Map();
  const closedDuringHydration = new Set();
  let hydrated = false;
  let hydrationError = /** @type {unknown} */ (null);
  let finishHydration = /** @type {(() => void) | null} */ (null);
  const hydrationReady = deferUntilHydrated
    ? new Promise((resolve) => { finishHydration = () => resolve(undefined); })
    : Promise.resolve();
  let persistQueue = Promise.resolve();
  let persistenceDirty = false;

  /** @param {string} rawUrl */
  const domainForUrl = (rawUrl) => {
    try {
      if (!allowUrl(rawUrl)) return null;
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
      return hostname || null;
    } catch { return null; }
  };

  const snapshot = () => [...domainsByTab]
    .map(([tabId, domains]) => /** @type {const} */ ([tabId, [...domains].sort()]))
    .sort(([left], [right]) => left - right);
  const persistCurrent = () => {
    const rows = snapshot();
    persistenceDirty = true;
    const write = persistQueue.catch(() => {}).then(() => persist(rows)).then(
      () => { persistenceDirty = false; },
      (error) => { persistenceDirty = true; throw error; },
    );
    persistQueue = write;
    return write;
  };

  return {
    /**
     * Retain a public document domain for the lifetime of a guarded tab. A
     * service worker can outlive the document that registered it, so replacing
     * the prior domain on navigation would release its network floor too soon.
     * @param {number} tabId
     * @param {string} rawUrl
     * @param {{ keepOnPersistFailure?: boolean }} [options]
     * @returns {Promise<{ tabId: number, domain: string, added: boolean } | null>}
     */
    async retain(tabId, rawUrl, options = {}) {
      await hydrationReady;
      if (hydrationError) throw hydrationError;
      if (!Number.isInteger(tabId) || tabId < 0 || !isGuarded(tabId)) return null;
      const domain = domainForUrl(rawUrl);
      if (!domain) return null;
      const domains = domainsByTab.get(tabId) ?? new Set();
      const added = !domains.has(domain);
      domains.add(domain);
      domainsByTab.set(tabId, domains);
      if (added || persistenceDirty) {
        try { await persistCurrent(); }
        catch (error) {
          if (options.keepOnPersistFailure) throw error;
          if (added) {
            domains.delete(domain);
            if (!domains.size) domainsByTab.delete(tabId);
            try { await persistCurrent(); } catch { /* the caller still fails closed */ }
          }
          throw error;
        }
      }
      return { tabId, domain, added };
    },

    /**
     * Undo only a newly retained domain whose DNR update failed. A receipt for
     * an already visited domain must never remove the older live protection.
     * @param {{ tabId: number, domain: string, added: boolean } | null} receipt
     */
    async rollback(receipt) {
      if (!receipt?.added) return false;
      const domains = domainsByTab.get(receipt.tabId);
      if (!domains?.delete(receipt.domain)) return false;
      if (!domains.size) domainsByTab.delete(receipt.tabId);
      await persistCurrent();
      return true;
    },

    /** @param {number} tabId */
    async close(tabId) {
      if (!hydrated) closedDuringHydration.add(tabId);
      if (!domainsByTab.delete(tabId)) return false;
      await persistCurrent();
      return true;
    },

    /** @param {readonly (readonly [number, readonly string[]])[]} rows */
    async hydrate(rows) {
      try {
        if (!Array.isArray(rows)) {
          throw new TypeError('browser-origin-custody-snapshot-invalid');
        }
        /** @type {Map<number, Set<string>>} */
        const restored = new Map();
        for (const row of rows) {
          if (!Array.isArray(row) || row.length !== 2) {
            throw new TypeError('browser-origin-custody-snapshot-invalid');
          }
          const [tabId, storedDomains] = row;
          if (!Number.isInteger(tabId) || tabId < 0 || !Array.isArray(storedDomains)) {
            throw new TypeError('browser-origin-custody-snapshot-invalid');
          }
          const domains = restored.get(tabId) ?? new Set();
          for (const storedDomain of storedDomains) {
            if (typeof storedDomain !== 'string') {
              throw new TypeError('browser-origin-custody-snapshot-invalid');
            }
            const domain = domainForUrl(`https://${storedDomain}/`);
            if (!domain || domain !== storedDomain) {
              throw new TypeError('browser-origin-custody-snapshot-invalid');
            }
            domains.add(domain);
          }
          restored.set(tabId, domains);
        }
        for (const [tabId, domains] of restored) {
          if (closedDuringHydration.has(tabId) || !isGuarded(tabId)) continue;
          const current = domainsByTab.get(tabId) ?? new Set();
          for (const domain of domains) current.add(domain);
          domainsByTab.set(tabId, current);
        }
        if (closedDuringHydration.size) await persistCurrent();
      } catch (error) {
        hydrationError = error;
        throw error;
      } finally {
        hydrated = true;
        finishHydration?.();
        finishHydration = null;
      }
    },

    domains() {
      for (const tabId of domainsByTab.keys()) {
        if (!isGuarded(tabId)) domainsByTab.delete(tabId);
      }
      return [...new Set([...domainsByTab.values()].flatMap((domains) => [...domains]))].sort();
    },

    /** @param {number} tabId */
    domainsForTab: (tabId) => [...(domainsByTab.get(tabId) ?? [])].sort(),
  };
};
