// @ts-check
// read_article — safeFetch with tab fallback.
//
// The escalation default from POLICY.md lives here. We try safeFetch
// first; if `shouldEscalate` flags the response (SPA shell, anti-bot,
// HTTP 403/429/503, or missing `expects` substrings), we open a real
// tab, let it load JS, read the page text, close the tab. That escalation
// tab is transient (opened then closed), so openWebTab keeps it in the
// background — flashing a tab the user can't even reach would just yank
// them. Tabs the user should SEE go through open_tab (which takes focus).

import { fetchUrl, openWebTab, readTabContent, closeTab } from './primitives.js';
import { shouldEscalate } from './policy.js';
import { originOfUrl } from '../defs/dom-helpers.js';
import { wrapUntrusted } from '../prompt-wrap.js';

const MAX_TEXT_CHARS = 8_000;       // cap returned text to keep context lean

/** @type {import('/shared/tool-types.js').Tool} */
export const readArticleTool = {
  name: 'read_article',
  primitive: 'web',
  description: [
    'Read a web page\'s visible text. Fast background safeFetch first;',
    'escalates to a JS-rendering background tab on an SPA shell, anti-bot',
    'block, 4xx/5xx, or a failed `expects`. ✅ an article, blog, or docs',
    'page. ❌ a JSON API (use call_api). Returns title, final URL, text.',
  ].join(' '),
  schema: {
    type: 'object',
    required: ['url'],
    properties: {
      url: { type: 'string', description: 'Absolute URL (must include scheme).' },
      expects: {
        type: 'array',
        items: { type: 'string' },
        description: [
          'Optional list of substrings that must appear in the response',
          'body. If any is missing, the wrapper escalates to a tab.',
        ].join(' '),
      },
    },
  },
  sideEffect: 'read',
  origins: (args) => {
    const o = originOfUrl(args?.url);
    return o ? [o] : [];
  },
  execute: async (args, ctx) => {
    if (typeof args?.url !== 'string' || !args.url) {
      return { ok: false, error: 'url_required' };
    }
    let parsed;
    try { parsed = new URL(args.url); }
    catch { return { ok: false, error: `invalid_url: ${args.url}` }; }
    if (!/^https?:$/.test(parsed.protocol)) {
      return { ok: false, error: `unsupported_scheme: ${parsed.protocol}` };
    }

    // Phase 1: try safeFetch.
    let fetched;
    try {
      fetched = await fetchUrl(args.url, { method: 'GET' }, ctx);
    } catch (e) {
      // safeFetch failure (network, abort, allowlist miss) — fall
      // through to tab escalation.
      return await escalate(args, ctx, { reason: `fetch_failed:${/** @type {{ message?: string }} */ (e)?.message ?? 'unknown'}` });
    }

    const decision = shouldEscalate({
      status:  fetched.status,
      body:    fetched.body,
      expects: args.expects,
    });

    if (!decision.escalate) {
      return ok({
        via: 'safeFetch',
        finalUrl: fetched.finalUrl,
        text: extractVisibleText(fetched.body),
      }, originOfUrl(fetched.finalUrl || args.url));
    }

    // Phase 2: escalation.
    return await escalate(args, ctx, { reason: decision.reason });
  },
};

/**
 * Inactive-tab escalation. Opens, reads, closes.
 *
 * @param {{ url: string }} args
 * @param {import('/shared/tool-types.js').ToolContext} ctx
 * @param {{ reason: string }} opts
 * @returns {Promise<import('/shared/tool-types.js').ToolResult>}
 */
const escalate = async (args, ctx, { reason }) => {
  /** @type {number | null} */
  let tabId = null;
  try {
    const opened = await openWebTab(args.url, ctx);
    tabId = opened.tabId;
    const page = await readTabContent(tabId, ctx);
    return ok({
      via: 'background_tab',
      escalation_reason: reason,
      finalUrl: opened.finalUrl,
      text: (page.text ?? '').slice(0, MAX_TEXT_CHARS),
      title: page.title,
    }, originOfUrl(opened.finalUrl || args.url));
  } catch (e) {
    return { ok: false, error: `escalation_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? e}` };
  } finally {
    if (tabId != null) await closeTab(tabId, ctx);
  }
};

// why: page content (safeFetch body or rendered tab text) is untrusted —
// fence it as data, not instructions, like read_page. read_article is a
// main-agent tool, so this fence is the only injection boundary between a
// hostile page and the privileged context (closing-tag break-out hardening
// lives in prompt-wrap.js neutralizeFence). The payload wraps text AND the
// page-derived metadata (finalUrl/title) — those are page-influenced too.
/**
 * @param {Record<string, unknown>} payload
 * @param {string} [origin]
 * @returns {import('/shared/tool-types.js').ToolResultOk}
 */
const ok = (payload, origin) => ({
  ok: true,
  content: wrapUntrusted({
    origin: origin ?? '',
    tool: 'read_article',
    body: JSON.stringify(payload, null, 2),
  }),
});

/**
 * Lightweight visible-text extraction for the safeFetch path. We don't
 * have a DOM in the SW — strip tags + collapse whitespace as a coarse
 * substitute. The tab-escalation path uses the real DOM via
 * readTabContent.
 *
 * @param {unknown} html
 * @returns {string}
 */
const extractVisibleText = (html) => {
  if (typeof html !== 'string') return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT_CHARS);
};
