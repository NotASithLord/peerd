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
import { siteClientOriginRefusal } from './site-client-origin.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;

/** @type {import('/shared/tool-types.js').Tool} */
export const siteClientRunTool = composeTool("site_client_run", {
  execute: async (args, ctx) => {
    const origin = normalizeSiteOrigin(args?.origin);
    if (!origin) return { ok: false, error: 'bad_origin: expected a public HTTP(S) site origin' };
    const refusal = await siteClientOriginRefusal(origin, ctx);
    if (refusal) return refusal;
    if (typeof args?.code !== 'string' || !args.code.trim()) return { ok: false, error: 'code_required' };
    const store = /** @type {import('../../site-clients/store.js').SiteClientStore | undefined} */ (
      /** @type {any} */ (ctx).siteClients);
    if (!store) return { ok: false, error: 'site_clients_unavailable' };
    const jsOffscreenClient = /** @type {{ execHeadless?: (code: string, opts: object) => Promise<any>, abortHeadless?: (runId: string, owner?: string) => Promise<void> } | undefined} */ (
      /** @type {any} */ (ctx).jsOffscreenClient);
    if (!jsOffscreenClient?.execHeadless) return { ok: false, error: 'site_client_run_unavailable' };
    const ownerSessionId = ctx.session?.sessionId;
    if (!ownerSessionId) return { ok: false, error: 'no_owner_session' };
    const extras = /** @type {{ scriptRuns?: { mintRunId: (owner: string) => string, register: (runId: string, signal: any, owner: string, caps: Record<string, boolean>) => void, release: (runId: string) => void }, abortSignal?: any }} */ (/** @type {any} */ (ctx));
    if (!extras.scriptRuns) return { ok: false, error: 'site_client_run_registry_unavailable' };
    if (extras.abortSignal?.aborted) return { ok: false, error: 'site_client_run_aborted: the turn was stopped before the run started' };

    const record = await store.get(origin).catch(() => null);
    // IDB yielded after the first check. Stored executable bytes may enter the
    // worker only if live custody still holds now.
    const postReadRefusal = await siteClientOriginRefusal(origin, ctx);
    if (postReadRefusal) return postReadRefusal;
    if (!record) {
      return { ok: false, error: `no_site_client: none stored for ${origin} — derive one first (site_capture + site_client_write), or just drive the page.` };
    }
    if (extras.abortSignal?.aborted) return { ok: false, error: 'site_client_run_aborted: the turn stopped while loading the client' };

    // Prepend the client module as a leading declaration the run body can use as
    // `client`. The module body is UNTRUSTED-PROVENANCE, but it only ever executes
    // behind the pinned-origin capability — never enters model context here.
    const wrapped = `const client = await (async () => {\n${record.body}\n})();\n${args.code}`;
    const timeoutMs = clamp(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000, MAX_TIMEOUT_MS);
    const runId = extras.scriptRuns.mintRunId(ownerSessionId);
    extras.scriptRuns.register(runId, extras.abortSignal, ownerSessionId, { site: true });
    /** @type {(() => void) | undefined} */
    let onAbort;
    if (extras.abortSignal && jsOffscreenClient.abortHeadless) {
      onAbort = () => { jsOffscreenClient.abortHeadless?.(runId, ownerSessionId); };
      if (extras.abortSignal.aborted) onAbort();
      else extras.abortSignal.addEventListener('abort', onAbort, { once: true });
    }
    let result;
    try {
      result = await jsOffscreenClient.execHeadless(wrapped, {
        timeoutMs, siteFetch: origin, ownerSessionId, runId,
        signal: extras.abortSignal,
      });
    } catch (e) {
      const err = /** @type {{ name?: string, message?: string }} */ (e);
      const postRunRefusal = await siteClientOriginRefusal(origin, ctx);
      if (postRunRefusal) return postRunRefusal;
      // Stop is a lifecycle outcome, not evidence that the persisted client is
      // stale. Only an actual client/policy/network failure accrues against it.
      if (!extras.abortSignal?.aborted) {
        await store.recordRun(origin, { ok: false }).catch(() => {});
        // recordRun is an IDB boundary. The tab may retask while it settles;
        // do not release even error bytes from the former origin afterward.
        const postRecordRefusal = await siteClientOriginRefusal(origin, ctx);
        if (postRecordRefusal) return postRecordRefusal;
      }
      return extras.abortSignal?.aborted
        ? { ok: false, error: 'site_client_run_aborted: the turn was stopped during the run' }
        : { ok: false, error: `site_client_run_failed: ${err?.name ?? 'Error'}: ${err?.message ?? String(e)}` };
    } finally {
      extras.scriptRuns.release(runId);
      if (onAbort && extras.abortSignal) {
        try { extras.abortSignal.removeEventListener?.('abort', onAbort); } catch { /* stub */ }
      }
    }
    // A long worker run can outlive the tab landing that authorized it. Its
    // only outward capability is rechecked at the relay; this final check keeps
    // its result and staleness mutation behind the same live custody wall.
    const postRunRefusal = await siteClientOriginRefusal(origin, ctx);
    if (postRunRefusal) return postRunRefusal;
    // A run that threw INSIDE the sealed worker (result.error) is a client failure
    // → accrue it against staleness; a clean run bumps verification. EXCEPTION: a
    // user-DECLINED non-GET write is not evidence the client is stale, so it does
    // not touch the staleness counters (the run still surfaces the decline).
    const declined = typeof result?.error === 'string' && /declined/i.test(result.error);
    const cancelled = extras.abortSignal?.aborted === true;
    if (!declined && !cancelled) {
      await store.recordRun(origin, { ok: !result?.error }).catch(() => {});
      // The bookkeeping write yields after the post-worker check. Recheck once
      // more so neither a value nor an error crosses a newly lost custody wall.
      const postRecordRefusal = await siteClientOriginRefusal(origin, ctx);
      if (postRecordRefusal) return postRecordRefusal;
    }
    if (cancelled) return { ok: false, error: 'site_client_run_aborted: the turn was stopped during the run' };
    return { ok: true, content: formatRunResult(origin, args.code, result) };
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
