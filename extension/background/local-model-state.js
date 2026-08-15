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
// TWO AXES, per model, and the distinction is load-bearing: `available` means
// USABLE (weights cached; lazy-loads on first use), while `resident` means the
// model is loaded in the offscreen heap RIGHT NOW. The runner asks a single
// question - "is there a local model I can run?" - so `available()` with no
// argument keeps answering that, and `residentModel()` names the one it would
// get. why residency outranks the default in that race: sending the runner to
// a merely-cached default while ANOTHER model is live would evict a multi-GB
// resident model to answer, exactly the swap the one-resident-model engine
// tries to avoid.
//
// `available` feeds resolveRunnerModel step 2 (local-when-available); `progress`
// is polled by Settings (which holds no port). Imports nothing.

/**
 * @param {Object} [opts]
 * @param {string} [opts.defaultModel] preferred model id when several are usable
 */
export const makeLocalModelState = ({ defaultModel = '' } = {}) => {
  /** @type {Set<string>} */
  const availableIds = new Set();
  /** @type {Set<string>} */
  const residentIds = new Set();
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
     * The model the runner gets: an ACTUALLY RESIDENT model first (default
     * preferred among residents), else the usable default, else the first
     * other usable one, else ''.
     * @returns {string}
     */
    residentModel: () => {
      if (residentIds.has(defaultModel)) return defaultModel;
      const live = residentIds.values().next().value;
      if (live) return live;
      return availableIds.has(defaultModel) ? defaultModel : (availableIds.values().next().value ?? '');
    },
    /** Has this worker seeded the FULL catalog from the model host? */
    hydrated: () => hydrated,
    /**
     * Record one model's usability. Returns whether this CHANGED anything (the
     * SW only re-publishes provider config on a real change). A model that
     * stops being usable also stops being resident.
     * @param {string} id
     * @param {unknown} b
     */
    setModelAvailable: (id, b) => {
      const next = !!b;
      const changed = availableIds.has(id) !== next;
      if (next) availableIds.add(id); else { availableIds.delete(id); residentIds.delete(id); }
      return changed;
    },
    /**
     * Record whether a model is loaded in the offscreen heap right now (the
     * engine's status.available / the 'ready' progress event - never inferred
     * from "downloaded"). Resident implies usable.
     * @param {string} id
     * @param {unknown} b
     */
    setModelResident: (id, b) => {
      if (b) { residentIds.add(id); availableIds.add(id); } else residentIds.delete(id);
    },
    /**
     * Mark the store seeded. ONLY full-catalog seeds may call this (the SW's
     * hydrate pass and the catalog route): a single model's ready event must
     * never claim the whole store is hydrated, or the real seeding would be
     * skipped and every OTHER downloaded model stay invisible.
     */
    markHydrated: () => { hydrated = true; },
    /** The last download-progress event (or null). */
    progress: () => progress,
    /** @param {unknown} p */
    setProgress: (p) => { progress = p; },
  };
};
