// @ts-check
// call_api — always safeFetch, never tab.
//
// For known JSON/text APIs (REST, GraphQL responses, RSS, plain text).
// Returns the response body and a parsed-JSON shape when the
// content-type permits. The agent should reach for this when the
// target speaks a structured-data wire format; for HTML use read_article.

import { fetchUrl } from './primitives.js';
import { originOfUrl } from '../defs/dom-helpers.js';
import { wrapUntrusted } from '../prompt-wrap.js';
import { needsWebWriteConfirm } from '/peerd-engine/index.js';

const MAX_BODY_CHARS = 16_000;       // hard cap to avoid context-blast on huge payloads

/** @type {import('/shared/tool-types.js').Tool} */
export const callApiTool = {
  name: 'call_api',
  primitive: 'web',
  description: [
    'Call a JSON / RSS / GraphQL / plain-text HTTP API — GET or POST',
    '(headers, body); always background safeFetch, never a tab.',
    '✅ GET an API, POST a JSON webhook. ❌ an HTML page (use read_article).',
    'Returns status, final URL, body + parsed JSON (capped 16k; paginate).',
    'Does NOT follow redirects.',
  ].join(' '),
  schema: {
    type: 'object',
    required: ['url'],
    properties: {
      url: { type: 'string', description: 'Absolute URL (must include scheme).' },
      method: {
        type: 'string',
        enum: ['GET', 'POST'],
        description: 'HTTP method. Default GET.',
      },
      headers: {
        type: 'object',
        description: 'Request headers. Content-Type is set automatically for JSON bodies.',
      },
      body: {
        description: 'Request body. If an object, it is JSON-stringified and Content-Type is set.',
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

    // Anti-exfiltration gate: a request that can transmit in-context data (page
    // text, memory, etc.) to an arbitrary non-denylisted host is confirmed by
    // default. The 'web:write' key + needsWebWriteConfirm predicate are shared
    // with the WebVM bridge, so "approve all writes this session" covers both
    // and the two can't drift; the confirmWebWrites setting (honored in the SW
    // confirm impl) lets the user turn it off. GET/HEAD reads are never gated.
    // Fail closed: if there's no confirm channel, refuse the write rather than
    // send it unconfirmed (production always wires ctx.confirm).
    const method = (args.method ?? 'GET').toUpperCase();
    if (needsWebWriteConfirm(method)) {
      if (!ctx.confirm) {
        return { ok: false, error: 'declined', content: 'No confirmation channel available for an outbound write.' };
      }
      // why cast: the SW confirm coordinator accepts a richer prompt (tool /
      // summary / sessionId for the side-panel card) than the base ConfirmPrompt
      // typedef — same pattern the dispatcher uses at its confirm call site.
      const ans = await ctx.confirm(/** @type {any} */ ({
        tool: 'web:write', kind: 'web_write', origins: [parsed.origin],
        summary: `Allow a ${method} request to ${parsed.host}? This can send data out of the browser.`,
        sessionId: ctx.session?.sessionId ?? null,
      }));
      if (ans !== 'yes_once' && ans !== 'yes_session') {
        return { ok: false, error: 'declined', content: 'User declined the outbound write.' };
      }
    }

    // Auto-serialize JSON bodies. Anything that isn't a string is
    // assumed to be a JSON-compatible value.
    let body = args.body;
    const headers = { ...(args.headers ?? {}) };
    if (body !== undefined && typeof body !== 'string') {
      body = JSON.stringify(body);
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/json';
      }
    }

    try {
      const res = await fetchUrl(args.url, {
        method: args.method ?? 'GET',
        headers,
        body,
      }, ctx);
      const truncated = res.body.length > MAX_BODY_CHARS;
      const text = truncated ? res.body.slice(0, MAX_BODY_CHARS) : res.body;
      // Try to parse JSON when the content-type suggests it. We don't
      // fail on parse error — the agent often wants the raw body
      // either way.
      let parsedJson = null;
      const ct = res.headers['content-type'] ?? '';
      if (/(json|graphql)/i.test(ct)) {
        try { parsedJson = JSON.parse(text); }
        catch { parsedJson = null; }
      }
      // why: the response body is attacker-influenced content fetched
      // from the open web — fence it as data, not instructions, exactly
      // like read_page. call_api is a main-agent tool (not runner-only),
      // so this is the only delimiter between a hostile API response and
      // the privileged context. Closing-tag break-out hardening lives in
      // prompt-wrap.js (neutralizeFence).
      return {
        ok: true,
        content: wrapUntrusted({
          origin: originOfUrl(res.finalUrl || args.url),
          tool: 'call_api',
          body: JSON.stringify({
            status:   res.status,
            finalUrl: res.finalUrl,
            contentType: ct || null,
            truncated,
            body: text,
            json: parsedJson,
          }, null, 2),
        }),
      };
    } catch (e) {
      // call_api never follows redirects (webFetch fails closed on 3xx for
      // SSRF safety). The common benign cases are http→https and apex↔www
      // canonicalization, so give the model a concrete recovery path
      // instead of an opaque egress error.
      const err = /** @type {{ reason?: string, message?: string }} */ (e);
      if (err?.reason === 'redirect_blocked') {
        return {
          ok: false,
          error: `redirected: ${args.url} issued an HTTP redirect, which call_api does not follow. `
            + 'Retry with the final URL (try https:// and/or the www. host), or use read_article to load it in a tab.',
        };
      }
      return { ok: false, error: err?.message ?? 'fetch_failed' };
    }
  },
};
