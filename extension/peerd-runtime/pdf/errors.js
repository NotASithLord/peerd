// @ts-check
// PDF subsystem — typed errors.
//
// Named subclasses (house rule), so callers can branch on the failure
// shape instead of string-matching a message. All extend TypedError so
// they serialize cleanly across the SW ↔ offscreen message bridge (the
// `name` survives; `instanceof` does not, so cross-context callers match
// on `.name` — same discipline as voice/errors.js).

import { TypedError } from '/shared/errors.js';

/** The PDF bytes could not be fetched (network / HTTP / unsupported scheme). */
export class PdfFetchError extends TypedError {
  static errorName = 'PdfFetchError';

  /**
   * @param {string} message
   * @param {{ status?: number }} [opts]
   */
  constructor(message, { status } = {}) {
    super(message);
    this.status = status ?? null;
  }
}

/** pdf.js could not parse the bytes (corrupt, encrypted, not a PDF). */
export class PdfParseError extends TypedError {
  static errorName = 'PdfParseError';

  /** @param {string} message */
  constructor(message) {
    super(message);
  }
}

/** A scanned/image-only PDF was found but the OCR engine isn't installed. */
export class OcrUnavailableError extends TypedError {
  static errorName = 'OcrUnavailableError';

  /** @param {string} [message] */
  constructor(message) {
    super(message ?? 'OCR is unavailable in this build. Use a searchable PDF or page images.');
  }
}

/** A requested engine name isn't one peerd knows. */
export class UnknownPdfEngineError extends TypedError {
  static errorName = 'UnknownPdfEngineError';

  /** @param {string} engine */
  constructor(engine) {
    super(`Unknown PDF engine: "${engine}". Known engines: pdfjs, ocr.`);
    this.engine = engine;
  }
}

// The OCR opt-in download reuses the voice download's error vocabulary so
// the model-store logic (copied pattern) stays identical. Re-declared here
// rather than imported from voice/ to keep the dweb-style module boundary
// clean (pdf/ must not reach into voice/ internals).

/** OCR asset download failed (network / HTTP). */
export class OcrDownloadError extends TypedError {
  static errorName = 'OcrDownloadError';

  /**
   * @param {string} message
   * @param {{ status?: number }} [opts]
   */
  constructor(message, { status } = {}) {
    super(message);
    this.status = status ?? null;
  }
}

/** A downloaded OCR asset failed its pinned SRI check — dropped, not cached. */
export class OcrSriMismatchError extends TypedError {
  static errorName = 'OcrSriMismatchError';

  /** @param {{ url: string, expected: string|null, actual: string }} info */
  constructor({ url, expected, actual }) {
    super(`OCR asset integrity check failed for ${url}`);
    this.url = url;
    this.expected = expected;
    this.actual = actual;
  }
}
