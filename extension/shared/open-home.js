// @ts-check
// Open the peerd home page (the full-tab SPA: Chat / Library / …).
//
// why focus-or-create (not a bare tabs.create like the options deep-link):
// home is a primary surface a user returns to often, so a second click
// should focus the existing tab, not pile up duplicates. We can't use
// runtime.openOptionsPage()'s de-dupe (that's options-only), so we query
// for an existing home tab and activate it, else create one. Best-effort:
// any tabs-API gap falls back to a plain create.
//
// why the optional `view`: a caller like the "Open Library" button means a
// SPECIFIC section, but home otherwise restores the last-used view from
// localStorage (often Chat) — landing you somewhere other than asked. The
// view rides as a URL fragment (`#library`); home reads it on boot AND on
// hashchange (the focus-existing-tab path, where no reload fires), then
// clears it so it doesn't override later rail navigation on refresh.
//
// Lives in shared/ so the side panel and any other surface can call it.

import browser from '/vendor/browser-polyfill.js';

const HOME_PATH = 'home/home.html';

/**
 * @param {string} [view] target home view (e.g. 'library', 'chat'); omitted
 *   restores the last-used view.
 */
export const openHome = async (view) => {
  try {
    const base = browser.runtime.getURL(HOME_PATH);
    const url = view ? `${base}#${view}` : base;
    const tabs = (await browser.tabs?.query?.({})) ?? [];
    // Match on the hashless base — an already-open home tab carries no (or a
    // different) fragment, so startsWith(url) would miss it.
    const existing = tabs.find((t) => typeof t.url === 'string' && t.url.startsWith(base));
    if (existing?.id != null) {
      // Pass the fragment-bearing url only when a view was requested: changing
      // just the hash navigates the live tab (fires hashchange) without a reload.
      await browser.tabs.update(existing.id, { active: true, ...(view ? { url } : {}) });
      if (existing.windowId != null) await browser.windows?.update?.(existing.windowId, { focused: true });
      return;
    }
    await browser.tabs.create({ url });
  } catch (e) {
    console.warn('[open-home] failed', e);
  }
};
