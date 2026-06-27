// @ts-check
// web_search — always a tab.
//
// Per POLICY.md: search results are heavily personalized, sometimes
// SPA-rendered, often anti-bot-protected. We open the user's chosen
// search engine in an inactive tab, let it load (with the user's
// session and cookies), and read the visible text. Closing the tab
// when done.
//
// V1 ships with Google as the default. The engine is configurable
// later via settings; the engine URL is just a template with `{q}`.

import { openWebTab, readTabContent, closeTab, landedHostDenial } from './primitives.js';
import { originOfUrl } from '../defs/dom-helpers.js';
import { wrapUntrusted } from '../prompt-wrap.js';

const DEFAULT_ENGINE = 'https://www.google.com/search?q={q}';

const MAX_TEXT_CHARS = 6_000;

/** @type {import('/shared/tool-types.js').Tool} */
export const webSearchTool = {
  name: 'web_search',
  primitive: 'web',
  description: [
    'Search the user\'s default engine in a background tab; returns the',
    'results-page text. Always a tab (not a bare fetch): results are',
    'personalized and anti-bot-protected, and the user\'s session shapes',
    'them. ✅ a query like "best X 2026". ❌ a known URL — message the "web"',
    'actor to fetch or read it.',
  ].join(' '),
  schema: {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string', description: 'Search query.' },
    },
  },
  sideEffect: 'read',
  origins: (args) => {
    try {
      const url = buildSearchUrl(args?.query ?? '');
      return [new URL(url).origin];
    } catch { return []; }
  },
  execute: async (args, ctx) => {
    if (typeof args?.query !== 'string' || !args.query.trim()) {
      return { ok: false, error: 'query_required' };
    }
    const url = buildSearchUrl(args.query);

    let tabId = null;
    try {
      const opened = await openWebTab(url, ctx);
      tabId = opened.tabId;
      // Defense-in-depth: a results page can meta-refresh / JS-redirect into a
      // denylisted or private host. Re-validate the landed host before reading
      // (the query is agent-controlled, the destination is not — but the same
      // one-line guard the web actor's drive-a-tab read uses applies here too).
      const denial = landedHostDenial(opened.finalUrl, ctx);
      if (denial) {
        ctx.audit?.({ type: 'egress_denied', details: { origin: denial.host, reason: `landed:${denial.reason}` } })?.catch?.(() => {});
        return { ok: false, error: `egress_denied: the results page redirected to ${denial.host}, which is not permitted.` };
      }
      const page = await readTabContent(tabId, ctx);
      // why: results-page text is untrusted web content — fence it as
      // data, not instructions, like read_page. web_search is a main-agent
      // tool, so this fence is the injection boundary between a hostile
      // results page and the privileged context (closing-tag break-out
      // hardening lives in prompt-wrap.js neutralizeFence).
      return {
        ok: true,
        content: wrapUntrusted({
          origin: originOfUrl(opened.finalUrl || url),
          tool: 'web_search',
          body: JSON.stringify({
            query: args.query,
            engine: 'google',
            finalUrl: opened.finalUrl,
            title: page.title,
            text:  (page.text ?? '').slice(0, MAX_TEXT_CHARS),
          }, null, 2),
        }),
      };
    } catch (e) {
      return { ok: false, error: `search_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? e}` };
    } finally {
      if (tabId != null) await closeTab(tabId, ctx);
    }
  },
};

/** @param {string} query @returns {string} */
const buildSearchUrl = (query) => DEFAULT_ENGINE.replace('{q}', encodeURIComponent(query));
