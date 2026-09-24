// @ts-check
// Focus the existing Home surface or create it. A requested view travels in
// the hash so a live tab can switch sections without reloading.

import browser from '/shared/browser-api.js';

const HOME_PATH = 'home/home.html';

/** @param {string} [view] */
export const openHome = async (view) => {
  try {
    const base = browser.runtime.getURL(HOME_PATH);
    const url = view ? `${base}#${view}` : base;
    const tabs = (await browser.tabs?.query?.({})) ?? [];
    const existing = tabs.find((t) => typeof t.url === 'string' && t.url.startsWith(base));
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
