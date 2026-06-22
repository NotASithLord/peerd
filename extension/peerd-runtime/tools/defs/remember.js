// @ts-check
// remember — propose a persistent memory write (AGENTS.md), gated on
// USER CONFIRMATION.
//
// This is the agent-facing door to file-based memory and the explicit
// lethal-trifecta seam: an AGENT cannot persist memory on its own. The
// tool builds a write proposal and routes it through the memory store's
// writeWithConfirm, which round-trips the exact diff to the side panel
// via ctx.confirm before anything touches IDB. A rejection (or a missing
// confirm channel) persists nothing and reports back so the agent can
// continue without retrying.
//
// sideEffect is 'write' so the dispatcher's six-gate chain treats it
// like any other mutation; the confirmation here is memory-specific
// (renders the diff), layered on top of — not instead of — the gates.

/**
 * The memory store instance the SW injects as ctx.memory (peerd-runtime
 * createMemoryStore). Reusing its ReturnType keeps the verbs in sync.
 * @typedef {ReturnType<import('/peerd-runtime/memory/store.js').createMemoryStore>} MemoryStore
 */

/**
 * The write proposal the memory store hands to the confirm callback. Only
 * the fields this tool reads for the side-panel summary are listed.
 * @typedef {Object} MemoryProposal
 * @property {string} op
 * @property {string} header
 * @property {number} addedLines
 * @property {number} removedLines
 */

/** @type {import('/shared/tool-types.js').Tool} */
export const rememberTool = {
  name: 'remember',
  primitive: 'memory',
  description: [
    'Propose a durable write to project memory (AGENTS.md) — the user must',
    'CONFIRM the exact diff before it saves; a rejection saves nothing.',
    '✅ conventions, commands, decisions, gotchas to keep across sessions.',
    '❌ chat history or transient state. Scope: "user" (global, about the',
    'user — expand frugally), "project" (this workspace), or "subtree" (a',
    'path within it). The body REPLACES that scope\'s doc, so read it first',
    '(read_memory) before appending. An empty body deletes it.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      scope: {
        type: 'string',
        enum: ['user', 'project', 'subtree'],
        description: 'Memory scope: user (global), project (workspace), or subtree (path within workspace).',
      },
      body: {
        type: 'string',
        description: 'Full markdown body for the scope. Replaces the existing doc. Empty string deletes it.',
      },
      workspace: {
        type: 'string',
        description: 'Workspace key for project/subtree scope (origin, vm:id, app:id). Defaults to the active tab origin.',
      },
      subpath: {
        type: 'string',
        description: 'Path within the workspace for subtree scope, e.g. "src/api".',
      },
    },
    required: ['scope', 'body'],
  },
  sideEffect: 'write',
  // why: memory writes touch IDB, not a web origin — the origin/egress
  // gates have nothing to check. Return [] so they trivially pass; the
  // real safety is the confirmation round-trip in execute().
  origins: () => [],

  execute: async (args, ctx) => {
    // why: ctx.memory is the opaque `Object` contract slot; narrow it to the
    // injected memory store instance (writeWithConfirm is the verb used).
    const memory = /** @type {MemoryStore | undefined} */ (
      /** @type {{ memory?: unknown }} */ (ctx).memory);
    if (!memory?.writeWithConfirm) return { ok: false, error: 'memory_not_available' };
    const kind = args?.scope;
    if (kind !== 'user' && kind !== 'project' && kind !== 'subtree') {
      return { ok: false, error: 'invalid_scope' };
    }
    if (typeof args?.body !== 'string') return { ok: false, error: 'body_required' };

    // Resolve the workspace for project/subtree from args or the active
    // tab. The user scope needs none.
    const workspace = args.workspace ?? ctx.activeTab?.origin ?? '';
    if ((kind === 'project' || kind === 'subtree') && !workspace) {
      return { ok: false, error: 'workspace_required' };
    }
    if (kind === 'subtree' && !args.subpath) {
      return { ok: false, error: 'subpath_required' };
    }

    const scope = { kind, workspace, subpath: args.subpath };
    // why: ctx.confirm is typed for the dispatcher's ConfirmPrompt shape, but
    // the confirm coordinator also routes memory-flavoured prompts (rendered
    // as a diff in the side panel). Narrow to that looser payload here.
    const confirmAny = /** @type {((p: Record<string, unknown>) => Promise<'yes_once'|'yes_session'|'no'|boolean>) | undefined} */ (
      /** @type {unknown} */ (ctx.confirm));
    try {
      const res = await memory.writeWithConfirm({
        scope,
        body: args.body,
        origin: 'agent',
        // why: the memory store calls this with the FULL proposal so the
        // side panel can render the diff. We adapt the dispatcher's
        // confirm signature: pass a memory-flavoured prompt carrying the
        // proposal; the panel decides how to render it.
        confirm: confirmAny
          ? (rawProposal) => {
              // why: the store types this proposal as `object`; the memory
              // proposal carries op/header/diff counts for the side-panel summary.
              const proposal = /** @type {MemoryProposal} */ (rawProposal);
              return confirmAny({
                tool: 'remember',
                sideEffect: 'write',
                kind: 'memory_write',
                proposal,
                summary: `${proposal.op} memory: ${proposal.header} (+${proposal.addedLines}/−${proposal.removedLines})`,
                origins: [],
                sessionId: ctx.session?.sessionId ?? null,
              });
            }
          : undefined,
      });
      if (res.rejected) {
        return { ok: false, error: 'memory_write_rejected', content: 'User declined the memory write.' };
      }
      return {
        ok: true,
        content: JSON.stringify({ op: res.op, scope: res.id }, null, 2),
      };
    } catch (e) {
      return { ok: false, error: `remember_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
  },
};
