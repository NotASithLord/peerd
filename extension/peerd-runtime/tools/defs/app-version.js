// @ts-check
// repo_version: local history mutations for the actor's own App/Notebook/Pod.
// Restore is recoverable (it writes a new commit) but force-confirms because it
// replaces the live working tree.

/** @type {import('/shared/tool-types.js').Tool} */
export const repositoryVersionTool = {
  name: 'repo_version',
  primitive: 'engine',
  description: [
    'Manage this App, Notebook, or Pod LOCAL Git history. checkpoint commits current files;',
    'branch creates a branch; checkout switches a clean working tree; restore',
    'replaces live files with a prior commit and records a NEW commit, so it',
    'remains reversible. Use repo_history first.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['checkpoint', 'branch', 'checkout', 'restore'] },
      message: { type: 'string', description: 'Short checkpoint message.' },
      name: { type: 'string', description: 'Branch name for branch/checkout.' },
      to: { type: 'string', description: 'Commit OID/ref for restore.' },
    },
    required: ['op'],
  },
  sideEffect: 'write',
  origins: () => [],
  execute: async (args, ctx) => {
    const repositories = /** @type {any} */ (ctx).repositories;
    const kind = /** @type {any} */ (ctx).actorType;
    const id = /** @type {any} */ (ctx).actorInstanceId;
    if (!repositories || !id || !['app', 'notebook', 'pod'].includes(kind)) return { ok: false, error: 'repository_unavailable' };
    const ref = { kind, id };
    const replacesTree = args.op === 'checkout' || args.op === 'restore';
    const tracker = kind === 'pod' ? /** @type {any} */ (ctx).podTabTracker
      : /** @type {any} */ (ctx).jsTabTracker;
    const appQuiescence = /** @type {any} */ (ctx).appQuiescence;
    const podClient = /** @type {any} */ (ctx).podClient;
    const podLive = kind === 'pod' && tracker?.getTabId?.(id) != null;
    const notebookLive = kind === 'notebook' && tracker?.getTabId?.(id) != null;
    let notebookQuiesced = false;
    let operationSucceeded = false;
    try {
      if (args.op === 'branch' && typeof args.name !== 'string') return { ok: false, error: 'branch_name_required' };
      if (args.op === 'checkout' && typeof args.name !== 'string') return { ok: false, error: 'branch_name_required' };
      if (args.op === 'restore') {
        if (typeof args.to !== 'string') return { ok: false, error: 'restore_target_required' };
        const confirm = /** @type {any} */ (ctx).confirm;
        if (!confirm) return { ok: false, error: 'restore_confirmation_unavailable' };
        const answer = await confirm({
          tool: 'repo_version', kind: 'repository_restore', sideEffect: 'destructive', origins: [],
          summary: `Restore ${kind} ${id} to ${args.to.slice(0, 12)}? Current history is retained and the restore becomes a new commit.`,
        });
        if (answer !== 'yes_once' && answer !== 'yes_session' && answer !== true) return { ok: false, error: 'restore_declined' };
      }
      if (notebookLive) {
        if (typeof tracker?.quiesceTab !== 'function' || await tracker.quiesceTab(id) !== true) {
          throw new Error('Notebook editor quiesce unavailable');
        }
        notebookQuiesced = true;
      }
      const operation = () => repositories.coordinate(ref, async () => {
        if (args.op === 'checkpoint') return repositories.commit(ref, { message: typeof args.message === 'string' ? args.message : 'checkpoint' });
        // Git carries a dirty working tree onto the new branch. The next
        // checkpoint therefore lands on the branch the model just requested.
        if (args.op === 'branch') return repositories.branch(ref, { name: args.name, checkout: true });
        if (args.op === 'checkout') return repositories.checkout(ref, { name: args.name });
        if (args.op === 'restore') return repositories.restore(ref, { to: args.to });
        throw new Error('unknown_repo_version_op');
      });
      const result = kind === 'app'
        ? await appQuiescence?.run?.(id, operation, {
          close: true,
          invalidateDweb: args.op === 'branch' || args.op === 'checkout' || args.op === 'restore',
        })
        : podLive
          ? await podClient?.withWorkspaceLock?.(id, operation)
          : await operation();
      if (kind === 'app' && result === undefined) throw new Error('App editor quiesce unavailable');
      if (podLive && result === undefined) throw new Error('Pod workspace quiesce unavailable');
      operationSucceeded = true;
      return { ok: true, content: JSON.stringify({ repository: ref, op: args.op, result }, null, 2) };
    } catch (e) {
      return { ok: false, error: `repo_version_failed: ${/** @type {{message?:string}} */ (e)?.message ?? String(e)}` };
    } finally {
      if (notebookQuiesced) {
        // checkout/restore replace bytes the live editor has cached; reload the
        // same tab (preserving focus/window placement) instead of closing it.
        if (operationSucceeded && replacesTree) {
          const reloaded = await tracker.reloadTab?.(id).catch(() => false);
          if (!reloaded) await tracker.resumeTab?.(id).catch(() => {});
        } else await tracker.resumeTab?.(id).catch(() => {});
      }
    }
  },
};
