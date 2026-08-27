// @ts-check

// why: Firefox runs a persistent-capable module background page and supports
// demand imports there. Keep the same exact owner interface while preserving
// its real lazy boundary; no Chrome entry imports this module.
export const firefoxKernelRuntimeModules = Object.freeze({
  controllerClient: async () => (await import(
    './offscreen-controller-client.js'
  )).makeSemanticControllerClient,
  demandPlane: async () => (await import(
    './kernel-demand-plane.js'
  )).createKernelDemandPlane,
  productionRuntime: async () => (await import(
    './kernel-production-runtime.js'
  )).createKernelProductionRuntime,
  sessionAuthority: async () => (await import(
    './kernel-session-authority.js'
  )).createKernelSessionAuthority,
  supportControl: async () => (await import(
    './kernel-support-control.js'
  )).createKernelSupportControl,
  turnFactories: async () => (await import(
    './kernel-turn-live-factories.js'
  )).createKernelTurnLiveFactories,
  directActorHost: async () => import('./direct-actor-host.js'),
  artifactCodec: async () => import('/peerd-engine/export.js'),
});
