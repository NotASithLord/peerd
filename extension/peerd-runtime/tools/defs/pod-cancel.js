// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
import { wrapUntrusted } from '../prompt-wrap.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const podCancelTool = composeTool("pod_cancel", {
  execute: async (args, ctx) => {
    if (typeof args?.jobId !== 'string') return { ok: false, error: 'jobId_required' };
    const client = /** @type {any} */ (ctx).podClient;
    if (!client?.cancel) return { ok: false, error: 'pod_unavailable' };
    try {
      const result = await client.cancel(args.jobId, { sessionId: ctx.session?.sessionId, podId: args.podId });
      return { ok: true, content: wrapUntrusted({ origin: `pod:${result.podId ?? args.podId ?? 'current'}/job:${args.jobId}`, tool: 'pod_cancel', body: JSON.stringify(result, null, 2) }) };
    }
    catch (error) { return { ok: false, error: `pod_cancel_failed: ${/** @type {{message?:string}} */ (error)?.message ?? String(error)}` }; }
  },
});
