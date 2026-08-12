// @ts-check
// realm-seal.js — side-effecting entry for the Notebook realm seal.
//
// The worker source assembled in notebook-tab.js emits this module's absolute
// URL as the entry's FIRST static import. Chrome evaluates that module graph
// directly. Firefox's linker preserves the same order in one strict script.
// Either way, this body and therefore the whole seal runs BEFORE any
// agent-authored module's top-level code, no matter what the agent imports. Do not add imports above
// notebook-neutralizers.js or code before applyRealmSeal(): anything
// earlier widens the pre-seal window.
//
// Kept as its own module (instead of calling applyRealmSeal in the entry
// body) because the entry's top-level statements only run AFTER all of
// its static imports have evaluated — too late to seal the realm against
// imported agent code.

import { applyNotebookRealmSeal } from './notebook-neutralizers.js';

try {
  applyNotebookRealmSeal(globalThis);
} catch (error) {
  // why report before rethrow: Firefox strips detail from Worker error
  // events. This trusted pre-user-code message keeps a seal regression
  // actionable without letting the run continue in an unsealed realm.
  postMessage({
    type: 'seal-failed',
    error: /** @type {{ stack?: string, message?: string }} */ (error)?.stack
      || /** @type {{ message?: string }} */ (error)?.message
      || String(error),
  });
  throw error;
}
