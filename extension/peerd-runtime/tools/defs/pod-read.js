// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
import { wrapUntrusted } from '../prompt-wrap.js';
import { buildPagedResult, clampPageLimit, pageStatusLine } from '../web/spill.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const podReadTool = composeTool("pod_read", {
  execute: async (args, ctx) => {
    if (typeof args?.path !== 'string') return { ok: false, error: 'path_required' };
    const client = /** @type {any} */ (ctx).podClient;
    if (!client?.readFile) return { ok: false, error: 'pod_unavailable' };
    try {
      const content = await client.readFile(args.path, { sessionId: ctx.session?.sessionId, podId: args.podId });
      return buildPagedResult({
        text: String(content),
        offset: typeof args.offset === 'number' ? args.offset : 0,
        limit: clampPageLimit(args.limit),
        frame: (page) => {
          const shown = wrapUntrusted({ origin: `pod:${args.podId ?? 'current'}/${args.path}`, tool: 'pod_read', body: page.slice });
          const nextArgs = JSON.stringify({
            path: args.path, ...(args.podId ? { podId: args.podId } : {}), offset: page.end,
          });
          const footer = page.remaining > 0 || page.offset > 0 ? `\n${pageStatusLine({ page, nextArgs })}` : '';
          return `${shown}${footer}`;
        },
      });
    } catch (error) { return { ok: false, error: `pod_read_failed: ${/** @type {{message?:string}} */ (error)?.message ?? String(error)}` }; }
  },
});
