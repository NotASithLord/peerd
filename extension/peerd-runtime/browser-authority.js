// @ts-check

// Stable browser-authority surface for the service-worker kernel. These are
// named policy and browser-operation helpers, not model-facing tool metadata
// or a generic browser dispatcher.
export {
  AUTH_WAITING_FOR_USER_CODE,
  AUTH_WAITING_FOR_USER_MESSAGE,
  browserDocumentIdentity,
  isDenylistedTab,
  originOfUrl,
  resolveTargetTab,
  scriptingTarget,
} from './browser-authority/dom-helpers.js';
export {
  resetToVerifiedBlank,
  updateAndObserveCommittedNavigation,
} from './browser-authority/committed-navigation.js';
export {
  BROWSER_TARGET_STAGES,
  BrowserAutomationPolicyError,
  browserDocumentRefusalFrom,
  browserNetworkGuardPostNavigationResult,
  browserTargetRefusalResult,
  classifyBrowserAutomationTarget,
  formSubmissionRefusalFrom,
  sensitiveSiteBrowserTargetVerdict,
  unverifiedBrowserTargetVerdict,
} from './tools/browser-automation-policy.js';
export { captureVisible } from './tools/web/primitives.js';
export { classifyLoginAffordance, loginTargetReader } from './tools/login-affordance.js';
export { isKnownIdp } from './actor/idp-registry.js';
export { classifyUrl as classifyUgcUrl } from './actor/ugc-registry.js';
export { describeToolActivity, displayOrigin } from './actor/activity-label.js';
export { inspectTabToolCall } from './tools/egress-heuristics.js';
export {
  normalizeBrowserChildPolicyNotices,
  withAsyncBrowserChildPolicyNotices,
  withBrowserChildPolicyNotices,
} from './browser-authority/child-policy-result.js';
export { wrapUntrusted } from './tools/prompt-wrap.js';
export { disarmMarkup } from './dom/cdr.js';
export { excerptFooter, excerptRelevant, pagingFooter, windowText } from './tools/web/spill.js';
export { summarizeMutations } from './dom/action-result.js';
export { readFrameworkStateInjected } from './dom/framework-state.js';
export { captureSnapshot, describeSource } from './dom/capture.js';
export { diffSnapshots } from './dom/snapshot-diff.js';
