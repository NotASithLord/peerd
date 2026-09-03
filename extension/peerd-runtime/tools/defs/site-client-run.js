// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
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
import { normalizeSiteOrigin } from '../../site-clients/core.js';
import { renderCodeOpTrace } from '../../actor/capability-manifest.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;

/** @type {import('/shared/tool-types.js').Tool} */
export const siteClientRunTool = composeTool("site_client_run", {
  execute: async (args, ctx) => {
    const origin = normalizeSiteOrigin(args?.origin);
    if (!origin) return { ok: false, error: 'bad_origin: expected a public HTTP(S) site origin' };
    if (typeof args?.code !== 'string' || !args.code.trim()) return { ok: false, error: 'code_required' };
    const timeoutMs = clamp(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000, MAX_TIMEOUT_MS);
    const authority = /** @type {{runStoredClient?:(origin:string,code:string,timeoutMs:number)=>Promise<{ok:boolean,result?:any,error?:string,outcomeKind?:string}>}|undefined} */ (
      /** @type {any} */ (ctx).siteClientAuthority);
    if (!authority?.runStoredClient) return { ok: false, error: 'site_client_run_unavailable' };
    const executed = await authority.runStoredClient(origin, args.code, timeoutMs);
    // why: the sealed stored client controls thrown exception text. Keep the
    // trusted failure class and recovery path, but never promote those bytes
    // into an unfenced model-facing error.
    const storedClientFailed = typeof executed?.error === 'string'
      && executed.error.startsWith('site_client_run_failed:');
    if (executed?.ok !== true) return {
      ok: false,
      error: storedClientFailed ? 'site_client_run_failed'
        : executed?.error ?? 'site_client_run_failed',
      ...(storedClientFailed ? {
        content: 'The stored site client failed. Drive the page to verify the live behavior, then use site_client_write if the client is stale.',
      } : {}),
      ...(executed?.outcomeKind ? { outcomeKind: executed.outcomeKind } : {}),
    };
    return { ok: true, content: formatRunResult(origin, args.code, executed.result ?? {}) };
  },
});

/**
 * Format + fence a run result. The output carries the SITE's bytes (fetched via
 * the pinned capability), so it is fenced by construction — like a2a_run, never
 * bare like a pure-compute script run.
 * @param {string} origin @param {string} code
 * @param {{ value?: unknown, consoleOutput?: {level:string,text:string}[], durationMs?: number, error?: string|null, codeTrace?: Array<{seq:number,bridge:string,method:string,outcome:string,ms:number}> }} r
 */
const formatRunResult = (origin, code, r) => {
  const lines = [];
  const oneLine = code.length > 200 ? `${code.slice(0, 200)}…` : code;
  lines.push(`> ${oneLine.replace(/\n/g, '\n  ')} (site-client ${origin})`);
  lines.push(`[${r?.durationMs ?? 0}ms]`);
  if (r?.codeTrace?.length) lines.push('[CODE OPS]', ...renderCodeOpTrace(r.codeTrace));
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
