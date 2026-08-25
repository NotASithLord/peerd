// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// js_write_file — write a string to the Notebook's OPFS scratch.

// Exported: the ONE per-file write ceiling for agent-authored OPFS content.
// The workspace relay (offscreen/job-runner.js, via /peerd-runtime/index.js)
// enforces the same number on worker-side writes, so `script` can't dodge the
// tool-side cap by writing from inside the sealed worker. Mirrored by
// peerd-runtime/toolbox/core.js MAX_TOOLBOX_BODY_CHARS (a toolbox module is the
// same order of agent-written source) — move them together.
export const MAX_FILE_CONTENT_CHARS = 500_000;

/** @type {import('/shared/tool-types.js').Tool} */
export const jsWriteFileTool = composeTool("js_write_file", {

  execute: async (args, ctx) => {
    if (typeof args?.path !== 'string' || args.path.length === 0) {
      return { ok: false, error: 'path_required' };
    }
    if (typeof args?.content !== 'string') {
      return { ok: false, error: 'content_required' };
    }
    if (args.content.length > MAX_FILE_CONTENT_CHARS) {
      return { ok: false, error: `content_too_large: ${args.content.length} > ${MAX_FILE_CONTENT_CHARS}` };
    }
    // why: jsClient rides the opaque ctx contract (not on ToolContext); narrow
    // to the one method this tool calls.
    const jsClient = /** @type {{ writeFile?: (path: string, content: string, opts: { sessionId?: string, notebookId?: string }) => Promise<unknown> } | undefined} */ (
      /** @type {any} */ (ctx).jsClient);
    if (!jsClient?.writeFile) return { ok: false, error: 'js_not_available' };
    try {
      await jsClient.writeFile(args.path, args.content, {
        sessionId: ctx.session?.sessionId,
        notebookId: args.notebook,
      });
    } catch (e) {
      return { ok: false, error: `write_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
    return {
      ok: true,
      content: JSON.stringify({ path: args.path, bytes: args.content.length }, null, 2),
    };
  },
});
