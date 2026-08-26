// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// js_delete — destroy a Notebook.
//
// Closes the tab, removes the registry entry, and drops both the OPFS working
// tree and its sibling Git object store.

/** @type {import('/shared/tool-types.js').Tool} */
export const jsDeleteTool = composeTool("js_delete", {

  execute: async (args, ctx) => {
    const authority = /** @type {{ readNotebook?: (id:string)=>Promise<{name:string,pinned:boolean}|null|undefined>, destroyNotebook?: (id:string)=>Promise<unknown> }} */ (
      /** @type {any} */ (ctx).notebookAuthority);
    if (!authority?.readNotebook || !authority.destroyNotebook) {
      return { ok: false, error: 'js_registry_unavailable' };
    }
    if (typeof args?.notebookId !== 'string') return { ok: false, error: 'notebookId_required' };
    const rec = await authority.readNotebook(args.notebookId);
    if (!rec) return { ok: false, error: 'notebook_not_found' };
    if (rec.pinned) return { ok: false, error: 'notebook_pinned' };
    try {
      await authority.destroyNotebook(args.notebookId);
    } catch (error) {
      return { ok: false, error: `notebook_delete_failed: ${/** @type {{message?:string}} */ (error)?.message ?? String(error)}` };
    }
    return {
      ok: true,
      content: JSON.stringify({ deleted: { id: args.notebookId, name: rec.name } }, null, 2),
    };
  },
});
