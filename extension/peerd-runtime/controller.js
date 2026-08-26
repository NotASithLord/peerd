// @ts-check
// Sealed semantic-controller public surface. Keep this exact: controller code
// must not import the universal UI/background barrel or deep-link internals.

export { buildTemporalContext, renderSystemPromptFromAssets } from './loop/system-prompt.js';
export { buildTemporalBlock } from './clock/context.js';
