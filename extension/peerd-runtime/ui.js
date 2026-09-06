// @ts-check
// Cold-safe UI surface. Keep this exact: sidepanel/Home must not inherit the
// agent loop, tool catalog, repository engine, or background semantics through
// the universal barrel before the vault gate is actionable.

export { classifyBrowserAutomationTarget } from './tools/browser-automation-policy.js';
export { createVoiceManager } from './voice/manager.js';
export { MicButton } from './voice/mic-button.js';
export { detectVoiceCapability } from './voice/engine-picker.js';
export { activeTrigger } from './composer/parse.js';
export { filterCandidates } from './composer/palette-filter.js';
export {
  classifyAttachment, ATTACHMENT_CAPS, MAX_ATTACHMENTS_PER_MESSAGE,
  DOC_MEDIA_TYPES, IMAGE_MEDIA_TYPES, formatBytes,
} from './loop/attachments.js';
export { manifestLabel } from './tools/manifests.js';
export { bundleToOtlp } from './observability/otel-export.js';
export { classifyFailure } from './observability/failure-classify.js';
export { contributorFeedbackTargets } from './observability/contributor-feedback.js';
export { PEER_NAME_MAX } from './profiles/profile.js';
