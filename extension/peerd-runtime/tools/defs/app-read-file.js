// @ts-check
// app_read_file — read a single file from an App's OPFS subtree.

/** @type {import('/shared/tool-types.js').Tool} */
export const appReadFileTool = {
  name: 'app_read_file',
  primitive: 'app',
  description: [
    'Read a single file from an App\'s OPFS subtree. Returns UTF-8 text.',
    'Use to inspect current content before patching. Without `appId`,',
    'targets the chat\'s current app.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      appId: { type: 'string' },
      path: { type: 'string' },
    },
    required: ['path'],
  },
  sideEffect: 'read',
  origins: () => [],

  execute: async (args, ctx) => {
    if (typeof args?.path !== 'string') return { ok: false, error: 'path_required' };
    // why: appClient rides the opaque ctx contract (not on ToolContext); narrow
    // to the one method this tool calls.
    const appClient = /** @type {{ readFile?: (opts: { appId?: string, path: string, sessionId?: string }) => Promise<string> } | undefined} */ (
      /** @type {any} */ (ctx).appClient);
    if (!appClient?.readFile) return { ok: false, error: 'app_not_available' };
    try {
      const content = await appClient.readFile({
        appId: args.appId,
        path: args.path,
        sessionId: ctx.session?.sessionId,
      });
      return { ok: true, content };
    } catch (e) {
      return { ok: false, error: `app_read_file_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
  },
};
