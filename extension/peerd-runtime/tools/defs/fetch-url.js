// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
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
import { disarmMarkup, disarmText } from '../../dom/cdr.js';
import { windowText, pagingFooter, excerptRelevant, excerptFooter } from '../web/spill.js';
import { needsWebWriteConfirm } from '/peerd-engine/background.js';
// The pure "is this response a document file?" test — see peerd-runtime/doc.
import { sniffResponseAsDocument } from '../../doc/sniff.js';
import { runtimeCapabilityAvailable, runtimeCapabilityForTool } from '../../runtime-capabilities.js';

const MAX_BODY_CHARS = 16_000;   // hard cap to avoid context-blast on huge payloads

// Is this response body actually MARKUP — i.e. is `<!-- -->` a comment the
// renderer hides, rather than four visible characters? Only a yes earns the
// destructive comment pass. Broader than the html/xhtml test used for
// extraction below, because XML and SVG hide comments too while being no use
// to Readability. Missing/garbage content-type falls to NO: the safe sweep
// still runs, and under-disarming a body wrapUntrusted will fence anyway beats
// silently deleting a span of someone's JSON.
const isMarkupType = (/** @type {string} */ ct) =>
  /(text\/html|application\/xhtml|(text|application)\/(\w+\+)?xml|image\/svg)/i.test(ct);
// Headers that would smuggle a session / credential into a "sessionless" call.
// Stripped unconditionally (case-insensitive). The keyless actor has no
// credential to begin with; this is the wall against a laundered injection
// trying to add one (e.g. a Cookie copied out of page text).
// `dpop` rides this list for the same reason `authorization` does: it is a
// credential slot the EGRESS BOUNDARY owns (RFC 9449 — peerd-egress/dpop/), so a
// tool-supplied value in it is by definition forged. A proof the actor wrote is
// worthless to a server, but it must not be the thing on the wire when the
// boundary declines to mint a real one.
const SESSION_HEADERS = new Set(['cookie', 'authorization', 'proxy-authorization', 'dpop']);

/** @param {Record<string, unknown>} headers @returns {Record<string, string>} */
const stripSessionHeaders = (headers) => {
  /** @type {Record<string, string>} */
  const out = {};
  // JSON Schema calls for an object. Enforce that again at the wire seam:
  // Object.entries(['payload']) would otherwise manufacture a valid numeric
  // header name (`0`) and transmit an array value the policy scanner correctly
  // treated as a malformed/non-header container.
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return out;
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (SESSION_HEADERS.has(k.toLowerCase())) continue;
    if (typeof v === 'string') out[k] = v;
  }
  return out;
};

/** @type {import('/shared/tool-types.js').Tool} */
export const fetchUrlTool = composeTool("fetch_url", {
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
      }), ctx.abortSignal);
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
      // A DOCUMENT FILE, not a page. fetch_url's primitive decodes every
      // response with Response.text(), so a .docx/.xlsx/.pptx/PDF arrives as
      // mojibake — and the paths below would then disarm it, window it, spill
      // 16k of it to the cache, and hand the model a screenful of garbage it
      // will nonetheless try to answer from. Hand over the reader that CAN
      // open it instead. The bytes are re-fetched there (offscreen, under the
      // same denylist + SSRF gates), which costs one request and is worth it:
      // the alternative is a confident answer drawn from noise.
      const asDocument = sniffResponseAsDocument({
        contentType: ct, url: res.finalUrl || args.url, bodyHead: res.body.slice(0, 4096),
      });
      if (asDocument) {
        const reader = runtimeCapabilityForTool(asDocument.tool,
          /** @type {any} */ (ctx).runtimeCapabilities);
        if (reader && !runtimeCapabilityAvailable(reader.capability)) {
          const recovery = asDocument.format === 'pdf'
            ? 'Ask the user to attach this PDF directly, or provide page images or a plain-text export.'
            : 'Ask for a PDF, page images, or a plain-text export.';
          return {
            ok: false,
            error: 'binary_document',
            format: asDocument.format,
            readerAvailable: false,
            content: `${res.finalUrl || args.url} is a ${asDocument.format.toUpperCase()} document, not a web page. `
              + `This runtime has no reader for those bytes. ${recovery}`,
          };
        }
        return {
          ok: false,
          error: 'binary_document',
          content: `${res.finalUrl || args.url} is a ${asDocument.format.toUpperCase()} document, not a web page — `
            + `fetch_url can only read text, so its bytes would come back unreadable. `
            + `Call ${asDocument.tool}({ url: "${res.finalUrl || args.url}" }) to read it.`,
        };
      }
      // HTML → clean markdown (the default; raw:true opts out). Boilerplate is
      // most of a page's bytes, and the JSON envelope below escapes every
      // quote in it — raw HTML routinely burns the whole 16k budget on nav and
      // script tags. Readability+Turndown (offscreen — the SW has no DOMParser)
      // return the readable core instead. FAIL-OPEN by design: a non-article
      // page (readerable:false), a missing client (Firefox — no offscreen
      // doc), or an extraction error all fall back to today's raw behavior —
      // extraction is an optimization, never a gate on the fetch.
      // CDR (dom/cdr.js) runs HERE, on the whole body, BEFORE anything derived
      // from it exists. why here and not later: everything below measures or
      // slices this string — excerptRelevant/windowText report character
      // offsets, and webCache.put stores the text read_web_cache pages back.
      // Disarming after windowing would make those offsets describe pre-strip
      // text and would leave undisarmed bytes sitting in the cache.
      //
      // WHICH sweep is decided by the content type, and that is load-bearing.
      // The invisible/control sweep is safe on anything. The COMMENT pass is
      // destructive by design (cdr.js HTML_COMMENT_RE), so it may only touch a
      // body that really is markup: on JSON or text/plain `<!--` is ordinary
      // visible content, and a well-formed pair spanning two attacker-supplied
      // fields would delete everything between them — inverting CDR's whole
      // guarantee from "the model sees what the human sees" into "the model
      // sees less". fetch_url reads APIs at least as often as it reads pages,
      // so this branch is the common case, not the edge one. raw:true still
      // gets the comment pass when the body IS html — the comment is the
      // vector regardless of who asked for the markup.
      let workingBody = isMarkupType(ct) ? disarmMarkup(res.body) : disarmText(res.body);
      let format = 'raw';
      let title = null;
      const webClient = /** @type {{ extractMarkdown?: (s: { html: string, url?: string }) => Promise<{ readerable: boolean, markdown?: string, title?: string | null }> } | null | undefined} */ (
        /** @type {any} */ (ctx).webOffscreenClient);
      if (args.raw !== true && /text\/html|application\/xhtml/i.test(ct) && webClient?.extractMarkdown) {
        try {
          const ex = await webClient.extractMarkdown({ html: workingBody, url: res.finalUrl || args.url });
          // Disarmed AGAIN after extraction, and it is not belt-and-braces:
          // extraction PARSES the HTML, so `&#8203;` — plain ASCII the first
          // sweep correctly left alone — is decoded into a literal zero-width
          // byte on the way out. The entity is the smuggling channel; this pass
          // is the one that closes it. Emptiness is judged AFTER the strip, so a
          // "page" that is nothing but invisible bytes falls back to raw rather
          // than shipping a blank markdown body.
          const markdown = disarmMarkup(ex.markdown);
          if (ex.readerable && markdown.trim()) {
            workingBody = markdown;
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
          // Stamp the OWNER. The spill store is one service-worker-level map keyed
          // by an opaque handle, so without this any actor holding a key could page
          // back bytes a different actor fetched - credentialed, from an origin it
          // is itself locked out of. read_web_cache checks this before slicing.
          await webCache.put({
            key: cacheKey, url: res.finalUrl || args.url, format, text: workingBody,
            ownerSessionId: ctx.session?.sessionId ?? null,
          });
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
          // The SSRF guard refuses BEFORE any request leaves peerd — typed
          // positive failure evidence for the lifecycle settle path.
          outcomeKind: 'pre-effect-failure',
        };
      }
      // A bare network throw (TypeError: Failed to fetch / AbortError) is
      // the wire dying with the request possibly delivered — stamp the
      // typed ambiguous outcome so the lifecycle settle path decides
      // deterministically instead of regex-matching the message.
      const name = /** @type {{ name?: string }} */ (e)?.name;
      const transportLost = name === 'AbortError' || name === 'TypeError';
      return {
        ok: false,
        error: err?.message ?? 'fetch_failed',
        ...(transportLost ? { outcomeKind: 'transport-lost' } : {}),
      };
    }
  },
});
