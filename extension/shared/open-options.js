// @ts-check
// Open the options page — the ONE way any peerd surface reaches the
// full-tab settings.
//
// why two paths: runtime.openOptionsPage() focuses an existing options
// tab (no duplicates) but cannot target a section. Deep links need the
// hash, so they go through tabs.create — same pattern the mic
// permission help already uses for its grant page. Frugality call
// (accepted in the design): a deep link can open a duplicate tab if an
// options tab is already open; we accept that over tab-query plumbing.
//
// Lives in shared/ (not sidepanel/) because peerd-runtime's MicButton
// needs it too — peerd-runtime importing /shared/* has abundant
// precedent (util.js, errors.js, channel-config.js).

import browser from '/vendor/browser-polyfill.js';

/**
 * @param {string} [section] options section id (e.g. 'providers',
 *   'voice') — omit to open/focus the page on its default section.
 */
export const openOptions = (section) => {
  try {
    if (!section) {
      browser.runtime.openOptionsPage();
      return;
    }
    browser.tabs.create({
      url: browser.runtime.getURL(`options/options.html#!/${section}`),
    });
  } catch (e) {
    console.warn('[open-options] failed', e);
  }
};
