// @ts-check
// peerd-runtime/dom — DOM navigation layer (Phase 1).
//
// Public surface for the a11y-tree-+-refs paradigm. See
// docs/DOM-NAVIGATION-ASSESSMENT.md (assessment + plan) and
// docs/DOM-NAVIGATION-DESIGN.md (the layer's design).
//
// Phase 1 ships the pure core: serialize a CDP a11y tree into a
// ref-annotated snapshot, and a harness-owned ref→node registry. The CDP
// fetch/click shell lives in background/debugger-pool.js; the tools
// (snapshot, click{ref}) wire the two together.

export { serializeAxTree } from './ax-serialize.js';
export { createRefRegistry } from './ref-registry.js';
export { diffSnapshots } from './snapshot-diff.js';
export { summarizeMutations } from './action-result.js';
// Firefox-parity fallback: captureSnapshot picks CDP when the pool is
// wired, else the chrome.scripting DOM-walk pseudo-snapshot
// (walk-injected.js) — same serializer, same ref contract.
export { captureSnapshot, describeSource, signalIsAttributable } from './capture.js';
export { domWalkInjected } from './walk-injected.js';

// The in-page activity indicator injected into the tab the web actor drives.
// Exported from the module surface because the SW-side shell that schedules it
// (background/page-activity.js) lives outside peerd-runtime.
export {
  activityOverlayInjected,
  clearActivityOverlayInjected,
  ACTIVITY_OVERLAY_ID,
} from './activity-overlay-injected.js';
// The "pull peerd in" reminder injected into a regular web page peerd opens
// (informational only — no SW route; docs/PULL-IN-PEERD-WEB-SCOPE.md).
export { pullInHintInjected } from './pull-in-hint-injected.js';
// No-CDP framework-state introspection (read_state's scripting fallback):
// a MAIN-world injectable, the scripting twin of debugger-pool's CDP path.
export { readFrameworkStateInjected } from './framework-state.js';
// DESIGN-19 Tap B — the MAIN-world fetch/XHR tap for site-client capture.
export { installFetchTapInjected, drainFetchTapInjected } from './fetch-tap-injected.js';
