// @ts-check
// background/local-model-state.js — the local WebGPU runner's residency flag +
// last download-progress event, behind a store so the local-model/* routes and
// the progress forwarder reach it via deps instead of reassigned `let`s.
//
// why a store (step 2 of the SW decomposition): localModelAvailable +
// lastLocalProgress were module-level lets flipped by local-model/{status,init}
// and the progress message handler, and read by resolveRunnerModel +
// buildModelOptions. Encapsulating them lets the routes move out.
//
// `available` feeds resolveRunnerModel step 2 (local-when-available); `progress`
// is polled by Settings (which holds no port). Imports nothing.

export const makeLocalModelState = () => {
  let available = false;
  /** @type {unknown} */
  let progress = null;
  return {
    /** Is the local model actor/cached (usable as the page-reader runner)? */
    available: () => available,
    /** @param {unknown} b */
    setAvailable: (b) => { available = !!b; },
    /** The last download-progress event (or null). */
    progress: () => progress,
    /** @param {unknown} p */
    setProgress: (p) => { progress = p; },
  };
};
