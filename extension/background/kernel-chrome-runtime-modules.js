// @ts-check

import { makeSemanticControllerClient } from './offscreen-controller-client.js';
import { createKernelDemandPlane } from './kernel-demand-plane.js';
import { createKernelProductionRuntime } from './kernel-production-runtime.js';
import { createKernelSessionAuthority } from './kernel-session-authority.js';
import { createKernelSupportControl } from './kernel-support-control.js';
import { createKernelTurnLiveFactories } from './kernel-turn-live-factories.js';

// why: Chrome MV3 rejects import() in a service worker. The package already
// bundled these exact modules into one file, so the authored Chrome entry must
// declare the same fixed authority closure instead of presenting it as lazy.
export const chromeKernelRuntimeModules = Object.freeze({
  controllerClient: async () => makeSemanticControllerClient,
  demandPlane: async () => createKernelDemandPlane,
  productionRuntime: async () => createKernelProductionRuntime,
  sessionAuthority: async () => createKernelSessionAuthority,
  supportControl: async () => createKernelSupportControl,
  turnFactories: async () => createKernelTurnLiveFactories,
});
