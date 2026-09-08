// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
import { wrapUntrusted } from '../prompt-wrap.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const podStatusTool = composeTool("pod_status", {
  execute: async (args, ctx) => {
    const client = /** @type {any} */ (ctx).podClient;
    if (!client?.status) return { ok: false, error: 'pod_unavailable' };
    try {
      const result = await client.status({
        sessionId: ctx.session?.sessionId, podId: args?.podId, jobId: args?.jobId,
        stream: args?.stream, offset: args?.offset, limit: args?.limit,
      });
      return { ok: true, content: wrapUntrusted({ origin: `pod:${result.podId}/status`, tool: 'pod_status', body: JSON.stringify(result, null, 2) }) };
    }
    catch (error) { return { ok: false, error: `pod_status_failed: ${/** @type {{message?:string}} */ (error)?.message ?? String(error)}` }; }
  },
});
