// @ts-check
// One opt-in pinned Home per normal window. The worker owns windows.onCreated
// so it works without an open page. Respect closed, unpinned or navigated tabs,
// including restored windows; browser-restored pinned Homes must not duplicate.

import { makeSerialLane } from '../shared/cold-util.js';

/** @typedef {{ id?: number, type?: string, incognito?: boolean }} FirstTabWindow */
/**
 * @typedef {{ id?: number, index?: number, pinned?: boolean, url?: string,
 *   pendingUrl?: string }} FirstTabTab
 */
/**
 * @typedef {{
 *   windows: {
 *     onCreated?: unknown,
 *     getAll: (filter: { windowTypes: Array<'normal'> }) => Promise<FirstTabWindow[]>,
 *     remove: (windowId: number) => Promise<void>,
 *   },
 *   tabs: {
 *     query: (query: { windowId: number }) => Promise<FirstTabTab[]>,
 *     create: (properties: { windowId: number, url: string, pinned: boolean,
 *       index: number, active: boolean }) => Promise<FirstTabTab>,
 *     remove: (tabIds: number[]) => Promise<void>,
 *   },
 * }} FirstTabBrowser
 */
/**
 * @typedef {{ event: (key: string, raw: unknown, owner: string) =>
 *   { addListener: (listener: (window: FirstTabWindow) => void) => void } | undefined }} FirstTabEvents
 */
/** @typedef {{ window: number | null, tabs: string }} FirstTabDeclined window null: it closed */
/**
 * @template T
 * @typedef {{
 *   onUpdated: (tabId: number, changeInfo: { pinned?: boolean, url?: string },
 *     tab: { windowId?: number }) => T,
 *   onRemoved: (tabId: number,
 *     removeInfo: { windowId?: number, isWindowClosing?: boolean }) => T,
 * }} FirstTabTabOwner
 */

// The windows peerd already handled in this browser session. storage.session
// is empty after a browser restart or an update, which is how a boot tells
// restored windows (keep what the browser restored) from new ones.
export const FIRST_TAB_WINDOWS_KEY = 'firstTab.windows.v1';
// The windows that still have their pinned Home tab, in storage.local. An
// update closes peerd's tabs and empties storage.session, but the window ids
// stay. A browser start writes it again, because the ids change then.
export const FIRST_TAB_KEPT_KEY = 'firstTab.kept.v1';
// The windows where the user closed or unpinned the tab, each with the
// addresses of its tabs. Reopen Closed Window brings a window back under a new
// id, so its tabs are how peerd knows it. why storage.session: it stays in
// memory, so peerd keeps no list of your tabs on disk.
export const FIRST_TAB_DECLINED_KEY = 'firstTab.declined.v1';
const MAX_WINDOWS = 256;
const MAX_DECLINED = 32;

/** @param {FirstTabWindow} window @returns {window is FirstTabWindow & { id: number }} */
export const firstTabWindow = (window) => typeof window?.id === 'number'
  && window.type === 'normal' && window.incognito !== true;

/**
 * The pinned Home tabs of one window, leftmost first.
 * @param {FirstTabTab[]} tabs @param {string} homeUrl
 * @param {ReadonlySet<number>} [created] tabs this worker made, before their URL shows
 */
export const pinnedHomes = (tabs, homeUrl, created = new Set()) => tabs.filter((tab) =>
  tab.pinned === true && ((tab.url || tab.pendingUrl || '').startsWith(homeUrl)
    || typeof tab.id === 'number' && created.has(tab.id)
      && (!tab.url || tab.url === 'about:blank') && !tab.pendingUrl))
  .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

/**
 * A window's tab addresses in one order, so a reopened window matches.
 * @param {FirstTabTab[]} tabs
 */
export const windowTabsKey = (tabs) =>
  tabs.map((tab) => tab.url || tab.pendingUrl || '').sort().join('\n');

/** @param {unknown} value */
const windowIds = (value) => Array.isArray(value)
  ? value.filter((id) => typeof id === 'number') : null;

/**
 * @param {Object} deps
 * @param {FirstTabBrowser} deps.browser
 * @param {FirstTabEvents} deps.events
 * @param {{ sessionGet: (key: string) => Promise<unknown>,
 *   sessionSet: (key: string, value: unknown) => Promise<void> }} deps.session
 * @param {{ get: (key: string) => Promise<unknown>,
 *   set: (key: string, value: unknown) => Promise<void> }} deps.store storage.local
 * @param {Promise<unknown>} deps.ready settings are loaded
 * @param {() => boolean} deps.isEnabled
 * @param {string} deps.homeUrl
 * @param {boolean} [deps.closeLoneWindows] Firefox can reopen a window only for its pinned tabs
 * @param {number} [deps.settleMs] lets a restored window finish adding its tabs
 * @param {(cause: unknown) => void} [deps.onError]
 */
export const attachKernelFirstTab = ({
  browser, events, session, store, ready, isEnabled, homeUrl,
  closeLoneWindows = false, settleMs = 300,
  onError = (cause) => console.warn('[kernel] first tab failed', cause),
}) => {
  const lane = makeSerialLane();
  /** @type {Set<number>} */
  const created = new Set();
  const readHandled = async () => windowIds(await session.sessionGet(FIRST_TAB_WINDOWS_KEY));
  const writeHandled = (/** @type {number[]} */ ids) =>
    session.sessionSet(FIRST_TAB_WINDOWS_KEY, [...new Set(ids)].slice(-MAX_WINDOWS));
  const readKept = async () => windowIds(await store.get(FIRST_TAB_KEPT_KEY)) ?? [];
  const writeKept = (/** @type {number[]} */ ids) =>
    store.set(FIRST_TAB_KEPT_KEY, [...new Set(ids)].slice(-MAX_WINDOWS));
  /** @returns {Promise<FirstTabDeclined[]>} */
  const readDeclined = async () => {
    const rows = await session.sessionGet(FIRST_TAB_DECLINED_KEY);
    return Array.isArray(rows) ? rows.filter((row) => typeof row?.tabs === 'string'
      && (row.window === null || typeof row.window === 'number')) : [];
  };
  const writeDeclined = (/** @type {FirstTabDeclined[]} */ rows) =>
    session.sessionSet(FIRST_TAB_DECLINED_KEY, rows.slice(-MAX_DECLINED));
  const normalWindows = async () =>
    (await browser.windows.getAll({ windowTypes: ['normal'] })).filter(firstTabWindow);
  const homesIn = async (/** @type {number} */ windowId) =>
    pinnedHomes(await browser.tabs.query({ windowId }), homeUrl, created);
  const settle = () => new Promise((resolve) => setTimeout(resolve, settleMs));
  // A window gets its tab unless it has one. Either way, it has one now.
  const ensure = async (/** @type {number} */ windowId) => {
    if (!(await homesIn(windowId)).length) {
      const tab = await browser.tabs.create({
        windowId, url: homeUrl, pinned: true, index: 0, active: false,
      });
      if (typeof tab?.id === 'number') created.add(tab.id);
    }
    await writeKept([...await readKept(), windowId]);
  };
  const run = (/** @type {() => Promise<void>} */ operation) =>
    lane(operation).catch(onError);
  // Each step below waits for the settings and does nothing while it is off.
  const whenOn = (/** @type {() => Promise<void>} */ operation) => run(async () => {
    await ready;
    if (isEnabled()) await operation();
  });

  // why first in the lane: the windows open when the worker first boots in
  // this session were restored, so they keep exactly what the browser restored.
  void run(async () => {
    if (await readHandled() === null) {
      await writeHandled((await normalWindows()).map((window) => window.id));
    }
  });

  // Reopen Closed Window: a window the user closed after taking its tab out
  // comes back with the same tabs and a new id. It stays without the tab.
  const reopenedDeclined = async (/** @type {number} */ windowId) => {
    const tabs = await browser.tabs.query({ windowId });
    if (pinnedHomes(tabs, homeUrl).length) return false;
    const key = windowTabsKey(tabs);
    const rows = await readDeclined();
    const row = rows.find((item) => item.window === null && item.tabs === key);
    if (row) await writeDeclined([...rows.filter((item) => item !== row), { window: windowId, tabs: key }]);
    return !!row;
  };

  events.event('windows.onCreated', browser.windows?.onCreated, 'kernel-first-tab')
    ?.addListener((window) => {
      void whenOn(async () => {
        if (!firstTabWindow(window)) return;
        const handled = await readHandled() ?? [];
        if (handled.includes(window.id)) return;
        // why mark first: a failure must not turn into a second try later.
        await writeHandled([...handled, window.id]);
        await settle();
        if (!(await reopenedDeclined(window.id))) await ensure(window.id);
      });
    });

  // The user turned the setting on: every open window gets its tab, and a
  // window keeps any pinned Home tab it has. A window the user took the tab
  // out of gets it too: this is a new request.
  const coverEveryWindow = () => whenOn(async () => {
    const windows = await normalWindows();
    await writeKept([]);
    await writeDeclined([]);
    for (const window of windows) await ensure(window.id).catch(onError);
    await writeHandled([...await readHandled() ?? [], ...windows.map((window) => window.id)]);
  });

  // An update closes peerd's tabs. Each window that still had its tab gets it
  // again, and no other window does.
  const restoreAfterUpdate = () => whenOn(async () => {
    const kept = await readKept();
    for (const window of await normalWindows()) {
      if (kept.includes(window.id)) await ensure(window.id).catch(onError);
    }
  });

  // A browser start: tidy what the browser restored, then note which windows
  // have their tab. Chrome can put the pinned tabs of every window into its
  // one startup window. Firefox can reopen a window only for its pinned tabs.
  // These are peerd's own pages, so closing the extra ones loses nothing.
  const browserStarted = () => whenOn(async () => {
    await settle();
    const windows = await normalWindows();
    /** @type {number[]} */ const kept = [];
    /** @type {number[]} */ const lone = [];
    for (const window of windows) {
      const tabs = await browser.tabs.query({ windowId: window.id });
      const [first, ...extra] = pinnedHomes(tabs, homeUrl);
      if (!first) continue;
      if (extra.length) {
        await browser.tabs.remove(/** @type {number[]} */ (extra.map((tab) => tab.id)))
          .catch(onError);
      }
      (closeLoneWindows && tabs.length === extra.length + 1 ? lone : kept).push(window.id);
    }
    // why the count: never close the last window.
    if (lone.length < windows.length) {
      for (const id of lone) await browser.windows.remove(id).catch(onError);
    } else kept.push(...lone);
    await writeKept(kept);
  });

  // why read the tabs as the event comes: by the time the lane gets to it, the
  // user may have closed the window too, and its tabs are gone.
  const tabsNow = (/** @type {number|undefined} */ windowId) => typeof windowId === 'number'
    ? browser.tabs.query({ windowId }).catch(() => null) : null;

  // A tab closed or went to a new address, or the user pinned or unpinned one.
  // The kept list follows whether the window still has a pinned Home tab. Only
  // a pin can add one. A window the user took the tab out of keeps its row of
  // tab addresses current, and the row stays when the window closes.
  /**
   * @param {number|undefined} windowId
   * @param {{ closing?: boolean, pinned?: boolean, navigated?: boolean,
   *   early?: Promise<FirstTabTab[] | null> | null }} [change]
   */
  const tabChanged = (windowId, { closing = false, pinned = false, navigated = false, early = null } = {}) =>
    whenOn(async () => {
      if (typeof windowId !== 'number') return;
      const rows = await readDeclined();
      const row = rows.find((item) => item.window === windowId);
      const kept = await readKept();
      const listed = kept.includes(windowId);
      if (navigated && !row && !listed) return;
      if (!listed && !pinned && !row) return;
      const rest = rows.filter((item) => item !== row);
      if (closing) {
        if (listed) await writeKept(kept.filter((id) => id !== windowId));
        if (row) await writeDeclined([...rest, { window: null, tabs: row.tabs }]);
        return;
      }
      const tabs = await early ?? await browser.tabs.query({ windowId });
      const has = pinnedHomes(tabs, homeUrl, created).length > 0;
      if (has !== listed) await writeKept(has ? [...kept, windowId] : kept.filter((id) => id !== windowId));
      if (has && row) await writeDeclined(rest);
      // A window with no tabs is closing: its row stays as it was.
      else if (!has && (listed || row) && tabs.length > 0) {
        await writeDeclined([...rest, { window: windowId, tabs: windowTabsKey(tabs) }]);
      }
    });

  /**
   * The tab custody owner keeps these two events. This wraps it.
   * @template T @param {FirstTabTabOwner<T>} owner @returns {FirstTabTabOwner<T>}
   */
  const watchTabs = (owner) => ({
    onUpdated: (tabId, changeInfo, tab) => {
      // why: creation only bridges the initial blank URL, never later navigation.
      if (typeof changeInfo?.url === 'string' && changeInfo.url !== 'about:blank') created.delete(tabId);
      const pinned = changeInfo?.pinned;
      if (typeof pinned === 'boolean') void tabChanged(tab?.windowId, { pinned, early: tabsNow(tab?.windowId) });
      else if (typeof changeInfo?.url === 'string') void tabChanged(tab?.windowId, { navigated: true });
      return owner.onUpdated(tabId, changeInfo, tab);
    },
    onRemoved: (tabId, removeInfo) => {
      created.delete(tabId);
      const closing = removeInfo?.isWindowClosing === true;
      void tabChanged(removeInfo?.windowId, { closing, early: closing ? null : tabsNow(removeInfo?.windowId) });
      return owner.onRemoved(tabId, removeInfo);
    },
  });

  return Object.freeze({ coverEveryWindow, restoreAfterUpdate, browserStarted, watchTabs });
};
