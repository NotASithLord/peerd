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
   * @param {{ timeoutMs?: number }} [opts]
   * @returns {Promise<{ value: unknown, consoleOutput: {level:string,text:string}[], durationMs: number, error: string|null }>}
   */
  execHeadless: async (code, { timeoutMs } = {}) => {
    await ensureOffscreen();
    const reply = await sendMessage({ type: 'job/run', code, timeoutMs });
    if (!reply?.ok) throw new Error(reply?.error ?? 'headless job failed');
    return reply.result;
  },
});
