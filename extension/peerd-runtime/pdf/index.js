// @ts-check
// peerd-runtime/pdf — public surface of the PDF-reading subsystem.
//
// Split across contexts, like voice:
//   SW         — the read_pdf tool dispatches to the offscreen client
//   offscreen  — pdf.js parsing + (opt-in) OCR recognition (needs a Worker)
//   side panel — Settings → Voice & OCR drives the opt-in OCR download
//
// The default engine (pdf.js text layer) is vendored and always available;
// OCR is an opt-in runtime download (the Moonshine-voice pattern).

export {
  DEFAULT_ENGINE, PDF_ENGINES, requireEngine,
  chooseEngine, looksScanned, SCANNED_CHARS_PER_PAGE,
} from './engines.js';

export {
  DEFAULT_MAX_CHARS, assemblePages, formatPdfBody,
} from './extract-format.js';

export {
  createOcrStore, hasValidOcrSris, OCR_ASSETS, OCR_TOTAL_BYTES,
} from './ocr-store.js';

export {
  PdfFetchError, PdfParseError, OcrUnavailableError,
  UnknownPdfEngineError, OcrDownloadError, OcrSriMismatchError,
} from './errors.js';
