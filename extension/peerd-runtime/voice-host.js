// @ts-check
// Voice-document surface. Keep this exact: Firefox statically links it into
// the background page, while Chrome loads it only inside the offscreen host.

export { createVoiceHostRuntime } from './voice/host-runtime.js';
