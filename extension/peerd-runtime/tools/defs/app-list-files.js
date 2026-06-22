// @ts-check
// app_list_files — enumerate files inside an App's OPFS subtree.

import { serializeListResult } from './columnar.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const appListFilesTool = {
  name: 'app_list_files',
  primitive: 'app',
  description: [
    'List every file in an App\'s OPFS subtree. Returns [{path, size}].',
    'Without `appId`, targets the chat\'s current app.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: { appId: { type: 'string' } },
  },
  sideEffect: 'read',
  origins: () => [],

  execute: async (args, ctx) => {
    // why: appClient rides the opaque ctx contract (not on ToolContext); narrow
    // to the one method this tool calls.
    const appClient = /** @type {{ listFiles?: (opts: { appId?: string, sessionId?: string }) => Promise<Array<{ path: string, size: number }>> } | undefined} */ (
      /** @type {any} */ (ctx).appClient);
    if (!appClient?.listFiles) return { ok: false, error: 'app_not_available' };
    try {
      const files = await appClient.listFiles({
        appId: args.appId,
        sessionId: ctx.session?.sessionId,
      });
      return {
        ok: true,
        content: serializeListResult({ count: files.length, files }, 'files'),
      };
    } catch (e) {
      return { ok: false, error: `app_list_files_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
  },
};
