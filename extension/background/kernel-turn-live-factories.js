// @ts-check

import { createKernelTurnAuthorityAdapter } from './kernel-turn-authority-adapter.js';

// why: the service worker constructs only the fixed authority adapter. Semantic
// inventory, prompt, and tool execution assembly enter through the sealed
// controller seams instead of a growing in-process function bag.
export const createKernelTurnLiveFactories = (/** @type {Record<string,any>} */ deps) =>
  createKernelTurnAuthorityAdapter(deps);
