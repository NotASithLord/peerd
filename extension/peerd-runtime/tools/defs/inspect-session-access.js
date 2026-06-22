// @ts-check
// inspect_session_access — proves "your sessions are already there".
//
// Lists the tabs and origins the agent can currently see. The §02 hook
// is the "browser is the runtime" claim — peerd inherits the user's
// existing browser sessions (logged-in tabs, cookies, etc.) rather than
// spinning up a separate browsing context. This tool demonstrates that.

import { serializeListResult } from './columnar.js';

/**
 * @typedef {Object} BrowserTab
 * @property {number} [id]
 * @property {string} [url]
 * @property {string} [title]
 * @property {boolean} [active]
 */

/** @type {import('/shared/tool-types.js').Tool} */
export const inspectSessionAccessTool = {
  name: 'inspect_session_access',
  primitive: 'inspect',
  description: [
    'List the tabs and origins the agent can currently see. peerd uses',
    'the user\'s existing browser sessions — tabs where they\'re already',
    'logged in are visible without re-authentication.',
  ].join(' '),
  schema: { type: 'object', properties: {} },
  sideEffect: 'read',
  origins: () => [],
  execute: async (_args, ctx) => {
    /** @type {Array<Record<string, unknown>>} */
    let tabs = [];
    try {
      // why: ctx.tabs is the opaque `Object` contract slot; narrow it to the
      // one method this tool uses (browser.tabs.query).
      const tabsApi = /** @type {{ query: (q: Record<string, unknown>) => Promise<BrowserTab[]> }} */ (ctx.tabs);
      const raw = await tabsApi.query({});
      tabs = raw.map((t) => ({
        id: t.id,
        origin: tryOriginOf(t.url),
        title: truncate(t.title, 60),
        active: t.active,
        url: redactSensitivePath(t.url),
      }));
    } catch (e) {
      return {
        ok: false,
        error: `tabs query failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`,
      };
    }
    return {
      ok: true,
      content: serializeListResult({
        accessibleTabs: tabs.length,
        // why: the denylist is the only origin restriction that exists —
        // say so here so the model never invents a tighter scope.
        scopeRule: 'Every tab is in scope. The denylist is the only floor.',
        tabs,
      }, 'tabs'),
    };
  },
};

/** @param {string | undefined} url @returns {string | null} */
const tryOriginOf = (url) => {
  try { return new URL(url ?? '').origin; }
  catch { return null; }
};

/** @param {string | undefined} s @param {number} n @returns {string} */
const truncate = (s, n) => {
  if (!s) return '';
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
};

/**
 * Strip the path off URLs we don't want to echo into chat verbatim.
 * Chrome's internal pages (settings, history, downloads) and tab paths
 * generally aren't sensitive, but a query string can carry tokens. The
 * agent doesn't need the full URL for the §02 demonstration; the origin
 * is enough.
 */
/** @param {string | undefined} url @returns {string} */
const redactSensitivePath = (url) => {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (u.search) return `${u.origin}${u.pathname}?…`;
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
};
