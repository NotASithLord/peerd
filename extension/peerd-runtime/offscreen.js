// @ts-check
// Offscreen-only runtime surface: document conversion, OCR/model storage, and
// the sealed script worker's code/actor bridges. It deliberately excludes UI
// components and the privileged background agent-loop assembly.

export { createModelStore } from './voice/model-store.js';
export {
  CODE_RUN_MAX_TRACE_OPS, buildCodeClientSource, canonicalCodeTraceLabel,
} from './actor/capability-manifest.js';
export {
  ACTORS_BRIDGE_GUARD_MS, ACTORS_RUN_MAX_OPS,
  ACTORS_TRACE_ERROR_MAX_CHARS, ACTORS_TRACE_TARGET_MAX_CHARS, actorsCallToOp,
  shapeActorsResult,
} from './actor/actors-api.js';
export { shapeActorRoster } from './tools/defs/actor-list.js';
export {
  pageCallToRelay, pageCallToToolCall, shapePageCallOutcome,
} from './actor/page-api.js';
export { MAX_FILE_CONTENT_CHARS } from './tools/defs/js-write-file.js';
export {
  chooseEngine, looksScanned, createOcrStore, PdfFetchError, PdfParseError,
} from './pdf/index.js';
export {
  convertToDocument, sniffDocFormat, DocFetchError, DocParseError,
  UnsupportedDocFormatError, LegacyDocFormatError, ZipError,
} from './doc/index.js';
export { MAX_SPILL_TEXT_CHARS } from './tools/result-store-policy.js';
