// @ts-check

// Exact App authority for one admitted tool call. The SW owns the OPFS tree,
// catalog, tab, repository lock, session default, and actor binding; the
// controller owns validation, search presentation, paging, and result shaping.

const mismatch = () => Object.assign(new Error('App authority mismatch'), {
  outcomeKnown: true, retryable: false,
});

/** @param {unknown} left @param {unknown} right */
const sameClone = (left, right) => {
  try { return JSON.stringify(left) === JSON.stringify(right); }
  catch { return false; }
};

/** @param {{call:any,ctx:any}} input */
export const createAppToolAuthority = ({ call, ctx }) => {
  const args = call?.args ?? {};
  const sessionId = ctx?.session?.sessionId;
  /** @type {{id:string,name:string}|null} */ let inspected = null;
  const requireTool = (/** @type {string} */ name) => {
    if (call?.name !== name) throw mismatch();
  };
  const sameApp = (/** @type {unknown} */ appId) => appId === args.appId;

  return Object.freeze({
    updateApp: async (
      /** @type {string|undefined} */ appId,
      /** @type {string|undefined} */ name,
      /** @type {string|undefined} */ html,
      /** @type {string[]|undefined} */ tags,
      /** @type {string|undefined} */ entryFile,
    ) => {
      requireTool('app_update');
      if (!sameApp(appId) || name !== args.name || html !== args.html
          || entryFile !== args.entryFile || !sameClone(tags, args.tags)
          || typeof ctx?.appClient?.update !== 'function') throw mismatch();
      const record = await ctx.appClient.update({
        appId, name, html, tags, entryFile, sessionId,
      });
      return record ? {
        id: record.id, name: record.name, entryFile: record.entryFile,
        updatedAt: record.updatedAt,
      } : null;
    },
    openApp: async (/** @type {string} */ appId) => {
      requireTool('app_open');
      if (appId !== args.appId || typeof ctx?.appClient?.open !== 'function') throw mismatch();
      return ctx.appClient.open({ appId, sessionId, focus: false });
    },
    searchApps: async (/** @type {string} */ query) => {
      requireTool('app_search');
      if (query !== String(args.query ?? '').trim()
          || typeof ctx?.appClient?.search !== 'function') throw mismatch();
      const hits = await ctx.appClient.search(query);
      return hits.map((/** @type {any} */ hit) => ({
        app: {
          id: hit.app.id, name: hit.app.name, tags: hit.app.tags,
          updatedAt: hit.app.updatedAt,
        },
        snippet: hit.snippet,
      }));
    },
    readApp: async (/** @type {string} */ appId) => {
      requireTool('app_delete');
      if (appId !== args.appId || typeof ctx?.appRegistry?.get !== 'function') throw mismatch();
      const record = await ctx.appRegistry.get(appId);
      inspected = record ? { id: record.id ?? appId, name: String(record.name ?? '') } : null;
      return inspected;
    },
    deleteApp: async (/** @type {string} */ appId) => {
      requireTool('app_delete');
      if (appId !== args.appId || inspected?.id !== appId
          || typeof ctx?.appRegistry?.get !== 'function'
          || typeof ctx?.appClient?.delete !== 'function') throw mismatch();
      const fresh = await ctx.appRegistry.get(appId);
      if (!fresh) throw mismatch();
      return ctx.appClient.delete(appId);
    },
    writeFile: (
      /** @type {string|undefined} */ appId,
      /** @type {string} */ path,
      /** @type {unknown} */ content,
    ) => {
      requireTool('app_write_file');
      const expected = typeof args.contentBase64 === 'string'
        ? { base64: args.contentBase64 }
        : args.content;
      if (!sameApp(appId) || path !== args.path || !sameClone(content, expected)
          || typeof ctx?.appClient?.writeFile !== 'function') throw mismatch();
      return ctx.appClient.writeFile({ appId, path, content, sessionId });
    },
    readFile: (/** @type {string|undefined} */ appId, /** @type {string} */ path) => {
      requireTool('app_read_file');
      if (!sameApp(appId) || path !== args.path
          || typeof ctx?.appClient?.readFile !== 'function') throw mismatch();
      return ctx.appClient.readFile({ appId, path, sessionId });
    },
    listFiles: async (/** @type {string|undefined} */ appId) => {
      requireTool('app_list_files');
      if (!sameApp(appId) || typeof ctx?.appClient?.listFiles !== 'function') throw mismatch();
      const files = await ctx.appClient.listFiles({ appId, sessionId });
      return files.map((/** @type {any} */ file) => ({ path: file.path, size: file.size }));
    },
    deleteFile: (
      /** @type {string|undefined} */ appId, /** @type {string} */ path,
    ) => {
      requireTool('app_delete_file');
      if (!sameApp(appId) || path !== args.path
          || typeof ctx?.appClient?.deleteFile !== 'function') throw mismatch();
      return ctx.appClient.deleteFile({ appId, path, sessionId });
    },
  });
};
