// @ts-check
// Focus the existing Home surface or create it. A requested view travels in
// the hash so a live tab can switch sections without reloading.

import browser from '/shared/browser-api.js';

const HOME_PATH = 'home/home.html';

/**
 * The Home tab to focus: one in the caller's window, the pinned one first,
 * else the first one in that window. An explicit window never selects a tab
 * from another window.
 * @template {{ windowId?: number, pinned?: boolean }} T
 * @param {T[]} homes @param {number | undefined} windowId
 * @returns {T | undefined}
 */
export const pickHomeTab = (homes, windowId) => {
  const here = homes.filter((tab) => tab.windowId === windowId);
  return here.find((tab) => tab.pinned) ?? here[0]
    ?? (windowId === undefined ? homes[0] : undefined);
};

/** @param {string} [view]
 * @param {{windowId?:number,tabId?:number|null,pinned?:boolean}} [options] */
export const openHome = async (view, options = {}) => {
  try {
    const base = browser.runtime.getURL(HOME_PATH);
    const url = view ? `${base}#${view}` : base;
    const tabs = (await browser.tabs?.query?.({})) ?? [];
    /** @type {number | undefined} */
    let windowId = options.windowId;
    // why: in the worker this is the last focused window.
    if (windowId === undefined) {
      try { windowId = (await browser.windows?.getCurrent?.())?.id; } catch { /* none */ }
    }
    const homes = tabs.filter((t) => typeof t.url === 'string'
      && t.url.split(/[?#]/, 1)[0] === base);
    const existing = homes.find((t) => t.id === options.tabId && t.windowId === windowId)
      ?? pickHomeTab(homes, windowId);
    if (existing?.id != null) {
      await browser.tabs.update(existing.id, { active: true, ...(view ? { url } : {}) });
      if (existing.windowId != null) await browser.windows?.update?.(existing.windowId, { focused: true });
      return;
    }
    await browser.tabs.create({ url, ...(windowId === undefined ? {} : { windowId }),
      ...(options.pinned ? { pinned: true, index: 0 } : {}) });
  } catch (e) {
    console.warn('[open-home] failed', e);
  }
};
