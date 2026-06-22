// @ts-check
// js_delete — destroy a Notebook.
//
// Closes the tab and removes the registry entry. The OPFS scratch
// directory under `/peerd-notebooks/<id>/` is left in place; cleaning
// it requires an OPFS operation that needs a fresh worker. V1 accepts
// the small leak — files are tiny and the user can drop the whole
// extension's OPFS via DevTools if it ever matters.

/** @type {import('/shared/tool-types.js').Tool} */
export const jsDeleteTool = {
  name: 'js_delete',
  primitive: 'notebook',
  description: [
    'Delete a Notebook: closes its tab and removes the catalog entry.',
    'Any chat with this as its current Notebook loses that pointer (their',
    'next js_notebook auto-creates a fresh Notebook). Use after confirming',
    'with the user — there is no recovery once destroyed.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      notebookId: { type: 'string', description: 'Notebook id to delete.' },
    },
    required: ['notebookId'],
  },
  sideEffect: 'destructive',
  origins: () => [],

  execute: async (args, ctx) => {
    // why: jsRegistry / jsTabTracker ride the opaque ctx contract (not on the
    // ToolContext typedef); narrow to the surface this tool touches.
    const jsRegistry = /** @type {{ get: (id: string) => Promise<{ name: string, pinned: boolean } | null | undefined>, delete: (id: string) => Promise<unknown> } | undefined} */ (
      /** @type {any} */ (ctx).jsRegistry);
    const jsTabTracker = /** @type {{ closeTab: (id: string) => Promise<unknown> } | undefined} */ (
      /** @type {any} */ (ctx).jsTabTracker);
    if (!jsRegistry || !jsTabTracker) {
      return { ok: false, error: 'js_registry_unavailable' };
    }
    if (typeof args?.notebookId !== 'string') return { ok: false, error: 'notebookId_required' };
    const rec = await jsRegistry.get(args.notebookId);
    if (!rec) return { ok: false, error: 'notebook_not_found' };
    if (rec.pinned) return { ok: false, error: 'notebook_pinned' };
    await jsTabTracker.closeTab(args.notebookId);
    await jsRegistry.delete(args.notebookId);
    return {
      ok: true,
      content: JSON.stringify({ deleted: { id: args.notebookId, name: rec.name } }, null, 2),
    };
  },
};
