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

/** @type {import('/shared/tool-types.js').Tool} */
export const jsReadFileTool = {
  name: 'js_read_file',
  primitive: 'notebook',
  description: [
    'Read a file from the Notebook\'s OPFS scratch and return its',
    'contents as UTF-8 text. Use to inspect what code wrote or what',
    'was staged via js_write_file. For binary or huge files, fetch',
    'directly inside js_notebook instead.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path in OPFS scratch.' },
      notebook: { type: 'string', description: 'Optional notebook id or name.' },
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
      return {
        ok: true,
        content: wrapUntrusted({
          origin: `notebook:${args.notebook ?? 'current'}/${args.path}`,
          tool: 'js_read_file',
          body: content,
        }),
      };
    } catch (e) {
      return { ok: false, error: `read_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
  },
};
