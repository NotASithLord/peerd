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
   * @param {{ timeoutMs?: number, a2a?: boolean, actors?: boolean, ownerSessionId?: string, ownerToolUseId?: string, runId?: string }} [opts]
   *   a2a: expose the `mesh` agent-to-agent client; actors: expose the `actors`
   *   delegation client (the script surface). ownerSessionId / ownerToolUseId /
   *   runId ride as trusted job params to the relay routes.
   * @returns {Promise<{ value: unknown, consoleOutput: {level:string,text:string}[], durationMs: number, error: string|null, usedEgress?: boolean, usedActors?: boolean, actorsTrace?: Array<{ seq: number, method: string, to?: string, goal?: string, ok: boolean, ms: number, error?: string }> }>}
   */
  execHeadless: async (code, { timeoutMs, a2a, ownerSessionId, actors, ownerToolUseId, runId } = {}) => {
    await ensureOffscreen();
    const reply = await sendMessage({
      type: 'job/run', code, timeoutMs,
      ...(a2a ? { a2a: true, ownerSessionId } : {}),
      ...(actors ? { actors: true, ownerSessionId, ownerToolUseId, runId } : {}),
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
