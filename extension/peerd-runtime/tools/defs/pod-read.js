// @ts-check
import { wrapUntrusted } from '../prompt-wrap.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const podReadTool = {
  name: 'pod_read', primitive: 'pod',
  description: 'Read one UTF-8 file from this Pod workspace. Command-written network bytes are fenced as untrusted data.',
  schema: { type: 'object', properties: { path: { type: 'string' }, podId: { type: 'string' } }, required: ['path'] },
  sideEffect: 'read', origins: () => [],
  execute: async (args, ctx) => {
    if (typeof args?.path !== 'string') return { ok: false, error: 'path_required' };
    const client = /** @type {any} */ (ctx).podClient;
    if (!client?.readFile) return { ok: false, error: 'pod_unavailable' };
    try {
      const content = await client.readFile(args.path, { sessionId: ctx.session?.sessionId, podId: args.podId });
      return { ok: true, content: wrapUntrusted({ origin: `pod:${args.podId ?? 'current'}/${args.path}`, tool: 'pod_read', body: String(content).slice(0, 32_000) }) };
    } catch (error) { return { ok: false, error: `pod_read_failed: ${/** @type {{message?:string}} */ (error)?.message ?? String(error)}` }; }
  },
};
