// @ts-check
// Open the peerd home page (the full-tab Library surface).
//
// why focus-or-create (not a bare tabs.create like the options deep-link):
// home is a primary surface a user returns to often, so a second click
// should focus the existing tab, not pile up duplicates. We can't use
// runtime.openOptionsPage()'s de-dupe (that's options-only), so we query
// for an existing home tab and activate it, else create one. Best-effort:
// any tabs-API gap falls back to a plain create.
//
// Lives in shared/ so the side panel and any other surface can call it.

import browser from '/vendor/browser-polyfill.js';

const HOME_PATH = 'home/home.html';

export const openHome = async () => {
  try {
    const url = browser.runtime.getURL(HOME_PATH);
    const tabs = (await browser.tabs?.query?.({})) ?? [];
    const existing = tabs.find((t) => typeof t.url === 'string' && t.url.startsWith(url));
    if (existing?.id != null) {
      await browser.tabs.update(existing.id, { active: true });
      if (existing.windowId != null) await browser.windows?.update?.(existing.windowId, { focused: true });
      return;
    }
    await browser.tabs.create({ url });
  } catch (e) {
    console.warn('[open-home] failed', e);
  }
};
