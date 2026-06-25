// @ts-check
// realm-seal.js — side-effecting entry for the Notebook realm seal.
//
// The worker source assembled in notebook-tab.js emits this module's absolute
// URL as the entry's FIRST static import. ES module graphs evaluate
// depth-first in declaration order, so this body — and therefore the
// whole seal — runs BEFORE any agent-authored module's top-level code,
// no matter what the agent imports. Do not add imports above
// notebook-neutralizers.js or code before applyRealmSeal(): anything
// earlier widens the pre-seal window.
//
// Kept as its own module (instead of calling applyRealmSeal in the entry
// body) because the entry's top-level statements only run AFTER all of
// its static imports have evaluated — too late to seal the realm against
// imported agent code.

import { applyRealmSeal } from './notebook-neutralizers.js';

applyRealmSeal(globalThis);
