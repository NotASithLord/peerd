// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// repo_version: local history mutations for the actor's own App/Notebook/Pod.
// Restore is recoverable (it writes a new commit) but force-confirms because it
// replaces the live working tree.

import { repositoryToolFailure } from './app-history.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const repositoryVersionTool = composeTool("repo_version", {
  execute: async (args, ctx) => {
    const authority = /** @type {any} */ (ctx).repositoryAuthority;
    const kind = /** @type {any} */ (ctx).actorType;
    const id = /** @type {any} */ (ctx).actorInstanceId;
    if (!authority || !id || !['app', 'notebook', 'pod'].includes(kind)) return { ok: false, error: 'repository_unavailable' };
    const ref = { kind, id };
    try {
      if (args.op === 'branch' && typeof args.name !== 'string') return { ok: false, error: 'branch_name_required' };
      if (args.op === 'checkout' && typeof args.name !== 'string') return { ok: false, error: 'branch_name_required' };
      if (args.op === 'restore') {
        if (typeof args.to !== 'string') return { ok: false, error: 'restore_target_required' };
        const answer = await authority.confirmRestore(args.to);
        if (answer !== 'yes_once' && answer !== 'yes_session' && answer !== true) return { ok: false, error: 'restore_declined' };
      }
      const result = args.op === 'checkpoint'
        ? await authority.checkpoint(typeof args.message === 'string' ? args.message : 'checkpoint')
        : args.op === 'branch'
          ? await authority.branch(args.name)
          : args.op === 'checkout'
            ? await authority.checkout(args.name)
            : args.op === 'restore'
              ? await authority.restore(args.to)
              : await Promise.reject(new Error('unknown_repo_version_op'));
      return { ok: true, content: JSON.stringify({ repository: ref, op: args.op, result }, null, 2) };
    } catch (e) {
      return repositoryToolFailure(e, 'repo_version', `${String(args?.op ?? 'version operation')} in local Git history`);
    }
  },
});
