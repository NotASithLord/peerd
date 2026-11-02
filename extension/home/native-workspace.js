// @ts-check

/** @typedef {import('webextension-polyfill').Tabs.Tab & { splitViewId?: number }} WorkspaceTab */
/** @typedef {WorkspaceTab & { id: number, windowId: number }} WorkspacePage */
/** @typedef {{ tabId: number|null, url: string }} WorkspaceFallback */
/**
 * @typedef {{ available: boolean, home: WorkspacePage|null, pages: WorkspacePage[],
 *   peer: WorkspacePage|null, ok: boolean, notice: string,
 *   fallback: WorkspaceFallback|null }} WorkspaceSnapshot
 */
/**
 * @typedef {{
 *   get: (id: number) => Promise<WorkspaceTab>,
 *   query: (query: { windowId: number }) => Promise<WorkspaceTab[]>,
 *   move: (id: number, properties: { index: number }) => Promise<unknown>,
 *   create: (properties: { windowId: number, index: number, url: string,
 *     active: boolean, splitWithTabId?: number }) => Promise<WorkspaceTab>,
 *   update: (id: number, properties: { active?: boolean, autoDiscardable?: boolean }) => Promise<unknown>,
 *   createSplit?: (ids: [number, number]) => Promise<number>,
 *   unsplit?: (id: number) => Promise<void>,
 * }} NativeWorkspaceTabs
 */

/** @param {WorkspaceTab} tab */
const inSplit = (tab) => typeof tab.splitViewId === 'number' && tab.splitViewId >= 0;
/** @param {WorkspaceTab} tab */
const pageUrl = (tab) => tab.url || tab.pendingUrl || '';

/** @param {WorkspaceTab} home @param {WorkspaceTab} page */
export const splitRefusal = (home, page) => {
  if (home.id === page.id) return 'Choose a browser tab beside chat.';
  if (home.windowId !== page.windowId) return 'Choose a tab in this window.';
  if (home.pinned) return 'Pinned Home stays pinned. Open the tab on its own.';
  if (home.pinned !== page.pinned) return 'These tabs have different pinned states.';
  if (home.groupId !== page.groupId) return 'These tabs belong to different tab groups.';
  if (inSplit(home) || inSplit(page)) return 'End the current split before starting another.';
  return '';
};

/**
 * Browser state owns the layout. The queue prevents repeated clicks from
 * changing the same pair at the same time.
 * @param {{ tabs: NativeWorkspaceTabs, homeTabId: number }} deps
 * @returns {{ refresh: () => Promise<WorkspaceSnapshot>,
 *   besideTab: (id: number, options?: { moveHome?: boolean }) => Promise<WorkspaceSnapshot>,
 *   newTabBeside: () => Promise<WorkspaceSnapshot>,
 *   showPageOnly: (id?: number|null) => Promise<WorkspaceSnapshot>,
 *   closeSplit: () => Promise<WorkspaceSnapshot>, protect: () => Promise<WorkspaceSnapshot>,
 *   release: () => Promise<void> }}
 */
export const makeNativeWorkspace = ({ tabs, homeTabId }) => {
  const available = () => typeof tabs.createSplit === 'function' && typeof tabs.unsplit === 'function';
  const read = async () => {
    const rawHome = await tabs.get(homeTabId);
    if (rawHome.id !== homeTabId || typeof rawHome.windowId !== 'number') throw new Error('home-tab-unavailable');
    const windowTabs = await tabs.query({ windowId: rawHome.windowId });
    const liveHome = windowTabs.find((tab) => tab.id === homeTabId && tab.windowId === rawHome.windowId);
    if (!liveHome) throw new Error('home-window-changed');
    const home = /** @type {WorkspacePage} */ (liveHome);
    const homeUrl = pageUrl(home).split(/[?#]/)[0];
    const pages = /** @type {WorkspacePage[]} */ (windowTabs
      .filter((tab) => typeof tab.id === 'number' && tab.id !== homeTabId && tab.windowId === home.windowId
        && pageUrl(tab).split(/[?#]/)[0] !== homeUrl));
    return { available: available(), home, pages,
      peer: inSplit(home) ? pages.find((tab) => tab.splitViewId === home.splitViewId) ?? null : null,
      ok: true, notice: '', fallback: /** @type {WorkspaceFallback|null} */ (null) };
  };
  /** @param {Awaited<ReturnType<typeof read>>} state @param {string} notice @param {WorkspacePage|null} [page] */
  const refuse = (state, notice, page) => ({ ...state, ok: false, notice,
    fallback: page && page.windowId === state.home.windowId
      ? { tabId: page.id, url: pageUrl(page) } : null });
  /** @type {boolean|undefined} */
  let originalAutoDiscardable;
  /** @param {WorkspacePage} home */
  const protectHome = async (home) => {
    if (typeof home.autoDiscardable !== 'boolean') return;
    originalAutoDiscardable ??= home.autoDiscardable;
    if (home.autoDiscardable) await tabs.update(homeTabId, { autoDiscardable: false });
  };
  const release = async () => {
    if (originalAutoDiscardable === undefined) return;
    const autoDiscardable = originalAutoDiscardable;
    originalAutoDiscardable = undefined;
    // why: pagehide must dispatch restoration without waiting for the action queue.
    await tabs.update(homeTabId, { autoDiscardable });
  };
  /** @type {Promise<unknown>} */
  let pending = Promise.resolve();
  /** @param {() => Promise<WorkspaceSnapshot>} operation */
  const run = (operation) => {
    const next = pending.then(operation).catch(async () => ({
      ...await read().catch(() => ({ available: available(), home: null, pages: [], peer: null })),
      ok: false, notice: 'Chromium could not change this layout. Check the tabs and try again.', fallback: null,
    }));
    pending = next;
    return next;
  };
  /** @param {number} id @param {{moveHome?: boolean}} [options] */
  const besideTab = (id, { moveHome = false } = {}) => run(async () => {
    let state = await read();
    let page = state.pages.find((tab) => tab.id === id);
    if (!page) return refuse(state, 'Choose an open tab in this window.');
    if (!available()) return refuse(state, 'Native split view is not available in this browser.', page);
    if (inSplit(state.home) && state.home.splitViewId === page.splitViewId) {
      await protectHome(state.home);
      return read();
    }
    let notice = splitRefusal(state.home, page);
    if (notice) return refuse(state, notice, page);
    try {
      if (state.home.index + 1 !== page.index) {
        if (!moveHome) return refuse(state, 'Move Home beside this tab to start split view.', page);
        await tabs.move(homeTabId, { index: page.index - Number(state.home.index < page.index) });
        state = await read();
        page = state.pages.find((tab) => tab.id === id);
        if (!page) return refuse(state, 'The selected tab is no longer in this window.');
        notice = splitRefusal(state.home, page);
        if (notice) return refuse(state, notice, page);
        if (state.home.index + 1 !== page.index) return refuse(state, 'The tabs moved. Choose the tab again.', page);
      }
      await tabs.createSplit?.([homeTabId, page.id]);
      state = await read();
      if (state.peer?.id !== id) return refuse(state, 'The tabs changed. Choose the tab again.', state.pages.find((tab) => tab.id === id));
      await protectHome(state.home);
      state = await read();
      if (state.peer?.id !== id) return refuse(state, 'The tabs changed. Choose the tab again.', state.pages.find((tab) => tab.id === id));
      await tabs.update(homeTabId, { active: true });
      return read();
    } catch {
      state = await read();
      return refuse(state, 'Chromium could not finish this layout change. Open the tab on its own.', state.pages.find((tab) => tab.id === id));
    }
  });
  const newTabBeside = () => run(async () => {
    const state = await read();
    const fallback = { tabId: null, url: 'about:blank' };
    if (!available()) return { ...refuse(state, 'Native split view is not available in this browser.'), fallback };
    if (state.home.pinned) return { ...refuse(state, 'Pinned Home stays pinned. Open a normal browser tab to browse.'), fallback };
    if (inSplit(state.home)) return refuse(state, 'End the current split before opening another.');
    /** @type {number|undefined} */
    let createdId;
    // why: the default new-tab URL can open another Home in Prowser.
    try {
      const page = await tabs.create({ windowId: state.home.windowId, index: state.home.index + 1,
        splitWithTabId: homeTabId, url: 'about:blank', active: true });
      createdId = page.id;
      const next = await read();
      if (typeof page.id !== 'number' || next.peer?.id !== page.id) {
        return refuse(next, 'The new tab is not in split view.', next.pages.find((tab) => tab.id === createdId));
      }
      await protectHome(next.home);
      return read();
    } catch {
      const next = await read();
      const page = next.pages.find((tab) => tab.id === createdId);
      const result = refuse(next, 'Chromium could not open a split. Check the tabs before opening another.', page);
      return page ? result : { ...result, fallback };
    }
  });
  /** @param {number|null} [id] */
  const showPageOnly = (id) => run(async () => {
    let state = await read();
    const page = id === null ? null : state.pages.find((tab) => tab.id === (id ?? state.peer?.id));
    if (!page && id !== null) return refuse(state, 'Choose an open tab in this window.');
    if (page && inSplit(page) && page.splitViewId !== state.home.splitViewId) {
      return refuse(state, 'This tab belongs to another split. Keep that split as it is.');
    }
    if (inSplit(state.home)) {
      if (typeof tabs.unsplit !== 'function') return refuse(state, 'Chromium cannot end this split.', page);
      await tabs.unsplit(/** @type {number} */ (state.home.splitViewId));
      state = await read();
      const livePage = page && state.pages.find((tab) => tab.id === page.id);
      if (inSplit(state.home) || page && (!livePage || inSplit(livePage))) {
        return refuse(state, 'The tabs changed. Choose the tab again.');
      }
    }
    await protectHome(state.home);
    state = await read();
    const livePage = page && state.pages.find((tab) => tab.id === page.id);
    if (inSplit(state.home) || page && (!livePage || inSplit(livePage))) return refuse(state, 'The tabs changed. Choose the tab again.');
    if (page) await tabs.update(page.id, { active: true });
    else await tabs.create({ windowId: state.home.windowId, index: state.home.index + 1, url: 'about:blank', active: true });
    return read();
  });
  const closeSplit = () => run(async () => {
    let state = await read();
    if (inSplit(state.home)) {
      if (typeof tabs.unsplit !== 'function') return refuse(state, 'Chromium cannot end this split.');
      await tabs.unsplit(/** @type {number} */ (state.home.splitViewId));
      state = await read();
      if (inSplit(state.home)) return refuse(state, 'The tabs changed. Return to Home again.');
    }
    await tabs.update(homeTabId, { active: true });
    return read();
  });
  const protect = () => run(async () => {
    const state = await read();
    await protectHome(state.home);
    return read();
  });
  return { refresh: () => run(read), besideTab, newTabBeside, showPageOnly, closeSplit, protect, release };
};
