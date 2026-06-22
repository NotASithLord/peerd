// @ts-check
// app_write_file — write a single file inside an App's OPFS subtree.

const MAX_CONTENT_CHARS = 500_000;

/** @type {import('/shared/tool-types.js').Tool} */
export const appWriteFileTool = {
  name: 'app_write_file',
  primitive: 'app',
  description: [
    'Write a single file inside an App\'s OPFS subtree. Use for any',
    'file that isn\'t the entry HTML -- style.css, script.js,',
    'data.json, lib/utils.js, etc. The composed view auto-reloads.',
    '',
    'For the entry file, app_update with `html` is the convenience.',
    'Without `appId`, targets the chat\'s current app.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      appId: { type: 'string', description: 'App id (default: current).' },
      path: { type: 'string', description: 'Relative path within the app, e.g. style.css.' },
      content: { type: 'string', description: 'File contents as UTF-8 text.' },
    },
    required: ['path', 'content'],
  },
  sideEffect: 'write',
  origins: () => [],

  execute: async (args, ctx) => {
    if (typeof args?.path !== 'string' || !args.path) {
      return { ok: false, error: 'path_required' };
    }
    if (typeof args?.content !== 'string') {
      return { ok: false, error: 'content_required' };
    }
    if (args.content.length > MAX_CONTENT_CHARS) {
      return { ok: false, error: `content_too_large: ${args.content.length} > ${MAX_CONTENT_CHARS}` };
    }
    // why: appClient rides the opaque ctx contract (not on ToolContext); narrow
    // to the one method this tool calls.
    const appClient = /** @type {{ writeFile?: (opts: { appId?: string, path: string, content: string, sessionId?: string }) => Promise<unknown> } | undefined} */ (
      /** @type {any} */ (ctx).appClient);
    if (!appClient?.writeFile) return { ok: false, error: 'app_not_available' };
    try {
      await appClient.writeFile({
        appId: args.appId,
        path: args.path,
        content: args.content,
        sessionId: ctx.session?.sessionId,
      });
      return {
        ok: true,
        content: JSON.stringify({ path: args.path, bytes: args.content.length }, null, 2),
      };
    } catch (e) {
      return { ok: false, error: `app_write_file_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
  },
};
