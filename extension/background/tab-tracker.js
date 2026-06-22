// @ts-check
// tab-tracker — SW-side bookkeeping of which engine-instance id lives in
// which browser tab. The shared core behind vm-/notebook-/app-tab-tracker.
//
// Each TAB-HOSTED peerd execution kind (WebVM, Notebook, App) is a discrete
// browser tab at chrome-extension://<id>/<kind>-tab/index.html#<id> (the
// headless js_run worker has no tab, so it isn't tracked here). The
// tab announces itself on load (`<kind>/tab-ready` message) and we learn
// its tabId from the sender. We also pre-populate the map at SW startup
// by querying for matching URLs (the SW can restart while instance tabs
// keep running). chrome.tabs.onRemoved drops stale entries.
//
// The three kinds were ~95% identical bookkeeping; the only real
// differences are the tab path, the ready timeout, the injectable tabs
// API (the in-browser vm test stubs it), and the error thrown when a tab
// closes before it's ready. Those are the config below. Each kind's
// module is now a thin wrapper that picks a name + the subset of methods
// it exposes (e.g. app adds reloadTab and omits isReady).
//
// What this module is NOT responsible for:
//   - Spawning the instance (that happens here too, as a convenience,
//     but the caller decides when).
//   - Tracking which session is attached to which instance (registry).
//   - Persisting anything (the persisted catalog lives in the registry).

import browser from '/vendor/browser-polyfill.js';

/**
 * @typedef {Object} TabTrackerConfig
 * @property {string} tabPath
 *   Extension-relative path to the instance tab page (e.g. VM_TAB_PATH).
 * @property {number} readyTimeoutMs
 *   How long ensureTab waits for the tab's `ready` broadcast before
 *   rejecting. VMs stream a disk image (slow); Notebooks/apps boot fast.
 * @property {(id: string) => Error} closedError
 *   Builds the rejection for a tab that closes before ready. vm injects
 *   VMTabClosedError (carries `.vmId`); notebook/app use a plain Error.
 * @property {(id: string) => string} notReadyMessage
 *   Message for the ensureTab readiness-timeout Error.
 * @property {import('webextension-polyfill').TabGroups.Color} [groupColor]
 *   tabGroups color for the collapsible peerd group. Defaults to orange.
 * @property {typeof browser.tabs} [tabs]
 *   Injected tabs API (query/get/create/update/remove). Defaults to the
 *   real browser.tabs; the in-browser tests inject a stub so tracker
 *   behavior is exercised without spawning real tabs.
 * @property {((tabId: number, kindLabel: string, id?: string) => void) | null} [announce]
 *   Drops a "go there" card in the chat for an agent-opened background tab.
 *   Injected by the SW (announceAgentTab); null when no announcer is wired.
 * @property {string} [kindLabel]
 *   Human noun for the announce card ('a Linux VM', 'a Notebook', 'an App').
 */

/**
 * @param {TabTrackerConfig} config
 */
export const createTabTracker = ({
  tabPath,
  readyTimeoutMs,
  closedError,
  notReadyMessage,
  groupColor = 'orange',
  tabs = browser.tabs,
  // why: agent-opened tabs open in the BACKGROUND (active:false) and never steal
  // focus; `announce(tabId, kindLabel)` drops a "go there" card in the chat
  // instead (DESIGN-12). Injected by the SW (announceAgentTab). kindLabel is the
  // human noun for the card ('a Linux VM', 'a Notebook', 'an App').
  announce = null,
  kindLabel = 'a tab',
}) => {
  const tabUrlPrefix = browser.runtime.getURL(tabPath);

  /** @type {Map<string, { tabId: number, ready: boolean, readyPromise: Promise<number>, resolveReady?: (tabId: number) => void, rejectReady?: (err: Error) => void }>} */
  const byId = new Map();
  /** @type {Map<number, string>} */
  const tabIdToId = new Map();

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
      // why the executor runs synchronously, so both are assigned before the
      // constructor returns; the casts express that to tsc (it can't prove it).
      /** @type {(tabId: number) => void} */
      let resolveReady = () => {};
      /** @type {(err: Error) => void} */
      let rejectReady = () => {};
      /** @type {Promise<number>} */
      const readyPromise = new Promise((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      // why the no-op catch: if the tab closes while NOBODY is awaiting
      // readiness (no ensureTab in flight), the rejectReady below would
      // otherwise surface as an unhandled rejection in the SW console.
      // Attaching one handler marks it handled; ensureTab's racers still
      // observe the rejection normally.
      readyPromise.catch(() => {});
      entry = { tabId, ready, readyPromise, resolveReady, rejectReady };
      byId.set(id, entry);
    } else {
      entry.tabId = tabId;
    }
    tabIdToId.set(tabId, id);
    return entry;
  };

  /** @param {string} id */
  const markReady = (id) => {
    const entry = byId.get(id);
    if (!entry) return;
    entry.ready = true;
    entry.resolveReady?.(entry.tabId);
  };

  /**
   * Walk existing tabs at SW boot. Any instance tab still alive in the
   * browser gets re-registered. They've already booted, so they're
   * considered ready immediately.
   */
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
    }
  };

  /**
   * Called from the SW's runtime.onMessage when a tab broadcasts
   * <kind>/tab-ready. Marks the tracker entry ready and pins the tabId.
   * @param {string} id @param {number} tabId
   */
  const onTabReady = (id, tabId) => {
    recordEntry(id, tabId, true);
    markReady(id);
  };

  /**
   * Called from chrome.tabs.onRemoved. Drops the entry and rejects any
   * pending ready waiters with the configured closedError. Returns the
   * id that lived in the closed tab (or null) so the SW wiring can
   * interrupt that instance's pending RPCs in its client — the tracker
   * only knows tabId↔id; the client owns the command queue.
   *
   * @param {number} tabId
   * @returns {string | null}
   */
  const onTabRemoved = (tabId) => {
    const id = tabIdToId.get(tabId);
    if (!id) return null;
    tabIdToId.delete(tabId);
    const entry = byId.get(id);
    if (entry) {
      entry.rejectReady?.(closedError(id));
      byId.delete(id);
    }
    return id;
  };

  /**
   * Return the tabId for id without creating it. Used for "is the
   * instance live?" checks (e.g. for the side panel chip).
   * @param {string} id
   */
  const getTabId = (id) => byId.get(id)?.tabId ?? null;

  /** @param {string} id */
  const isReady = (id) => !!byId.get(id)?.ready;

  /**
   * Ensure a tab exists for id. If one is already live, return its id
   * immediately. Otherwise spawn a tab and wait for its <kind>/tab-ready
   * broadcast.
   *
   * `active` applies ONLY to the create path: a newly spawned tab can
   * take focus so the user sees it appear (DECISIONS #20, 2026-06-14),
   * while a call that finds the tab already live returns early and never
   * re-focuses it — so acting on an existing instance leaves the user put.
   *
   * @param {string} id
   * @param {{ active?: boolean, groupTitle?: string }} [opts]
   * @returns {Promise<number>} tabId
   */
  const ensureTab = async (id, opts = {}) => {
    const existing = byId.get(id);
    if (existing) {
      // If the tab is still alive, we're done; otherwise spawn.
      try {
        const tab = await tabs.get(existing.tabId);
        if (tab) {
          // Interacting with an EXISTING agent tab (e.g. vm_boot on a live VM)
          // — update the "current agent tab" card so it tracks where the loop is
          // working, not just where it last created a tab. Background only.
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
        // Tab no longer exists; fall through to create a new one.
        tabIdToId.delete(existing.tabId);
        byId.delete(id);
      }
    }

    const url = `${tabUrlPrefix}#${id}`;
    const tab = await tabs.create({
      url,
      active: opts.active === true,
      pinned: false,
    });
    if (tab.id == null) throw new Error('tabs.create returned no id');
    const entry = recordEntry(id, tab.id, false);

    // Agent-opened (background) tab → announce a "go there" card. Fired on CREATE
    // (not after ready) so even a slow-booting background tab surfaces a card the
    // moment it exists. A user-focused open (active:true) doesn't announce.
    if (opts.active !== true && announce) {
      try { announce(tab.id, kindLabel, id); } catch { /* best-effort card */ }
    }

    // Best-effort: park in a tab group so the user can collapse them.
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

  /**
   * Close an id's tab (if alive). Returns true if a close was issued.
   * @param {string} id
   */
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

  /** Re-trigger a reload (used after app body updates so the iframe re-renders).
   * @param {string} id */
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
    onTabRemoved,
    parseIdFromUrl,
    getTabId,
    isReady,
    ensureTab,
    closeTab,
    reloadTab,
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
