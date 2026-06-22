// @ts-check
// js_write_file — write a string to the Notebook's OPFS scratch.

const MAX_CONTENT_CHARS = 500_000;

/** @type {import('/shared/tool-types.js').Tool} */
export const jsWriteFileTool = {
  name: 'js_write_file',
  primitive: 'notebook',
  description: [
    'Write `content` (a UTF-8 string) to `path` in the Notebook\'s OPFS',
    'scratch. Paths are relative to the Notebook\'s OPFS root; nested',
    'directories are created as needed. Use this to stage data for an',
    'upcoming js_notebook (e.g. a CSV, a JSON blob, source code to import).',
    'Cap: 500000 characters. The Notebook can read these via peerd.self.readFile.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path in OPFS scratch (e.g. data/in.json).' },
      content: { type: 'string', description: 'File contents as UTF-8 text.' },
      notebook: { type: 'string', description: 'Optional notebook id or name (default: current).' },
    },
    required: ['path', 'content'],
  },
  sideEffect: 'write',
  origins: () => [],

  execute: async (args, ctx) => {
    if (typeof args?.path !== 'string' || args.path.length === 0) {
      return { ok: false, error: 'path_required' };
    }
    if (typeof args?.content !== 'string') {
      return { ok: false, error: 'content_required' };
    }
    if (args.content.length > MAX_CONTENT_CHARS) {
      return { ok: false, error: `content_too_large: ${args.content.length} > ${MAX_CONTENT_CHARS}` };
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
};
