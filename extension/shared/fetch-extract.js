// @ts-check
// shared/fetch-extract.js — the post-fetch `extract` step for code mode's
// bridged fetch: peerd.egress.fetch(url, { extract: 'markdown' }).
//
// why here (shared/) and IO-injected: the sealed worker's fetch bridge has two
// hosts — the offscreen job runner (script) applies extraction against the
// LOCAL web-extract entry in its own document, and the SW's sw/web-fetch route
// (serving the Notebook tab's relay) applies it through the same offscreen
// client fetch_url already uses. One pure decide/decode/reshape function keeps
// those hosts from growing divergent pipelines, and makes the step bun-testable.
//
// SECURITY: extraction runs AFTER the audited fetch returned — the egress
// chokepoint (denylist, SSRF, redirect fail-closed, audit, confirm-on-write)
// is untouched; this only post-processes bytes the run was already allowed to
// hold, so it adds no authority. Provenance is unchanged too: extracted
// markdown is the same untrusted web content as the raw HTML, and the run's
// output re-enters fenced via usedEgress (tools/defs/script.js).

import { bytesToBase64, base64ToBytes } from './util.js';

/**
 * @typedef {Object} BridgedFetchResponse the sw/web-fetch wire shape
 * @property {boolean} ok
 * @property {number} [status]
 * @property {string} [statusText]
 * @property {Record<string, string> | null} [headers]
 * @property {string | null} [bodyB64]
 * @property {string | null} [error]
 * @property {boolean} [extracted]   present only when an extract was requested
 */

/**
 * @typedef {(source: { html: string, url?: string }) => Promise<{ readerable: boolean, markdown?: string, title?: string | null }>} ExtractMarkdownFn
 */

// Only 'markdown' ships (design 02 open question 2: 'text' is a stripTags call
// away in peerd:std). Any other value is treated as absent so a future mode
// can never silently change bytes on a build that doesn't know it.
/** @param {unknown} value @returns {'markdown' | undefined} */
const normalizeExtract = (value) => (value === 'markdown' ? 'markdown' : undefined);

// Same candidate test fetch_url uses for extraction: real page markup only —
// never XML/SVG/JSON (Readability would mangle them).
/** @param {string} contentType */
const isHtmlContentType = (contentType) => /text\/html|application\/xhtml/i.test(contentType);

/** @param {Record<string, string> | null | undefined} headers @returns {string} */
const contentTypeOf = (headers) => {
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === 'content-type') return value;
  }
  return '';
};

/**
 * Apply a requested extraction to a completed bridged-fetch response.
 * No `extract` → the response is returned as-is, byte-for-byte (the raw
 * behavior every existing caller keeps).
 *
 * Bodies are decoded as UTF-8 regardless of any header charset (parity with
 * the raw bridge path and fetch_url — Response.text() is UTF-8-only too), so
 * a legacy-charset page extracts with mojibake rather than failing.
 *
 * @param {BridgedFetchResponse | null | undefined} resp
 * @param {{ extract?: unknown, url?: string, extractMarkdown?: ExtractMarkdownFn | null }} opts
 *   extractMarkdown is the injected IO (the offscreen Readability+Turndown
 *   pipeline); absent → passthrough (Firefox has no offscreen doc).
 * @returns {Promise<BridgedFetchResponse | null | undefined>}
 */
export const applyFetchExtract = async (resp, { extract, url, extractMarkdown }) => {
  if (!normalizeExtract(extract)) return resp;
  // FAIL-OPEN from here down (the fetch_url posture): extraction is an
  // optimization, never a gate on the fetch — a failed fetch, a non-HTML body,
  // a missing extractor, a non-article page (readerable:false), or an
  // extraction error all return the body unchanged marked extracted:false, so
  // a script fanning out over mixed URLs never throws on the flag.
  const passthrough = { .../** @type {BridgedFetchResponse} */ (resp ?? { ok: false }), extracted: false };
  if (!resp?.ok || !resp.bodyB64 || typeof extractMarkdown !== 'function') return passthrough;
  if (!isHtmlContentType(contentTypeOf(resp.headers))) return passthrough;
  try {
    const html = new TextDecoder().decode(base64ToBytes(resp.bodyB64));
    const result = await extractMarkdown({ html, url });
    if (!result?.readerable || typeof result.markdown !== 'string' || !result.markdown.trim()) {
      return passthrough;
    }
    // Rewrite content-type alongside the body so the bridge's fake Response
    // reports what the bytes now ARE (design 2a: contentType 'text/markdown').
    /** @type {Record<string, string>} */
    const headers = {};
    for (const [key, value] of Object.entries(resp.headers ?? {})) {
      if (key.toLowerCase() !== 'content-type') headers[key] = value;
    }
    headers['content-type'] = 'text/markdown';
    return {
      ...resp,
      headers,
      bodyB64: bytesToBase64(new TextEncoder().encode(result.markdown)),
      extracted: true,
    };
  } catch {
    return passthrough;
  }
};
