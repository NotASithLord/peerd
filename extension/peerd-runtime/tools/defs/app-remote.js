// @ts-check
// repo_remote: force-confirmed Git network operations. The actor never
// receives a token or raw fetch; the trusted repository service binds vault
// credentials to the normalized remote host.

import { normalizeGitRemote } from '/peerd-engine/repository/remote.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const repositoryRemoteTool = {
  name: 'repo_remote',
  primitive: 'engine',
  description: [
    'Link, fetch, or push this App, Notebook, or Pod Git repository over HTTPS. GitHub works',
    'directly from the extension; no CORS proxy. Credentials stay in the vault',
    'and never enter this actor. Every operation asks the user; push never forces.',
    'Fetch downloads refs and objects but never merges the working branch. To import an',
    'existing repository, clone it through sandbox_create instead of linking it to an App.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['link', 'fetch', 'push'] },
      url: { type: 'string', description: 'HTTPS repository URL for link.' },
      branch: { type: 'string', description: 'Optional branch for push.' },
    },
    required: ['op'],
  },
  sideEffect: 'write',
  origins: (args) => {
    if (typeof args?.url !== 'string') return [];
    try { return [new URL(args.url).origin]; } catch { return []; }
  },
  execute: async (args, ctx) => {
    const repositories = /** @type {any} */ (ctx).repositories;
    const kind = /** @type {any} */ (ctx).actorType;
    const id = /** @type {any} */ (ctx).actorInstanceId;
    if (!repositories || !id || !['app', 'notebook', 'pod'].includes(kind)) return { ok: false, error: 'repository_unavailable' };
    try {
      const ref = { kind, id };
      const currentRemote = args.op === 'link' ? null : await repositories.getRemote(ref);
      if (args.op !== 'link' && !currentRemote) return { ok: false, error: 'no_origin_remote' };
      if (args.op === 'link' && typeof args.url !== 'string') return { ok: false, error: 'remote_url_required' };
      // Canonicalize before consent so the text the user approves is exactly
      // the authority the repository service will persist or contact.
      const approvedRemote = args.op === 'link'
        ? normalizeGitRemote(args.url)
        : currentRemote;
      const target = approvedRemote.url;
      const confirm = /** @type {any} */ (ctx).confirm;
      if (!confirm) return { ok: false, error: 'git_confirmation_unavailable' };
      const answer = await confirm({
        tool: 'repo_remote', kind: `git_${args.op}`, sideEffect: args.op === 'push' ? 'mutate_external' : 'write',
        origins: [new URL(target).origin],
        summary: args.op === 'push'
          ? `Push ${kind} ${id} to ${target} on ${args.branch || 'its current branch'}? This sends code and commit history to the remote.`
          : args.op === 'fetch'
            ? `Fetch repository metadata and objects for ${kind} ${id} from ${target}?`
            : `Link ${kind} ${id} to Git remote ${target}? Future fetch/push can use its vault-bound host token.`,
      });
      if (answer !== 'yes_once' && answer !== 'yes_session' && answer !== true) return { ok: false, error: `git_${args.op}_declined` };
      const tracker = kind === 'notebook' ? /** @type {any} */ (ctx).jsTabTracker
        : kind === 'pod' ? /** @type {any} */ (ctx).podTabTracker
        : null;
      const appQuiescence = /** @type {any} */ (ctx).appQuiescence;
      const podClient = /** @type {any} */ (ctx).podClient;
      const podLive = kind === 'pod' && args.op === 'push' && tracker?.getTabId?.(id) != null;
      const notebookLive = kind === 'notebook' && args.op === 'push' && tracker?.getTabId?.(id) != null;
      let notebookQuiesced = false;
      try {
        if (notebookLive) {
          if (typeof tracker?.quiesceTab !== 'function' || await tracker.quiesceTab(id) !== true) {
            throw new Error('Notebook editor quiesce unavailable');
          }
          notebookQuiesced = true;
        }
        const operation = () => repositories.coordinate(ref, async () => {
          if (args.op === 'link') return repositories.setRemote(ref, { url: approvedRemote.url });
          // Consent waits outside the repository lane. Re-read the remote after
          // acquiring it so a concurrent set-url cannot redirect an approval
          // for A into a fetch or push to B.
          const liveRemote = await repositories.getRemote(ref);
          if (!liveRemote
              || liveRemote.url !== approvedRemote.url
              || liveRemote.host !== approvedRemote.host) {
            throw new Error('Git remote changed while authorization was pending; review and retry');
          }
          if (args.op === 'fetch') return repositories.fetch(ref, { signal: /** @type {any} */ (ctx).abortSignal });
          if (args.op === 'push') {
            await repositories.commit(ref, { message: 'checkpoint before push' });
            return repositories.push(ref, { ref: typeof args.branch === 'string' ? args.branch : undefined, signal: /** @type {any} */ (ctx).abortSignal });
          }
          throw new Error('unknown_repo_remote_op');
        });
        const result = kind === 'app' && args.op === 'push'
          ? await appQuiescence?.run?.(id, operation, { close: true })
          : podLive
            ? await podClient?.withWorkspaceLock?.(id, operation)
            : await operation();
        if (kind === 'app' && args.op === 'push' && result === undefined) {
          throw new Error('App editor quiesce unavailable');
        }
        if (podLive && result === undefined) throw new Error('Pod workspace quiesce unavailable');
        if (args.op === 'push' && result?.ok !== true) {
          return { ok: false, error: `git_push_rejected: ${result?.error || 'remote rejected the update'}` };
        }
        return { ok: true, content: JSON.stringify({ repository: ref, op: args.op, result }, null, 2) };
      } finally {
        if (notebookQuiesced) await tracker.resumeTab?.(id).catch(() => {});
      }
    } catch (e) {
      return { ok: false, error: `repo_remote_failed: ${/** @type {{message?:string}} */ (e)?.message ?? String(e)}` };
    }
  },
};
