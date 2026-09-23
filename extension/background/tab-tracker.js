// @ts-check
// Track each tab-hosted engine instance across service-worker restarts.

import browser from '/vendor/browser-polyfill.js';

/** @typedef {Object} TabTrackerConfig
 * @property {string} tabPath
 * @property {number} readyTimeoutMs
 * @property {(id:string)=>Error} closedError
 * @property {(id:string)=>string} notReadyMessage
 * @property {import('webextension-polyfill').TabGroups.Color} [groupColor]
 * @property {typeof browser.tabs} [tabs]
 * @property {((tabId:number,kindLabel:string,id?:string)=>void)|null} [announce]
 * @property {string} [kindLabel]
 * @property {boolean} [announceOnReady]
 * @property {((id:string,tabId:number)=>void)|null} [onAdopt]
 * @property {((id:string)=>void)|null} [onDrop] */
/** @param {TabTrackerConfig} config */
export const createTabTracker = ({
  tabPath,
  readyTimeoutMs,
  closedError,
  notReadyMessage,
  groupColor = 'orange',
  tabs = browser.tabs,
  // why: Announce agent-opened background tabs without taking focus.
  announce = null,
  kindLabel = 'a tab',
  announceOnReady = false,
  // why: Best-effort hooks keep the durable liveness ledger current.
  onAdopt = /** @type {((id: string, tabId: number) => void) | null} */ (null),
  onDrop = /** @type {((id: string) => void) | null} */ (null),
}) => {
  const tabUrlPrefix = browser.runtime.getURL(tabPath);

  /** @type {Map<string, { tabId: number, ready: boolean, readyPromise: Promise<number>, resolveReady?: (tabId: number) => void, rejectReady?: (err: Error) => void, announceWhenReady?: boolean }>} */
  const byId = new Map();
  /** @type {Map<number, string>} */
  const tabIdToId = new Map();
  /** @type {Map<string,Promise<number>>} */
  const ensureById = new Map();

  /** @param {string | undefined} url @returns {string | null} */
  const parseIdFromUrl = (url) => {
    if (typeof url !== 'string') return null;
    if (!url.startsWith(tabUrlPrefix)) return null;
    const hashIdx = url.indexOf('#');
    if (hashIdx < 0) return null;
    const id = url.slice(hashIdx + 1).split(/[?&]/)[0];
    return id || null;
  };

  /** @param {string} id @param {number} tabId @param {boolean} [ready] */
  const recordEntry = (id, tabId, ready = false) => {
    let entry = byId.get(id);
    if (!entry) {
      // why: The Promise executor assigns both callbacks synchronously.
      /** @type {(tabId: number) => void} */
      let resolveReady = () => {};
      /** @type {(err: Error) => void} */
      let rejectReady = () => {};
      /** @type {Promise<number>} */
      const readyPromise = new Promise((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      // why: Handle a rejection when no caller waits for readiness.
      readyPromise.catch(() => {});
      entry = { tabId, ready, readyPromise, resolveReady, rejectReady };
      byId.set(id, entry);
    } else {
      tabIdToId.delete(entry.tabId);
      entry.tabId = tabId;
    }
    tabIdToId.set(tabId, id);
    try { onAdopt?.(id, tabId); } catch { /* liveness is best-effort */ }
    return entry;
  };

  /** @param {string} id */
  const markReady = (id) => {
    const entry = byId.get(id);
    if (!entry) return;
    entry.ready = true;
    entry.resolveReady?.(entry.tabId);
  };

  /** why: A reload needs a new readiness promise for the same tab. @param {string} id */
  const markReloading = (id) => {
    const entry = byId.get(id);
    if (!entry) return;
    /** @type {(tabId: number) => void} */
    let resolveReady = () => {};
    /** @type {(err: Error) => void} */
    let rejectReady = () => {};
    /** @type {Promise<number>} */
    const readyPromise = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    readyPromise.catch(() => {});          // see recordEntry: keep a bare reject handled
    entry.ready = false;
    entry.readyPromise = readyPromise;
    entry.resolveReady = resolveReady;
    entry.rejectReady = rejectReady;
  };

  /** Adopt existing instance tabs after a service-worker restart. */
  const bootstrap = async () => {
    try {
      const liveTabs = await tabs.query({ url: `${tabUrlPrefix}*` });
      for (const tab of liveTabs) {
        const id = parseIdFromUrl(tab.url ?? '');
        if (!id || tab.id == null) continue;
        recordEntry(id, tab.id, true);
        markReady(id);
      }
    } catch (e) {
      console.warn(`[tab-tracker ${tabPath}] bootstrap failed`, e);
      throw e;
    }
  };

  /** @param {string} id @param {number} tabId */
  const onTabReady = (id, tabId) => {
    recordEntry(id, tabId, true);
    markReady(id);
    if (announceOnReady && announce && byId.get(id)?.announceWhenReady) {
      try { announce(tabId, kindLabel, id); } catch { /* best-effort card */ }
    }
  };

  // why: Apps must install tab-scoped network rules before they become ready.
  /** @param {string} id @param {number} tabId */
  const onTabPending = (id, tabId) => { recordEntry(id, tabId, false); };

  /** why: Return the host failure instead of a later timeout. @param {string} id @param {Error} error */
  const onTabFailed = (id, error) => {
    const entry = byId.get(id);
    if (!entry) return null;
    entry.rejectReady?.(error);
    byId.delete(id);
    tabIdToId.delete(entry.tabId);
    try { onDrop?.(id); } catch { /* liveness is best-effort */ }
    return entry.tabId;
  };

  /** @param {number} tabId @returns {string|null} */
  const onTabRemoved = (tabId) => {
    const id = tabIdToId.get(tabId);
    if (!id) return null;
    tabIdToId.delete(tabId);
    const entry = byId.get(id);
    if (entry) {
      entry.rejectReady?.(closedError(id));
      byId.delete(id);
    }
    try { onDrop?.(id); } catch { /* liveness is best-effort */ }
    return id;
  };

  /** @param {string} id */
  const getTabId = (id) => byId.get(id)?.tabId ?? null;

  /** @param {string} id */
  const isReady = (id) => !!byId.get(id)?.ready;

  /** why: Only a newly created active tab can take focus.
   * @param {string} id @param {{active?:boolean,groupTitle?:string,hashSuffix?:string}} [opts] @returns {Promise<number>} */
  const ensureTabUnlocked = async (id, opts = {}) => {
    const existing = byId.get(id);
    if (existing) {
      // If the tab is still alive, we're done; otherwise spawn.
      try {
        const tab = await tabs.get(existing.tabId);
        if (tab) {
          // why: Keep the current agent-tab card on the live background tab.
          if (opts.active !== true && announce) {
            try { announce(existing.tabId, kindLabel, id); } catch { /* best-effort */ }
          }
          if (existing.ready) return existing.tabId;
          return Promise.race([
            existing.readyPromise,
            timeout(readyTimeoutMs, notReadyMessage(id)),
          ]);
        }
      } catch {
        tabIdToId.delete(existing.tabId);
        byId.delete(id);
      }
    }

    // why: Keep bounded launch context inside the extension origin fragment.
    const hashSuffix = typeof opts.hashSuffix === 'string'
      && opts.hashSuffix.startsWith('?')
      && !opts.hashSuffix.includes('#')
      && opts.hashSuffix.length <= 2_048
      ? opts.hashSuffix
      : '';
    const url = `${tabUrlPrefix}#${id}${hashSuffix}`;
    const tab = await tabs.create({
      url,
      active: opts.active === true,
      pinned: false,
    });
    if (tab.id == null) throw new Error('tabs.create returned no id');
    const entry = recordEntry(id, tab.id, false);
    entry.announceWhenReady = opts.active !== true;

    // why: Surface a slow background tab as soon as it exists.
    if (opts.active !== true && announce && !announceOnReady) {
      try { announce(tab.id, kindLabel, id); } catch { /* best-effort card */ }
    }

    if (opts.groupTitle) {
      addToGroup(tab.id, opts.groupTitle, groupColor).catch((e) => {
        console.debug(`[tab-tracker ${tabPath}] addToGroup failed`, e);
      });
    }

    return Promise.race([
      entry.readyPromise,
      timeout(readyTimeoutMs, notReadyMessage(id)),
    ]);
  };
  const ensureTab = (/** @type {string} */ id, /** @type {{active?:boolean,groupTitle?:string,hashSuffix?:string}} */ opts = {}) => {
    const active = ensureById.get(id);
    if (active) return active;
    const pending = ensureTabUnlocked(id, opts).finally(() => {
      if (ensureById.get(id) === pending) ensureById.delete(id);
    });
    ensureById.set(id, pending);
    return pending;
  };

  /** @param {string} id */
  const closeTab = async (id) => {
    const tabId = getTabId(id);
    if (tabId == null) return false;
    try {
      await tabs.remove(tabId);
      return true;
    } catch {
      return false;
    }
  };

  /** @param {string} id */
  const reloadTab = async (id) => {
    const tabId = getTabId(id);
    if (tabId == null) return false;
    try {
      await tabs.reload(tabId);
      return true;
    } catch {
      return false;
    }
  };

  const listLive = () => Array.from(byId.keys());

  return {
    bootstrap,
    onTabReady,
    onTabPending,
    onTabFailed,
    onTabRemoved,
    parseIdFromUrl,
    getTabId,
    isReady,
    ensureTab,
    closeTab,
    reloadTab,
    markReloading,
    listLive,
  };
};

/** @param {number} ms @param {string} msg @returns {Promise<never>} */
const timeout = (ms, msg) => new Promise((_, reject) => {
  setTimeout(() => reject(new Error(msg)), ms);
});

/**
 * Group all peerd instance tabs under one collapsible tab group.
 * chrome.tabGroups is best-effort; failure is non-fatal.
 * @param {number} tabId @param {string} title
 * @param {import('webextension-polyfill').TabGroups.Color} color
 */
const addToGroup = async (tabId, title, color) => {
  if (typeof browser.tabGroups === 'undefined' || typeof browser.tabs.group !== 'function') {
    return;
  }
  // Look for an existing group with the same title in the same window.
  const tab = await browser.tabs.get(tabId);
  const groups = await browser.tabGroups.query({ title, windowId: tab.windowId });
  let groupId = groups[0]?.id;
  if (groupId == null) {
    groupId = await browser.tabs.group({ tabIds: [tabId] });
    await browser.tabGroups.update(groupId, { title, color, collapsed: false });
  } else {
    await browser.tabs.group({ tabIds: [tabId], groupId });
  }
};
