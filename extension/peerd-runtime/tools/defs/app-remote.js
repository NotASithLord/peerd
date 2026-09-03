// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// repo_remote: force-confirmed Git network operations. The actor never
// receives a token or raw fetch; the trusted repository service binds vault
// credentials to the normalized remote host.

import { normalizeGitRemote } from '/peerd-engine/controller.js';
import { repositoryToolFailure } from './app-history.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const repositoryRemoteTool = composeTool("repo_remote", {
  execute: async (args, ctx) => {
    const authority = /** @type {any} */ (ctx).repositoryAuthority;
    const kind = /** @type {any} */ (ctx).actorType;
    const id = /** @type {any} */ (ctx).actorInstanceId;
    if (!authority || !id || !['app', 'notebook', 'pod'].includes(kind)) return { ok: false, error: 'repository_unavailable' };
    try {
      const ref = { kind, id };
      const currentRemote = args.op === 'link' ? null : await authority.readRemote();
      if (args.op !== 'link' && !currentRemote) return { ok: false, error: 'no_origin_remote' };
      if (args.op === 'link' && typeof args.url !== 'string') return { ok: false, error: 'remote_url_required' };
      // Canonicalize before consent so the text the user approves is exactly
      // the authority the repository service will persist or contact.
      const approvedRemote = args.op === 'link'
        ? normalizeGitRemote(args.url)
        : currentRemote;
      const target = approvedRemote.url;
      const answer = await authority.confirmRemote(args.op, target, args.branch);
      if (answer !== 'yes_once' && answer !== 'yes_session' && answer !== true) return { ok: false, error: `git_${args.op}_declined` };
      const result = args.op === 'link'
        ? await authority.link(approvedRemote.url)
        : args.op === 'fetch'
          ? await authority.fetch(target)
          : args.op === 'push'
            ? await authority.push(target, typeof args.branch === 'string' ? args.branch : undefined)
            : await Promise.reject(new Error('unknown_repo_remote_op'));
      if (args.op === 'push' && result?.ok !== true) {
        return { ok: false, error: `git_push_rejected: ${result?.error || 'remote rejected the update'}` };
      }
      return { ok: true, content: JSON.stringify({ repository: ref, op: args.op, result }, null, 2) };
    } catch (e) {
      return repositoryToolFailure(e, 'repo_remote', `${String(args?.op ?? 'remote operation')} on the Git remote`);
    }
  },
});
