// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// toolbox_list — the toolbox dossier view (design js-superpower/06). Metas
// only: names, exports, sizes, run/fail counts (the rot signal). The free-prose
// descriptions are model-authored and possibly influence-laundered, so the
// renderer fences them (renderToolboxList — trust contract rule 2). No tool
// reads a module BODY into context — bodies are execute-only.

import { renderToolboxList } from '../../toolbox/core.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const toolboxListTool = composeTool("toolbox_list", {

  execute: async (_args, ctx) => {
    // why: toolbox rides the opaque ctx contract (not on ToolContext).
    const store = /** @type {import('../../toolbox/store.js').ToolboxStore | undefined} */ (
      /** @type {any} */ (ctx).toolbox);
    if (!store) return { ok: false, error: 'toolbox_unavailable' };
    try {
      const metas = await store.listMeta();
      metas.sort((a, b) => a.name.localeCompare(b.name));
      return { ok: true, content: renderToolboxList(metas) };
    } catch (e) {
      return { ok: false, error: `toolbox_list_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
  },
});
