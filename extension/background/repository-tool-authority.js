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
 * @param {{binding:any,ctx:any,signal:AbortSignal,shared?:any}} input
 */
export const createRepositoryToolAuthority = ({ binding, ctx, signal, shared = {} }) => {
  const args = binding.args;
  const kind = ctx?.actorType;
  const id = ctx?.actorInstanceId;
  const repositories = ctx?.repositories;
  const boundPodId = kind === 'pod' && typeof id === 'string' && id ? id : null;
  const repositoryRef = ['app', 'notebook', 'pod'].includes(kind)
    && typeof id === 'string' && id ? Object.freeze({ kind, id }) : null;

  const requireRepository = () => {
    if (!repositoryRef || !repositories) throw mismatch();
    return repositoryRef;
  };
  const requireLive = () => {
    if (!signal?.aborted) return;
    throw Object.assign(new Error('repository operation stopped before mutation'), {
      outcomeKnown: true, retryable: false,
    });
  };

  const coordinateMutation = async (
    /** @type {()=>Promise<any>} */ operation,
    /** @type {{quiesce?:boolean,replacesTree?:boolean}} */ options = {},
  ) => {
    const ref = requireRepository();
    const coordinated = () => repositories.coordinate(ref, async () => {
      // why: the repository's own lock may outlive the turn that queued this
      // operation. Recheck inside that queue, immediately before touching the
      // worktree, rather than relying on the earlier authority-scheduler gate.
      requireLive();
      return operation();
    });
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
    if (!['turn.repository.read-remote'].includes(binding.operation)) throw mismatch();
    shared.remote = await repositories.getRemote(ref);
    shared.remoteRead = true;
    return shared.remote;
  };
  const approved = (/** @type {unknown} */ answer) => answer === true
    || answer === 'yes_once' || answer === 'yes_session';
  const consumeRemoteApproval = (
    /** @type {string} */ op,
    /** @type {string} */ target,
    /** @type {string|undefined} */ branch,
  ) => {
    const approval = shared.repositoryRemoteApproval;
    shared.repositoryRemoteApproval = null;
    if (!approval || approval.op !== op || approval.target !== target
        || approval.branch !== branch) throw mismatch();
    return approval.remote;
  };

  return Object.freeze({
    readPod: async (/** @type {string} */ podId) => {
      if (binding.operation !== 'turn.repository.read-pod' || podId !== args.podId
          || (boundPodId !== null && podId !== boundPodId)
          || typeof ctx?.podRegistry?.get !== 'function') throw mismatch();
      const record = await ctx.podRegistry.get(podId);
      shared.podRecord = record
        ? { id: podId, name: String(record.name ?? ''), pinned: record.pinned === true } : null;
      return shared.podRecord;
    },
    destroyPod: async (/** @type {string} */ podId) => {
      if (binding.operation !== 'turn.repository.destroy-pod' || podId !== args.podId
          || (boundPodId !== null && podId !== boundPodId)
          || shared.podRecord?.id !== podId || shared.podRecord.pinned
          || typeof ctx?.podTabTracker?.closeTab !== 'function'
          || typeof ctx?.podRegistry?.delete !== 'function'
          || !repositories) throw mismatch();
      return repositories.coordinate({ kind: 'pod', id: podId }, async () => {
        requireLive();
        await ctx.podTabTracker.closeTab(podId);
        await repositories.destroy({ kind: 'pod', id: podId }, { worktree: true });
        await ctx.podRegistry.delete(podId);
      });
    },
    readStatus: () => {
      if (binding.operation !== 'turn.repository.read-status') throw mismatch();
      return repositories.status(requireRepository());
    },
    readHistory: (/** @type {number} */ depth) => {
      const expected = Math.min(100, Math.max(1, Number(args?.depth) || 20));
      if (binding.operation !== 'turn.repository.read-history' || depth !== expected) throw mismatch();
      return repositories.history(requireRepository(), { depth });
    },
    readRemote,
    readDiff: (/** @type {string} */ from, /** @type {string|null} */ to) => {
      const expectedFrom = typeof args.from === 'string' ? args.from : 'HEAD';
      const expectedTo = typeof args.to === 'string' ? args.to : null;
      if (binding.operation !== 'turn.repository.read-diff'
          || from !== expectedFrom || to !== expectedTo) throw mismatch();
      return repositories.diff(requireRepository(), { from, to });
    },
    confirmRestore: async (/** @type {string} */ to) => {
      const ref = requireRepository();
      if (binding.operation !== 'turn.repository.confirm-restore' || to !== args.to) {
        throw mismatch();
      }
      if (typeof ctx?.confirm !== 'function') return false;
      const answer = await ctx.confirm({
        tool: binding.operation, kind: 'repository_restore', sideEffect: 'destructive', origins: [],
        summary: `Restore ${ref.kind} ${ref.id} to ${to.slice(0, 12)}? Current history is retained and the restore becomes a new commit.`,
      }, signal);
      if (signal?.aborted) return false;
      if (approved(answer)) shared.repositoryRestoreApproval = Object.freeze({ to });
      return answer;
    },
    checkpoint: (/** @type {string} */ message) => {
      const expected = typeof args.message === 'string' ? args.message : 'checkpoint';
      if (binding.operation !== 'turn.repository.checkpoint' || message !== expected) {
        throw mismatch();
      }
      return coordinateMutation(
        () => repositories.commit(requireRepository(), { message }), { quiesce: true },
      );
    },
    branch: (/** @type {string} */ name) => {
      if (binding.operation !== 'turn.repository.branch' || name !== args.name) {
        throw mismatch();
      }
      return coordinateMutation(() => repositories.branch(requireRepository(), {
        name, checkout: true,
      }), { quiesce: true });
    },
    checkout: (/** @type {string} */ name) => {
      if (binding.operation !== 'turn.repository.checkout' || name !== args.name) {
        throw mismatch();
      }
      return coordinateMutation(
        () => repositories.checkout(requireRepository(), { name }),
        { quiesce: true, replacesTree: true },
      );
    },
    restore: (/** @type {string} */ to) => {
      const approval = shared.repositoryRestoreApproval;
      shared.repositoryRestoreApproval = null;
      if (binding.operation !== 'turn.repository.restore' || to !== args.to
          || approval?.to !== to) {
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
      if (binding.operation !== 'turn.repository.confirm-remote'
          || branch !== (typeof args.branch === 'string' ? args.branch : undefined)) throw mismatch();
      const candidate = op === 'link'
        ? normalizeGitRemote(args.url)
        : shared.remoteRead ? shared.remote : null;
      if (!candidate || target !== candidate.url) throw mismatch();
      if (typeof ctx?.confirm !== 'function') return false;
      const answer = await ctx.confirm({
        tool: binding.operation, kind: `git_${op}`,
        sideEffect: op === 'push' ? 'mutate_external' : 'write',
        origins: [new URL(target).origin],
        summary: op === 'push'
          ? `Push ${ref.kind} ${ref.id} to ${target} on ${branch || 'its current branch'}? This sends working-tree files${ref.kind === 'app' ? ', including file-backed App data' : ''}, and commit history to the remote.`
          : op === 'fetch'
            ? `Fetch repository metadata and objects for ${ref.kind} ${ref.id} from ${target}?`
            : `Link ${ref.kind} ${ref.id} to Git remote ${target}? Future fetch/push can use its vault-bound host token.`,
      }, signal);
      if (signal?.aborted) return false;
      if (approved(answer)) shared.repositoryRemoteApproval = Object.freeze({
        op, target, branch, remote: Object.freeze({ ...candidate }),
      });
      return answer;
    },
    link: (/** @type {string} */ url) => {
      if (binding.operation !== 'turn.repository.link') throw mismatch();
      consumeRemoteApproval('link', url, undefined);
      return coordinateMutation(() => repositories.setRemote(requireRepository(), { url }));
    },
    fetch: (/** @type {string} */ target) => {
      if (binding.operation !== 'turn.repository.fetch') throw mismatch();
      const approvedRemote = consumeRemoteApproval('fetch', target, undefined);
      return coordinateMutation(async () => {
        const live = await repositories.getRemote(requireRepository());
        if (!sameRemote(live, approvedRemote)) throw new Error(
          'Git remote changed while authorization was pending; review and retry',
        );
        return repositories.fetch(requireRepository(), {
          signal, expectedRemote: approvedRemote.url,
        });
      });
    },
    push: (/** @type {string} */ target, /** @type {string|undefined} */ branch) => {
      const expectedBranch = typeof args.branch === 'string' ? args.branch : undefined;
      if (binding.operation !== 'turn.repository.push' || branch !== expectedBranch) {
        throw mismatch();
      }
      const approvedRemote = consumeRemoteApproval('push', target, branch);
      return coordinateMutation(async () => {
        const live = await repositories.getRemote(requireRepository());
        if (!sameRemote(live, approvedRemote)) throw new Error(
          'Git remote changed while authorization was pending; review and retry',
        );
        await repositories.commit(requireRepository(), { message: 'checkpoint before push' });
        try {
          const result = await repositories.push(requireRepository(), {
            ref: branch, signal, expectedRemote: approvedRemote.url,
          });
          return result?.ok === false
            ? { ...result, performed: true, retryable: false } : result;
        } catch (cause) {
          const failure = cause instanceof Error ? cause : new Error(String(cause));
          Object.assign(failure, { performed: true, retryable: false });
          throw failure;
        }
      }, { quiesce: true });
    },
  });
};

// why: orchestrator and isolated-actor relays must reuse one exact authority
// binding instead of rebuilding domain custody in each route table.
export const bindRepositoryToolAuthority = (
  /** @type {any} */ state, /** @type {any} */ input,
) => {
  const binding = Object.freeze({ operation: input.operation, args: structuredClone(input.args) });
  return createRepositoryToolAuthority({ ...input, binding, shared: state });
};
