// @ts-check
// app_search — substring search across saved Apps.
//
// Searches BOTH metadata (name, tags) and body HTML. Returns ranked
// results — name/tag hits beat body-only hits. Useful when the user
// references a past app vaguely ("the chart I had you make last week").

import { serializeListResult } from './columnar.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const appSearchTool = {
  name: 'app_search',
  primitive: 'app',
  description: [
    'Search saved Apps by name, tags, and body text (substring,',
    'case-insensitive). Returns up to 20 ranked matches with a short',
    'snippet from the body when the hit was in the HTML. Use when the',
    'user vaguely references a past app ("the chart I had you make").',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search text.' },
    },
    required: ['query'],
  },
  sideEffect: 'read',
  origins: () => [],

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
        content: serializeListResult({
          query: args.query,
          count: trimmed.length,
          truncated: hits.length > 20,
          hits: trimmed,
        }, 'hits'),
      };
    } catch (e) {
      return { ok: false, error: `app_search_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
  },
};
