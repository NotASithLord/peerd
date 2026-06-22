// @ts-check
// peerd-runtime/voice — public surface of the voice subsystem.
//
// The voice subsystem is split across three contexts:
//   side panel  — manager, model-store, mic-button (UI)
//   offscreen   — transcriber, Moonshine instance
//   SW          — message routing only
//
// Files import directly from these public re-exports.

export { createVoiceManager } from './manager.js';
export { createModelStore } from './model-store.js';
export { createBestTranscriber, detectVoiceCapability } from './engine-picker.js';
export { MicButton } from './mic-button.js';
export { normalizeVariant, normalizeEngine, VOICE_ENGINES } from './settings.js';
