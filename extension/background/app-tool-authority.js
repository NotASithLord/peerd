// @ts-check

// Exact App authority for one admitted tool call. The SW owns the OPFS tree,
// catalog, tab, repository lock, session default, and actor binding; the
// controller owns validation, search presentation, paging, and result shaping.

import { sameCanonicalStructuredClone } from '/shared/canonical-clone-digest.js';

const APP_AUTHORITY_ARGUMENT_BYTES = 8 * 1024 * 1024;

const mismatch = () => Object.assign(new Error('App authority mismatch'), {
  outcomeKnown: true, retryable: false,
});

/** @param {{binding:any,ctx:any,signal?:AbortSignal,shared?:any,appProgramSemanticToken?:string}} input */
export const createAppToolAuthority = ({
  binding, ctx, signal = ctx?.abortSignal, shared = {}, appProgramSemanticToken,
}) => {
  const args = binding.args;
  const sessionId = ctx?.session?.sessionId;
  const boundAppId = ctx?.actorType === 'app' ? ctx.actorInstanceId : null;
  const requireOperation = (/** @type {string} */ name) => {
    if (binding.operation !== name) throw mismatch();
  };
  const sameApp = (/** @type {unknown} */ appId) => boundAppId
    ? appId === undefined || appId === boundAppId
    : appId === args.appId;
  const appIdFor = (/** @type {string|undefined} */ appId) => boundAppId ?? appId;
  const requireLive = () => {
    if (!signal?.aborted) return;
    throw Object.assign(new Error('App operation stopped before mutation'), {
      outcomeKnown: true, outcomeKind: 'pre-effect-failure', retryable: false,
    });
  };

  return Object.freeze({
    updateApp: async (
      /** @type {string|undefined} */ appId,
      /** @type {string|undefined} */ name,
      /** @type {string|undefined} */ html,
      /** @type {string[]|undefined} */ tags,
      /** @type {string|undefined} */ entryFile,
    ) => {
      requireOperation('turn.app.update');
      if (!sameApp(appId) || name !== args.name || html !== args.html
          || entryFile !== args.entryFile || !sameCanonicalStructuredClone(
            tags, args.tags, { maxBytes: APP_AUTHORITY_ARGUMENT_BYTES },
          )
          || typeof ctx?.appClient?.update !== 'function') throw mismatch();
      const record = await ctx.appClient.update({
        appId: appIdFor(appId), name, html, tags, entryFile, sessionId, signal,
      });
      return record ? {
        id: record.id, name: record.name, entryFile: record.entryFile,
        updatedAt: record.updatedAt,
      } : null;
    },
    openApp: async (/** @type {string} */ appId) => {
      requireOperation('turn.app.open');
      if (boundAppId || appId !== args.appId || typeof ctx?.appClient?.open !== 'function') {
        throw mismatch();
      }
      return ctx.appClient.open({ appId, sessionId, focus: false });
    },
    searchApps: async (/** @type {string} */ query) => {
      requireOperation('turn.app.search');
      if (boundAppId || query !== String(args.query ?? '').trim()
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
      requireOperation('turn.app.read');
      if (!sameApp(appId) || typeof ctx?.appRegistry?.get !== 'function') throw mismatch();
      const targetAppId = appIdFor(appId);
      const record = await ctx.appRegistry.get(targetAppId);
      shared.inspected = record
        ? { id: record.id ?? targetAppId, name: String(record.name ?? '') } : null;
      return shared.inspected;
    },
    deleteApp: async (/** @type {string} */ appId) => {
      requireOperation('turn.app.delete');
      const targetAppId = appIdFor(appId);
      if (!sameApp(appId) || shared.inspected?.id !== targetAppId
          || typeof ctx?.appRegistry?.get !== 'function'
          || typeof ctx?.appClient?.delete !== 'function') throw mismatch();
      const fresh = await ctx.appRegistry.get(targetAppId);
      if (!fresh) throw mismatch();
      // why: the registry probe may wait behind another App mutation. Stop
      // must still win before deletion crosses its first physical edge.
      requireLive();
      return ctx.appClient.delete(targetAppId);
    },
    writeFile: (
      /** @type {string|undefined} */ appId,
      /** @type {string} */ path,
      /** @type {unknown} */ content,
    ) => {
      requireOperation('turn.app.write-file');
      const expected = typeof args.contentBase64 === 'string'
        ? { base64: args.contentBase64 }
        : args.content;
      if (!sameApp(appId) || path !== args.path || !sameCanonicalStructuredClone(
        content, expected, { maxBytes: APP_AUTHORITY_ARGUMENT_BYTES },
      )
          || typeof ctx?.appClient?.writeFile !== 'function') throw mismatch();
      return ctx.appClient.writeFile({
        appId: appIdFor(appId), path, content, sessionId, signal,
      });
    },
    readFile: (/** @type {string|undefined} */ appId, /** @type {string} */ path) => {
      requireOperation('turn.app.read-file');
      if (!sameApp(appId) || path !== args.path
          || typeof ctx?.appClient?.readFile !== 'function') throw mismatch();
      return ctx.appClient.readFile({ appId: appIdFor(appId), path, sessionId });
    },
    listFiles: async (/** @type {string|undefined} */ appId) => {
      requireOperation('turn.app.list-files');
      if (!sameApp(appId) || typeof ctx?.appClient?.listFiles !== 'function') throw mismatch();
      const files = await ctx.appClient.listFiles({ appId: appIdFor(appId), sessionId });
      return files.map((/** @type {any} */ file) => ({ path: file.path, size: file.size }));
    },
    deleteFile: (
      /** @type {string|undefined} */ appId, /** @type {string} */ path,
    ) => {
      requireOperation('turn.app.delete-file');
      if (!sameApp(appId) || path !== args.path
          || typeof ctx?.appClient?.deleteFile !== 'function') throw mismatch();
      return ctx.appClient.deleteFile({ appId: appIdFor(appId), path, sessionId, signal });
    },
    observeRuntime: () => {
      requireOperation('turn.app.observe');
      if (typeof ctx?.appAgentCall !== 'function') return {
        ok: false, error: 'app_playtest_not_available', outcomeKnown: true,
        outcomeKind: 'pre-effect-failure',
      };
      return ctx.appAgentCall('observe', {}, signal);
    },
    actRuntime: (/** @type {string} */ action, /** @type {Record<string,unknown>} */ params) => {
      requireOperation('turn.app.act');
      if (action !== args.action || !sameCanonicalStructuredClone(
        params, args.params ?? {}, { maxBytes: APP_AUTHORITY_ARGUMENT_BYTES },
      )) throw mismatch();
      if (typeof ctx?.appAgentCall !== 'function') return {
        ok: false, error: 'app_playtest_not_available', outcomeKnown: true,
        outcomeKind: 'pre-effect-failure',
      };
      return ctx.appAgentCall('act', { action, params }, signal);
    },
    runCode: async (/** @type {string} */ code, /** @type {number} */ timeoutMs) => {
      requireOperation('turn.app.run-code');
      const expectedTimeout = Math.min(180_000, Math.max(1000, Number(args.timeoutMs ?? 60_000)));
      if (code !== args.code || timeoutMs !== expectedTimeout) throw mismatch();
      const client = ctx?.jsOffscreenClient;
      if (typeof client?.execHeadless !== 'function') return { refusal: 'app_code_unavailable' };
      if (typeof sessionId !== 'string' || !sessionId) {
        return { refusal: 'app_code_requires_actor_session' };
      }
      const scriptRuns = ctx?.scriptRuns;
      if (!scriptRuns) return { refusal: 'app_code_run_registry_unavailable' };
      if (signal?.aborted) return { aborted: true };
      const runId = scriptRuns.mintRunId(sessionId);
      scriptRuns.register(runId, signal, sessionId, { app: true });
      let executionDispatched = false;
      const onAbort = typeof client.abortHeadless === 'function'
        ? () => { client.abortHeadless(runId, sessionId); }
        : null;
      if (onAbort && signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      try {
        return await client.execHeadless(code, {
          timeoutMs,
          caps: { app: true, page: false, egress: false, subagent: false, opfs: false },
          ownerSessionId: sessionId,
          runId,
          ...(appProgramSemanticToken ? { appProgramSemanticToken } : {}),
          signal,
          onExecutionDispatch: () => { executionDispatched = true; },
        });
      } catch (cause) {
        const failure = cause instanceof Error ? cause : new Error(String(cause));
        Object.assign(failure, {
          executionDispatched: executionDispatched
            || /** @type {{executionDispatched?:boolean}} */ (cause)?.executionDispatched === true,
          outcomeKnown: executionDispatched
            ? false : /** @type {{outcomeKnown?:boolean}} */ (cause)?.outcomeKnown,
        });
        throw failure;
      } finally {
        scriptRuns.release(runId);
        if (onAbort && signal) {
          try { signal.removeEventListener?.('abort', onAbort); } catch { /* stub */ }
        }
      }
    },
  });
};

export const bindAppToolAuthority = (/** @type {any} */ state, /** @type {any} */ input) => {
  const binding = Object.freeze({ operation: input.operation, args: structuredClone(input.args) });
  return createAppToolAuthority({ ...input, binding, shared: state });
};
