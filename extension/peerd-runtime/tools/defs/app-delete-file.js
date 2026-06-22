// @ts-check
// app_delete_file — delete a single file from an App's OPFS subtree.
//
// Refuses to delete the entry file (would brick the app).

/** @type {import('/shared/tool-types.js').Tool} */
export const appDeleteFileTool = {
  name: 'app_delete_file',
  primitive: 'app',
  description: [
    'Delete a single file from an App\'s OPFS subtree. Cannot delete',
    'the entry file (app_update or change entryFile first if you need',
    'to). The composed view auto-reloads.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      appId: { type: 'string' },
      path: { type: 'string' },
    },
    required: ['path'],
  },
  sideEffect: 'destructive',
  origins: () => [],

  execute: async (args, ctx) => {
    if (typeof args?.path !== 'string') return { ok: false, error: 'path_required' };
    // why: appClient rides the opaque ctx contract (not on ToolContext); narrow
    // to the one method this tool calls.
    const appClient = /** @type {{ deleteFile?: (opts: { appId?: string, path: string, sessionId?: string }) => Promise<unknown> } | undefined} */ (
      /** @type {any} */ (ctx).appClient);
    if (!appClient?.deleteFile) return { ok: false, error: 'app_not_available' };
    try {
      await appClient.deleteFile({
        appId: args.appId,
        path: args.path,
        sessionId: ctx.session?.sessionId,
      });
      return { ok: true, content: JSON.stringify({ deleted: args.path }, null, 2) };
    } catch (e) {
      return { ok: false, error: `app_delete_file_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
  },
};
