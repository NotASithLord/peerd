// @ts-check
import { wrapUntrusted } from '../prompt-wrap.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const podCancelTool = {
  name: 'pod_cancel', primitive: 'pod',
  description: 'Cancel one running Pod job by id. Cancellation terminates only that job Worker.',
  schema: { type: 'object', properties: { jobId: { type: 'string' }, podId: { type: 'string' } }, required: ['jobId'] },
  sideEffect: 'write', origins: () => [],
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
};
