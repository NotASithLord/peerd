// @ts-check
// background/routes/ralph.js — the Ralph persistent-loop control routes.
//
// Thin relays to the bound ralphDriver + plan store; no reassigned module
// state. Bodies verbatim, deps injected, imports none.

/**
 * @param {Record<string, any>} deps
 * @returns {Record<string, (msg?: any) => Promise<any>>}
 */
export const makeRalphRoutes = (deps) => {
  const { vault, ralphDriver, ralphPlanStore } = deps;

  return {
    // --- ralph (persistent fresh-context loop) ---
    //
    // Start/stop/status surface for the side panel's Ralph panel. The
    // orchestration lives in makeRalphDriver (peerd-runtime/ralph): start
    // refuses unless Act mode with confirmations off allows unattended
    // commits, driving runs in budgeted bursts so a single SW awake-window
    // can't be exceeded, and the persisted state lets a restart resume
    // mid-run.
    'ralph/start': async ({ maxIterations, mode } = {}) => {
      if (vault.isLocked()) return { ok: false, error: 'locked' };
      return ralphDriver.start({ maxIterations, mode });
    },

    'ralph/halt': async () => ralphDriver.halt(),

    'ralph/status': async () => {
      const s = await ralphDriver.status();
      return { ok: true, ...s };
    },

    // Read/write the plan file directly (PLANNING surface: the user can
    // hand-edit the plan, or seed a goal before starting a run).
    'ralph/getPlan': async () => ({ ok: true, text: await ralphPlanStore.loadText() }),
    'ralph/setPlan': async ({ text }) => {
      if (typeof text !== 'string') return { ok: false, error: 'text-required' };
      await ralphPlanStore.saveText(text);
      return { ok: true };
    },

    'ralph/reset': async () => {
      await ralphDriver.reset();
      return { ok: true };
    },
  };
};
