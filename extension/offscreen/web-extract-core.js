// @ts-check
// offscreen/web-extract-core.js — the HTML → markdown pipeline (Readability +
// Turndown), split from web-extract.js's message-handler shell.
//
// why the split (functional core, imperative shell): the shell registers a
// runtime.onMessage listener at import time, which only works inside a live
// extension context — this core has no browser.* edge, so any DOM-bearing
// document can import it: the offscreen doc (via the shell + the job runner's
// fetch bridge) AND the in-browser test runner, which drives the REAL pipeline
// against fixtures instead of stubs.

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
export const extractWeb = async ({ html, url } = {}) => {
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

/**
 * extractWeb adapted to the throwing contract the extract post-step expects
 * (shared/fetch-extract.js `ExtractMarkdownFn` — the same shape fetch_url's
 * offscreen client presents). The apply helper fails OPEN on a throw, so an
 * extractor error is passthrough. This is the SAME-DOCUMENT injection the
 * headless job runner rides (offscreen.js) — kept here as production code so
 * the in-browser suite exercises the real adaptation, not a copy.
 * @type {import('/shared/fetch-extract.js').ExtractMarkdownFn}
 */
export const extractMarkdownLocal = async ({ html, url }) => {
  const out = await extractWeb({ html, url });
  if (!out.ok) throw new Error(out.error);
  return out.result;
};
