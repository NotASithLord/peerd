// @ts-check

import { createControllerTurnSemantics } from '/peerd-runtime/controller-turn-semantics.js';
import { createKernelTurnAuthorityAdapter } from './kernel-turn-authority-adapter.js';

// why: this is the only live composition path. T1 separates ownership without
// relocating execution or introducing a second protocol-backed implementation.
export const createKernelTurnLiveFactories = (/** @type {Record<string,any>} */ deps) =>
  createKernelTurnAuthorityAdapter(deps, createControllerTurnSemantics());
