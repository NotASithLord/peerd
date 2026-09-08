// @ts-check
// Settings-only runtime features. Keep the shared ui.js surface stable so
// Sidepanel and Home do not inherit Options-only OCR or memory machinery.

export { createVoiceManager } from './voice/manager.js';
export { detectVoiceCapability } from './voice/engine-picker.js';
export { bundleToOtlp } from './observability/otel-export.js';
export {
  createOcrStore, hasValidOcrSris, OCR_TOTAL_BYTES,
} from './pdf/ocr-store.js';
export { countLines, ALWAYS_LOADED_LINE_BUDGET } from './memory/memory.js';
