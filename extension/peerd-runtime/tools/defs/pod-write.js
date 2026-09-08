// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
import { MAX_FILE_CONTENT_CHARS } from './js-write-file.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const podWriteTool = composeTool("pod_write", {
  execute: async (args, ctx) => {
    if (typeof args?.path !== 'string' || !args.path) return { ok: false, error: 'path_required' };
    if (typeof args?.content !== 'string') return { ok: false, error: 'content_required' };
    if (args.content.length > MAX_FILE_CONTENT_CHARS) return { ok: false, error: 'content_too_large' };
    const client = /** @type {any} */ (ctx).podClient;
    if (!client?.writeFile) return { ok: false, error: 'pod_unavailable' };
    try {
      const podId = await client.writeFile(args.path, args.content, { sessionId: ctx.session?.sessionId, podId: args.podId });
      return { ok: true, content: JSON.stringify({ podId, path: args.path, bytes: new TextEncoder().encode(args.content).byteLength }, null, 2) };
    } catch (error) { return { ok: false, error: `pod_write_failed: ${/** @type {{message?:string}} */ (error)?.message ?? String(error)}` }; }
  },
});
