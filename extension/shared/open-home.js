// @ts-check
// Focus the existing Home surface or create it. A requested view travels in
// the hash so a live tab can switch sections without reloading.

import browser from '/shared/browser-api.js';

const HOME_PATH = 'home/home.html';

/**
 * The Home tab to focus: one in the caller's window, the pinned one first,
 * else the first one in any window. With "Keep peerd as the first tab" on,
 * every window has one, and a jump to another window would lose the user.
 * @template {{ windowId?: number, pinned?: boolean }} T
 * @param {T[]} homes @param {number | undefined} windowId
 * @returns {T | undefined}
 */
export const pickHomeTab = (homes, windowId) => {
  const here = homes.filter((tab) => tab.windowId === windowId);
  return here.find((tab) => tab.pinned) ?? here[0] ?? homes[0];
};

/** @param {string} [view] */
export const openHome = async (view) => {
  try {
    const base = browser.runtime.getURL(HOME_PATH);
    const url = view ? `${base}#${view}` : base;
    const tabs = (await browser.tabs?.query?.({})) ?? [];
    /** @type {number | undefined} */
    let windowId;
    // why: in the worker this is the last focused window.
    try { windowId = (await browser.windows?.getCurrent?.())?.id; } catch { /* none */ }
    const existing = pickHomeTab(
      tabs.filter((t) => typeof t.url === 'string' && t.url.startsWith(base)), windowId);
    if (existing?.id != null) {
      await browser.tabs.update(existing.id, { active: true, ...(view ? { url } : {}) });
      if (existing.windowId != null) await browser.windows?.update?.(existing.windowId, { focused: true });
      return;
    }
    await browser.tabs.create({ url });
  } catch (e) {
    console.warn('[open-home] failed', e);
  }
};
