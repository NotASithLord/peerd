// @ts-check
// Firefox can synchronously cancel a request while the exact child tab is
// waiting for its durable tab-scoped DNR floor. Chrome does not expose MV3
// blocking webRequest, so its child path continues to use blank-first adoption
// plus the same durable floor.

import { isCloudMetadataHost, isPrivateOrLocalHost } from '../shared/private-network.js';

/**
 * @typedef {{ allowed: boolean, reason?: string }} ChildRequestVerdict
 */

/**
 * @param {string} rawUrl
 * @param {(hostname: string) => boolean} [isSensitiveHost]
 * @param {boolean} [policyReady]
 * @returns {ChildRequestVerdict}
 */
export const classifyDrivenChildRequestTarget = (
  rawUrl,
  isSensitiveHost = () => false,
  policyReady = true,
) => {
  let target;
  try { target = new URL(rawUrl); } catch { return { allowed: true }; }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(target.protocol)) return { allowed: true };
  if (isCloudMetadataHost(target.hostname)) return { allowed: false, reason: 'cloud_metadata' };
  if (isPrivateOrLocalHost(target.hostname)) return { allowed: false, reason: 'private_network' };
  // A restored actor binding can become live before the async denylist seed.
  // Only an exact browser-identified child reaches this classifier, so holding
  // its request briefly is safer than guessing that an empty policy is real.
  if (!policyReady) return { allowed: false, reason: 'policy_loading' };
  if (isSensitiveHost(target.hostname)) return { allowed: false, reason: 'sensitive_site' };
  return { allowed: true };
};

export class FirefoxChildRequestGuardUnavailableError extends Error {
  /** @param {unknown} [cause] */
  constructor(cause) {
    super('Firefox exact-child request guard could not be registered', { cause });
    this.name = 'FirefoxChildRequestGuardUnavailableError';
  }
}

export const FIREFOX_DRIVEN_CHILD_MARKERS_KEY = 'peerd.firefoxDrivenChildren.v1';

/**
 * Firefox background scripts run in an event page, so localStorage is the
 * synchronous durable primitive available to a blocking webRequest listener.
 * Only browser tab ids cross this boundary; destinations never do.
 * @param {Storage} storage
 */
export const makeFirefoxDrivenChildMarkerStore = (storage) => {
  if (typeof storage?.getItem !== 'function' || typeof storage?.setItem !== 'function'
      || typeof storage?.removeItem !== 'function') {
    throw new FirefoxChildRequestGuardUnavailableError();
  }
  return Object.freeze({
    read() {
      const raw = storage.getItem(FIREFOX_DRIVEN_CHILD_MARKERS_KEY);
      if (raw === null) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new TypeError('firefox-child-markers-invalid');
      return parsed;
    },
    /** @param {readonly {tabId:number,sourceTabId:number}[]} markers */
    write(markers) {
      if (markers.length === 0) storage.removeItem(FIREFOX_DRIVEN_CHILD_MARKERS_KEY);
      else storage.setItem(FIREFOX_DRIVEN_CHILD_MARKERS_KEY, JSON.stringify(markers));
    },
  });
};

/**
 * Register only in a generated Firefox package. A Firefox failure is fatal:
 * silently continuing would advertise a guard that is not present.
 * @param {{ isFirefox: boolean, event: any, listener: (details: any) => any }} input
 */
export const registerFirefoxDrivenChildRequestGuard = ({ isFirefox, event, listener }) => {
  if (!isFirefox) return false;
  if (typeof event?.addListener !== 'function') {
    throw new FirefoxChildRequestGuardUnavailableError();
  }
  try {
    event.addListener(listener, { urls: ['<all_urls>'] }, ['blocking']);
  } catch (error) {
    throw new FirefoxChildRequestGuardUnavailableError(error);
  }
  return true;
};

/**
 * @param {Object} deps
 * @param {(sourceTabId: number) => boolean} deps.isDrivenSource
 * @param {()=>boolean} [deps.isSourceReady]
 * @param {(url: string) => ChildRequestVerdict} [deps.classifyTarget]
 * @param {(event: { sourceTabId: number, tabId: number, reason: string }) => unknown} [deps.onBlocked]
 * @param {{read:()=>unknown,write:(markers:readonly {tabId:number,sourceTabId:number}[])=>void}} [deps.markers]
 * @param {number} [deps.maxChildren]
 */
export const makeDrivenChildRequestGuard = ({
  isDrivenSource,
  isSourceReady = () => true,
  classifyTarget = classifyDrivenChildRequestTarget,
  onBlocked = () => {},
  markers,
  maxChildren = 256,
}) => {
  /** @type {Map<number, number>} */
  const exactChildren = new Map();
  const reported = new Set();
  let markerStoreReady = true;

  const validId = (/** @type {unknown} */ value) => typeof value === 'number'
    && Number.isInteger(value) && value >= 0;
  const markerSnapshot = () => [...exactChildren].map(([tabId, sourceTabId]) => ({
    tabId, sourceTabId,
  }));
  const persist = () => {
    if (!markers) return;
    try { markers.write(markerSnapshot()); }
    catch {
      // why: continuing after durability loss would make an event-page recycle
      // silently widen exact-child authority. Hold requests in this realm.
      markerStoreReady = false;
    }
  };
  if (markers) {
    try {
      const stored = markers.read();
      if (!Array.isArray(stored)) throw new TypeError('firefox-child-markers-invalid');
      for (const marker of stored) {
        if (!validId(marker?.tabId) || !validId(marker?.sourceTabId)) {
          throw new TypeError('firefox-child-markers-invalid');
        }
        exactChildren.set(marker.tabId, marker.sourceTabId);
      }
      if (exactChildren.size > maxChildren) markerStoreReady = false;
    } catch {
      markerStoreReady = false;
    }
  }

  const sourceState = (/** @type {number} */ sourceTabId) => {
    try {
      if (!isSourceReady()) return null;
      return isDrivenSource(sourceTabId) === true;
    } catch { return null; }
  };
  const adopt = (/** @type {unknown} */ childTabId, /** @type {unknown} */ sourceTabId) => {
    if (!validId(childTabId) || !validId(sourceTabId)) return;
    const child = /** @type {number} */ (childTabId);
    const source = /** @type {number} */ (sourceTabId);
    if (sourceState(source) !== false) {
      exactChildren.set(child, source);
      if (exactChildren.size > maxChildren) markerStoreReady = false;
      persist();
    }
  };

  return {
    /** @param {{ tabId?: number, sourceTabId?: number }} details */
    onNavigationTarget(details) {
      adopt(details.tabId, details.sourceTabId);
    },

    /** @param {{ tabId?: number, sourceTabId?: number }} details */
    resolveNavigationTarget(details) {
      if (!validId(details.tabId) || !validId(details.sourceTabId)) return;
      const tabId = /** @type {number} */ (details.tabId);
      const sourceTabId = /** @type {number} */ (details.sourceTabId);
      const state = sourceState(sourceTabId);
      if (state === true) adopt(tabId, sourceTabId);
      else if (state === false && exactChildren.delete(tabId)) persist();
    },

    /**
     * This callback must stay synchronous. Firefox applies its returned cancel
     * decision before network IO; awaiting ownership or storage would reopen
     * the child-navigation race this guard exists to close.
     * @param {{ tabId?: number, url?: string, type?: string }} details
     */
    onBeforeRequest(details) {
      if (!markerStoreReady) return { cancel: true };
      if (typeof details.tabId !== 'number' || !exactChildren.has(details.tabId)
          || typeof details.url !== 'string') return {};
      const verdict = classifyTarget(details.url);
      if (verdict.allowed) return {};
      if (details.type !== 'main_frame' && !reported.has(details.tabId)) {
        reported.add(details.tabId);
        try {
          onBlocked({
            sourceTabId: /** @type {number} */ (exactChildren.get(details.tabId)),
            tabId: details.tabId,
            reason: verdict.reason ?? 'private_network',
          });
        } catch { /* observability cannot change the synchronous cancel decision */ }
      }
      return { cancel: true };
    },

    /** @param {number} tabId */
    release(tabId) {
      const removed = exactChildren.delete(tabId);
      reported.delete(tabId);
      if (removed) persist();
    },

    /**
     * Drop crash leftovers only after current browser tab identity disproves
     * the stored exact source-child relation.
     * @param {readonly {id?:number,openerTabId?:number}[]} tabs
     */
    reconcile(tabs) {
      if (!Array.isArray(tabs)) {
        markerStoreReady = false;
        return false;
      }
      const current = new Map(tabs
        .filter((tab) => validId(tab?.id))
        .map((tab) => [tab.id, tab]));
      let changed = false;
      for (const [tabId, sourceTabId] of exactChildren) {
        const child = current.get(tabId);
        if (!child || !current.has(sourceTabId) || child.openerTabId !== sourceTabId
            || sourceState(sourceTabId) === false) {
          exactChildren.delete(tabId);
          reported.delete(tabId);
          changed = true;
        }
      }
      markerStoreReady = exactChildren.size <= maxChildren;
      if (changed || markers) persist();
      return markerStoreReady;
    },

    has: (/** @type {number} */ tabId) => exactChildren.has(tabId),
    ready: () => markerStoreReady,
  };
};
