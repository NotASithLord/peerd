// @ts-check
// background/routes/local-model.js — local WebGPU runner control
// (FEATURE-LOCAL-WEBGPU B). status/probe are read-only; init triggers the
// (one-time) model download in the offscreen engine. Unsupported hosts refuse
// before offscreen startup. Supported routes forward to local-model/host/*;
// status/init update the local-model store used by runner resolution.

/**
 * @param {Record<string, any>} deps
 * @returns {Record<string, (msg?: any) => Promise<any>>}
 */
export const makeLocalModelRoutes = (deps) => {
  const {
    ensureOffscreen, browser, localModelState, localModelHostAvailable, pushState,
    onProviderConfigChanged,
  } = deps;
  const unavailable = () => ({
    ok: false,
    error: 'runtime_capability_unavailable',
    performed: false,
    facility: 'localWebGpuHost',
    reasonCode: 'host_unsupported',
    retryable: false,
    alternative: 'use_ollama',
  });

  return {
    'local-model/status': async () => {
      if (!localModelHostAvailable()) return unavailable();
      await ensureOffscreen();
      const r = await browser.runtime.sendMessage({ type: 'local-model/host/status' });
      const changed = localModelState.setAvailable(!!(r?.available || r?.downloaded)); // cached counts as usable (lazy-loads on first use)
      if (changed) { onProviderConfigChanged?.(); pushState?.(); }
      // include the last progress event so Settings (which keeps no port) can show
      // a phase hint while the model downloads.
      return r ? { ...r, progress: localModelState.progress() } : { ok: false };
    },
    'local-model/probe': async () => {
      if (!localModelHostAvailable()) return unavailable();
      await ensureOffscreen();
      return (await browser.runtime.sendMessage({ type: 'local-model/host/probe' })) ?? { ok: false };
    },
    'local-model/init': async () => {
      if (!localModelHostAvailable()) return unavailable();
      await ensureOffscreen();
      const r = await browser.runtime.sendMessage({ type: 'local-model/host/init' });
      const changed = localModelState.setAvailable(!!(r?.available || r?.downloaded)); // cached counts as usable (lazy-loads on first use)
      if (changed) { onProviderConfigChanged?.(); pushState?.(); }
      return r ?? { ok: false };
    },
  };
};
