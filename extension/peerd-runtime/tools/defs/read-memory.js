// @ts-check
// read_memory — read memory the always-loaded block does NOT include.
//
// The user/project memory rides the system prompt every turn. This tool
// fetches the rest ON DEMAND: a specific scope's full body, or the
// subtree (path-scoped) notes for a folder/section the agent is about to
// work in. Keeping subtree memory out of the always-loaded block is how
// the < ~200-line budget holds while deep per-area notes still exist.
//
// Read-only: no confirmation, no mutation.

/**
 * The memory store instance the SW injects as ctx.memory (peerd-runtime
 * createMemoryStore). Reusing its ReturnType keeps the verbs in sync.
 * @typedef {ReturnType<import('/peerd-runtime/memory/store.js').createMemoryStore>} MemoryStore
 */

/** @type {import('/shared/tool-types.js').Tool} */
export const readMemoryTool = {
  name: 'read_memory',
  primitive: 'memory',
  description: [
    'Read persistent memory not already in your always-loaded context.',
    'Use when descending into a specific area of a workspace, or to see',
    'the full body of a scope. With scope "subtree" + a subpath, returns',
    'every subtree note covering that path (most specific first). With',
    '"project"/"user", returns that scope\'s full doc.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      scope: {
        type: 'string',
        enum: ['user', 'project', 'subtree'],
        description: 'Which scope to read.',
      },
      workspace: {
        type: 'string',
        description: 'Workspace key for project/subtree (origin, vm:id, app:id). Defaults to active tab origin.',
      },
      subpath: {
        type: 'string',
        description: 'Path within the workspace for subtree reads, e.g. "src/api".',
      },
    },
    required: ['scope'],
  },
  sideEffect: 'read',
  origins: () => [],

  execute: async (args, ctx) => {
    // why: ctx.memory is the opaque `Object` contract slot; narrow it to the
    // injected memory store instance (its read verbs).
    const memory = /** @type {MemoryStore | undefined} */ (
      /** @type {{ memory?: unknown }} */ (ctx).memory);
    if (!memory) return { ok: false, error: 'memory_not_available' };
    const kind = args?.scope;
    const workspace = args?.workspace ?? ctx.activeTab?.origin ?? '';
    try {
      if (kind === 'subtree') {
        if (!workspace) return { ok: false, error: 'workspace_required' };
        if (!args.subpath) return { ok: false, error: 'subpath_required' };
        const docs = await memory.readSubtree(workspace, args.subpath);
        return {
          ok: true,
          content: docs.length
            ? docs.map((d) => `### ${d.subpath}\n${d.body}`).join('\n\n')
            : '(no subtree memory for that path)',
        };
      }
      if (kind === 'user' || kind === 'project') {
        if (kind === 'project' && !workspace) return { ok: false, error: 'workspace_required' };
        const doc = await memory.readScope({ kind, workspace });
        return { ok: true, content: doc?.body || '(empty)' };
      }
      return { ok: false, error: 'invalid_scope' };
    } catch (e) {
      return { ok: false, error: `read_memory_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
  },
};
