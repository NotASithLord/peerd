// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// repo_history: an App/Notebook/Pod actor's read-only repository window. One call returns
// status + log and, when requested, a bounded diff.

const MAX_PATCH_CHARS = 40_000;
const SAFE_REPOSITORY_ERROR_CODE = /^[a-z0-9][a-z0-9_-]{0,127}$/;

/**
 * Keep repository custody evidence intact at the model-facing tool boundary.
 * Repository transports stamp post-dispatch loss with `outcomeKnown:false`;
 * flattening that into an ordinary error invites an unsafe automatic retry.
 *
 * This lives in the already-loaded repository tool cluster so all three tools
 * share one policy without adding another module to the legacy cold graph.
 * @param {unknown} cause
 * @param {'repo_history'|'repo_remote'|'repo_version'} tool
 * @param {string} action
 * @returns {import('/shared/tool-types.js').ToolResultErr}
 */
export const repositoryToolFailure = (cause, tool, action) => {
  const detail = /** @type {{message?:unknown,code?:unknown,outcomeKnown?:unknown,outcomeKind?:unknown}} */ (cause);
  const code = typeof detail?.code === 'string' && SAFE_REPOSITORY_ERROR_CODE.test(detail.code)
    ? detail.code : null;
  if (detail?.outcomeKnown === false) {
    const outcomeKind = detail.outcomeKind === 'host-lost' ? 'host-lost' : 'transport-lost';
    return {
      ok: false,
      error: `${tool}_outcome_unknown`,
      content: `Peerd could not confirm whether ${action} finished. Run repo_history to reconcile the repository before taking another Git action. Do not retry automatically.`,
      ...(code ? { code } : {}),
      outcomeKnown: false,
      outcomeKind,
      retryable: false,
      structured: {
        ...(code ? { code } : {}),
        outcomeKnown: false,
        outcomeKind,
        retryable: false,
        reconciliation: 'repo_history',
      },
    };
  }
  const message = typeof detail?.message === 'string' ? detail.message : String(cause);
  return {
    ok: false,
    error: `${tool}_failed: ${message}`,
    ...(code ? { code } : {}),
    ...(detail?.outcomeKnown === true ? { outcomeKnown: true, retryable: true } : {}),
  };
};

/** @type {import('/shared/tool-types.js').Tool} */
export const repositoryHistoryTool = composeTool("repo_history", {
  execute: async (args, ctx) => {
    const repositories = /** @type {any} */ (ctx).repositories;
    const kind = /** @type {any} */ (ctx).actorType;
    const id = /** @type {any} */ (ctx).actorInstanceId;
    if (!repositories || !id || !['app', 'notebook', 'pod'].includes(kind)) return { ok: false, error: 'repository_unavailable' };
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
      return repositoryToolFailure(e, 'repo_history', 'reading Git history');
    }
  },
});
