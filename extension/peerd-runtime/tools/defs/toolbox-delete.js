// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// toolbox_delete — remove a stored toolbox module (design js-superpower/06).
// Reversibility is the point: every stored module is deletable, and a deleted
// name stops resolving on the next run. No bespoke confirm (removing stored
// code narrows what can execute — the dangerous direction is the WRITE); the
// standard Plan/Act confirm policy still applies via sideEffect 'destructive'.

/** @type {import('/shared/tool-types.js').Tool} */
export const toolboxDeleteTool = composeTool("toolbox_delete", {

  execute: async (args, ctx) => {
    const name = typeof args?.name === 'string' ? args.name.trim() : '';
    if (!name) return { ok: false, error: 'name_required' };
    // why: toolbox rides the opaque ctx contract (not on ToolContext).
    const store = /** @type {import('../../toolbox/store.js').ToolboxStore | undefined} */ (
      /** @type {any} */ (ctx).toolbox);
    if (!store) return { ok: false, error: 'toolbox_unavailable' };
    try {
      const meta = await store.getMeta(name);
      if (!meta) return { ok: false, error: `toolbox_module_not_found: ${name}` };
      await store.remove(name);
      return { ok: true, content: `deleted toolbox module '${name}'` };
    } catch (e) {
      return { ok: false, error: `toolbox_delete_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
  },
});
