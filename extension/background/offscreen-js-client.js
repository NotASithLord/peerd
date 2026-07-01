// @ts-check
// background/offscreen-js-client.js — SW-side client for headless JS jobs.
//
// Runs the agent's `js_run` code in a sealed Worker hosted by the OFFSCREEN
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
   * @param {{ timeoutMs?: number, caps?: { page?: boolean, egress?: boolean, subagent?: boolean, opfs?: boolean }, ownerSessionId?: string }} [opts]
   *   caps: capability profile for the sealed worker (default = the historical
   *   js_run surface). ownerSessionId: the actor session this job runs FOR —
   *   required by the page bridge; set only from a trusted ctx (PR #119).
   * @returns {Promise<{ value: unknown, consoleOutput: {level:string,text:string}[], durationMs: number, error: string|null }>}
   */
  execHeadless: async (code, { timeoutMs, caps, ownerSessionId } = {}) => {
    await ensureOffscreen();
    const reply = await sendMessage({ type: 'job/run', code, timeoutMs, caps, ownerSessionId });
    if (!reply?.ok) throw new Error(reply?.error ?? 'headless job failed');
    return reply.result;
  },
});
