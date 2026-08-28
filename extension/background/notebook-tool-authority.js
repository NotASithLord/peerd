// @ts-check

// Exact Notebook authority for one admitted tool call. The SW owns the live
// worker, OPFS namespace, catalog, tab, repository lock, cancellation, and the
// actor/session binding; the controller owns validation and result shaping.

const mismatch = () => Object.assign(new Error('Notebook authority mismatch'), {
  outcomeKnown: true, retryable: false,
});

/** @param {{binding:any,ctx:any,signal:AbortSignal,shared?:any}} input */
export const createNotebookToolAuthority = ({ binding, ctx, signal, shared = {} }) => {
  const args = binding.args;
  const sessionId = ctx?.session?.sessionId;
  const boundNotebookId = ctx?.actorType === 'notebook' ? ctx.actorInstanceId : null;
  const requireBoundNotebook = (/** @type {unknown} */ notebookId) => {
    if (boundNotebookId && notebookId !== boundNotebookId) throw mismatch();
  };
  const requireOperation = (/** @type {string} */ name) => {
    if (binding.operation !== name) throw mismatch();
  };
  const requireLive = () => {
    if (!signal?.aborted) return;
    throw Object.assign(new Error('Notebook operation stopped before mutation'), {
      outcomeKnown: true, outcomeKind: 'pre-effect-failure', retryable: false,
    });
  };

  return Object.freeze({
    readNotebook: async (/** @type {string} */ notebookId) => {
      if (binding.operation !== 'turn.notebook.read'
          || typeof notebookId !== 'string' || typeof ctx?.jsRegistry?.get !== 'function') {
        throw mismatch();
      }
      if (notebookId !== args.notebookId) throw mismatch();
      requireBoundNotebook(notebookId);
      const record = await ctx.jsRegistry.get(notebookId);
      if (record) shared.resolvedNotebookId = notebookId;
      shared.inspected = record ?? null;
      return record ? {
        id: record.id ?? notebookId, name: String(record.name ?? ''), pinned: record.pinned === true,
      } : null;
    },
    listNotebooks: async () => {
      requireOperation('turn.notebook.list');
      if (typeof ctx?.jsRegistry?.list !== 'function') throw mismatch();
      const records = await ctx.jsRegistry.list();
      return records.filter((/** @type {any} */ record) =>
        !boundNotebookId || record.id === boundNotebookId)
        .map((/** @type {any} */ record) => ({ id: record.id, name: record.name }));
    },
    setDefaultNotebook: async (/** @type {string} */ notebookId) => {
      requireOperation('turn.notebook.set-default');
      if (typeof notebookId !== 'string'
          || typeof ctx?.jsRegistry?.get !== 'function') throw mismatch();
      const record = await ctx.jsRegistry.get(notebookId);
      if (!record || notebookId !== args.notebookId) throw mismatch();
      requireBoundNotebook(notebookId);
      shared.resolvedNotebookId = notebookId;
      if (!sessionId) return false;
      if (typeof ctx?.jsRegistry?.setDefaultForSession !== 'function') throw mismatch();
      requireLive();
      await ctx.jsRegistry.setDefaultForSession(sessionId, notebookId);
      return true;
    },
    runNotebook: (/** @type {string} */ code, /** @type {number} */ timeoutMs,
      /** @type {string|undefined} */ notebookId) => {
      requireOperation('turn.notebook.run');
      if (code !== args.code || timeoutMs !== args.timeoutMs
          || notebookId !== args.notebookId
          || boundNotebookId && notebookId !== undefined && notebookId !== boundNotebookId
          || typeof ctx?.jsClient?.eval !== 'function') throw mismatch();
      return ctx.jsClient.eval(code, {
        timeoutMs, sessionId, notebookId: boundNotebookId ?? notebookId, signal,
      });
    },
    writeFile: (/** @type {string} */ path, /** @type {string} */ content,
      /** @type {string|undefined} */ notebookId) => {
      requireOperation('turn.notebook.write-file');
      if (path !== args.path || content !== args.content || notebookId !== args.notebookId
          || boundNotebookId && notebookId !== undefined && notebookId !== boundNotebookId
          || typeof ctx?.jsClient?.writeFile !== 'function') throw mismatch();
      return ctx.jsClient.writeFile(path, content, {
        sessionId, notebookId: boundNotebookId ?? notebookId,
      });
    },
    readFile: (/** @type {string} */ path, /** @type {string|undefined} */ notebookId) => {
      requireOperation('turn.notebook.read-file');
      if (path !== args.path || notebookId !== args.notebookId
          || boundNotebookId && notebookId !== undefined && notebookId !== boundNotebookId
          || typeof ctx?.jsClient?.readFile !== 'function') throw mismatch();
      return ctx.jsClient.readFile(path, {
        sessionId, notebookId: boundNotebookId ?? notebookId,
      });
    },
    destroyNotebook: async (/** @type {string} */ notebookId) => {
      requireOperation('turn.notebook.destroy');
      requireBoundNotebook(notebookId);
      const repositories = ctx?.repositories;
      if (notebookId !== args.notebookId || shared.inspected?.id !== notebookId
          || shared.inspected?.pinned
          || typeof ctx?.jsRegistry?.get !== 'function'
          || typeof ctx?.jsRegistry?.delete !== 'function'
          || typeof ctx?.jsTabTracker?.closeTab !== 'function'
          || typeof repositories?.coordinate !== 'function'
          || typeof repositories?.destroy !== 'function') throw mismatch();
      return repositories.coordinate({ kind: 'notebook', id: notebookId }, async () => {
        const fresh = await ctx.jsRegistry.get(notebookId);
        if (!fresh || fresh.pinned === true) throw mismatch();
        // why: the repository queue and fresh registry read may both outlive
        // the turn. Retired work must not close the tab or destroy OPFS.
        requireLive();
        await ctx.jsTabTracker.closeTab(notebookId);
        await repositories.destroy({ kind: 'notebook', id: notebookId }, { worktree: true });
        await ctx.jsRegistry.delete(notebookId);
      });
    },
  });
};

export const bindNotebookToolAuthority = (/** @type {any} */ state, /** @type {any} */ input) => {
  const binding = Object.freeze({ operation: input.operation, args: structuredClone(input.args) });
  return createNotebookToolAuthority({ ...input, binding, shared: state });
};
