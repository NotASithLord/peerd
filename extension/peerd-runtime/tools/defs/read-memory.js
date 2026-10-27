// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// read_memory pages durable notes outside the always-loaded context.
import { buildPagedResult, SPILL_PAGE_CHARS, pageStatusLine } from '../web/spill.js';

/**
 * The memory store instance the SW injects as ctx.memory (peerd-runtime
 * createMemoryStore). Reusing its ReturnType keeps the verbs in sync.
 * @typedef {ReturnType<import('/peerd-runtime/memory/store.js').createMemoryStore>} MemoryStore
 */

/** @type {import('/shared/tool-types.js').Tool} */
export const readMemoryTool = composeTool("read_memory", {

  execute: async (args, ctx) => {
    // why: ctx.memory is the opaque `Object` contract slot; narrow it to the
    // injected memory store instance (its read verbs).
    const memory = /** @type {MemoryStore | undefined} */ (
      /** @type {{ memory?: unknown }} */ (ctx).memory);
    if (!memory) return { ok: false, error: 'memory_not_available' };
    const kind = args?.scope;
    const workspace = args?.workspace ?? ctx.activeTab?.origin ?? '';
    try {
      let content;
      if (kind === 'subtree') {
        if (!workspace) return { ok: false, error: 'workspace_required' };
        if (!args.subpath) return { ok: false, error: 'subpath_required' };
        const docs = await memory.readSubtree(workspace, args.subpath);
        content = docs.length ? docs.map((d) => `### ${d.subpath}\n${d.body}`).join('\n\n') : '(no subtree memory for that path)';
      } else if (kind === 'user' || kind === 'project') {
        if (kind === 'project' && !workspace) return { ok: false, error: 'workspace_required' };
        const doc = await memory.readScope({ kind, workspace });
        content = doc?.body || '(empty)';
      } else return { ok: false, error: 'invalid_scope' };
      // why: the durable doc backs each page. Never cut notes before a write.
      return buildPagedResult({ text: content, offset: typeof args.offset === 'number' ? args.offset : 0,
        limit: SPILL_PAGE_CHARS, frame: (page) => page.slice + (page.remaining > 0 || page.offset > 0
          ? `\n${pageStatusLine({ page, nextArgs: JSON.stringify({ scope: kind,
            ...(kind !== 'user' ? { workspace } : {}), ...(kind === 'subtree' ? { subpath: args.subpath } : {}), offset: page.end }) })}` : ''),
      });
    } catch (e) {
      return { ok: false, error: `read_memory_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
  },
});
