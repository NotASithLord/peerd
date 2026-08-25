// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const podDestroyTool = composeTool("pod_destroy", {
  execute: async (args, ctx) => {
    if (typeof args?.podId !== 'string') return { ok: false, error: 'podId_required' };
    const registry = /** @type {any} */ (ctx).podRegistry;
    const tracker = /** @type {any} */ (ctx).podTabTracker;
    const repositories = /** @type {any} */ (ctx).repositories;
    if (!registry || !tracker || !repositories) return { ok: false, error: 'pod_registry_unavailable' };
    const record = await registry.get(args.podId);
    if (!record) return { ok: false, error: 'pod_not_found' };
    if (record.pinned) return { ok: false, error: 'pod_pinned' };
    try {
      await repositories.coordinate({ kind: 'pod', id: args.podId }, async () => {
        await tracker.closeTab(args.podId);
        await repositories.destroy({ kind: 'pod', id: args.podId }, { worktree: true });
        await registry.delete(args.podId);
      });
      return { ok: true, content: JSON.stringify({ destroyed: { id: args.podId, name: record.name } }, null, 2) };
    } catch (error) { return { ok: false, error: `pod_destroy_failed: ${/** @type {{message?:string}} */ (error)?.message ?? String(error)}` }; }
  },
});
