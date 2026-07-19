// @ts-check
// site_client_run — execute a stored SITE CLIENT (DESIGN-19) against its origin.
//
// The persisted client MODULE (JS derived from observed traffic) runs in the SAME
// sealed keyless worker as `script`/`a2a_run`, with EXACTLY ONE capability: a
// `site` client whose fetch is PINNED to the client's origin (site.fetch(path) →
// the SW site-fetch/call route → the actor's session-scoped, denylisted, audited
// webFetch). Everything else — cross-origin fetch, raw egress, OPFS, subagents,
// the page bridge — is denied at the host relay AND absent in-realm. So a stale or
// even hostile client's worst case is a wrong result or a bad request to the
// origin that was already the counterparty: the live actor's existing worst case.
//
// Web-actor-only (exposure.js ACTOR_TYPE_TOOLS.web). The client is UNRELIABLE by
// contract — its output re-enters fenced; on failure the actor falls back to
// driving the page and proposes a patched client (site_client_write).

import { clamp } from '/shared/util.js';
import { pushValueBlock } from './value-block.js';
import { wrapUntrusted } from '../prompt-wrap.js';
import { normalizeSiteOrigin } from '../../site-clients/index.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;

/** @type {import('/shared/tool-types.js').Tool} */
export const siteClientRunTool = {
  name: 'site_client_run',
  primitive: 'web',
  description: [
    'Run the stored SITE CLIENT for an origin — derived knowledge of that site\'s API,',
    'far cheaper than re-driving the DOM. Write JS against the injected `site` client:',
    'the loaded client module\'s ops are available as `client` (the object its body',
    'RETURNS — call e.g. `await client.listCharges()`), and',
    'site.fetch(path, { method, headers, body }) makes ONE request PINNED to the',
    'origin (it carries your session same-origin, exactly like fetch_url — never pass',
    'credentials). Cross-origin fetches are refused. TREAT THE CLIENT AS A CACHE: it',
    'may be stale or wrong. If a call fails or returns something off, DRIVE THE PAGE',
    'instead (ground truth) and propose a fix with site_client_write. Returns the',
    'run value + console, fenced (the bytes are the site\'s).',
  ].join(' '),
  schema: {
    type: 'object',
    required: ['origin', 'code'],
    properties: {
      origin: { type: 'string', description: 'The site origin whose client to load (e.g. https://api.example.com).' },
      code: { type: 'string', description: 'JS to run; drives `client` (the loaded module) and `site.fetch`, returns the outcome. Async body: top-level await + return.' },
      timeoutMs: { type: 'number', description: `Wall-clock cap (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).` },
    },
  },
  // The non-GET write inside a run is gated at the SW site-fetch/call route via
  // the shared web:write confirm — same as fetch_url. The tool itself is a read.
  sideEffect: 'read',
  origins: (args) => {
    const o = normalizeSiteOrigin(args?.origin);
    return o ? [o] : [];
  },
  execute: async (args, ctx) => {
    const origin = normalizeSiteOrigin(args?.origin);
    if (!origin) return { ok: false, error: `bad_origin: ${args?.origin}` };
    if (typeof args?.code !== 'string' || !args.code.trim()) return { ok: false, error: 'code_required' };
    const store = /** @type {import('../../site-clients/store.js').SiteClientStore | undefined} */ (
      /** @type {any} */ (ctx).siteClients);
    if (!store) return { ok: false, error: 'site_clients_unavailable' };
    const jsOffscreenClient = /** @type {{ execHeadless?: (code: string, opts: object) => Promise<any> } | undefined} */ (
      /** @type {any} */ (ctx).jsOffscreenClient);
    if (!jsOffscreenClient?.execHeadless) return { ok: false, error: 'site_client_run_unavailable' };
    const ownerSessionId = ctx.session?.sessionId;
    if (!ownerSessionId) return { ok: false, error: 'no_owner_session' };

    const record = await store.get(origin).catch(() => null);
    if (!record) {
      return { ok: false, error: `no_site_client: none stored for ${origin} — derive one first (site_capture + site_client_write), or just drive the page.` };
    }

    // Prepend the client module as a leading declaration the run body can use as
    // `client`. The module body is UNTRUSTED-PROVENANCE, but it only ever executes
    // behind the pinned-origin capability — never enters model context here.
    const wrapped = `const client = await (async () => {\n${record.body}\n})();\n${args.code}`;
    const timeoutMs = clamp(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000, MAX_TIMEOUT_MS);
    let result;
    try {
      result = await jsOffscreenClient.execHeadless(wrapped, { timeoutMs, siteFetch: origin, ownerSessionId });
    } catch (e) {
      const err = /** @type {{ name?: string, message?: string }} */ (e);
      await store.recordRun(origin, { ok: false }).catch(() => {});
      return { ok: false, error: `site_client_run_failed: ${err?.name ?? 'Error'}: ${err?.message ?? String(e)}` };
    }
    // A run that threw INSIDE the sealed worker (result.error) is a client failure
    // → accrue it against staleness; a clean run bumps verification.
    const ranOk = !result?.error;
    await store.recordRun(origin, { ok: ranOk }).catch(() => {});
    return { ok: true, content: formatRunResult(origin, args.code, result) };
  },
};

/**
 * Format + fence a run result. The output carries the SITE's bytes (fetched via
 * the pinned capability), so it is fenced by construction — like a2a_run, never
 * bare like a pure-compute script run.
 * @param {string} origin @param {string} code
 * @param {{ value?: unknown, consoleOutput?: {level:string,text:string}[], durationMs?: number, error?: string|null }} r
 */
const formatRunResult = (origin, code, r) => {
  const lines = [];
  const oneLine = code.length > 200 ? `${code.slice(0, 200)}…` : code;
  lines.push(`> ${oneLine.replace(/\n/g, '\n  ')} (site-client ${origin})`);
  lines.push(`[${r?.durationMs ?? 0}ms]`);
  const body = [];
  if (r?.error) body.push('[ERROR]', r.error, '(the client may be stale — drive the page to verify, then site_client_write a fix)');
  if (r?.consoleOutput?.length) {
    body.push('[CONSOLE]');
    for (const { level, text } of r.consoleOutput) body.push(`  ${level === 'info' ? '' : `[${level}] `}${text}`);
  }
  pushValueBlock(body, r?.value);
  lines.push(wrapUntrusted({ origin: `site-client(${origin})`, tool: 'site_client_run', body: body.join('\n') }));
  return lines.join('\n');
};
