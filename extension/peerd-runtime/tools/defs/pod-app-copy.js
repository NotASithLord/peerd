// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// pod_app_copy - copy files between a Pod and an existing App.
//
// why host-mediated: the arguments name only instances and paths. The service
// worker reads, hashes, confirms and writes the bytes, so a 10 MB .wasm costs
// the model the same as a one-line file and never enters its context.

/** @type {import('/shared/tool-types.js').Tool} */
export const podAppCopyTool = composeTool("pod_app_copy", {
  execute: async (args, ctx) => {
    if (args?.direction !== 'pod_to_app' && args?.direction !== 'app_to_pod') {
      return { ok: false, error: 'direction must be pod_to_app or app_to_pod' };
    }
    if (typeof args?.podId !== 'string' || !args.podId) return { ok: false, error: 'podId_required' };
    if (typeof args?.appId !== 'string' || !args.appId) return { ok: false, error: 'appId_required' };
    if (!Array.isArray(args?.files) || !args.files.length) return { ok: false, error: 'files_required' };
    const authority = /** @type {{ copyPodFiles?: Function } | undefined} */ (
      /** @type {any} */ (ctx).appAuthority);
    if (!authority?.copyPodFiles) return { ok: false, error: 'pod_app_copy_unavailable' };
    try {
      // why the files go unchanged: the host validates them, so it alone
      // decides that an entry holds paths and nothing else.
      const result = await authority.copyPodFiles(args.direction, args.podId, args.appId, args.files);
      if (!result?.ok) {
        return {
          ok: false,
          error: result?.declined ? 'declined: the user did not approve this copy' : String(result?.error ?? 'pod_app_copy_failed'),
        };
      }
      return {
        ok: true,
        content: JSON.stringify({
          direction: result.direction, podId: result.podId, appId: result.appId,
          files: result.files,
          ...(result.outsideFiles ? {
            note: 'This Pod now holds files from an App someone else published. Its web fetch and Git remotes are refused until the user allows them again in the Pod tab.',
          } : {}),
        }, null, 2),
      };
    } catch (error) {
      return { ok: false, error: `pod_app_copy_failed: ${/** @type {{ message?: string }} */ (error)?.message ?? String(error)}` };
    }
  },
});
