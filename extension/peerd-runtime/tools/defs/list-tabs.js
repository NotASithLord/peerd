// @ts-check
// list_tabs — enumerate the browser's open tabs.
//
// Cheap context-providing tool. The agent uses this to decide whether
// to navigate the current tab or open a new one. Primitive = sessions
// because the result describes the user's existing browser sessions.

import { originOfUrl, isDenylistedTab } from './dom-helpers.js';
import { serializeListResult } from './columnar.js';

/**
 * A browser tab as surfaced by browser.tabs.query.
 * @typedef {Object} BrowserTab
 * @property {number} [id]
 * @property {string} [url]
 * @property {string} [title]
 * @property {boolean} [active]
 * @property {number} [windowId]
 */

/** @type {import('/shared/tool-types.js').Tool} */
export const listTabsTool = {
  name: 'list_tabs',
  primitive: 'tab',
  description: [
    'List all open browser tabs with their id, title, url, and origin.',
    'Useful for deciding whether to navigate an existing tab or open a',
    'new one.',
  ].join(' '),
  schema: { type: 'object', properties: {} },
  sideEffect: 'read',
  origins: () => [],

  execute: async (_args, ctx) => {
    // why: ctx.tabs is the opaque `Object` contract slot; narrow it to the
    // one method this tool uses (browser.tabs.query).
    const tabsApi = /** @type {{ query: (q: Record<string, unknown>) => Promise<BrowserTab[]> }} */ (ctx.tabs);
    /** @type {BrowserTab[]} */
    let tabs;
    try { tabs = await tabsApi.query({}); }
    catch (e) {
      return { ok: false, error: `tabs_query_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
    // why: drop denylisted tabs entirely. Leaking their id + origin would
    // hand a prompt-injected agent the exact tabId needed to drive a
    // bank/email/health tab via a DOM tool's `tabId` arg — the agent can't
    // target what it can't enumerate. (resolveTargetTab refuses them too;
    // this removes the enumeration primitive that feeds the exploit.)
    const denylist = ctx.denylist ?? [];
    const visible = tabs.filter((t) => !isDenylistedTab(t.url, denylist));
    const summary = visible.map((t) => ({
      id: t.id,
      origin: originOfUrl(t.url),
      title: truncate(t.title || '', 60),
      active: !!t.active,
      windowId: t.windowId,
    }));
    const hidden = tabs.length - visible.length;
    return {
      ok: true,
      content: serializeListResult({
        count: summary.length,
        tabs: summary,
        // Tell the agent SOMETHING was withheld so it doesn't loop hunting
        // for a tab it can see in the browser but not here.
        ...(hidden > 0 ? { denylisted_tabs_hidden: hidden } : {}),
      }, 'tabs'),
    };
  },
};

/** @param {string} s @param {number} n @returns {string} */
const truncate = (s, n) => s.length <= n ? s : `${s.slice(0, n - 1)}…`;
