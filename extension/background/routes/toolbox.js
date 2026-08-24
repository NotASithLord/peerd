// @ts-check
// background/routes/toolbox.js — design js-superpower/06: the resolution +
// rot-bookkeeping routes for toolbox modules.
//
// 'toolbox/read' is the resolver relay: the Notebook tab and the offscreen
// job-runner fetch a module BODY here at import-resolution time. Bodies are
// EXECUTE-ONLY — this route feeds the sealed worker's resolver, never a
// prompt. Lane gating does NOT live here (both hosts are first-party and the
// dispatcher already refuses untrusted senders); it lives at the hosts, as dep
// injection: a job that must not resolve toolbox modules never gets the
// resolver dep, so the request is never made — and a forged request would
// still only yield bytes into a sealed, keyless worker realm.
//
// 'toolbox/record' is the treat-as-cache bookkeeping: hosts report, after a
// run settles, which toolbox modules it imported and whether it succeeded
// (runCount/failCount on the meta — the rot signal toolbox_list surfaces).
// Imports nothing (the store validates names/shapes).

/**
 * @param {Record<string, any>} deps
 * @returns {Record<string, (msg?: any) => Promise<any>>}
 */
export const makeToolboxRoutes = (deps) => {
  const { toolboxStore } = deps;

  return {
    'toolbox/read': async ({ name } = {}) => {
      try {
        const body = await toolboxStore.getBody(name);
        if (body == null) return { ok: false, error: `unknown toolbox module '${String(name)}'; toolbox_list shows what exists` };
        return { ok: true, body };
      } catch (e) { return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) }; }
    },

    'toolbox/record': async ({ names, ok } = {}) => {
      try {
        await toolboxStore.recordRuns(Array.isArray(names) ? names : [], { ok: ok === true });
        return { ok: true };
      } catch (e) {
        void e;
        return {
          ok: false,
          error: 'Peerd could not confirm whether Toolbox run bookkeeping finished. '
            + 'Refresh before recording it again.',
          code: 'toolbox-record-outcome-unknown',
          outcomeKnown: false,
          outcomeKind: 'unknown',
          retryable: false,
        };
      }
    },
  };
};
