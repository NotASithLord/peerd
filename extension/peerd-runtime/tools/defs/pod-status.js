// @ts-check
import { wrapUntrusted } from '../prompt-wrap.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const podStatusTool = {
  name: 'pod_status', primitive: 'pod',
  description: 'Inspect this Pod without creating or starting one. The default job table is metadata-only. Pass jobId plus stream to page retained stdout/stderr.',
  schema: { type: 'object', properties: {
    podId: { type: 'string' },
    jobId: { type: 'string' },
    stream: { type: 'string', enum: ['stdout', 'stderr'] },
    offset: { type: 'integer', description: 'Character offset for the selected stream.' },
    limit: { type: 'integer', description: 'Characters to return, capped at 16000.' },
  } },
  sideEffect: 'read', origins: () => [],
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
};
