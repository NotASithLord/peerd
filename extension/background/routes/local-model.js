// @ts-check
// background/routes/local-model.js — local WebGPU runner control
// (FEATURE-LOCAL-WEBGPU B). status/probe are read-only; init triggers the
// (one-time) model download in the offscreen engine. All ensure the offscreen
// doc + forward to the host (local-model/host/*); status/init flip the
// local-model store's `available` (feeds resolveRunnerModel step 2).
//
// Unblocked by background/local-model-state.js. Bodies verbatim, imports none.

/**
 * @param {Record<string, any>} deps
 * @returns {Record<string, (msg?: any) => Promise<any>>}
 */
export const makeLocalModelRoutes = (deps) => {
  const { ensureOffscreen, browser, localModelState } = deps;

  return {
    'local-model/status': async () => {
      await ensureOffscreen();
      const r = await browser.runtime.sendMessage({ type: 'local-model/host/status' });
      localModelState.setAvailable(!!(r?.available || r?.downloaded)); // cached counts as usable (lazy-loads on first use)
      // include the last progress event so Settings (which keeps no port) can show
      // a phase hint while the model downloads.
      return r ? { ...r, progress: localModelState.progress() } : { ok: false };
    },
    'local-model/probe': async () => {
      await ensureOffscreen();
      return (await browser.runtime.sendMessage({ type: 'local-model/host/probe' })) ?? { ok: false };
    },
    'local-model/init': async () => {
      await ensureOffscreen();
      const r = await browser.runtime.sendMessage({ type: 'local-model/host/init' });
      localModelState.setAvailable(!!(r?.available || r?.downloaded)); // cached counts as usable (lazy-loads on first use)
      return r ?? { ok: false };
    },
  };
};
