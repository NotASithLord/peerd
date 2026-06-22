// @ts-check
// navigate — change the URL of the target tab and wait for load.
//
// V1 semantics:
//   - Default target is the active tab; pass tabId for a specific one.
//   - We update the URL and wait for chrome.tabs.onUpdated(status='complete').
//   - 30s timeout — pages that never fire 'complete' (websockets, infinite
//     scroll bootstraps) resolve with a "navigation timed out, partial
//     state may apply" warning; the agent can read_page to see what loaded.
//
// origins() returns BOTH the current tab origin and the destination
// origin so the denylist gate fires if either is denylisted.

import { resolveTargetTab, originOfUrl } from './dom-helpers.js';

const NAV_TIMEOUT_MS = 30_000;

/**
 * A browser tab as surfaced by browser.tabs.get.
 * @typedef {Object} BrowserTab
 * @property {number} [id]
 * @property {string} [url]
 */

/**
 * The browser.tabs surface navigate exercises.
 * @typedef {Object} TabsApi
 * @property {(tabId: number) => Promise<BrowserTab>} get
 * @property {(tabId: number, props: { url: string }) => Promise<unknown>} update
 * @property {{ addListener: (l: NavListener) => void, removeListener: (l: NavListener) => void }} onUpdated
 */

/**
 * @callback NavListener
 * @param {number} tabId
 * @param {{ status?: string }} changeInfo
 * @returns {void}
 */

// Destination schemes navigate will load. http(s) only: Chrome BLOCKS
// top-frame navigation to data: (and effectively blob:) URLs as an
// anti-phishing measure, so tabs.update silently no-ops and the load
// times out. Don't pretend to support them. (To render self-contained
// HTML the a11y tree can read, there is no good path today — Apps are
// sandboxed cross-origin iframes the a11y tree can't see into; use a real
// http(s) page for DOM work.)
const NAVIGABLE_SCHEMES = new Set(['http:', 'https:']);

/** @type {import('/shared/tool-types.js').Tool} */
export const navigateTool = {
  name: 'navigate',
  primitive: 'tab',
  description: [
    'Navigate the target tab to an http(s) URL. Waits up to 30s for the',
    'page to finish loading. Returns the final URL (may differ from the',
    'requested URL after redirects).',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Absolute http(s) URL to navigate to (must include scheme).',
      },
      tabId: {
        type: 'integer',
        description: 'Optional tab id; defaults to the active tab.',
      },
    },
    required: ['url'],
  },
  sideEffect: 'write',
  origins: (args, ctx) => {
    /** @type {string[]} */
    const out = [];
    if (ctx.activeTab?.origin) out.push(ctx.activeTab.origin);
    const dest = originOfUrl(args?.url);
    if (dest && !out.includes(dest)) out.push(dest);
    return out;
  },

  execute: async (args, ctx) => {
    if (!args?.url || typeof args.url !== 'string') {
      return { ok: false, error: 'url_required' };
    }
    let parsed;
    try { parsed = new URL(args.url); }
    catch { return { ok: false, error: `invalid_url: ${args.url}` }; }
    // Allowlist of safe destination schemes. http(s) is the norm; data:
    // and blob: let the agent render self-contained HTML (test pages,
    // generated previews) WITHOUT the App/sandboxed-iframe detour that the
    // a11y tree can't see into. javascript:/file:/chrome: stay rejected —
    // they're injection / local-fs / privileged surfaces.
    if (!NAVIGABLE_SCHEMES.has(parsed.protocol)) {
      // why: actionable so the agent doesn't improvise (e.g. hosting HTML
      // in an App, whose sandboxed iframe the a11y tree can't read).
      return {
        ok: false,
        error: `unsupported_scheme: ${parsed.protocol} — navigate only loads http(s). `
          + 'Chrome blocks data:/blob: top-frame navigation. For DOM work use a real http(s) page.',
      };
    }

    const tab = await resolveTargetTab(args, ctx);
    if (!tab?.id) return { ok: false, error: 'no_target_tab' };
    const tabId = tab.id;

    try {
      await waitForNavigation(ctx, tabId, args.url);
    } catch (e) {
      const msg = /** @type {{ message?: string }} */ (e)?.message;
      return {
        ok: false,
        error: msg ?? 'navigation_failed',
        content: JSON.stringify({ requested: args.url, timed_out: /timed out/i.test(msg ?? '') }),
      };
    }

    // Read the final URL — may differ after redirects.
    // why: ctx.tabs is the opaque `Object` contract slot; narrow to get().
    const tabsApi = /** @type {TabsApi} */ (ctx.tabs);
    /** @type {BrowserTab} */
    let finalTab;
    try { finalTab = await tabsApi.get(tabId); }
    catch { finalTab = tab; }

    return {
      ok: true,
      content: JSON.stringify({
        requested: args.url,
        finalUrl: finalTab?.url ?? args.url,
        tabId,
      }, null, 2),
    };
  },
};

/**
 * @param {import('/shared/tool-types.js').ToolContext} ctx
 * @param {number} tabId
 * @param {string} url
 * @returns {Promise<void>}
 */
const waitForNavigation = (ctx, tabId, url) => new Promise((resolve, reject) => {
  // why: ctx.tabs is the opaque `Object` contract slot; narrow to the
  // onUpdated/update surface this navigation watcher exercises.
  const tabsApi = /** @type {TabsApi} */ (ctx.tabs);
  let settled = false;
  /** @param {Error | null} err */
  const finish = (err) => {
    if (settled) return;
    settled = true;
    tabsApi.onUpdated.removeListener(listener);
    clearTimeout(timer);
    err ? reject(err) : resolve();
  };
  /** @type {NavListener} */
  const listener = (id, info) => {
    if (id !== tabId) return;
    if (info.status === 'complete') finish(null);
  };
  tabsApi.onUpdated.addListener(listener);
  const timer = setTimeout(() => finish(new Error('navigation timed out after 30s')), NAV_TIMEOUT_MS);
  tabsApi.update(tabId, { url }).catch(finish);
});
