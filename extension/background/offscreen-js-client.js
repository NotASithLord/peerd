// @ts-check
// background/offscreen-js-client.js — SW-side client for headless JS jobs.
//
// Runs the agent's `script` code in a sealed Worker hosted by the OFFSCREEN
// document (no tab). It ensures the offscreen doc exists, dispatches the job,
// and returns the run result. Dependencies are injected (ensureOffscreen +
// sendMessage) so it stays a pure, testable shell.

/**
 * @param {Object} deps
 * @param {() => Promise<void>} deps.ensureOffscreen   create the offscreen doc if absent
 * @param {(msg: object) => Promise<any>} deps.sendMessage   runtime.sendMessage → offscreen
 */
export const makeOffscreenJsClient = ({ ensureOffscreen, sendMessage }) => ({
  /**
   * @param {string} code
   * @param {{ timeoutMs?: number, a2a?: boolean, actors?: boolean, siteFetch?: string, toolbox?: boolean, caps?: { page?: boolean, egress?: boolean, subagent?: boolean, opfs?: boolean, provider?: boolean }, ownerSessionId?: string, ownerToolUseId?: string, runId?: string, workspaceSessionId?: string, signal?: AbortSignal }} [opts]
   *   a2a: expose the `mesh` agent-to-agent client; actors: expose the `actors`
   *   delegation client (the script surface for chat or a granted spawned actor).
   *   caps: capability profile for the
   *   sealed worker (default = the historical js_run surface); caps.page also
   *   needs ownerSessionId — the actor session the page bridge dispatches FOR,
   *   set only from a trusted ctx (PR #119). ownerSessionId / ownerToolUseId /
   *   runId ride as trusted job params to the relay routes. runId forwards on
   *   ANY lane (#153) — a runId-carrying job registers with the runner's
   *   liveJobs map, which is what lets abortHeadless terminate it on Stop.
   *   workspaceSessionId mounts the durable per-session workspace as the job's
   *   OPFS root (trusted job param — the tool derives it from ctx.session, the
   *   worker can never name its own root).
   * @returns {Promise<{ value: unknown, consoleOutput: {level:string,text:string}[], durationMs: number, error: string|null, errorCode?: string, endTurn?: boolean, endTurnContent?: string, usedEgress?: boolean, usedRemoteModules?: boolean, usedActors?: boolean, actorDeliveryIds?: string[], usedWorkspace?: boolean, workspaceOverBudget?: boolean, actorsTrace?: Array<{ seq: number, method: string, to?: string, goal?: string, ok: boolean, ms: number, error?: string, settled?: boolean, actorFailed?: boolean, cancelled?: boolean }>, usedProvider?: boolean, providerCalls?: number, providerTokens?: number }>}
   */
  execHeadless: async (code, { timeoutMs, a2a, ownerSessionId, actors, ownerToolUseId, runId, caps, siteFetch, toolbox, workspaceSessionId, signal } = {}) => {
    const wallMs = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs)
      ? Math.max(1, Math.floor(timeoutMs)) : 30_000;
    // Epoch time crosses the SW→offscreen realm boundary; performance.now()
    // does not. Mint ONCE before startup so document creation, dispatch,
    // workspace mount, module resolution, execution, and bounded cleanup all
    // spend the same advertised wall-clock.
    const startedAt = Date.now();
    const deadlineAt = startedAt + wallMs;
    /** @template T @param {Promise<T>} promise @param {string} phase */
    const withinDeadline = (promise, phase) => new Promise((resolve, reject) => {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) { reject(new Error(`headless job timed out during ${phase}`)); return; }
      let settled = false;
      /** @param {(value: any) => void} fn @param {any} value */
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        fn(value);
      };
      const onAbort = () => finish(reject, new Error(
        phase === 'offscreen startup' ? 'headless job aborted before dispatch' : `headless job aborted during ${phase}`,
      ));
      const timer = setTimeout(() => finish(reject, new Error(`headless job timed out during ${phase}`)), remaining);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
    });
    await withinDeadline(ensureOffscreen(), 'offscreen startup');
    // why: Stop may arrive while the offscreen document is still being
    // created. In that window job/abort has nowhere to leave its early-abort
    // tombstone, so launching after ensureOffscreen would orphan the worker
    // until its wall-clock. The signal is local-only (never cloned into the
    // message); there is no await between this check and dispatch.
    if (signal?.aborted) throw new Error('headless job aborted before dispatch');
    const reply = await withinDeadline(sendMessage({
      type: 'job/run', code, timeoutMs: wallMs, startedAt, deadlineAt,
      ...(a2a ? { a2a: true, ownerSessionId } : {}),
      ...(actors ? { actors: true, ownerSessionId, ownerToolUseId } : {}),
      // DESIGN-19: a site-client run — the pinned origin + its owner ride as trusted
      // job params; job-runner forces every other cap off.
      ...(siteFetch ? { siteFetch, ownerSessionId } : {}),
      // design 06: the script lane's toolbox-resolution flag (trusted job param).
      ...(toolbox ? { toolbox: true } : {}),
      ...(caps ? { caps, ownerSessionId } : {}),
      ...(runId ? { runId } : {}),
      ...(workspaceSessionId ? { workspaceSessionId } : {}),
    }), 'execution');
    if (!reply?.ok) throw new Error(reply?.error ?? 'headless job failed');
    return reply.result;
  },
  /**
   * Terminate a runId-carrying headless job (Stop plumbing). Best-effort —
   * a job that already finished is a no-op.
   * @param {string} runId @param {string} [ownerSessionId]
   */
  abortHeadless: async (runId, ownerSessionId) => {
    try { await sendMessage({ type: 'job/abort', runId, ownerSessionId }); } catch { /* offscreen gone = job gone */ }
  },
});
