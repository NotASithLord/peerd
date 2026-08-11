// @ts-check
import { MAX_FILE_CONTENT_CHARS } from './js-write-file.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const podWriteTool = {
  name: 'pod_write', primitive: 'pod',
  description: 'Write UTF-8 text to a relative path in this Pod workspace. Nested directories are created. Cap 500000 characters.',
  schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, podId: { type: 'string' } }, required: ['path', 'content'] },
  sideEffect: 'write', origins: () => [],
  execute: async (args, ctx) => {
    if (typeof args?.path !== 'string' || !args.path) return { ok: false, error: 'path_required' };
    if (typeof args?.content !== 'string') return { ok: false, error: 'content_required' };
    if (args.content.length > MAX_FILE_CONTENT_CHARS) return { ok: false, error: 'content_too_large' };
    const client = /** @type {any} */ (ctx).podClient;
    if (!client?.writeFile) return { ok: false, error: 'pod_unavailable' };
    try {
      const podId = await client.writeFile(args.path, args.content, { sessionId: ctx.session?.sessionId, podId: args.podId });
      return { ok: true, content: JSON.stringify({ podId, path: args.path, bytes: args.content.length }, null, 2) };
    } catch (error) { return { ok: false, error: `pod_write_failed: ${/** @type {{message?:string}} */ (error)?.message ?? String(error)}` }; }
  },
};
