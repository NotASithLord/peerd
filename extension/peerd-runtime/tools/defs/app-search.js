// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// app_search — substring search across saved Apps.
//
// Searches BOTH metadata (name, tags) and body HTML. Returns ranked
// results — name/tag hits beat body-only hits. Useful when the user
// references a past app vaguely ("the chart I had you make last week").

import { serializeListResult } from './columnar.js';
import { wrapUntrusted } from '../prompt-wrap.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const appSearchTool = composeTool("app_search", {

  execute: async (args, ctx) => {
    if (typeof args?.query !== 'string' || !args.query.trim()) {
      return { ok: false, error: 'query_required' };
    }
    // why: appClient rides the opaque ctx contract (not on ToolContext); narrow
    // to the one method this tool calls (search returns ranked app hits).
    const appClient = /** @type {{ search?: (query: string) => Promise<Array<{ app: { id: string, name: string, tags: string[], updatedAt: number }, snippet: string }>> } | undefined} */ (
      /** @type {any} */ (ctx).appClient);
    if (!appClient?.search) return { ok: false, error: 'app_not_available' };
    try {
      const hits = await appClient.search(args.query.trim());
      const trimmed = hits.slice(0, 20).map((h) => ({
        id: h.app.id,
        name: h.app.name,
        tags: h.app.tags,
        updatedAt: h.app.updatedAt,
        snippet: h.snippet,
      }));
      return {
        ok: true,
        // why: names, tags, and especially body snippets are user-authored App
        // bytes. A spawned child or clean-context reviewer may receive this
        // otherwise-main-visible tool, so fence the result at the tool seam just
        // like app_read_file rather than letting saved HTML become instructions.
        content: wrapUntrusted({
          origin: 'saved-apps',
          tool: 'app_search',
          body: serializeListResult({
            query: args.query,
            count: trimmed.length,
            truncated: hits.length > 20,
            hits: trimmed,
          }, 'hits'),
        }),
      };
    } catch (e) {
      return { ok: false, error: `app_search_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
  },
});
