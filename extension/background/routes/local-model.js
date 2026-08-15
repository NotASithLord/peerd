// @ts-check
// background/routes/local-model.js — local WebGPU runner control
// (FEATURE-LOCAL-WEBGPU B). status/catalog/probe are read-only; init triggers
// the (one-time) model download in the offscreen engine. Unsupported hosts
// refuse before offscreen startup. Supported routes forward to
// local-model/host/*; status/init update the local-model store used by runner
// resolution.
//
// Every route is MODEL-SCOPED: `msg.model` names which on-device model to ask
// about or download, defaulting to the engine's own default when absent (so a
// caller that predates multi-model support still asks a well-formed question).

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

  // A host reply names the model it is about; record THAT model's usability
  // rather than assuming the request's id (they differ when the engine falls
  // back to its default for an absent id).
  /** @param {any} reply */
  const recordAvailability = (reply) => {
    const id = typeof reply?.model === 'string' ? reply.model : null;
    if (!id) return;
    // cached counts as usable (lazy-loads on first use)
    const changed = localModelState.setModelAvailable(id, !!(reply.available || reply.downloaded));
    if (changed) { onProviderConfigChanged?.(); pushState?.(); }
  };

  return {
    'local-model/status': async (msg) => {
      if (!localModelHostAvailable()) return unavailable();
      await ensureOffscreen();
      const r = await browser.runtime.sendMessage({
        type: 'local-model/host/status', model: msg?.model, includeSupport: !!msg?.includeSupport,
      });
      recordAvailability(r);
      // include the last progress event so Settings (which keeps no port) can show
      // a phase hint while the model downloads.
      return r ? { ...r, progress: localModelState.progress() } : { ok: false };
    },
    'local-model/catalog': async (msg) => {
      if (!localModelHostAvailable()) return unavailable();
      await ensureOffscreen();
      const r = await browser.runtime.sendMessage({
        type: 'local-model/host/catalog', includeSupport: msg?.includeSupport !== false,
      });
      // Seed residency for EVERY model in one pass - this is the call Settings
      // makes on mount, so it is also the cheapest moment to correct the store.
      if (Array.isArray(r?.models)) for (const entry of r.models) recordAvailability(entry);
      return r ? { ...r, progress: localModelState.progress() } : { ok: false };
    },
    'local-model/probe': async () => {
      if (!localModelHostAvailable()) return unavailable();
      await ensureOffscreen();
      return (await browser.runtime.sendMessage({ type: 'local-model/host/probe' })) ?? { ok: false };
    },
    'local-model/init': async (msg) => {
      if (!localModelHostAvailable()) return unavailable();
      await ensureOffscreen();
      const r = await browser.runtime.sendMessage({ type: 'local-model/host/init', model: msg?.model });
      recordAvailability(r);
      return r ?? { ok: false };
    },
  };
};
