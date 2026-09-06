// @ts-check
// why: the SW needs browser policy and injected bodies without importing semantic catalogs.

export {
  activityOverlayInjected,
  clearActivityOverlayInjected,
} from './dom/activity-overlay-injected.js';
export {
  isDenylistedTab,
  liveDocumentLocationInjected,
} from './dom/browser-target-probe.js';
export { pullInHintInjected } from './dom/pull-in-hint-injected.js';
export { shapeSketch } from './site-clients/shape-sketch.js';
export {
  classifyBrowserAutomationTarget,
  isAddressableBrowserTab,
} from './tools/browser-automation-policy.js';
