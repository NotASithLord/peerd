// @ts-check

// Exact Notebook authority for one admitted tool call. The SW owns the live
// worker, OPFS namespace, catalog, tab, repository lock, cancellation, and the
// actor/session binding; the controller owns validation and result shaping.

const mismatch = () => Object.assign(new Error('Notebook authority mismatch'), {
  outcomeKnown: true, retryable: false,
});

/** @param {{call:any,ctx:any,signal:AbortSignal}} input */
export const createNotebookToolAuthority = ({ call, ctx, signal }) => {
  const args = call?.args ?? {};
  const sessionId = ctx?.session?.sessionId;
  /** @type {string|undefined} */ let resolvedNotebookId;
  /** @type {any} */ let inspected = null;
  const requireTool = (/** @type {string} */ name) => {
    if (call?.name !== name) throw mismatch();
  };

  return Object.freeze({
    readNotebook: async (/** @type {string} */ notebookId) => {
      if (!['js_notebook', 'js_delete'].includes(call?.name)
          || typeof notebookId !== 'string' || typeof ctx?.jsRegistry?.get !== 'function') {
        throw mismatch();
      }
      if (call.name === 'js_notebook') {
        const wanted = typeof args.notebook === 'string' ? args.notebook.trim() : '';
        if (!wanted.startsWith('notebook-') || notebookId !== wanted) throw mismatch();
      } else if (notebookId !== args.notebookId) throw mismatch();
      const record = await ctx.jsRegistry.get(notebookId);
      if (record && call.name === 'js_notebook') resolvedNotebookId = notebookId;
      if (call.name === 'js_delete') inspected = record ?? null;
      return record ? {
        id: record.id ?? notebookId, name: String(record.name ?? ''), pinned: record.pinned === true,
      } : null;
    },
    listNotebooks: async () => {
      requireTool('js_notebook');
      const wanted = typeof args.notebook === 'string' ? args.notebook.trim() : '';
      if (!wanted || wanted.startsWith('notebook-')
          || typeof ctx?.jsRegistry?.list !== 'function') throw mismatch();
      const records = await ctx.jsRegistry.list();
      return records.map((/** @type {any} */ record) => ({ id: record.id, name: record.name }));
    },
    setDefaultNotebook: async (/** @type {string} */ notebookId) => {
      requireTool('js_notebook');
      const wanted = typeof args.notebook === 'string' ? args.notebook.trim() : '';
      if (!wanted || typeof notebookId !== 'string'
          || typeof ctx?.jsRegistry?.get !== 'function') throw mismatch();
      const record = await ctx.jsRegistry.get(notebookId);
      if (!record || (wanted.startsWith('notebook-') ? notebookId !== wanted
        : String(record.name).toLowerCase() !== wanted.toLowerCase())) throw mismatch();
      resolvedNotebookId = notebookId;
      if (!sessionId) return undefined;
      if (typeof ctx?.jsRegistry?.setDefaultForSession !== 'function') throw mismatch();
      return ctx.jsRegistry.setDefaultForSession(sessionId, notebookId);
    },
    runNotebook: (/** @type {string} */ code, /** @type {number} */ timeoutMs,
      /** @type {string|undefined} */ notebookId) => {
      requireTool('js_notebook');
      const expectedTimeout = Math.min(120_000, Math.max(1000, Number(args.timeoutMs ?? 30_000)));
      const explicit = typeof args.notebook === 'string' && args.notebook.trim();
      if (code !== args.code || timeoutMs !== expectedTimeout
          || (explicit && notebookId !== resolvedNotebookId)
          || (!explicit && notebookId !== undefined)
          || typeof ctx?.jsClient?.eval !== 'function') throw mismatch();
      return ctx.jsClient.eval(code, { timeoutMs, sessionId, notebookId, signal });
    },
    writeFile: (/** @type {string} */ path, /** @type {string} */ content,
      /** @type {string|undefined} */ notebookId) => {
      requireTool('js_write_file');
      if (path !== args.path || content !== args.content || notebookId !== args.notebook
          || typeof ctx?.jsClient?.writeFile !== 'function') throw mismatch();
      return ctx.jsClient.writeFile(path, content, { sessionId, notebookId });
    },
    readFile: (/** @type {string} */ path, /** @type {string|undefined} */ notebookId) => {
      requireTool('js_read_file');
      if (path !== args.path || notebookId !== args.notebook
          || typeof ctx?.jsClient?.readFile !== 'function') throw mismatch();
      return ctx.jsClient.readFile(path, { sessionId, notebookId });
    },
    destroyNotebook: async (/** @type {string} */ notebookId) => {
      requireTool('js_delete');
      const repositories = ctx?.repositories;
      if (notebookId !== args.notebookId || inspected?.id !== notebookId || inspected?.pinned
          || typeof ctx?.jsRegistry?.get !== 'function'
          || typeof ctx?.jsRegistry?.delete !== 'function'
          || typeof ctx?.jsTabTracker?.closeTab !== 'function'
          || typeof repositories?.coordinate !== 'function'
          || typeof repositories?.destroy !== 'function') throw mismatch();
      return repositories.coordinate({ kind: 'notebook', id: notebookId }, async () => {
        const fresh = await ctx.jsRegistry.get(notebookId);
        if (!fresh || fresh.pinned === true) throw mismatch();
        await ctx.jsTabTracker.closeTab(notebookId);
        await repositories.destroy({ kind: 'notebook', id: notebookId }, { worktree: true });
        await ctx.jsRegistry.delete(notebookId);
      });
    },
  });
};
