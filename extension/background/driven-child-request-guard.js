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
export const FIREFOX_DRIVEN_CHILD_IDS_KEY = `${FIREFOX_DRIVEN_CHILD_MARKERS_KEY}.ids`;

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
    readExactIds() {
      const raw = storage.getItem(FIREFOX_DRIVEN_CHILD_IDS_KEY);
      if (raw === null) return null;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new TypeError('firefox-child-ids-invalid');
      return parsed;
    },
    /** @param {readonly {tabId:number,sourceTabId:number}[]} markers */
    write(markers) {
      if (markers.length === 0) {
        storage.removeItem(FIREFOX_DRIVEN_CHILD_MARKERS_KEY);
        storage.removeItem(FIREFOX_DRIVEN_CHILD_IDS_KEY);
      } else {
        storage.setItem(
          FIREFOX_DRIVEN_CHILD_IDS_KEY,
          JSON.stringify(markers.map(({ tabId }) => tabId)),
        );
        storage.setItem(FIREFOX_DRIVEN_CHILD_MARKERS_KEY, JSON.stringify(markers));
      }
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
 * @param {(sourceTabId: number)=>Promise<boolean>} [deps.waitForSourceEvidence]
 * @param {(sourceTabId: number)=>Promise<boolean>} [deps.waitForSourceAuthority]
 * @param {(sourceTabId: number)=>Promise<boolean>} [deps.ensureSourceAuthority]
 * @param {()=>Promise<boolean>} [deps.waitForPolicyReady]
 * @param {(url: string) => ChildRequestVerdict} [deps.classifyTarget]
 * @param {(event: { sourceTabId: number, tabId: number, reason: string, flowToken?:symbol }) => unknown} [deps.onBlocked]
 * @param {(failure:{ok:false,code:string,outcomeKnown:true,retryable:true,affectedTabIds:number[],sourceTabIds:number[],confirmedTabIds:number[],closeTabIds:number[]})=>unknown} [deps.onUnavailable]
 * @param {{read:()=>unknown,readExactIds?:()=>unknown,write:(markers:readonly {tabId:number,sourceTabId:number}[])=>void}} [deps.markers]
 * @param {number} [deps.maxChildren]
 * @param {number} [deps.classificationTimeoutMs]
 * @param {number} [deps.policyTimeoutMs]
 */
export const makeDrivenChildRequestGuard = ({
  isDrivenSource,
  isSourceReady = () => true,
  waitForSourceEvidence,
  waitForSourceAuthority,
  ensureSourceAuthority,
  waitForPolicyReady,
  classifyTarget = classifyDrivenChildRequestTarget,
  onBlocked = () => {},
  onUnavailable = () => {},
  markers,
  maxChildren = 256,
  classificationTimeoutMs = 5_000,
  policyTimeoutMs = classificationTimeoutMs,
}) => {
  /** @type {Map<number, number>} */
  const exactChildren = new Map();
  const uncertainChildren = new Set();
  const confirmedChildren = new Set();
  const ambiguousChildren = new Set();
  const observedChildren = new Set();
  /** @type {Map<number,symbol>} */ const flowTokens = new Map();
  /** @type {Map<number,ReturnType<typeof setTimeout>>} */
  const classificationTimers = new Map();
  /** @type {Map<number,Set<(state:'driven'|'user'|'ambiguous')=>void>>} */
  const classificationWaiters = new Map();
  const reported = new Set();
  const reportedPolicyFailures = new Set();
  let markerStoreReady = true;
  /** @type {string|null} */ let unavailableSignature = null;

  const validId = (/** @type {unknown} */ value) => typeof value === 'number'
    && Number.isInteger(value) && value >= 0;
  const markerSnapshot = () => [...exactChildren].map(([tabId, sourceTabId]) => ({
    tabId, sourceTabId,
  }));
  const affectedTabIds = () => [...new Set([
    ...exactChildren.keys(), ...uncertainChildren,
  ])].sort((left, right) => left - right);
  const signalUnavailable = () => {
    markerStoreReady = false;
    const affected = affectedTabIds();
    const confirmed = affected.filter((tabId) => confirmedChildren.has(tabId));
    const close = affected.filter((tabId) => confirmedChildren.has(tabId));
    const sources = [...new Set(affected
      .map((tabId) => exactChildren.get(tabId))
      .filter((value) => typeof value === 'number'))];
    const signature = `${affected.join(',')}|${confirmed.join(',')}|${close.join(',')}`;
    if (signature === unavailableSignature
        || (affected.length === 0 && unavailableSignature !== null)) return;
    unavailableSignature = signature;
    try {
      onUnavailable({
        ok: false, code: 'firefox-child-custody-unavailable',
        outcomeKnown: true, retryable: true,
        affectedTabIds: affected, sourceTabIds: sources,
        confirmedTabIds: confirmed, closeTabIds: close,
      });
    } catch { /* containment cannot depend on reporting */ }
  };
  const signalPolicyUnavailable = (/** @type {number} */ tabId) => {
    if (reportedPolicyFailures.has(tabId)) return;
    reportedPolicyFailures.add(tabId);
    const sourceTabId = exactChildren.get(tabId);
    try {
      onUnavailable({
        ok: false, code: 'firefox-child-policy-unavailable',
        outcomeKnown: true, retryable: true,
        affectedTabIds: [tabId],
        sourceTabIds: typeof sourceTabId === 'number' ? [sourceTabId] : [],
        confirmedTabIds: [], closeTabIds: [],
      });
    } catch { /* reporting cannot change the blocking decision */ }
  };
  const persist = () => {
    if (!markers) {
      markerStoreReady = exactChildren.size <= maxChildren;
      if (markerStoreReady && uncertainChildren.size === 0) unavailableSignature = null;
      return;
    }
    if ([...uncertainChildren].some((tabId) => !exactChildren.has(tabId))) {
      signalUnavailable();
      return;
    }
    try {
      markers.write(markerSnapshot());
      markerStoreReady = exactChildren.size <= maxChildren;
      if (markerStoreReady && uncertainChildren.size === 0) unavailableSignature = null;
    }
    catch {
      for (const tabId of exactChildren.keys()) uncertainChildren.add(tabId);
      signalUnavailable();
    }
  };
  if (markers) {
    /** @type {number[]|null} */ let ledger = null;
    let hydrationFailed = false;
    try {
      const storedIds = markers.readExactIds?.() ?? null;
      if (storedIds !== null && (!Array.isArray(storedIds)
          || storedIds.some((tabId) => !validId(tabId)))) {
        throw new TypeError('firefox-child-ids-invalid');
      }
      ledger = storedIds;
    } catch { hydrationFailed = true; }
    try {
      const stored = markers.read();
      if (!Array.isArray(stored)) throw new TypeError('firefox-child-markers-invalid');
      if (stored.some((marker) => !validId(marker?.tabId)
          || !validId(marker?.sourceTabId))) {
        throw new TypeError('firefox-child-markers-invalid');
      }
      for (const marker of stored) {
        exactChildren.set(marker.tabId, marker.sourceTabId);
      }
    } catch { hydrationFailed = true; }
    if (ledger) {
      const exactIds = new Set(exactChildren.keys());
      for (const tabId of ledger) {
        if (!exactIds.has(tabId)) uncertainChildren.add(tabId);
      }
      if (ledger.length !== exactIds.size
          || ledger.some((tabId) => !exactIds.has(tabId))) hydrationFailed = true;
    }
    for (const tabId of exactChildren.keys()) uncertainChildren.add(tabId);
    if (hydrationFailed || exactChildren.size > maxChildren) signalUnavailable();
  }

  const sourceState = (/** @type {number} */ sourceTabId) => {
    try {
      if (!isSourceReady()) return null;
      return isDrivenSource(sourceTabId) === true;
    } catch { return null; }
  };
  const clearClassification = (/** @type {number} */ tabId) => {
    const timer = classificationTimers.get(tabId);
    if (timer !== undefined) clearTimeout(timer);
    classificationTimers.delete(tabId);
    ambiguousChildren.delete(tabId);
  };
  const resolveClassification = (
    /** @type {number} */ tabId,
    /** @type {'driven'|'user'|'ambiguous'} */ state,
  ) => {
    const waiters = classificationWaiters.get(tabId);
    classificationWaiters.delete(tabId);
    for (const resolve of waiters ?? []) resolve(state);
  };
  const classifyDriven = (/** @type {number} */ tabId) => {
    uncertainChildren.delete(tabId);
    clearClassification(tabId);
    persist();
    resolveClassification(tabId, 'driven');
  };
  const classifyUser = (/** @type {number} */ tabId) => {
    exactChildren.delete(tabId);
    uncertainChildren.delete(tabId);
    confirmedChildren.delete(tabId);
    clearClassification(tabId);
    persist();
    resolveClassification(tabId, 'user');
  };
  const settleClassification = (/** @type {number} */ tabId) => {
    const sourceTabId = exactChildren.get(tabId);
    if (sourceTabId === undefined || !uncertainChildren.has(tabId)) {
      clearClassification(tabId);
      return;
    }
    const state = sourceState(sourceTabId);
    if (state === true) {
      classifyDriven(tabId);
    } else if (state === false) {
      classifyUser(tabId);
    } else {
      classificationTimers.delete(tabId);
      ambiguousChildren.add(tabId);
      signalUnavailable();
      resolveClassification(tabId, 'ambiguous');
    }
  };
  const scheduleClassification = (/** @type {number} */ tabId) => {
    if (classificationTimers.has(tabId)) return;
    classificationTimers.set(tabId, setTimeout(
      () => settleClassification(tabId), Math.max(0, classificationTimeoutMs),
    ));
  };
  const waitForClassification = (/** @type {number} */ tabId) =>
    new Promise((resolve) => {
      const waiters = classificationWaiters.get(tabId) ?? new Set();
      waiters.add(resolve);
      classificationWaiters.set(tabId, waiters);
    });
  const startClassification = (
    /** @type {number} */ child,
    /** @type {number} */ source,
    demandSource = false,
  ) => {
    if (classificationTimers.has(child) || ambiguousChildren.has(child)) return;
    uncertainChildren.add(child);
    scheduleClassification(child);
    if (typeof waitForSourceEvidence === 'function') {
      Promise.resolve(waitForSourceEvidence(source)).catch(() => {});
    }
    const sourceAuthority = demandSource
      ? ensureSourceAuthority ?? waitForSourceAuthority : waitForSourceAuthority;
    if (typeof sourceAuthority === 'function') {
      Promise.resolve(sourceAuthority(source)).then((driven) => {
        if (exactChildren.get(child) !== source || !uncertainChildren.has(child)) return;
        if (driven === true) classifyDriven(child);
        else classifyUser(child);
      }).catch(() => {});
    }
  };
  const refreshClassifications = () => {
    for (const tabId of [...uncertainChildren]) {
      const sourceTabId = exactChildren.get(tabId);
      if (sourceTabId === undefined) continue;
      const state = sourceState(sourceTabId);
      if (state === true) classifyDriven(tabId);
      else if (state === false) classifyUser(tabId);
    }
  };
  const adopt = (/** @type {unknown} */ childTabId, /** @type {unknown} */ sourceTabId) => {
    if (!validId(childTabId) || !validId(sourceTabId)) return;
    const child = /** @type {number} */ (childTabId);
    const source = /** @type {number} */ (sourceTabId);
    const state = sourceState(source);
    if (state !== false) {
      observedChildren.add(child);
      confirmedChildren.delete(child);
      reported.delete(child);
      reportedPolicyFailures.delete(child);
      exactChildren.set(child, source);
      if (state === null) {
        startClassification(child, source);
      } else {
        uncertainChildren.delete(child);
        clearClassification(child);
      }
      if (exactChildren.size > maxChildren) signalUnavailable();
      persist();
    }
  };
  const reportRequestBlocked = (
    /** @type {{tabId?:number,type?:string,flowToken?:symbol}} */ details,
    /** @type {string} */ reason,
    includeMainFrame = false,
  ) => {
    if (typeof details.tabId !== 'number' || reported.has(details.tabId)
        || (!includeMainFrame && details.type === 'main_frame')) return;
    const sourceTabId = exactChildren.get(details.tabId);
    if (sourceTabId === undefined) return;
    reported.add(details.tabId);
    try {
      onBlocked({
        sourceTabId, tabId: details.tabId, reason,
        ...(details.flowToken ? { flowToken: details.flowToken } : {}),
      });
    }
    catch { /* observability cannot change the blocking decision */ }
  };
  const refusePolicy = (
    /** @type {{tabId?:number,type?:string,flowToken?:symbol}} */ details) => {
    if (typeof details.tabId !== 'number') return { cancel: true };
    reportRequestBlocked(details, 'policy_unavailable', true);
    signalPolicyUnavailable(details.tabId);
    return { cancel: true };
  };
  /** @returns {{cancel?:boolean}|Promise<{cancel?:boolean}>} */
  const decideKnownRequest = (
    /** @type {{ tabId?: number, url?: string, type?: string, flowToken?:symbol }} */ details,
    allowPolicyWait = true,
  ) => {
    if (typeof details.tabId !== 'number' || !exactChildren.has(details.tabId)
        || typeof details.url !== 'string') return {};
    const verdict = classifyTarget(details.url);
    if (verdict.reason === 'policy_loading' && allowPolicyWait
        && typeof waitForPolicyReady === 'function') {
      /** @type {Promise<boolean>} */
      const policyReady = new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), Math.max(0, policyTimeoutMs));
        Promise.resolve().then(waitForPolicyReady).then(
          (ready) => { clearTimeout(timer); resolve(ready === true); },
          () => { clearTimeout(timer); resolve(false); },
        );
      });
      return policyReady.then((ready) => {
        if (!exactChildren.has(/** @type {number} */ (details.tabId))) return {};
        if (ready) return decideKnownRequest(details, false);
        return refusePolicy(details);
      });
    }
    if (verdict.reason === 'policy_loading' && !allowPolicyWait) {
      return refusePolicy(details);
    }
    if (verdict.allowed) return {};
    reportRequestBlocked(details, verdict.reason ?? 'private_network', true);
    return { cancel: true };
  };

  return {
    /** @param {{ tabId?: number, sourceTabId?: number, flowToken?:symbol }} details */
    onNavigationTarget(details) {
      if (typeof details.tabId === 'number' && typeof details.flowToken === 'symbol') {
        flowTokens.set(details.tabId, details.flowToken);
      }
      adopt(details.tabId, details.sourceTabId);
    },

    /** @param {{ tabId?: number, sourceTabId?: number }} details */
    resolveNavigationTarget(details) {
      if (!validId(details.tabId) || !validId(details.sourceTabId)) return;
      const tabId = /** @type {number} */ (details.tabId);
      const sourceTabId = /** @type {number} */ (details.sourceTabId);
      const state = sourceState(sourceTabId);
      if (state === true) {
        exactChildren.set(tabId, sourceTabId);
        classifyDriven(tabId);
      } else if (state === false) {
        classifyUser(tabId);
      }
    },

    /**
     * @param {{ tabId?: number, url?: string, type?: string }} details
     */
    onBeforeRequest(details) {
      if (typeof details.tabId !== 'number') return {};
      const tabId = details.tabId;
      const request = flowTokens.has(tabId)
        ? { ...details, tabId, flowToken: flowTokens.get(tabId) } : { ...details, tabId };
      if (uncertainChildren.has(tabId)) {
        if (!observedChildren.has(tabId) && exactChildren.has(tabId)
            && typeof details.url === 'string'
            && classifyTarget(details.url).allowed) return {};
        const sourceTabId = exactChildren.get(tabId);
        if (sourceTabId !== undefined) {
          const state = sourceState(sourceTabId);
          if (state === true) {
            classifyDriven(tabId);
            if (!markerStoreReady) return { cancel: true };
            return decideKnownRequest(request);
          }
          if (state === false) {
            classifyUser(tabId);
            return {};
          }
          startClassification(tabId, sourceTabId, !observedChildren.has(tabId));
        }
        if (!classificationTimers.has(tabId)) return { cancel: true };
        return waitForClassification(tabId).then((state) => {
          if (state === 'user') return {};
          if (state === 'ambiguous') return { cancel: true };
          return decideKnownRequest(request);
        });
      }
      if (!markerStoreReady && exactChildren.has(tabId)) return { cancel: true };
      return decideKnownRequest(request);
    },

    /** @param {number} tabId */
    release(tabId) {
      const removed = exactChildren.delete(tabId);
      const uncertain = uncertainChildren.delete(tabId);
      confirmedChildren.delete(tabId);
      observedChildren.delete(tabId);
      flowTokens.delete(tabId);
      clearClassification(tabId);
      resolveClassification(tabId, 'ambiguous');
      reported.delete(tabId);
      reportedPolicyFailures.delete(tabId);
      if (removed || uncertain) persist();
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
      for (const tabId of uncertainChildren) {
        const child = current.get(tabId);
        if (!validId(child?.openerTabId) || !current.has(child.openerTabId)) {
          uncertainChildren.delete(tabId);
          exactChildren.delete(tabId);
          confirmedChildren.delete(tabId);
          clearClassification(tabId);
          changed = true;
          continue;
        }
        const sourceTabId = /** @type {number} */ (child.openerTabId);
        const state = sourceState(sourceTabId);
        if (state === true) {
          exactChildren.set(tabId, sourceTabId);
          uncertainChildren.delete(tabId);
          confirmedChildren.add(tabId);
          clearClassification(tabId);
          changed = true;
        } else if (state === false) {
          uncertainChildren.delete(tabId);
          exactChildren.delete(tabId);
          confirmedChildren.delete(tabId);
          clearClassification(tabId);
          changed = true;
        }
      }
      for (const [tabId, sourceTabId] of exactChildren) {
        const child = current.get(tabId);
        const state = sourceState(sourceTabId);
        if (!child || !current.has(sourceTabId) || child.openerTabId !== sourceTabId
            || state === false) {
          exactChildren.delete(tabId);
          uncertainChildren.delete(tabId);
          confirmedChildren.delete(tabId);
          clearClassification(tabId);
          reported.delete(tabId);
          changed = true;
        } else if (state === true) {
          uncertainChildren.delete(tabId);
          confirmedChildren.add(tabId);
        } else {
          confirmedChildren.delete(tabId);
        }
      }
      markerStoreReady = exactChildren.size <= maxChildren;
      if (!markerStoreReady) signalUnavailable();
      if (changed || markers) persist();
      return markerStoreReady && uncertainChildren.size === 0;
    },

    has: (/** @type {number} */ tabId) => exactChildren.has(tabId),
    ready: () => {
      refreshClassifications();
      return markerStoreReady && uncertainChildren.size === 0;
    },
    status: () => {
      refreshClassifications();
      const ok = markerStoreReady && uncertainChildren.size === 0;
      return ok ? Object.freeze({ ok: true }) : Object.freeze({
        ok: false, code: 'firefox-child-custody-unavailable', outcomeKnown: true,
        retryable: true, affectedTabIds: Object.freeze(affectedTabIds()),
      });
    },
  };
};
