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
   * @param {{ timeoutMs?: number, a2a?: boolean, actors?: boolean, siteFetch?: string, caps?: { page?: boolean, egress?: boolean, subagent?: boolean, opfs?: boolean }, ownerSessionId?: string, ownerToolUseId?: string, runId?: string }} [opts]
   *   a2a: expose the `mesh` agent-to-agent client; actors: expose the `actors`
   *   delegation client (the script surface). caps: capability profile for the
   *   sealed worker (default = the historical js_run surface); caps.page also
   *   needs ownerSessionId — the actor session the page bridge dispatches FOR,
   *   set only from a trusted ctx (PR #119). ownerSessionId / ownerToolUseId /
   *   runId ride as trusted job params to the relay routes. runId forwards on
   *   ANY lane (#153) — a runId-carrying job registers with the runner's
   *   liveJobs map, which is what lets abortHeadless terminate it on Stop.
   * @returns {Promise<{ value: unknown, consoleOutput: {level:string,text:string}[], durationMs: number, error: string|null, usedEgress?: boolean, usedActors?: boolean, actorsTrace?: Array<{ seq: number, method: string, to?: string, goal?: string, ok: boolean, ms: number, error?: string }> }>}
   */
  execHeadless: async (code, { timeoutMs, a2a, ownerSessionId, actors, ownerToolUseId, runId, caps, siteFetch } = {}) => {
    await ensureOffscreen();
    const reply = await sendMessage({
      type: 'job/run', code, timeoutMs,
      ...(a2a ? { a2a: true, ownerSessionId } : {}),
      ...(actors ? { actors: true, ownerSessionId, ownerToolUseId } : {}),
      // DESIGN-19: a site-client run — the pinned origin + its owner ride as trusted
      // job params; job-runner forces every other cap off.
      ...(siteFetch ? { siteFetch, ownerSessionId } : {}),
      ...(caps ? { caps, ownerSessionId } : {}),
      ...(runId ? { runId } : {}),
    });
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
