// @ts-check
// repo_history — an App/Notebook actor's read-only repository window. One call returns
// status + log and, when requested, a bounded diff.

const MAX_PATCH_CHARS = 40_000;

/** @type {import('/shared/tool-types.js').Tool} */
export const repositoryHistoryTool = {
  name: 'repo_history',
  primitive: 'engine',
  description: [
    'Inspect this App or Notebook\'s browser-native Git repository: current branch and',
    'working-tree status plus recent commits. Set includeDiff to compare `from`',
    '(default HEAD) with `to` (default live working tree). Git OIDs are developer',
    'history identifiers; signed dwapp version_id remains the release identity.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      depth: { type: 'integer', description: 'Recent commits to return (default 20, max 100).' },
      includeDiff: { type: 'boolean', description: 'Include a bounded unified diff.' },
      from: { type: 'string', description: 'Commit/ref to diff from (default HEAD).' },
      to: { type: 'string', description: 'Commit/ref to diff to (default live working tree).' },
    },
  },
  sideEffect: 'read',
  origins: () => [],
  execute: async (args, ctx) => {
    const repositories = /** @type {any} */ (ctx).repositories;
    const kind = /** @type {any} */ (ctx).actorType;
    const id = /** @type {any} */ (ctx).actorInstanceId;
    if (!repositories || !id || (kind !== 'app' && kind !== 'notebook')) return { ok: false, error: 'repository_unavailable' };
    try {
      const ref = { kind, id };
      const depth = Math.min(100, Math.max(1, Number(args?.depth) || 20));
      const [status, commits, remote] = await Promise.all([
        repositories.status(ref),
        repositories.history(ref, { depth }),
        repositories.getRemote(ref),
      ]);
      let diff = null;
      if (args?.includeDiff === true) {
        const visibleOids = new Set(commits.map((/** @type {{oid:string}} */ row) => row.oid));
        const requestedFrom = typeof args.from === 'string' ? args.from : 'HEAD';
        const requestedTo = typeof args.to === 'string' ? args.to : null;
        if (requestedFrom !== 'HEAD' && !visibleOids.has(requestedFrom)) return { ok: false, error: 'diff_from_must_be_a_visible_commit' };
        if (requestedTo !== null && requestedTo !== 'HEAD' && !visibleOids.has(requestedTo)) return { ok: false, error: 'diff_to_must_be_a_visible_commit' };
        const result = await repositories.diff(ref, {
          from: requestedFrom,
          to: requestedTo,
        });
        diff = {
          from: result.from, to: result.to,
          files: result.files.map((/** @type {any} */ file) => ({ path: file.path, status: file.status, binary: !!file.binary })),
          patch: result.patch.slice(0, MAX_PATCH_CHARS),
          truncated: result.patch.length > MAX_PATCH_CHARS,
        };
      }
      return { ok: true, content: JSON.stringify({ repository: ref, status, remote, commits, ...(diff ? { diff } : {}) }, null, 2) };
    } catch (e) {
      return { ok: false, error: `repo_history_failed: ${/** @type {{message?:string}} */ (e)?.message ?? String(e)}` };
    }
  },
};
