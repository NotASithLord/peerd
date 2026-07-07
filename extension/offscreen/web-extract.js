// @ts-check
// offscreen/web-extract.js — HTML → clean markdown for fetch_url.
//
// fetch_url's execute() runs in the SW, which has no DOMParser — so the
// extraction lives HERE, in the offscreen document, reached via
// background/offscreen-web-client.js → a 'web/extract' message → this handler
// (the exact shape of the pdf-extract pipeline, its sibling above).
//
// Two vendored halves (see each SOURCE.txt): Readability (Firefox Reader
// View's extractor) isolates the article from the boilerplate; Turndown
// converts that article HTML to markdown — the dense representation the model
// actually reads. A cheap isProbablyReaderable pre-check skips extraction on
// non-article pages (dashboards, listings, search results) so the caller falls
// back to today's raw-text behavior instead of getting a mangled fragment.
//
// why client-side at all: the hosted "clean content" APIs other agents lean on
// (Firecrawl etc.) are forbidden here — BYOK / no backend / no third party
// sees the user's browsing. This is peerd's privacy-preserving substitute.

import browser from '/vendor/browser-polyfill.js';
import { isTrustedSender } from '/shared/messaging.js';

// Both libs are loaded LAZILY (dynamic import), mirroring loadPdfjs: the
// offscreen document always loads, but most sessions never fetch an article —
// keep the ~120KB of parser off the startup path and pay it once, on first
// use. why Promise.all in one gate: turndown's browser build probes DOMParser
// at IMPORT time, so it must only ever be imported in a DOM context — this
// module — and never from the SW.
/** @type {Promise<{ Readability: any, isProbablyReaderable: any, TurndownService: any }> | null} */
let libsPromise = null;
const loadLibs = () => (libsPromise ??= Promise.all([
  import('/vendor/readability/Readability.js'),
  import('/vendor/readability/Readability-readerable.js'),
  import('/vendor/turndown/turndown.browser.es.js'),
]).then(([r, rr, t]) => ({ Readability: r.default, isProbablyReaderable: rr.default, TurndownService: t.default })));

// Bound the PARSE work — a pathological page must not wedge the offscreen
// renderer (the shared host for voice + the SW keepalive). Article content
// virtually always lives in the head of the document; the client also caps
// what it sends (offscreen-web-client.js), this is the second wall.
const MAX_HTML_CHARS = 3_000_000;

/**
 * Extract the readable core of an HTML page as markdown.
 *
 * @param {{ html?: string, url?: string }} msg
 * @returns {Promise<{ ok: true, result: { readerable: boolean, markdown?: string, title?: string | null, byline?: string | null, htmlTruncated: boolean } } | { ok: false, error: string }>}
 */
const extractWeb = async ({ html, url } = {}) => {
  if (typeof html !== 'string' || !html) return { ok: false, error: 'html_required' };
  const htmlTruncated = html.length > MAX_HTML_CHARS;
  const input = htmlTruncated ? html.slice(0, MAX_HTML_CHARS) : html;
  const { Readability, isProbablyReaderable, TurndownService } = await loadLibs();

  // A FRESH document per extraction — Readability MUTATES what it parses.
  const doc = new DOMParser().parseFromString(input, 'text/html');
  // The parsed doc inherits THIS page's baseURI (a chrome-extension:// URL);
  // point it at the fetched page instead so relative hrefs/srcs resolve
  // against the real origin, not the extension.
  if (typeof url === 'string' && url) {
    try {
      const base = doc.createElement('base');
      base.href = url;
      doc.head.prepend(base);
    } catch { /* malformed url — links stay relative, extraction still works */ }
  }

  // Non-article page → tell the caller to keep its raw-text behavior. This is
  // the safety valve against Readability mangling dashboards and listings.
  if (!isProbablyReaderable(doc)) {
    return { ok: true, result: { readerable: false, htmlTruncated } };
  }

  const article = new Readability(doc).parse();
  if (!article?.content) {
    return { ok: true, result: { readerable: false, htmlTruncated } };
  }

  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  const markdown = turndown.turndown(article.content);
  return {
    ok: true,
    result: {
      readerable: true,
      markdown,
      title: article.title ?? null,
      byline: article.byline ?? null,
      htmlTruncated,
    },
  };
};

// Gated on isTrustedSender like every sibling handler (pdf/extract, job/run,
// voice) — fail-closed defense-in-depth; see pdf-extract.js's note.
// why cast: the polyfill's OnMessageListener return-type is stricter than this
// fire-and-respond handler (mirrors the sibling listeners).
browser.runtime.onMessage.addListener(/** @type {any} */ ((/** @type {any} */ msg, /** @type {any} */ sender, /** @type {any} */ sendResponse) => {
  if (msg?.type !== 'web/extract') return undefined;
  if (!isTrustedSender(sender)) { sendResponse({ ok: false, error: 'untrusted-sender' }); return true; }
  extractWeb(msg)
    .then((out) => sendResponse(out))
    .catch((e) => sendResponse({ ok: false, error: e?.name ? `${e.name}: ${e.message}` : (e?.message ?? String(e)) }));
  return true;     // async sendResponse contract
}));
