// @ts-check
// Package-time replacement for targets that do not ship the `debugger`
// permission (Store Chrome and every Firefox build). The service worker keeps
// one stable interface, while an impossible CDP path contributes no cold graph.

const unavailable = async () => {
  throw new Error('debugger_unavailable');
};

export const createDebuggerPool = () => Object.freeze({
  attach: unavailable,
  // Cleanup is idempotent when this target can never own debugger custody.
  detach: async () => {},
  evaluate: unavailable,
  dispatchKeys: unavailable,
  getAxTree: unavailable,
  captureScreenshot: unavailable,
  clickBackendNode: unavailable,
  setValueBackendNode: unavailable,
  readFrameworkState: unavailable,
  startNetworkCapture: unavailable,
  stopNetworkCapture: async () => [],
  discardNetworkCapture: async () => {},
  releaseNetworkCapture: () => {},
  isAttached: () => false,
});
