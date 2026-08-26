// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const podDestroyTool = composeTool("pod_destroy", {
  execute: async (args, ctx) => {
    if (typeof args?.podId !== 'string') return { ok: false, error: 'podId_required' };
    const authority = /** @type {any} */ (ctx).repositoryAuthority;
    if (!authority) return { ok: false, error: 'pod_registry_unavailable' };
    const record = await authority.readPod(args.podId);
    if (!record) return { ok: false, error: 'pod_not_found' };
    if (record.pinned) return { ok: false, error: 'pod_pinned' };
    try {
      await authority.destroyPod(args.podId);
      return { ok: true, content: JSON.stringify({ destroyed: { id: args.podId, name: record.name } }, null, 2) };
    } catch (error) { return { ok: false, error: `pod_destroy_failed: ${/** @type {{message?:string}} */ (error)?.message ?? String(error)}` }; }
  },
});
