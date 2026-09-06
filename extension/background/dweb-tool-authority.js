// @ts-check

import { sha256Hex } from '../shared/util.js';

const mismatch = () => Object.assign(new Error('dweb authority mismatch'), {
  outcomeKnown: true, retryable: false,
});

/** @param {unknown} cause */
const knownFailure = (cause) => {
  if (cause && typeof cause === 'object') {
    Object.assign(cause, { outcomeKnown: true });
    return cause;
  }
  return Object.assign(new Error(String(cause)), { outcomeKnown: true });
};

/** @param {{binding:any,ctx:any,signal?:AbortSignal}} input */
export const createDwebToolAuthority = ({ binding, ctx, signal }) => {
  const args = binding.args ?? {};
  const requireOperation = (/** @type {string} */ operation) => {
    if (binding.operation !== operation) throw mismatch();
  };
  const dwebFor = (/** @type {string} */ operation) => {
    requireOperation(operation);
    if (!ctx?.dweb) return null;
    return ctx.dweb;
  };
  const confirmForced = async (/** @type {any} */ prompt) => {
    // why: publish/install are self-confirming authority operations. They must
    // never inherit approval from the ordinary action preference or from a
    // missing confirmation channel.
    if (typeof ctx?.confirm !== 'function') return false;
    let answer;
    try { answer = await ctx.confirm(prompt, signal ?? ctx.abortSignal); }
    catch (cause) {
      // why: confirmation happens before mesh or app-library mutation.
      throw knownFailure(cause);
    }
    if (answer !== true && answer !== 'yes_once' && answer !== 'yes_session') return false;
    if ((signal ?? ctx.abortSignal)?.aborted) return false;
    const permission = typeof ctx?.readAuthorityPermission === 'function'
      ? await ctx.readAuthorityPermission().catch(() => ({ mode: 'plan' }))
      : ctx?.permission;
    return !(signal ?? ctx.abortSignal)?.aborted && permission?.mode === 'act';
  };
  return Object.freeze({
    discoverApps: () => dwebFor('turn.dweb.discover-apps')?.discover()
      ?? { ok: false, error: 'dweb_unavailable' },
    readPeers: () => dwebFor('turn.dweb.read-peers')?.peers()
      ?? { ok: false, error: 'dweb_unavailable' },
    publishConfirmedApp: async (/** @type {string} */ appId) => {
      const dweb = dwebFor('turn.dweb.publish-confirmed-app');
      if (appId !== String(args?.appId ?? '').trim()) throw mismatch();
      if (!dweb) return { ok: false, error: 'dweb_unavailable' };
      if (typeof dweb.prepareShare !== 'function' || typeof dweb.share !== 'function') {
        return { ok: false, error: 'dweb_share_preparation_unavailable' };
      }
      const prepared = await dweb.prepareShare(appId);
      if (prepared?.ok !== true || prepared.appId !== appId
          || typeof prepared.digest !== 'string') {
        return prepared ?? { ok: false, error: 'dweb_share_preparation_failed' };
      }
      const confirmed = await confirmForced({
        tool: binding.operation, kind: 'dweb_publish', origins: [],
        summary: `Publish App "${String(prepared.name).slice(0, 96)}" (${appId}) to the dweb app store?\n`
          + `Entry: ${String(prepared.entryFile).slice(0, 160)}\n`
          + `Files: ${prepared.fileCount}; bytes: ${prepared.totalBytes}; tree: ${prepared.digest.slice(0, 16)}`,
        sessionId: ctx?.session?.sessionId ?? null,
      });
      if (!confirmed) return { ok: false, error: 'declined', declined: true };
      const result = await dweb.share(appId, prepared);
      if (result?.error === 'share-rollback-failed') return {
        ...result, performed: true, outcomeKnown: false,
        outcomeKind: 'host-lost', retryable: false,
      };
      return result;
    },
    installConfirmedApp: async (
      /** @type {string} */ uri, /** @type {string|undefined} */ name,
    ) => {
      const dweb = dwebFor('turn.dweb.install-confirmed-app');
      if (uri !== String(args?.uri ?? '').trim() || name !== args?.name) throw mismatch();
      if (!dweb) return { ok: false, error: 'dweb_unavailable' };
      const uriDigest = await sha256Hex(uri);
      const displayedUri = uri.length <= 512
        ? uri : `${uri.slice(0, 240)}…${uri.slice(-240)}`;
      const requestedName = typeof name === 'string' && name.trim()
        ? `\nRequested name: ${name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 96)}` : '';
      const confirmed = await confirmForced({
        tool: binding.operation, kind: 'dweb_install', origins: [],
        summary: `Install this peer app?\nIdentity: ${displayedUri}`
          + `\nURI SHA-256: ${uriDigest}${requestedName}`
          + '\nIt runs sandboxed, with no extension access.',
        sessionId: ctx?.session?.sessionId ?? null,
      });
      if (!confirmed) return { ok: false, error: 'declined', declined: true };
      return dweb.install({ uri, name });
    },
    setPeerBlocked: (
      /** @type {string} */ did, /** @type {boolean} */ block,
      /** @type {string|undefined} */ reason,
    ) => {
      const dweb = dwebFor('turn.dweb.set-peer-blocked');
      if (did !== String(args?.did ?? '').trim() || block !== (args?.block !== false)
          || reason !== args?.reason) throw mismatch();
      return dweb?.block({ did, block, reason })
        ?? { ok: false, error: 'dweb_unavailable' };
    },
    setDiscoveryEnabled: (/** @type {boolean} */ enabled) => {
      const dweb = dwebFor('turn.dweb.set-discovery-enabled');
      if (enabled !== args?.enabled) throw mismatch();
      return dweb?.setDiscovery({ enabled })
        ?? { ok: false, error: 'dweb_unavailable' };
    },
    runMeshProgram: async (
      /** @type {string} */ code, /** @type {number} */ timeoutMs,
    ) => {
      requireOperation('turn.dweb.run-mesh-program');
      const expectedTimeout = Math.min(180_000, Math.max(
        1000, Number(args?.timeoutMs ?? 135_000),
      ));
      if (code !== args?.code || timeoutMs !== expectedTimeout) throw mismatch();
      if (!ctx?.dweb) return { ok: false, error: 'a2a_unavailable' };
      const ownerSessionId = ctx?.session?.sessionId;
      const client = ctx?.jsOffscreenClient;
      const runs = ctx?.scriptRuns;
      const abortSignal = signal ?? ctx?.abortSignal;
      if (!client?.execHeadless) return { ok: false, error: 'a2a_unavailable' };
      if (!ownerSessionId) return { ok: false, error: 'a2a: no owner session' };
      if (!runs) return { ok: false, error: 'a2a_run_registry_unavailable' };
      if (abortSignal?.aborted) {
        return { ok: false, error: 'a2a_aborted: the turn was stopped before the run started' };
      }
      const runId = runs.mintRunId(ownerSessionId);
      runs.register(runId, abortSignal, ownerSessionId, { a2a: true });
      const onAbort = () => { void client.abortHeadless?.(runId, ownerSessionId); };
      if (abortSignal && client.abortHeadless) {
        if (abortSignal.aborted) onAbort();
        else abortSignal.addEventListener('abort', onAbort, { once: true });
      }
      try {
        const result = await client.execHeadless(code, {
          timeoutMs, a2a: true, ownerSessionId, runId, signal: abortSignal,
        });
        if (result?.outcomeKnown === false) return {
          ok: false,
          error: 'a2a_nested_host_outcome_unknown',
          outcomeKnown: false,
          outcomeKind: result?.outcomeKind === 'host-lost'
            ? 'host-lost' : 'transport-lost',
          performed: true,
          retryable: false,
          result,
        };
        return { ok: true, result };
      } catch (cause) {
        const custody = /** @type {{executionDispatched?:boolean,outcomeKnown?:boolean,outcomeKind?:string}} */ (cause);
        if (custody?.executionDispatched === true || custody?.outcomeKnown === false
            || custody?.outcomeKind === 'transport-lost') {
          // why: a mesh program may have sent or published before the sealed
          // worker transport failed. Keep that ambiguity non-retryable.
          const failure = cause instanceof Error ? cause : new Error(String(cause));
          Object.assign(failure, {
            executionDispatched: true,
            outcomeKnown: false,
            outcomeKind: 'transport-lost',
            retryable: false,
          });
          throw failure;
        }
        const error = /** @type {{name?:string,message?:string}} */ (cause);
        return {
          ok: false,
          error: `a2a_run_failed: ${error?.name ?? 'Error'}: ${error?.message ?? String(cause)}`,
        };
      } finally {
        runs.release(runId);
        if (abortSignal && client.abortHeadless) {
          abortSignal.removeEventListener?.('abort', onAbort);
        }
      }
    },
  });
};

export const bindDwebToolAuthority = (/** @type {any} */ state, /** @type {any} */ input) =>
  createDwebToolAuthority({
    ...input,
    binding: Object.freeze({ operation: input.operation, args: structuredClone(input.args) }),
  });
