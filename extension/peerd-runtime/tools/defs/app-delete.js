// @ts-check
// app_delete — destroy an App.
//
// Closes the tab (if open), drops the IDB body, removes the metadata
// record. Irreversible. Use after confirming with the user.

/** @type {import('/shared/tool-types.js').Tool} */
export const appDeleteTool = {
  name: 'app_delete',
  primitive: 'app',
  description: [
    'Delete an App: closes its tab, drops the IDB body, removes the',
    'catalog entry. Irreversible. Use only after confirming with the',
    'user — there is no undo once the body is gone.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      appId: { type: 'string', description: 'App id to delete.' },
    },
    required: ['appId'],
  },
  sideEffect: 'destructive',
  origins: () => [],

  execute: async (args, ctx) => {
    if (typeof args?.appId !== 'string') return { ok: false, error: 'appId_required' };
    // why: appClient / appRegistry ride the opaque ctx contract (not on
    // ToolContext); narrow to the surface this tool touches.
    const appClient = /** @type {{ delete?: (appId: string) => Promise<unknown> } | undefined} */ (
      /** @type {any} */ (ctx).appClient);
    const appRegistry = /** @type {{ get: (appId: string) => Promise<{ name: string } | null | undefined> } | undefined} */ (
      /** @type {any} */ (ctx).appRegistry);
    if (!appClient?.delete) return { ok: false, error: 'app_not_available' };
    const rec = await appRegistry?.get(args.appId);
    if (!rec) return { ok: false, error: 'app_not_found' };
    try {
      await appClient.delete(args.appId);
      return {
        ok: true,
        content: JSON.stringify({ deleted: { id: args.appId, name: rec.name } }, null, 2),
      };
    } catch (e) {
      return { ok: false, error: `app_delete_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
  },
};
