// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// js_read_file — read a file from the Notebook's OPFS scratch.
//
// The content comes back FENCED (wrapUntrusted): a Notebook file is not
// reliably agent-authored — notebook code fetches (peerd.egress.fetch) and
// persists what it fetched to OPFS, so an unfenced read is a laundering path
// for web bytes into the orchestrator's trusted context (the exact flow the
// heap split closes everywhere else). Reads stay GLOBAL for ergonomics; the
// fence is what makes that safe.

import { wrapUntrusted } from '../prompt-wrap.js';
import { buildPagedResult, clampPageLimit, pageStatusLine } from '../web/spill.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const jsReadFileTool = composeTool("js_read_file", {

  execute: async (args, ctx) => {
    if (typeof args?.path !== 'string') return { ok: false, error: 'path_required' };
    const authority = /** @type {{ readFile?: (path:string,notebookId?:string)=>Promise<string> }} */ (
      /** @type {any} */ (ctx).notebookAuthority);
    if (!authority?.readFile) return { ok: false, error: 'js_not_available' };
    try {
      const content = await authority.readFile(args.path, args.notebook);
      // Self-paging (the infinite-reread fix): the OPFS file IS the durable
      // backing, so a big read returns a bounded slice and the footer points
      // back at THIS tool with a new offset — no spill store, and no need for a
      // main-agent reader the notebook actor could not reach anyway (read_run_
      // cache is off the actor tier). why it matters: before this a >window file
      // came back whole, got 8k-redacted, and every re-read returned the SAME
      // truncation — a guaranteed wasted-turn loop. buildPagedResult flags
      // `paged` (redacted at the larger paged ceiling) and fits the framed slice
      // under it so the requested page is never re-cut.
      return buildPagedResult({
        text: content,
        offset: typeof args.offset === 'number' ? args.offset : 0,
        limit: clampPageLimit(args.limit),
        // The slice is fenced (a Notebook file is not reliably agent-authored);
        // the tool-authored paging status rides OUTSIDE the fence. nextArgs is
        // JSON.stringify'd so a path with a quote/backslash stays valid.
        frame: (page) => {
          const shown = wrapUntrusted({
            origin: `notebook:${args.notebook ?? 'current'}/${args.path}`,
            tool: 'js_read_file',
            body: page.slice,
          });
          const nextArgs = JSON.stringify({
            path: args.path,
            ...(args.notebook ? { notebook: args.notebook } : {}),
            offset: page.end,
          });
          const footer = (page.remaining > 0 || page.offset > 0)
            ? `\n${pageStatusLine({ page, nextArgs })}`
            : '';
          return `${shown}${footer}`;
        },
      });
    } catch (e) {
      return { ok: false, error: `read_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
  },
});
