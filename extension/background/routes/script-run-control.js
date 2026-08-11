// @ts-check
// Control-plane route for a settled headless run. Kept outside the service
// worker wiring so the exact sender/owner/abort contract is directly testable.

/**
 * @param {{
 *   scriptRuns: { ownerFor: (runId: string) => string|null, abort: (runId: string) => void },
 *   isOffscreenSender: (sender: any) => boolean,
 * }} deps
 */
export const makeScriptRunControlRoutes = (deps) => {
  const { scriptRuns, isOffscreenSender } = deps;
  return {
    /** @param {{ runId?: string, ownerSessionId?: string }} msg @param {any} sender */
    'script-run/abort': (msg = {}, sender = undefined) => {
      if (!isOffscreenSender(sender)) return { ok: false, error: 'script_run_abort_unauthorized_relay' };
      if (typeof msg.runId !== 'string' || !msg.runId
        || typeof msg.ownerSessionId !== 'string' || !msg.ownerSessionId
        || scriptRuns.ownerFor(msg.runId) !== msg.ownerSessionId) {
        return { ok: false, error: 'script_run_abort_unknown_finished_or_foreign_run' };
      }
      scriptRuns.abort(msg.runId);
      return { ok: true };
    },
  };
};
