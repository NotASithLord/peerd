// @ts-check
// background/local-model-state.js - the local WebGPU runners' residency flags +
// last download-progress event, behind a store so the local-model/* routes and
// the progress forwarder reach it via deps instead of reassigned `let`s.
//
// why a store (step 2 of the SW decomposition): localModelAvailable +
// lastLocalProgress were module-level lets flipped by local-model/{status,init}
// and the progress message handler, and read by resolveRunnerModel +
// buildModelOptions. Encapsulating them lets the routes move out.
//
// Residency is PER MODEL (the engine ships more than one on-device model), but
// the runner asks a single question - "is there a local model I can run?" - so
// `available()` with no argument keeps answering that, and `residentModel()`
// names the one it would get. why the default model wins that race: it is the
// model the runner path is tuned for; another downloaded model is a fallback,
// not a silent substitution.
//
// `available` feeds resolveRunnerModel step 2 (local-when-available); `progress`
// is polled by Settings (which holds no port). Imports nothing.

/**
 * @param {Object} [opts]
 * @param {string} [opts.defaultModel] preferred model id when several are resident
 */
export const makeLocalModelState = ({ defaultModel = '' } = {}) => {
  /** @type {Set<string>} */
  const availableIds = new Set();
  let hydrated = false;
  /** @type {unknown} */
  let progress = null;
  return {
    /**
     * Is a local model resident/cached (usable as the web actor model)? With an
     * id, asks about THAT model; with none, asks whether any model is usable.
     * @param {string} [id]
     */
    available: (id) => (id === undefined ? availableIds.size > 0 : availableIds.has(id)),
    /** Every usable local model id. @returns {string[]} */
    availableModels: () => [...availableIds],
    /**
     * The model the runner gets: the default when it's usable, else the first
     * other usable one, else ''.
     * @returns {string}
     */
    residentModel: () => (availableIds.has(defaultModel) ? defaultModel : (availableIds.values().next().value ?? '')),
    /** Has this worker confirmed cache/residency with the model host? */
    hydrated: () => hydrated,
    /**
     * Record one model's usability. Returns whether this CHANGED anything (the
     * SW only re-publishes provider config on a real change).
     * @param {string} id
     * @param {unknown} b
     */
    setModelAvailable: (id, b) => {
      const next = !!b;
      const changed = !hydrated || availableIds.has(id) !== next;
      if (next) availableIds.add(id); else availableIds.delete(id);
      hydrated = true;
      return changed;
    },
    /** The last download-progress event (or null). */
    progress: () => progress,
    /** @param {unknown} p */
    setProgress: (p) => { progress = p; },
  };
};
