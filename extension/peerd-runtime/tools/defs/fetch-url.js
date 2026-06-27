// @ts-check
// fetch_url — the web resident's secure fetch (its non-render web mechanism).
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
    'SESSIONLESS secure fetch: a direct GET/POST to a URL — no tab, no rendering,',
    'and NO session (cookies omitted, auth headers stripped). The cheaper of your',
    'two web mechanisms. Use it when the data is reachable WITHOUT the user being',
    'logged in (public / JSON APIs, RSS, static content, an endpoint a page just',
    "wraps). If the target needs the user's login or cookies, or only renders",
    'client-side, do NOT use this — drive a tab instead. Rides the denylist + SSRF',
    '+ audit egress chain; does NOT follow redirects. Returns status, final URL,',
    'body + parsed JSON (capped 16k).',
  ].join(' '),
  schema: {
    type: 'object',
    required: ['url'],
    properties: {
      url: { type: 'string', description: 'Absolute URL (must include an http(s) scheme).' },
      method: { type: 'string', enum: ['GET', 'POST'], description: 'HTTP method. Default GET.' },
      headers: {
        type: 'object',
        description: 'Request headers. Cookie / Authorization are stripped (sessionless). Content-Type is set automatically for JSON bodies.',
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
      const truncated = res.body.length > MAX_BODY_CHARS;
      const text = truncated ? res.body.slice(0, MAX_BODY_CHARS) : res.body;
      let parsedJson = null;
      const ct = res.headers['content-type'] ?? '';
      if (/(json|graphql)/i.test(ct)) { try { parsedJson = JSON.parse(text); } catch { parsedJson = null; } }
      // The body is open-web content the page/host controls — fence it as DATA,
      // not instructions (the same boundary call_api / read_page enforce).
      return {
        ok: true,
        content: wrapUntrusted({
          origin: originOfUrl(res.finalUrl || args.url),
          tool: 'fetch_url',
          body: JSON.stringify({
            status: res.status,
            finalUrl: res.finalUrl,
            contentType: ct || null,
            truncated,
            body: text,
            json: parsedJson,
          }, null, 2),
        }),
      };
    } catch (e) {
      const err = /** @type {{ reason?: string, message?: string }} */ (e);
      if (err?.reason === 'redirect_blocked') {
        return {
          ok: false,
          error: `redirected: ${args.url} issued an HTTP redirect, which fetch_url does not follow. `
            + 'Retry with the final URL (try https:// and/or the www. host), or drive a tab instead.',
        };
      }
      return { ok: false, error: err?.message ?? 'fetch_failed' };
    }
  },
};
