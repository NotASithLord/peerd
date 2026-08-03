// @ts-check
// js_read_file — read a file from the Notebook's OPFS scratch.
//
// The content comes back FENCED (wrapUntrusted): a Notebook file is not
// reliably agent-authored — notebook code fetches (peerd.egress.fetch) and
// persists what it fetched to OPFS, so an unfenced read is a laundering path
// for web bytes into the orchestrator's trusted context (the exact flow the
// heap split closes everywhere else). Reads stay GLOBAL for ergonomics; the
// fence is what makes that safe.

import { wrapUntrusted } from '../prompt-wrap.js';
import { pageSlice, pageStatusLine, SPILL_PAGE_CHARS } from '../web/spill.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const jsReadFileTool = {
  name: 'js_read_file',
  primitive: 'notebook',
  description: [
    'Read a file from the Notebook\'s OPFS scratch and return its',
    'contents as UTF-8 text. Use to inspect what code wrote or what',
    'was staged via js_write_file. A large file returns a bounded slice',
    'plus a paging note — re-call with offset to read on (no re-truncation).',
    'For binary files, fetch directly inside js_notebook instead.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path in OPFS scratch.' },
      notebook: { type: 'string', description: 'Optional notebook id or name.' },
      offset: { type: 'number', description: 'Start character offset. Default 0.' },
      limit: { type: 'number', description: `Max characters to return (capped at ${SPILL_PAGE_CHARS}). Default the cap.` },
    },
    required: ['path'],
  },
  sideEffect: 'read',
  origins: () => [],

  execute: async (args, ctx) => {
    if (typeof args?.path !== 'string') return { ok: false, error: 'path_required' };
    // why: jsClient rides the opaque ctx contract (not on ToolContext); narrow
    // to the one method this tool calls.
    const jsClient = /** @type {{ readFile?: (path: string, opts: { sessionId?: string, notebookId?: string }) => Promise<string> } | undefined} */ (
      /** @type {any} */ (ctx).jsClient);
    if (!jsClient?.readFile) return { ok: false, error: 'js_not_available' };
    try {
      const content = await jsClient.readFile(args.path, {
        sessionId: ctx.session?.sessionId,
        notebookId: args.notebook,
      });
      // Self-paging (the infinite-reread fix): the OPFS file IS the durable
      // backing, so a big read returns a bounded slice and the footer points
      // back at THIS tool with a new offset — no spill store, and no need for a
      // main-agent reader the notebook actor could not reach anyway (read_run_
      // cache is off the actor tier). why it matters: before this a >window file
      // came back whole, got 8k-redacted, and every re-read returned the SAME
      // truncation — a guaranteed wasted-turn loop.
      const limit = Math.min(typeof args.limit === 'number' && args.limit > 0 ? args.limit : SPILL_PAGE_CHARS, SPILL_PAGE_CHARS);
      const page = pageSlice(content, typeof args.offset === 'number' ? args.offset : 0, limit);
      // The slice is fenced (a Notebook file is not reliably agent-authored); the
      // tool-authored paging status rides OUTSIDE the fence.
      const shown = wrapUntrusted({
        origin: `notebook:${args.notebook ?? 'current'}/${args.path}`,
        tool: 'js_read_file',
        body: page.slice,
      });
      const nextArgs = args.notebook
        ? `{ "path": "${args.path}", "notebook": "${args.notebook}", "offset": ${page.end} }`
        : `{ "path": "${args.path}", "offset": ${page.end} }`;
      const footer = (page.remaining > 0 || page.offset > 0)
        ? `\n${pageStatusLine({ page, nextArgs })}`
        : '';
      // paged: the loop redacts this at PAGED_MAX_CHARS, not the 8k backstop, so
      // the requested slice survives — the whole point of the offset/limit page.
      return { ok: true, content: `${shown}${footer}`, paged: true };
    } catch (e) {
      return { ok: false, error: `read_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
  },
};
