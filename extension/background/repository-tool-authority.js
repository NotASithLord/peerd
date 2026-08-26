// @ts-check

// Exact repository and Pod-lifecycle custody shared by orchestrator and actor
// relays. The admitted tool call and SW-owned actor binding are closed over;
// every method rechecks semantic arguments before touching a registry, tab,
// workspace, repository, confirmation surface, credential, or network.

import { normalizeGitRemote } from '/peerd-engine/authority.js';

const sameRemote = (/** @type {any} */ left, /** @type {any} */ right) =>
  left?.url === right?.url && left?.host === right?.host;

const mismatch = () => Object.assign(new Error('repository authority mismatch'), {
  outcomeKnown: true, retryable: false,
});

/**
 * @param {{call:any,ctx:any,signal:AbortSignal}} input
 */
export const createRepositoryToolAuthority = ({ call, ctx, signal }) => {
  const args = call?.args ?? {};
  const kind = ctx?.actorType;
  const id = ctx?.actorInstanceId;
  const repositories = ctx?.repositories;
  const repositoryRef = ['app', 'notebook', 'pod'].includes(kind)
    && typeof id === 'string' && id ? Object.freeze({ kind, id }) : null;
  let remoteRead = false;
  /** @type {any} */ let remote = null;
  /** @type {any} */ let approvedRemote = null;
  /** @type {any} */ let podRecord = null;

  const requireRepository = () => {
    if (!repositoryRef || !repositories) throw mismatch();
    return repositoryRef;
  };

  const coordinateMutation = async (
    /** @type {()=>Promise<any>} */ operation,
    /** @type {{quiesce?:boolean,replacesTree?:boolean}} */ options = {},
  ) => {
    const ref = requireRepository();
    const coordinated = () => repositories.coordinate(ref, operation);
    if (options.quiesce !== true) return coordinated();
    if (kind === 'app') {
      const result = await ctx?.appQuiescence?.run?.(id, coordinated, { close: true });
      if (result === undefined) throw new Error('App editor quiesce unavailable');
      return result;
    }
    if (kind === 'pod' && ctx?.podTabTracker?.getTabId?.(id) != null) {
      const result = await ctx?.podClient?.withWorkspaceLock?.(id, coordinated);
      if (result === undefined) throw new Error('Pod workspace quiesce unavailable');
      return result;
    }
    const tracker = kind === 'notebook' ? ctx?.jsTabTracker : null;
    const notebookLive = tracker?.getTabId?.(id) != null;
    if (!notebookLive) return coordinated();
    if (typeof tracker.quiesceTab !== 'function' || await tracker.quiesceTab(id) !== true) {
      throw new Error('Notebook editor quiesce unavailable');
    }
    let succeeded = false;
    try {
      const result = await coordinated();
      succeeded = true;
      return result;
    } finally {
      if (succeeded && options.replacesTree) {
        const reloaded = await tracker.reloadTab?.(id).catch(() => false);
        if (!reloaded) await tracker.resumeTab?.(id).catch(() => {});
      } else await tracker.resumeTab?.(id).catch(() => {});
    }
  };

  const readRemote = async () => {
    const ref = requireRepository();
    if (!['repo_history', 'repo_remote'].includes(call?.name)) throw mismatch();
    remote = await repositories.getRemote(ref);
    remoteRead = true;
    return remote;
  };

  return Object.freeze({
    readPod: async (/** @type {string} */ podId) => {
      if (call?.name !== 'pod_destroy' || podId !== args.podId
          || typeof ctx?.podRegistry?.get !== 'function') throw mismatch();
      const record = await ctx.podRegistry.get(podId);
      podRecord = record ? { id: podId, name: String(record.name ?? ''), pinned: record.pinned === true } : null;
      return podRecord;
    },
    destroyPod: async (/** @type {string} */ podId) => {
      if (call?.name !== 'pod_destroy' || podId !== args.podId
          || podRecord?.id !== podId || podRecord.pinned
          || typeof ctx?.podTabTracker?.closeTab !== 'function'
          || typeof ctx?.podRegistry?.delete !== 'function'
          || !repositories) throw mismatch();
      return repositories.coordinate({ kind: 'pod', id: podId }, async () => {
        await ctx.podTabTracker.closeTab(podId);
        await repositories.destroy({ kind: 'pod', id: podId }, { worktree: true });
        await ctx.podRegistry.delete(podId);
      });
    },
    readStatus: () => {
      if (call?.name !== 'repo_history') throw mismatch();
      return repositories.status(requireRepository());
    },
    readHistory: (/** @type {number} */ depth) => {
      const expected = Math.min(100, Math.max(1, Number(args?.depth) || 20));
      if (call?.name !== 'repo_history' || depth !== expected) throw mismatch();
      return repositories.history(requireRepository(), { depth });
    },
    readRemote,
    readDiff: (/** @type {string} */ from, /** @type {string|null} */ to) => {
      const expectedFrom = typeof args.from === 'string' ? args.from : 'HEAD';
      const expectedTo = typeof args.to === 'string' ? args.to : null;
      if (call?.name !== 'repo_history' || args.includeDiff !== true
          || from !== expectedFrom || to !== expectedTo) throw mismatch();
      return repositories.diff(requireRepository(), { from, to });
    },
    confirmRestore: (/** @type {string} */ to) => {
      const ref = requireRepository();
      if (call?.name !== 'repo_version' || args.op !== 'restore' || to !== args.to
          || typeof ctx?.confirm !== 'function') throw mismatch();
      return ctx.confirm({
        tool: 'repo_version', kind: 'repository_restore', sideEffect: 'destructive', origins: [],
        summary: `Restore ${ref.kind} ${ref.id} to ${to.slice(0, 12)}? Current history is retained and the restore becomes a new commit.`,
      });
    },
    checkpoint: (/** @type {string} */ message) => {
      const expected = typeof args.message === 'string' ? args.message : 'checkpoint';
      if (call?.name !== 'repo_version' || args.op !== 'checkpoint' || message !== expected) {
        throw mismatch();
      }
      return coordinateMutation(
        () => repositories.commit(requireRepository(), { message }), { quiesce: true },
      );
    },
    branch: (/** @type {string} */ name) => {
      if (call?.name !== 'repo_version' || args.op !== 'branch' || name !== args.name) {
        throw mismatch();
      }
      return coordinateMutation(() => repositories.branch(requireRepository(), {
        name, checkout: true,
      }), { quiesce: true });
    },
    checkout: (/** @type {string} */ name) => {
      if (call?.name !== 'repo_version' || args.op !== 'checkout' || name !== args.name) {
        throw mismatch();
      }
      return coordinateMutation(
        () => repositories.checkout(requireRepository(), { name }),
        { quiesce: true, replacesTree: true },
      );
    },
    restore: (/** @type {string} */ to) => {
      if (call?.name !== 'repo_version' || args.op !== 'restore' || to !== args.to) {
        throw mismatch();
      }
      return coordinateMutation(
        () => repositories.restore(requireRepository(), { to }),
        { quiesce: true, replacesTree: true },
      );
    },
    confirmRemote: async (
      /** @type {string} */ op,
      /** @type {string} */ target,
      /** @type {string|undefined} */ branch,
    ) => {
      const ref = requireRepository();
      if (call?.name !== 'repo_remote' || op !== args.op
          || branch !== (typeof args.branch === 'string' ? args.branch : undefined)
          || typeof ctx?.confirm !== 'function') throw mismatch();
      const candidate = op === 'link'
        ? normalizeGitRemote(args.url)
        : remoteRead ? remote : null;
      if (!candidate || target !== candidate.url) throw mismatch();
      approvedRemote = candidate;
      return ctx.confirm({
        tool: 'repo_remote', kind: `git_${op}`,
        sideEffect: op === 'push' ? 'mutate_external' : 'write',
        origins: [new URL(target).origin],
        summary: op === 'push'
          ? `Push ${ref.kind} ${ref.id} to ${target} on ${branch || 'its current branch'}? This sends working-tree files${ref.kind === 'app' ? ', including file-backed App data' : ''}, and commit history to the remote.`
          : op === 'fetch'
            ? `Fetch repository metadata and objects for ${ref.kind} ${ref.id} from ${target}?`
            : `Link ${ref.kind} ${ref.id} to Git remote ${target}? Future fetch/push can use its vault-bound host token.`,
      });
    },
    link: (/** @type {string} */ url) => {
      if (call?.name !== 'repo_remote' || args.op !== 'link'
          || approvedRemote?.url !== url) throw mismatch();
      return coordinateMutation(() => repositories.setRemote(requireRepository(), { url }));
    },
    fetch: (/** @type {string} */ target) => {
      if (call?.name !== 'repo_remote' || args.op !== 'fetch'
          || approvedRemote?.url !== target) throw mismatch();
      return coordinateMutation(async () => {
        const live = await repositories.getRemote(requireRepository());
        if (!sameRemote(live, approvedRemote)) throw new Error(
          'Git remote changed while authorization was pending; review and retry',
        );
        return repositories.fetch(requireRepository(), { signal });
      });
    },
    push: (/** @type {string} */ target, /** @type {string|undefined} */ branch) => {
      const expectedBranch = typeof args.branch === 'string' ? args.branch : undefined;
      if (call?.name !== 'repo_remote' || args.op !== 'push'
          || approvedRemote?.url !== target || branch !== expectedBranch) throw mismatch();
      return coordinateMutation(async () => {
        const live = await repositories.getRemote(requireRepository());
        if (!sameRemote(live, approvedRemote)) throw new Error(
          'Git remote changed while authorization was pending; review and retry',
        );
        await repositories.commit(requireRepository(), { message: 'checkpoint before push' });
        return repositories.push(requireRepository(), { ref: branch, signal });
      }, { quiesce: true });
    },
  });
};
