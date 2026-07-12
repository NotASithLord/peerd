// @ts-check
// fetch_url — the web actor's secure fetch (its non-render web mechanism).
//
// The cheaper of the web actor's two mechanisms (the other is open + drive a tab).
// A direct, denylist-gated, audited HTTP call with NO tab and NO rendering. It rides
// ctx.webFetch — scheme + SSRF/private-network + denylist + redirect-block + audit,
// the SAME chain call_api uses — and the capability strip (spawn.js
// restrictCtxCapabilities) leaves the web ctx NO getSecret / NO safeFetch (keyless).
//
// SESSION is decided AT THE BOUNDARY, not here: ctx.webFetch is session-scoped
// (peerd-egress withSessionScopedCredentials) so the user's cookies ride ONLY on a
// request same-origin to the tab the actor owns — where it is already in that session
// via the rendered tab — and EVERY cross-origin request (and the whole 0-tab state)
// stays sessionless. This tool never sets credentials, so it cannot opt a cross-origin
// request into the session. why still strip Cookie/Authorization here: those are
// tool-supplied HEADERS (a laundered injection forging a credential); the real
// same-origin cookies come from the browser's jar via the boundary, never a header.

import { fetchUrl } from '../web/primitives.js';
import { originOfUrl } from './dom-helpers.js';
import { wrapUntrusted } from '../prompt-wrap.js';
import { windowText, pagingFooter, excerptRelevant, excerptFooter } from '../web/spill.js';
import { needsWebWriteConfirm } from '/peerd-engine/index.js';

const MAX_BODY_CHARS = 16_000;   // hard cap to avoid context-blast on huge payloads
// Headers that would smuggle a session / credential into a "sessionless" call.
// Stripped unconditionally (case-insensitive). The keyless actor has no
// credential to begin with; this is the wall against a laundered injection
// trying to add one (e.g. a Cookie copied out of page text).
const SESSION_HEADERS = new Set(['cookie', 'authorization', 'proxy-authorization']);

/** @param {Record<string, unknown>} headers @returns {Record<string, string>} */
const stripSessionHeaders = (headers) => {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (SESSION_HEADERS.has(k.toLowerCase())) continue;
    if (typeof v === 'string') out[k] = v;
  }
  return out;
};

/** @type {import('/shared/tool-types.js').Tool} */
export const fetchUrlTool = {
  name: 'fetch_url',
  primitive: 'web',
  description: [
    'Secure fetch: a direct GET/POST to a URL — no tab, no rendering. The cheaper of',
    'your two web mechanisms. SESSIONLESS for every cross-origin request and whenever',
    "you own no tab (no cookies); it carries the user's session ONLY for a request",
    'same-origin to the tab you currently own. Use it for data reachable WITHOUT login',
    '(public / JSON APIs, RSS, static content, an endpoint a page just wraps). For a',
    'target you have NOT yet rendered that needs the login, or one that only renders',
    'client-side, drive a tab instead — but once you HAVE rendered a site, fetch_url',
    "carries its session, so hit that SAME origin's endpoints here instead of",
    're-scraping. Rides the denylist + SSRF + audit egress chain; does NOT follow',
    'redirects. Returns status, final URL, body + parsed JSON (capped 16k). HTML',
    'is extracted to clean markdown by default (raw:true for the full HTML).',
  ].join(' '),
  schema: {
    type: 'object',
    required: ['url'],
    properties: {
      url: { type: 'string', description: 'Absolute URL (must include an http(s) scheme).' },
      method: { type: 'string', enum: ['GET', 'POST'], description: 'HTTP method. Default GET.' },
      raw: { type: 'boolean', description: 'HTML responses are extracted to clean markdown by default (boilerplate stripped). Pass true to get the raw HTML instead — e.g. when you need markup, attributes, or embedded script/JSON the extraction would drop.' },
      query: { type: 'string', description: 'What you are looking for on this page (a few keywords). When the page is too long to show whole, the most relevant passages are surfaced (BM25) instead of a blind head+tail window — so a mid-page answer is not missed. Omit to get the head+tail window.' },
      headers: {
        type: 'object',
        description: 'Request headers. Tool-supplied Cookie / Authorization are always stripped (you cannot inject a credential). Content-Type is set automatically for JSON bodies.',
      },
      body: { description: 'Request body. If an object, it is JSON-stringified and Content-Type is set.' },
    },
  },
  // read, like call_api — the non-GET write is gated INSIDE via the shared
  // web:write confirm, not the mutate_external egress hook.
  sideEffect: 'read',
  origins: (args) => {
    const o = originOfUrl(args?.url);
    return o ? [o] : [];
  },
  execute: async (args, ctx) => {
    if (typeof args?.url !== 'string' || !args.url) return { ok: false, error: 'url_required' };
    let parsed;
    try { parsed = new URL(args.url); }
    catch { return { ok: false, error: `invalid_url: ${args.url}` }; }
    if (!/^https?:$/.test(parsed.protocol)) return { ok: false, error: `unsupported_scheme: ${parsed.protocol}` };

    const method = (args.method ?? 'GET').toUpperCase();
    // Anti-exfiltration: a non-GET can transmit in-context data to an arbitrary
    // host. Confirm by default (the shared 'web:write' key + needsWebWriteConfirm
    // predicate cover call_api + the WebVM bridge too, so one approval governs
    // all). Fail closed: no confirm channel → refuse rather than send unconfirmed.
    // GET reads are never gated.
    if (needsWebWriteConfirm(method)) {
      if (!ctx.confirm) return { ok: false, error: 'declined', content: 'No confirmation channel available for an outbound write.' };
      const ans = await ctx.confirm(/** @type {any} */ ({
        tool: 'web:write', kind: 'web_write', origins: [parsed.origin],
        summary: `Allow a ${method} request to ${parsed.host}? This can send data out of the browser.`,
        sessionId: ctx.session?.sessionId ?? null,
      }));
      if (ans !== 'yes_once' && ans !== 'yes_session') return { ok: false, error: 'declined', content: 'User declined the outbound write.' };
    }

    let body = args.body;
    const headers = stripSessionHeaders(/** @type {Record<string, unknown>} */ (args.headers ?? {}));
    if (body !== undefined && typeof body !== 'string') {
      body = JSON.stringify(body);
      if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';
    }

    try {
      // No credentials arg: the SESSION decision is the boundary's (ctx.webFetch is
      // session-scoped) — same-origin to the owned tab carries the session, every
      // cross-origin request stays sessionless. The tool can't override it.
      const res = await fetchUrl(
        args.url,
        { method, headers, body: /** @type {string | undefined} */ (body) },
        ctx,
      );
      const ct = res.headers['content-type'] ?? '';
      // HTML → clean markdown (the default; raw:true opts out). Boilerplate is
      // most of a page's bytes, and the JSON envelope below escapes every
      // quote in it — raw HTML routinely burns the whole 16k budget on nav and
      // script tags. Readability+Turndown (offscreen — the SW has no DOMParser)
      // return the readable core instead. FAIL-OPEN by design: a non-article
      // page (readerable:false), a missing client (Firefox — no offscreen
      // doc), or an extraction error all fall back to today's raw behavior —
      // extraction is an optimization, never a gate on the fetch.
      let workingBody = res.body;
      let format = 'raw';
      let title = null;
      const webClient = /** @type {{ extractMarkdown?: (s: { html: string, url?: string }) => Promise<{ readerable: boolean, markdown?: string, title?: string | null }> } | null | undefined} */ (
        /** @type {any} */ (ctx).webOffscreenClient);
      if (args.raw !== true && /text\/html|application\/xhtml/i.test(ct) && webClient?.extractMarkdown) {
        try {
          const ex = await webClient.extractMarkdown({ html: res.body, url: res.finalUrl || args.url });
          if (ex.readerable && typeof ex.markdown === 'string' && ex.markdown.trim()) {
            workingBody = ex.markdown;
            format = 'markdown';
            title = ex.title ?? null;
          }
        } catch { /* extraction failed — raw fallback */ }
      }
      // Spill-and-page for an oversized body (Hermes-style): the FULL text is
      // stored locally and the model sees a head+tail WINDOW plus the exact
      // read_web_cache paging call — instead of the old silent head-only slice
      // that lost the tail without saying so. Falls back to the old slice when
      // the cache capability is absent (a ctx without webCache).
      const webCache = /** @type {{ key?: () => string, put?: (r: object) => Promise<void> } | undefined} */ (
        /** @type {any} */ (ctx).webCache);
      // When the caller named a query AND the body is prose (not JSON — BM25 is
      // for paragraphs, not object trees), surface the most-relevant PASSAGES
      // instead of a blind head+tail window: a long page's answer usually sits
      // mid-document. excerptRelevant returns null (no query / no match / too
      // few passages) → fall back to windowText. Either way the FULL text is
      // stored and pageable; this only picks a better first window.
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      const ex = (query && !/(json|graphql)/i.test(ct))
        ? excerptRelevant(workingBody, query, MAX_BODY_CHARS) : null;
      const win = windowText(workingBody, MAX_BODY_CHARS);   // always computed (cheap) — the fallback path
      let text = ex ? ex.excerpt : win.window;
      const truncated = ex ? ex.excerpted : win.windowed;
      /** @type {string | null} */
      let footer = null;
      if (truncated && webCache?.key && webCache?.put) {
        const cacheKey = webCache.key();
        try {
          await webCache.put({ key: cacheKey, url: res.finalUrl || args.url, format, text: workingBody });
          footer = ex
            ? excerptFooter({ key: cacheKey, total: ex.total, passagesShown: ex.passagesShown, passagesTotal: ex.passagesTotal, query })
            : pagingFooter({ key: cacheKey, total: win.total, headChars: win.headChars, tailChars: win.tailChars });
        } catch { /* spill failed — the window/excerpt (with its elision markers) still ships */ }
      } else if (truncated && !webCache) {
        // No cache capability → the pre-spill behavior (head-only slice).
        text = workingBody.slice(0, MAX_BODY_CHARS);
      }
      let parsedJson = null;
      if (/(json|graphql)/i.test(ct)) { try { parsedJson = JSON.parse(truncated ? workingBody.slice(0, MAX_BODY_CHARS) : text); } catch { parsedJson = null; } }
      // The body is open-web content the page/host controls — fence it as DATA,
      // not instructions (the same boundary call_api / read_page enforce). The
      // paging footer is TOOL-AUTHORED (caller-computed values only, never
      // fetched bytes) and rides OUTSIDE the fence — page content must never
      // be able to forge or suppress it.
      const fenced = wrapUntrusted({
        origin: originOfUrl(res.finalUrl || args.url),
        tool: 'fetch_url',
        body: JSON.stringify({
          status: res.status,
          finalUrl: res.finalUrl,
          contentType: ct || null,
          format,
          ...(title ? { title } : {}),
          truncated,
          body: text,
          json: parsedJson,
        }, null, 2),
      });
      return { ok: true, content: footer ? `${fenced}\n${footer}` : fenced };
    } catch (e) {
      const err = /** @type {{ reason?: string, message?: string }} */ (e);
      if (err?.reason === 'redirect_blocked') {
        return {
          ok: false,
          error: `redirected: ${args.url} issued an HTTP redirect, which fetch_url does not follow. `
            + 'Retry with the final URL (try https:// and/or the www. host), or drive a tab instead.',
        };
      }
      // A private/loopback/LAN host (localhost, 127.0.0.1, 192.168.*, a local dev
      // server) is refused by the SSRF guard — fetch_url can't reach it. This is
      // NOT "the site is unreachable": RENDER it instead — navigate opens it in
      // your tab and the DOM tools (snapshot / read_page) read the live page. And
      // never re-fetch content you can already SEE on a page you've rendered.
      if (err?.reason === 'private_network') {
        return {
          ok: false,
          error: `blocked: ${args.url} is a private/loopback host, which fetch_url cannot reach (SSRF defense) — `
            + 'this does NOT mean the site is unreachable. Open it with navigate and read the rendered page '
            + 'with snapshot/read_page instead. If you already rendered the page, read that DOM — do not re-fetch it.',
        };
      }
      return { ok: false, error: err?.message ?? 'fetch_failed' };
    }
  },
};
